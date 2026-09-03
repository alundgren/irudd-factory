import type {
  Candidate,
  GitHubService,
  ProviderService,
  WorkspaceService,
} from "@irudd-factory/application";
import {
  Clock,
  FactoryError,
  GitHub,
  IdGenerator,
  Provider,
  StateStore,
  Workspaces,
} from "@irudd-factory/application";
import { ASSIGNMENT_EVENTS } from "@irudd-factory/contracts";
import { layerStateStore } from "@irudd-factory/state-sqlite";
import { Effect, Layer } from "effect";
import type { FactoryConfig } from "../src/config.ts";
import type { FactoryDependencies } from "../src/service.ts";
import type { FixtureControls, FixtureDefinition } from "./types.ts";

function replaceAssignmentId(value: string, assignmentId: string): string {
  return value.replace("{assignmentId}", assignmentId);
}

export function seedFixture(fixture: FixtureDefinition) {
  return Effect.gen(function* () {
    const store = yield* StateStore;
    yield* store.reset();
    if (fixture.state.assignment) {
      yield* store.seedAssignment(
        fixture.state.assignment,
        fixture.state.events,
      );
    }
    if (fixture.state.queue) {
      const repositories = new Map<
        string,
        typeof fixture.state.queue.candidates
      >();
      for (const issue of fixture.state.queue.candidates) {
        repositories.set(issue.repository, [
          ...(repositories.get(issue.repository) ?? []),
          issue,
        ]);
      }
      for (const [repository, issues] of repositories) {
        yield* store.reconcileQueue({
          repository,
          candidates: issues.map((issue, index) => ({
            tenureId: `fixture-tenure-${repository.replace("/", "-")}-${index + 1}`,
            candidate: {
              issue,
              workflow: fixture.behavior.candidateWorkflow,
            },
          })),
          timestamp: fixture.state.now,
        });
      }
      if (fixture.state.queue.stale) {
        const tenures = yield* store.getDispatchableQueue(100);
        for (const tenure of tenures) {
          yield* store.rejectQueueTenure(tenure.tenureId, fixture.state.now, {
            code: "issue_ineligible",
            message: "Fresh validation rejected this fixture issue",
          });
        }
      }
    }
    if (fixture.state.dispatch) {
      yield* store.setDispatchPaused(
        fixture.state.dispatch.paused,
        fixture.state.now,
      );
      yield* store.setCodexEnabled(
        fixture.state.dispatch.codexEnabled,
        fixture.state.now,
      );
    }
  });
}

export function fixtureDependencies(
  config: FactoryConfig,
  fixture: FixtureDefinition,
  controls: FixtureControls = {},
): FactoryDependencies {
  let assignmentSequence = 0;
  const claimedNodes = new Set<string>();
  const candidates: Candidate[] = fixture.state.candidates.map((issue) => ({
    issue,
    workflow: fixture.behavior.candidateWorkflow,
  }));
  const github: GitHubService = {
    discoverCandidates: (repository) =>
      Effect.succeed(
        candidates.filter(
          (candidate) =>
            candidate.issue.repository === repository &&
            (!controls.hideClaimedCandidates ||
              !claimedNodes.has(candidate.issue.nodeId)),
        ),
      ),
    revalidateIssue: (candidate) =>
      Effect.gen(function* () {
        controls.onRevalidate?.();
        if (controls.revalidateFailure) {
          return yield* Effect.fail(
            new FactoryError({
              code: "issue_ineligible",
              message: controls.revalidateFailure,
            }),
          );
        }
        return candidate;
      }),
    claimIssue: (issue) =>
      Effect.sync(() => {
        controls.onClaim?.();
        if (controls.hideClaimedCandidates) claimedNodes.add(issue.nodeId);
        return fixture.behavior.claimOutcome;
      }),
    verifyPullRequest: () => Effect.succeed(fixture.behavior.pullRequest),
  };
  const workspaces: WorkspaceService = {
    create: ({ assignmentId }) =>
      Effect.sync(() => {
        controls.onWorkspace?.();
        const workspace = fixture.behavior.workspace;
        return {
          clonePath: replaceAssignmentId(workspace.clonePath, assignmentId),
          worktreePath: replaceAssignmentId(
            workspace.worktreePath,
            assignmentId,
          ),
          worktreeGitDir: replaceAssignmentId(
            workspace.worktreeGitDir,
            assignmentId,
          ),
          commonGitDir: replaceAssignmentId(
            workspace.commonGitDir,
            assignmentId,
          ),
          branch: replaceAssignmentId(workspace.branch, assignmentId),
        };
      }),
  };
  const provider: ProviderService = {
    run: (input, emit) =>
      Effect.gen(function* () {
        controls.onProviderRun?.();
        if (controls.cleanupUncertain) {
          yield* emit({
            type: ASSIGNMENT_EVENTS.providerFailed,
            timestamp: fixture.state.now,
            detail: { processExit: { cleanupTimedOut: true } },
            patch: { state: "ownership_uncertain" },
          });
          return yield* Effect.fail(
            new FactoryError({
              code: "cleanup_timeout",
              message: "Fixture could not confirm provider exit",
            }),
          );
        }
        if (controls.failAfterObservation) {
          const observed = controls.failAfterObservation;
          yield* emit({
            type: ASSIGNMENT_EVENTS.providerSettingsObserved,
            timestamp: fixture.state.now,
            detail: {
              ...(observed.model ? { observedModel: observed.model } : {}),
              ...(observed.effort ? { observedEffort: observed.effort } : {}),
            },
            patch: {
              ...(observed.model ? { observedModel: observed.model } : {}),
              ...(observed.effort ? { observedEffort: observed.effort } : {}),
            },
          });
          return yield* Effect.fail(
            new FactoryError({
              code: "observed_model_mismatch",
              message: "Fixture observed a provider mismatch",
            }),
          );
        }
        yield* controls.beforeRunning
          ? Effect.promise(controls.beforeRunning)
          : Effect.sleep(`${fixture.behavior.provider.runningDelayMs} millis`);
        yield* emit({
          type: ASSIGNMENT_EVENTS.providerThreadStarted,
          timestamp: fixture.state.now,
          detail: { threadId: fixture.behavior.provider.result.threadId },
          patch: {
            state: "running",
            codexVersion: fixture.behavior.provider.result.codexVersion,
            threadId: fixture.behavior.provider.result.threadId,
            observedModel: input.assignment.requestedModel,
            observedEffort: input.assignment.requestedEffort,
          },
        });
        yield* controls.beforeCompletion
          ? Effect.promise(() =>
              controls.beforeCompletion!(input.assignment.issue.number),
            )
          : Effect.sleep(
              `${fixture.behavior.provider.completionDelayMs} millis`,
            );
        return {
          ...fixture.behavior.provider.result,
          observedModel: input.assignment.requestedModel,
          observedEffort: input.assignment.requestedEffort,
        };
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => controls.onProviderInterrupted?.()),
        ),
      ),
  };
  return Layer.mergeAll(
    layerStateStore(config.databasePath, { recover: false }),
    Layer.succeed(GitHub, github),
    Layer.succeed(Workspaces, workspaces),
    Layer.succeed(Provider, provider),
    Layer.succeed(Clock, { now: () => fixture.state.now }),
    Layer.succeed(IdGenerator, {
      assignmentId: () =>
        `assignment-${fixture.name}-${(assignmentSequence += 1)}`,
    }),
  );
}
