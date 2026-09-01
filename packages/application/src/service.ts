import type {
  Assignment,
  CommandReceipt,
  FactorySnapshot,
  NormalizedError,
} from "@irudd-factory/contracts";
import { ASSIGNMENT_EVENTS } from "@irudd-factory/contracts";
import { Effect } from "effect";
import {
  asFactoryError,
  FactoryError,
  type FactoryErrorCode,
} from "./errors.ts";
import {
  Clock,
  GitHub,
  IdGenerator,
  Provider,
  StateStore,
  Workspaces,
} from "./ports.ts";
import { buildAssignmentPrompt } from "./workflow.ts";

export interface ApplicationOptions {
  readonly repository: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: string;
}

function failure(code: FactoryErrorCode, error: unknown): NormalizedError {
  const normalized = asFactoryError(error, code);
  return {
    code: normalized.code,
    message: normalized.message,
    ...(normalized.detail ? { detail: normalized.detail } : {}),
  };
}

export function makeApplication(options: ApplicationOptions) {
  const processAssignment = (initial: Assignment) =>
    Effect.gen(function* () {
      const state = yield* StateStore;
      const github = yield* GitHub;
      const workspaces = yield* Workspaces;
      const provider = yield* Provider;
      const clock = yield* Clock;

      const claim = yield* github.claimIssue(initial.issue);
      if (claim !== "confirmed") {
        const code: FactoryErrorCode =
          claim === "unclaimed" ? "claim_unconfirmed" : "claim_unknown";
        yield* state.appendEvent(
          initial.id,
          {
            type: ASSIGNMENT_EVENTS.failed,
            timestamp: clock.now(),
            detail: { code },
          },
          {
            state: "failed",
            error: {
              code,
              message:
                claim === "unclaimed"
                  ? "GitHub confirmed that the issue was not claimed"
                  : "GitHub claim state could not be confirmed",
            },
          },
        );
        return;
      }

      const starting = yield* state.appendEvent(
        initial.id,
        {
          type: ASSIGNMENT_EVENTS.providerStartRequested,
          timestamp: clock.now(),
          detail: {},
        },
        { state: "starting" },
      );
      const workspace = yield* workspaces.create({
        repository: starting.issue.repository,
        assignmentId: starting.id,
        startingCommit: starting.workflow.startingCommit,
      });
      const withWorkspace = yield* state.appendEvent(
        starting.id,
        {
          type: ASSIGNMENT_EVENTS.workspaceCreated,
          timestamp: clock.now(),
          detail: { branch: workspace.branch },
        },
        { workspace },
      );

      const prompt = buildAssignmentPrompt(
        withWorkspace.workflow.body,
        withWorkspace.issue.repository,
        withWorkspace.issue.number,
      );
      const result = yield* provider.run(
        { assignment: withWorkspace, prompt, workspace },
        (event) =>
          state
            .appendEvent(
              withWorkspace.id,
              {
                type: event.type,
                timestamp: event.timestamp,
                detail: { ...event.detail },
              },
              event.patch,
            )
            .pipe(Effect.asVoid),
      );
      yield* state.appendEvent(
        withWorkspace.id,
        {
          type: ASSIGNMENT_EVENTS.providerTurnFinished,
          timestamp: clock.now(),
          detail: {
            finalResponse: result.finalResponse,
            itemSummaries: result.itemSummaries,
            tokenUsage: result.tokenUsage,
            approvalCount: result.approvalCount,
            processExit: result.processExit,
          },
        },
        {
          codexVersion: result.codexVersion,
          threadId: result.threadId,
          turnId: result.turnId,
          observedModel: result.observedModel,
          observedEffort: result.observedEffort,
        },
      );
      const pullRequest = yield* github.verifyPullRequest(
        withWorkspace.issue.repository,
        workspace.branch,
        withWorkspace.issue.number,
      );
      yield* state.appendEvent(
        withWorkspace.id,
        {
          type: ASSIGNMENT_EVENTS.completed,
          timestamp: clock.now(),
          detail: { pullRequestUrl: pullRequest.url, draft: pullRequest.draft },
        },
        { state: "completed", pullRequest },
      );
    }).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          const state = yield* StateStore;
          const clock = yield* Clock;
          const normalized = failure("assignment_failed", error);
          yield* state.appendEvent(
            initial.id,
            {
              type: ASSIGNMENT_EVENTS.failed,
              timestamp: clock.now(),
              detail: { code: normalized.code, message: normalized.message },
            },
            { state: "failed", error: normalized },
          );
        }).pipe(Effect.catchAll(() => Effect.void)),
      ),
    );

  const runNextEligibleIssue = (
    commandId: string,
  ): Effect.Effect<
    CommandReceipt,
    FactoryError,
    StateStore | GitHub | Workspaces | Provider | Clock | IdGenerator
  > =>
    Effect.gen(function* () {
      if (!commandId.trim()) {
        return yield* Effect.fail(
          new FactoryError({
            code: "command_id_required",
            message: "commandId must be a nonempty string",
          }),
        );
      }
      const state = yield* StateStore;
      const existing = yield* state.getReceipt(commandId);
      if (existing) return existing;

      const github = yield* GitHub;
      const clock = yield* Clock;
      const ids = yield* IdGenerator;
      const candidates = yield* github.discoverCandidates(options.repository);
      const admission = yield* state.admit({
        commandId,
        provider: options.provider,
        candidates,
        assignmentId: ids.assignmentId(),
        requestedModel: options.model,
        requestedEffort: options.reasoningEffort,
        timestamp: clock.now(),
      });
      const receipt = admission.receipt;
      if (admission.created && receipt.result._tag === "started") {
        yield* processAssignment(receipt.result.assignment).pipe(
          Effect.forkDaemon,
        );
      }
      return receipt;
    });

  const getSnapshot = (): Effect.Effect<
    FactorySnapshot,
    FactoryError,
    StateStore
  > =>
    Effect.gen(function* () {
      const state = yield* StateStore;
      return yield* state.getSnapshot();
    });

  return { runNextEligibleIssue, getSnapshot, processAssignment } as const;
}
