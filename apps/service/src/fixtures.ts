import type {
  Candidate,
  GitHubService,
  ProviderService,
  WorkspaceService,
} from "@irudd-factory/application";
import {
  Clock,
  GitHub,
  IdGenerator,
  Provider,
  SCENARIOS,
  type ScenarioName,
  Workspaces,
} from "@irudd-factory/application";
import { Layer } from "effect";
import { Effect } from "effect";
import { layerStateStore } from "@irudd-factory/state-sqlite";
import type { FactoryConfig } from "./config.ts";
import type { FactoryDependencies } from "./service.ts";

export function fixtureDependencies(
  config: FactoryConfig,
  scenarioName: ScenarioName,
): FactoryDependencies {
  const scenario = SCENARIOS[scenarioName];
  const workflow = {
    startingCommit: "a".repeat(40),
    blobId: "b".repeat(40),
    digest: "c".repeat(64),
    body: "Implement the fixture issue and run its tests.",
  };
  const candidates: Candidate[] = scenario.candidates.map((issue) => ({
    issue,
    workflow,
  }));
  const github: GitHubService = {
    discoverCandidates: () => Effect.succeed(candidates),
    claimIssue: () => Effect.succeed("confirmed"),
    verifyPullRequest: () =>
      Effect.succeed({
        url: "https://github.com/factory/fixture/pull/99",
        number: 99,
        draft: false,
      }),
  };
  const workspaces: WorkspaceService = {
    create: ({ assignmentId }) =>
      Effect.succeed({
        clonePath: "/fixture/clones/factory--fixture",
        worktreePath: `/fixture/worktrees/${assignmentId}`,
        worktreeGitDir: `/fixture/clones/factory--fixture/.git/worktrees/${assignmentId}`,
        commonGitDir: "/fixture/clones/factory--fixture/.git",
        branch: `factory/${assignmentId}`,
      }),
  };
  const provider: ProviderService = {
    run: (_input, emit) =>
      Effect.gen(function* () {
        yield* Effect.sleep("300 millis");
        yield* emit({
          type: "provider.thread.started",
          timestamp: scenario.now,
          detail: { threadId: "thread-runnable" },
          patch: {
            state: "running",
            codexVersion: "codex-cli fixture",
            threadId: "thread-runnable",
            observedModel: config.codex.model,
            observedEffort: config.codex.reasoningEffort,
          },
        });
        yield* Effect.sleep("700 millis");
        return {
          codexVersion: "codex-cli fixture",
          threadId: "thread-runnable",
          turnId: "turn-runnable",
          observedModel: config.codex.model,
          observedEffort: config.codex.reasoningEffort,
          finalResponse: "Opened the fixture pull request.",
          itemSummaries: [{ id: "item-1", type: "agentMessage" }],
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
          approvalCount: 0,
          processExit: { code: 0, signal: "SIGTERM" },
        };
      }),
  };
  return Layer.mergeAll(
    layerStateStore(config.databasePath),
    Layer.succeed(GitHub, github),
    Layer.succeed(Workspaces, workspaces),
    Layer.succeed(Provider, provider),
    Layer.succeed(Clock, { now: () => scenario.now }),
    Layer.succeed(IdGenerator, {
      assignmentId: () => `assignment-${scenarioName}`,
    }),
  );
}
