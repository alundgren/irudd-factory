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

      yield* github.revalidateIssue({
        issue: initial.issue,
        workflow: initial.workflow,
      });
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
          const current = yield* state.getAssignment(initial.id);
          const ownershipUncertain =
            current?.state === "ownership_uncertain" ||
            normalized.detail === "cleanup_timeout" ||
            (current?.processStartPending === true &&
              normalized.code === "process_identity_changed");
          yield* state.appendEvent(
            initial.id,
            {
              type: ASSIGNMENT_EVENTS.failed,
              timestamp: clock.now(),
              detail: { code: normalized.code, message: normalized.message },
            },
            {
              state: ownershipUncertain ? "ownership_uncertain" : "failed",
              error: normalized,
              processStartPending: ownershipUncertain
                ? (current?.processStartPending ?? true)
                : false,
            },
          );
        }).pipe(Effect.catchAll(() => Effect.void)),
      ),
    );

  const admitCandidates = (
    commandId: string,
    candidates: ReadonlyArray<import("./ports.ts").Candidate>,
    allowRetry = false,
    queueTenureId?: string,
    source: "manual" | "automatic" = "manual",
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
      const configuredCandidates = yield* Effect.forEach(
        candidates,
        (candidate) => {
          const settings = options.repositories.find(
            ({ repository }) =>
              repository === candidate.issue.repository.toLowerCase(),
          );
          return settings
            ? Effect.succeed({
                ...candidate,
                requestedModel: settings.model,
                requestedEffort: settings.reasoningEffort,
              })
            : Effect.fail(
                new FactoryError({
                  code: "repository_not_configured",
                  message: `Repository ${candidate.issue.repository} is not configured`,
                }),
              );
        },
      );
      const admission = yield* state.admit({
        commandId,
        provider: options.provider,
        candidates: configuredCandidates,
        assignmentId: ids.assignmentId(),
        timestamp: clock.now(),
        slots: options.slots,
        allowRetry,
        ...(queueTenureId ? { queueTenureId } : {}),
        source,
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

  const observeRepositories = () =>
    Effect.gen(function* () {
      const state = yield* StateStore;
      const github = yield* GitHub;
      const clock = yield* Clock;
      const timestamp = clock.now();
      yield* state.endQueueTenuresOutsideRepositories(
        options.repositories.map(({ repository }) => repository),
        timestamp,
      );
      yield* Effect.forEach(
        options.repositories,
        ({ repository }) =>
          github.discoverCandidates(repository).pipe(
            Effect.flatMap((candidates) =>
              state.reconcileQueue({
                repository,
                candidates: candidates.map((candidate) => ({ candidate })),
                timestamp,
              }),
            ),
            Effect.catchAll(() => Effect.void),
          ),
        { concurrency: "unbounded" },
      );
    });

  const dispatchQueue = () =>
    Effect.gen(function* () {
      const state = yield* StateStore;
      const github = yield* GitHub;
      const clock = yield* Clock;
      const controls = yield* state.getDispatchState();
      if (controls.paused || !controls.codexEnabled) return;

      while (true) {
        const queued = yield* state.getDispatchableQueue(100);
        if (queued.length === 0) return;
        for (const queuedCandidate of queued) {
          const current = yield* github
            .revalidateIssue(queuedCandidate)
            .pipe(Effect.either);
          if (current._tag === "Left") {
            if (current.left.code !== "issue_ineligible") return;
            const reason = failure("issue_ineligible", current.left);
            yield* state.markQueueTenureIneligible(
              queuedCandidate.tenureId,
              clock.now(),
              { code: reason.code, message: reason.message },
            );
            continue;
          }
          const receipt = yield* admitCandidates(
            `automatic:${queuedCandidate.tenureId}`,
            [current.right],
            true,
            queuedCandidate.tenureId,
            "automatic",
          );
          if (receipt.result._tag === "provider_busy") {
            return;
          }
          if (receipt.result._tag === "no_candidate") {
            yield* state.endQueueTenure(queuedCandidate.tenureId, clock.now(), {
              code: "admission_rejected",
              message: "This issue could not reserve a Codex slot",
            });
          }
        }
      }
    });

  const pollAndDispatch = () =>
    observeRepositories().pipe(Effect.zipRight(dispatchQueue()));

  const startDispatcher = () =>
    Effect.gen(function* () {
      const state = yield* StateStore;
      const clock = yield* Clock;
      yield* state.endQueueTenuresOutsideRepositories(
        options.repositories.map(({ repository }) => repository),
        clock.now(),
      );
      const fiber = yield* Effect.sleep(options.pollIntervalMs).pipe(
        Effect.zipRight(
          pollAndDispatch().pipe(Effect.catchAll(() => Effect.void)),
        ),
        Effect.forever,
        Effect.forkDaemon,
      );
      inFlight.add(fiber);
      fiber.addObserver(() => inFlight.delete(fiber));
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
      const queueTenureId =
        candidates.length === 1 && candidates[0]
          ? yield* state.getActiveQueueTenureId(candidates[0].issue.nodeId)
          : null;
      return yield* admitCandidates(
        commandId,
        candidates,
        false,
        queueTenureId ?? undefined,
      );
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
      const current = yield* github.revalidateIssue(candidate);
      const queueTenureId = yield* state.getActiveQueueTenureId(
        current.issue.nodeId,
      );
      return yield* admitCandidates(
        commandId,
        [current],
        true,
        queueTenureId ?? undefined,
      );
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

  const listQueue = (input: {
    readonly limit: number;
    readonly cursor?: string;
    readonly watermark?: string;
  }) =>
    Effect.gen(function* () {
      const state = yield* StateStore;
      return yield* state.listQueue(input);
    });

  const setDispatchPaused = (paused: boolean) =>
    Effect.gen(function* () {
      const state = yield* StateStore;
      const clock = yield* Clock;
      const next = yield* state.setDispatchPaused(paused, clock.now());
      if (!paused) yield* dispatchQueue();
      return next;
    });

  const setCodexEnabled = (enabled: boolean) =>
    Effect.gen(function* () {
      const state = yield* StateStore;
      const clock = yield* Clock;
      const next = yield* state.setCodexEnabled(enabled, clock.now());
      if (enabled) yield* dispatchQueue();
      return next;
    });

  const shutdown = (): Effect.Effect<void> =>
    Fiber.interruptAll(Array.from(inFlight));

  return {
    runNextEligibleIssue,
    startIssue,
    getSnapshot,
    listQueue,
    setDispatchPaused,
    setCodexEnabled,
    pollAndDispatch,
    startDispatcher,
    processAssignment,
    shutdown,
  } as const;
}
