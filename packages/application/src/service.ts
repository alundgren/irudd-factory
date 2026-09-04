import type {
  Assignment,
  CommandReceipt,
  FactorySnapshot,
  NormalizedError,
  PageRequest,
  LifecycleCommand,
  LifecycleCommandKind,
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
import type { PullRequestLookupOutcome } from "./ports.ts";
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
  readonly access?: string;
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
  const inFlight = new Map<string, Fiber.RuntimeFiber<void, never>>();
  const lifecycleInFlight = new Set<string>();

  const trackAssignment = (
    assignmentId: string,
    fiber: Fiber.RuntimeFiber<void, never>,
  ) => {
    inFlight.set(assignmentId, fiber);
    fiber.addObserver(() => inFlight.delete(assignmentId));
  };

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
            .pipe(
              Effect.zipRight(
                event.records && event.records.length > 0
                  ? state.appendProviderRecords(withWorkspace.id, event.records)
                  : Effect.void,
              ),
            ),
        (records) => state.appendProviderRecords(withWorkspace.id, records),
      );
      if (result.records && result.records.length > 0) {
        yield* state.appendProviderRecords(withWorkspace.id, result.records);
      }
      yield* state.appendEvent(
        withWorkspace.id,
        {
          type: ASSIGNMENT_EVENTS.providerTurnFinished,
          timestamp: clock.now(),
          detail: {
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
        trackAssignment(receipt.result.assignment.id, fiber);
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
      trackAssignment("dispatcher", fiber);
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
          ...(options.access ? { access: options.access } : {}),
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
    Fiber.interruptAll(Array.from(inFlight.values()));

  const readIssues = (page: PageRequest) =>
    Effect.gen(function* () {
      return yield* (yield* StateStore).readIssues(page);
    });
  const readAttempts = (page: PageRequest) =>
    Effect.gen(function* () {
      return yield* (yield* StateStore).readAttempts(page);
    });
  const readAttempt = (attemptId: string) =>
    Effect.gen(function* () {
      return yield* (yield* StateStore).getAssignment(attemptId);
    });
  const readTranscript = (attemptId: string, page: PageRequest) =>
    Effect.gen(function* () {
      return yield* (yield* StateStore).readTranscript(attemptId, page);
    });
  const readEvents = (attemptId: string, page: PageRequest) =>
    Effect.gen(function* () {
      return yield* (yield* StateStore).readEvents(attemptId, page);
    });
  const readUsage = (page: PageRequest) =>
    Effect.gen(function* () {
      return yield* (yield* StateStore).readUsage(page);
    });
  const readTimeline = (page: PageRequest) =>
    Effect.gen(function* () {
      return yield* (yield* StateStore).readTimeline(page);
    });
  const getOperationsOverview = () =>
    Effect.gen(function* () {
      return yield* (yield* StateStore).getOperationsOverview();
    });
  const readLifecycleCommands = (page: PageRequest) =>
    Effect.gen(function* () {
      return yield* (yield* StateStore).readLifecycleCommands(page);
    });

  const finishLifecycleFailure = (
    commandId: string,
    error: unknown,
  ): Effect.Effect<LifecycleCommand, FactoryError, StateStore | Clock> =>
    Effect.gen(function* () {
      const state = yield* StateStore;
      const clock = yield* Clock;
      const normalized = failure("unexpected_error", error);
      return yield* state.finishLifecycleCommand(
        commandId,
        {
          _tag: "rejected",
          code: normalized.code,
          message: normalized.message,
        },
        clock.now(),
      );
    });

  const executeLifecycleCommand = (command: LifecycleCommand) =>
    Effect.gen(function* () {
      const state = yield* StateStore;
      const github = yield* GitHub;
      const clock = yield* Clock;
      const ids = yield* IdGenerator;
      const attempt = yield* state.getAssignment(command.targetAttemptId);
      if (!attempt) {
        return yield* state.finishLifecycleCommand(
          command.commandId,
          {
            _tag: "rejected",
            code: "assignment_not_found",
            message: `Assignment ${command.targetAttemptId} was not found`,
          },
          clock.now(),
        );
      }

      // Polling owns eligibility observations. Commands only read them and
      // continue with their command-specific validation.
      yield* state.getLatestEligibilityObservation(attempt.id);

      if (command.kind === "stop") {
        if (command.effect.startsWith("process_resolved:")) {
          const recorded = command.effect.slice("process_resolved:".length);
          if (recorded === "uncertain") {
            return yield* state.finishLifecycleCommand(
              command.commandId,
              { _tag: "stop_uncertain" },
              clock.now(),
              {
                state: "stop_uncertain",
                error: {
                  code: "process_identity_changed",
                  message: "Provider process exit could not be confirmed",
                },
              },
            );
          }
          const processResult =
            recorded === "terminated" ? "terminated" : "exited";
          return yield* state.finishLifecycleCommand(
            command.commandId,
            { _tag: "stopped", processResult },
            clock.now(),
            {
              state: "stopped",
              processGroupId: null,
              processStartIdentity: null,
              processStartPending: false,
            },
          );
        }
        yield* state.markLifecycleCommandExecuting(
          command.commandId,
          "process_interrupting",
          clock.now(),
        );
        const fiber = inFlight.get(attempt.id);
        if (fiber) yield* Fiber.interrupt(fiber);
        const processResult = yield* state.reconcileAttemptProcess(attempt.id);
        yield* state.markLifecycleCommandExecuting(
          command.commandId,
          `process_resolved:${processResult}`,
          clock.now(),
        );
        return processResult === "uncertain"
          ? yield* state.finishLifecycleCommand(
              command.commandId,
              { _tag: "stop_uncertain" },
              clock.now(),
              {
                state: "stop_uncertain",
                error: {
                  code: "process_identity_changed",
                  message: "Provider process exit could not be confirmed",
                },
              },
            )
          : yield* state.finishLifecycleCommand(
              command.commandId,
              { _tag: "stopped", processResult },
              clock.now(),
              {
                state: "stopped",
                processGroupId: null,
                processStartIdentity: null,
                processStartPending: false,
              },
            );
      }

      if (command.kind === "return") {
        if (!github.inspectClaim || !github.removeClaim) {
          return yield* finishLifecycleFailure(
            command.commandId,
            new FactoryError({
              code: "github_command_invalid",
              message: "The GitHub adapter does not support returning attempts",
            }),
          );
        }
        const labelMutationStarted =
          command.effect === "label_removing" ||
          command.effect === "label_removed";
        if (!labelMutationStarted && command.effect !== "pull_request_absent") {
          yield* state.markLifecycleCommandExecuting(
            command.commandId,
            "pull_request_inspecting",
            clock.now(),
          );
          let pullRequestEvidence: PullRequestLookupOutcome;
          if (!attempt.workspace) {
            pullRequestEvidence = { _tag: "absent" };
          } else if (!github.inspectAttemptPullRequest) {
            pullRequestEvidence = { _tag: "unknown" };
          } else {
            const lookup = yield* Effect.either(
              github.inspectAttemptPullRequest(
                attempt.issue.repository,
                attempt.workspace.branch,
              ),
            );
            pullRequestEvidence =
              lookup._tag === "Right" ? lookup.right : { _tag: "unknown" };
          }
          if (pullRequestEvidence._tag === "present") {
            return yield* state.finishLifecycleCommand(
              command.commandId,
              {
                _tag: "rejected",
                code: "pull_request_present",
                message: `Attempt ${attempt.id} has pull request ${pullRequestEvidence.pullRequest.url}`,
              },
              clock.now(),
            );
          }
          if (pullRequestEvidence._tag === "unknown") {
            return yield* state.finishLifecycleCommand(
              command.commandId,
              {
                _tag: "rejected",
                code: "pull_request_presence_unknown",
                message: `Pull request absence could not be confirmed for attempt ${attempt.id}`,
              },
              clock.now(),
            );
          }
          yield* state.markLifecycleCommandExecuting(
            command.commandId,
            "pull_request_absent",
            clock.now(),
          );
        }
        if (command.effect !== "label_removed") {
          yield* state.markLifecycleCommandExecuting(
            command.commandId,
            "label_removing",
            clock.now(),
          );
          let claim = yield* github.inspectClaim(attempt.issue);
          if (claim !== "unclaimed")
            claim = yield* github.removeClaim(attempt.issue);
          if (claim !== "unclaimed") {
            return yield* finishLifecycleFailure(
              command.commandId,
              new FactoryError({
                code:
                  claim === "confirmed" ? "claim_unconfirmed" : "claim_unknown",
                message:
                  claim === "confirmed"
                    ? "GitHub still reports the claimed label"
                    : "GitHub claim removal could not be confirmed",
              }),
            );
          }
          yield* state.markLifecycleCommandExecuting(
            command.commandId,
            "label_removed",
            clock.now(),
          );
        }
        return yield* state.finishLifecycleCommand(
          command.commandId,
          { _tag: "returned", claimedRemoved: true },
          clock.now(),
        );
      }

      if (command.kind === "restart") {
        const existingRestart = yield* state.getReceipt(
          `lifecycle:${command.commandId}`,
        );
        if (existingRestart?.result._tag === "started") {
          const sibling = existingRestart.result.assignment;
          yield* state.markLifecycleCommandExecuting(
            command.commandId,
            "sibling_reserved",
            clock.now(),
          );
          const fiber = yield* processAssignment(sibling).pipe(
            Effect.forkDaemon,
          );
          trackAssignment(sibling.id, fiber);
          const completed = yield* state.finishLifecycleCommand(
            command.commandId,
            { _tag: "restarted", siblingAttemptId: sibling.id },
            clock.now(),
          );
          return completed;
        }
        if (existingRestart) {
          return yield* state.finishLifecycleCommand(
            command.commandId,
            {
              _tag: "rejected",
              code: existingRestart.result._tag,
              message: "Restart could not reserve a Codex slot",
            },
            clock.now(),
          );
        }
        if (!github.revalidateClaimedIssue) {
          return yield* finishLifecycleFailure(
            command.commandId,
            new FactoryError({
              code: "github_command_invalid",
              message:
                "The GitHub adapter does not support restarting attempts",
            }),
          );
        }
        yield* state.markLifecycleCommandExecuting(
          command.commandId,
          "issue_revalidating",
          clock.now(),
        );
        const validated = yield* github
          .revalidateClaimedIssue(attempt.issue)
          .pipe(
            Effect.catchAll((error) =>
              finishLifecycleFailure(command.commandId, error),
            ),
          );
        if ("phase" in validated) return validated;
        yield* state.markLifecycleCommandExecuting(
          command.commandId,
          "issue_validated",
          clock.now(),
        );
        const settings = options.repositories.find(
          ({ repository }) =>
            repository === attempt.issue.repository.toLowerCase(),
        );
        if (!settings) {
          return yield* finishLifecycleFailure(
            command.commandId,
            new FactoryError({
              code: "repository_not_configured",
              message: `Repository ${attempt.issue.repository} is not configured`,
            }),
          );
        }
        const admission = yield* state.admit({
          commandId: `lifecycle:${command.commandId}`,
          provider: options.provider,
          candidates: [
            {
              ...validated,
              requestedModel: settings.model,
              requestedEffort: settings.reasoningEffort,
            },
          ],
          assignmentId: ids.assignmentId(),
          timestamp: clock.now(),
          slots: options.slots,
          allowRetry: true,
          source: "manual",
        });
        if (admission.receipt.result._tag !== "started") {
          return yield* state.finishLifecycleCommand(
            command.commandId,
            {
              _tag: "rejected",
              code: admission.receipt.result._tag,
              message: "Restart could not reserve a Codex slot",
            },
            clock.now(),
          );
        }
        const sibling = admission.receipt.result.assignment;
        yield* state.markLifecycleCommandExecuting(
          command.commandId,
          "sibling_reserved",
          clock.now(),
        );
        const fiber = yield* processAssignment(sibling).pipe(Effect.forkDaemon);
        trackAssignment(sibling.id, fiber);
        const completed = yield* state.finishLifecycleCommand(
          command.commandId,
          { _tag: "restarted", siblingAttemptId: sibling.id },
          clock.now(),
        );
        return completed;
      }

      yield* state.markLifecycleCommandExecuting(
        command.commandId,
        "visibility_updating",
        clock.now(),
      );
      return command.kind === "archive"
        ? yield* state.finishLifecycleCommand(
            command.commandId,
            { _tag: "archived" },
            clock.now(),
            { archivedAt: clock.now() },
          )
        : yield* state.finishLifecycleCommand(
            command.commandId,
            { _tag: "restored" },
            clock.now(),
            { archivedAt: null },
          );
    });

  const controlAttempt = (
    commandId: string,
    kind: LifecycleCommandKind,
    attemptId: string,
    expectedTargetVersion: number,
  ) =>
    Effect.gen(function* () {
      const state = yield* StateStore;
      const clock = yield* Clock;
      const target = yield* state.getAssignment(attemptId);
      const current = yield* state.beginLifecycleCommand({
        commandId,
        kind,
        targetAttemptId: attemptId,
        expectedTargetVersion,
        repositoryConfigured: options.repositories.some(
          ({ repository }) =>
            repository === target?.issue.repository.toLowerCase(),
        ),
        timestamp: clock.now(),
      });
      if (current.command.phase === "final") return current.command;
      if (lifecycleInFlight.has(current.command.commandId)) {
        return current.command;
      }
      lifecycleInFlight.add(current.command.commandId);
      return yield* executeLifecycleCommand(current.command).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            lifecycleInFlight.delete(current.command.commandId);
          }),
        ),
      );
    });

  const recoverInterruptedAttempts = () =>
    Effect.gen(function* () {
      const state = yield* StateStore;
      const github = yield* GitHub;
      const clock = yield* Clock;
      const lifecycleCommands = yield* state.unfinishedLifecycleCommands();
      for (const command of lifecycleCommands) {
        lifecycleInFlight.add(command.commandId);
        yield* executeLifecycleCommand(command).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              lifecycleInFlight.delete(command.commandId);
            }),
          ),
        );
      }
      const unfinished = yield* state.unfinishedPullRequestLookups();
      for (const attempt of unfinished) {
        yield* state.appendEvent(attempt.id, {
          type: ASSIGNMENT_EVENTS.pullRequestReconciled,
          timestamp: clock.now(),
          detail: { evidence: "unknown" },
        });
      }
      const candidates = yield* state.pullRequestRecoveryCandidates();
      for (const attempt of candidates) {
        const workspace = attempt.workspace;
        if (!workspace) continue;
        yield* state.appendEvent(attempt.id, {
          type: ASSIGNMENT_EVENTS.pullRequestLookupStarted,
          timestamp: clock.now(),
          detail: {},
        });
        let pullRequest = null;
        let evidence = "unknown";
        if (github.lookupPullRequest) {
          const lookup = yield* Effect.either(
            github.lookupPullRequest(
              attempt.issue.repository,
              workspace.branch,
              attempt.issue.number,
            ),
          );
          if (lookup._tag === "Right") {
            evidence = lookup.right._tag;
            if (lookup.right._tag === "present") {
              pullRequest = lookup.right.pullRequest;
            }
          }
        }
        yield* state.appendEvent(
          attempt.id,
          {
            type: ASSIGNMENT_EVENTS.pullRequestReconciled,
            timestamp: clock.now(),
            detail: pullRequest
              ? { evidence: "verified", pullRequestUrl: pullRequest.url }
              : { evidence },
          },
          pullRequest ? { pullRequest } : {},
        );
      }
    });

  return {
    runNextEligibleIssue,
    startIssue,
    getSnapshot,
    listQueue,
    setDispatchPaused,
    setCodexEnabled,
    pollAndDispatch,
    startDispatcher,
    recoverInterruptedAttempts,
    readIssues,
    readAttempts,
    readAttempt,
    readTranscript,
    readEvents,
    readUsage,
    readTimeline,
    getOperationsOverview,
    readLifecycleCommands,
    controlAttempt,
    processAssignment,
    shutdown,
  } as const;
}
