import type {
  Assignment,
  CommandReceipt,
  FactorySnapshot,
  NormalizedError,
} from "@irudd-factory/contracts";
import { ASSIGNMENT_EVENTS } from "@irudd-factory/contracts";
import { Effect, Fiber } from "effect";
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
  readonly repositories: ReadonlyArray<{
    readonly repository: string;
    readonly model: string;
    readonly reasoningEffort: string;
  }>;
  readonly provider: string;
  readonly slots: number;
  readonly pollIntervalMs: number;
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
  const inFlight = new Set<Fiber.RuntimeFiber<void, never>>();

  const processAssignment = (initial: Assignment) =>
    Effect.gen(function* () {
      const state = yield* StateStore;
      const github = yield* GitHub;
      const workspaces = yield* Workspaces;
      const provider = yield* Provider;
      const clock = yield* Clock;

      if (github.revalidateIssue) {
        yield* github.revalidateIssue({
          issue: initial.issue,
          workflow: initial.workflow,
        });
      }
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

      const processPending = yield* state.appendEvent(
        withWorkspace.id,
        {
          type: ASSIGNMENT_EVENTS.providerProcessStartPending,
          timestamp: clock.now(),
          detail: {},
        },
        { processStartPending: true },
      );
      const prompt = buildAssignmentPrompt(
        withWorkspace.workflow.body,
        withWorkspace.issue.repository,
        withWorkspace.issue.number,
      );
      const result = yield* provider.run(
        { assignment: processPending, prompt, workspace },
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
          processStartPending: false,
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
            {
              state: "failed",
              error: normalized,
              processStartPending: false,
            },
          );
        }).pipe(Effect.catchAll(() => Effect.void)),
      ),
    );

  const admitCandidates = (
    commandId: string,
    candidates: ReadonlyArray<import("./ports.ts").Candidate>,
    allowRetry = false,
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

      const clock = yield* Clock;
      const ids = yield* IdGenerator;
      const selected = candidates.length === 1 ? candidates[0] : undefined;
      const settings = selected
        ? options.repositories.find(
            ({ repository }) =>
              repository === selected.issue.repository.toLowerCase(),
          )
        : undefined;
      const admission = yield* state.admit({
        commandId,
        provider: options.provider,
        candidates,
        assignmentId: ids.assignmentId(),
        requestedModel: settings?.model ?? "",
        requestedEffort: settings?.reasoningEffort ?? "",
        timestamp: clock.now(),
        slots: options.slots,
        allowRetry,
      });
      const receipt = admission.receipt;
      if (admission.created && receipt.result._tag === "started") {
        const fiber = yield* processAssignment(receipt.result.assignment).pipe(
          Effect.forkDaemon,
        );
        inFlight.add(fiber);
        fiber.addObserver(() => inFlight.delete(fiber));
      }
      return receipt;
    });

  const runNextEligibleIssue = (commandId: string) =>
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
      const candidates = (yield* Effect.all(
        options.repositories.map(({ repository }) =>
          github.discoverCandidates(repository),
        ),
        { concurrency: "unbounded" },
      )).flat();
      return yield* admitCandidates(commandId, candidates);
    });

  const startIssue = (
    commandId: string,
    repositoryInput: string,
    issueNumber: number,
  ) =>
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
      const repository = repositoryInput.toLowerCase();
      if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
        return yield* Effect.fail(
          new FactoryError({
            code: "issue_ineligible",
            message: "issueNumber must be a positive integer",
          }),
        );
      }
      if (
        !options.repositories.some((entry) => entry.repository === repository)
      ) {
        return yield* Effect.fail(
          new FactoryError({
            code: "repository_not_configured",
            message: `Repository ${repositoryInput} is not configured`,
          }),
        );
      }
      const github = yield* GitHub;
      const discovered = yield* github.discoverCandidates(repository);
      const candidate = discovered.find(
        ({ issue }) => issue.number === issueNumber,
      );
      if (!candidate) {
        return yield* Effect.fail(
          new FactoryError({
            code: "issue_ineligible",
            message: `${repository}#${issueNumber} is not eligible`,
          }),
        );
      }
      const current = github.revalidateIssue
        ? yield* github.revalidateIssue(candidate)
        : candidate;
      return yield* admitCandidates(commandId, [current], true);
    });

  const getSnapshot = (): Effect.Effect<
    FactorySnapshot,
    FactoryError,
    StateStore
  > =>
    Effect.gen(function* () {
      const state = yield* StateStore;
      const snapshot = yield* state.getSnapshot();
      return {
        ...snapshot,
        configuration: {
          repositories: options.repositories.map((entry) => ({
            repository: entry.repository,
            codex: {
              model: entry.model,
              reasoningEffort: entry.reasoningEffort,
            },
          })),
          codexSlots: options.slots,
          pollIntervalMs: options.pollIntervalMs,
        },
      };
    });

  const shutdown = (): Effect.Effect<void> =>
    Fiber.interruptAll(Array.from(inFlight));

  return {
    runNextEligibleIssue,
    startIssue,
    getSnapshot,
    processAssignment,
    shutdown,
  } as const;
}
