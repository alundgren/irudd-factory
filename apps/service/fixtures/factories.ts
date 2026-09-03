import type {
  Assignment,
  AssignmentEvent,
  IssueRef,
} from "@irudd-factory/contracts";
import { CODEX_PROVIDER } from "@irudd-factory/application";
import type { FixtureBehavior, FixtureState } from "./types.ts";

export const FIXTURE_NOW = "2026-01-15T12:00:00.000Z";
export const FIXTURE_MODEL = "gpt-5.6-luna";
export const FIXTURE_EFFORT = "low";
export const FIXTURE_REPOSITORY = "factory/fixture";

export const FIXTURE_WORKFLOW = {
  startingCommit: "a".repeat(40),
  blobId: "b".repeat(40),
  digest: "c".repeat(64),
  body: "Implement the requested issue and run the repository tests.",
};

export function fixtureIssue(number: number): IssueRef {
  return {
    nodeId: `I_fixture_${number}`,
    repository: FIXTURE_REPOSITORY,
    number,
    url: `https://github.com/${FIXTURE_REPOSITORY}/issues/${number}`,
    title: `Fixture issue ${number}`,
  };
}

export function fixtureAssignment(
  state: Assignment["state"],
  options: { readonly draft?: boolean; readonly longError?: boolean } = {},
): Assignment {
  const terminal = state === "completed" || state === "failed";
  return {
    id: `assignment-${state}`,
    provider: CODEX_PROVIDER,
    issue: fixtureIssue(20),
    state,
    workflow: FIXTURE_WORKFLOW,
    workspace: terminal
      ? {
          clonePath: "/tmp/factory/clones/factory-fixture",
          worktreePath: `/tmp/factory/worktrees/assignment-${state}`,
          worktreeGitDir: `/tmp/factory/clones/factory-fixture/.git/worktrees/assignment-${state}`,
          commonGitDir: "/tmp/factory/clones/factory-fixture/.git",
          branch: `factory/assignment-${state}`,
        }
      : null,
    requestedModel: FIXTURE_MODEL,
    requestedEffort: FIXTURE_EFFORT,
    observedModel: terminal ? FIXTURE_MODEL : null,
    observedEffort: terminal ? FIXTURE_EFFORT : null,
    codexVersion: terminal ? "codex-cli 0.147.0" : null,
    threadId: terminal ? "thread-fixture" : null,
    turnId: terminal ? "turn-fixture" : null,
    processGroupId: null,
    processStartIdentity: null,
    pullRequest:
      state === "completed"
        ? {
            url: "https://github.com/factory/fixture/pull/21",
            number: 21,
            draft: options.draft ?? false,
          }
        : null,
    error:
      state === "failed"
        ? {
            code: "provider_failed",
            message: options.longError
              ? "The provider failed after initialization.\n\nThe complete diagnostic remains visible so an operator can distinguish the primary failure from cleanup details. ".repeat(
                  8,
                )
              : "The provider failed",
          }
        : null,
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    lastEventSequence: 1,
  };
}

export function emptyState(
  candidates: ReadonlyArray<IssueRef> = [],
): FixtureState {
  return { now: FIXTURE_NOW, candidates, assignment: null, events: [] };
}

export function assignedState(
  state: Assignment["state"],
  candidates: ReadonlyArray<IssueRef>,
  options: { readonly draft?: boolean; readonly longError?: boolean } = {},
): FixtureState {
  const assignment = fixtureAssignment(state, options);
  const events: ReadonlyArray<Omit<AssignmentEvent, "sequence">> = [
    {
      assignmentId: assignment.id,
      type: `fixture.${state}`,
      timestamp: FIXTURE_NOW,
      detail: {},
    },
  ];
  return {
    now: FIXTURE_NOW,
    candidates,
    assignment,
    events,
  };
}

export function defaultBehavior(): FixtureBehavior {
  return {
    candidateWorkflow: {
      ...FIXTURE_WORKFLOW,
      body: "Implement the fixture issue and run its tests.",
    },
    claimOutcome: "confirmed",
    workspace: {
      clonePath: "/fixture/clones/factory--fixture",
      worktreePath: "/fixture/worktrees/{assignmentId}",
      worktreeGitDir:
        "/fixture/clones/factory--fixture/.git/worktrees/{assignmentId}",
      commonGitDir: "/fixture/clones/factory--fixture/.git",
      branch: "factory/{assignmentId}",
    },
    pullRequest: {
      url: "https://github.com/factory/fixture/pull/99",
      number: 99,
      draft: false,
    },
    provider: {
      runningDelayMs: 300,
      completionDelayMs: 700,
      result: {
        codexVersion: "codex-cli fixture",
        threadId: "thread-runnable",
        turnId: "turn-runnable",
        observedModel: FIXTURE_MODEL,
        observedEffort: FIXTURE_EFFORT,
        finalResponse: "Opened the fixture pull request.",
        itemSummaries: [{ id: "item-1", type: "agentMessage" }],
        tokenUsage: {
          total: {
            inputTokens: 10,
            cachedInputTokens: 0,
            outputTokens: 5,
            reasoningOutputTokens: 0,
            totalTokens: 15,
          },
          last: {
            inputTokens: 10,
            cachedInputTokens: 0,
            outputTokens: 5,
            reasoningOutputTokens: 0,
            totalTokens: 15,
          },
          modelContextWindow: null,
        },
        approvalCount: 0,
        processExit: { code: 0, signal: "SIGTERM" },
      },
    },
  };
}
