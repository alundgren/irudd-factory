import type {
  Assignment,
  AssignmentEvent,
  CommandResult,
  IssueRef,
} from "@irudd-factory/contracts";
import { Effect } from "effect";
import { StateStore } from "./ports.ts";

export const SCENARIO_NAMES = [
  "empty",
  "ambiguous",
  "busy-reserved",
  "busy-starting",
  "busy-running",
  "runnable",
  "failed-long",
  "completed-ready",
  "completed-draft",
] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

export interface ScenarioDefinition {
  readonly name: ScenarioName;
  readonly now: string;
  readonly candidates: ReadonlyArray<IssueRef>;
  readonly assignment: Assignment | null;
  readonly events: ReadonlyArray<Omit<AssignmentEvent, "sequence">>;
  readonly expectedResult: CommandResult["_tag"] | "projection_only";
}

const now = "2026-01-15T12:00:00.000Z";
const workflow = {
  startingCommit: "a".repeat(40),
  blobId: "b".repeat(40),
  digest: "c".repeat(64),
  body: "Implement the requested issue and run the repository tests.",
};

function issue(number: number): IssueRef {
  return {
    nodeId: `I_fixture_${number}`,
    repository: "factory/fixture",
    number,
    url: `https://github.com/factory/fixture/issues/${number}`,
    title: `Fixture issue ${number}`,
  };
}

function assignment(
  state: Assignment["state"],
  options: { readonly draft?: boolean; readonly longError?: boolean } = {},
): Assignment {
  const terminal = state === "completed" || state === "failed";
  return {
    id: `assignment-${state}`,
    provider: "codex",
    issue: issue(20),
    state,
    workflow,
    workspace: terminal
      ? {
          clonePath: "/tmp/factory/clones/factory-fixture",
          worktreePath: `/tmp/factory/worktrees/assignment-${state}`,
          worktreeGitDir: `/tmp/factory/clones/factory-fixture/.git/worktrees/assignment-${state}`,
          commonGitDir: "/tmp/factory/clones/factory-fixture/.git",
          branch: `factory/assignment-${state}`,
        }
      : null,
    requestedModel: "gpt-5.6-luna",
    requestedEffort: "low",
    observedModel: terminal ? "gpt-5.6-luna" : null,
    observedEffort: terminal ? "low" : null,
    codexVersion: terminal ? "codex-cli 0.147.0" : null,
    threadId: terminal ? "thread-fixture" : null,
    turnId: terminal ? "turn-fixture" : null,
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
    createdAt: now,
    updatedAt: now,
    lastEventSequence: 1,
  };
}

function seeded(
  name: ScenarioName,
  state: Assignment["state"],
  expectedResult: ScenarioDefinition["expectedResult"],
  options: { readonly draft?: boolean; readonly longError?: boolean } = {},
): ScenarioDefinition {
  const value = assignment(state, options);
  return {
    name,
    now,
    candidates:
      state === "reserved" || state === "starting" || state === "running"
        ? [issue(21)]
        : [],
    assignment: value,
    events: [
      {
        assignmentId: value.id,
        type: `fixture.${state}`,
        timestamp: now,
        detail: {},
      },
    ],
    expectedResult,
  };
}

export const SCENARIOS: Readonly<Record<ScenarioName, ScenarioDefinition>> = {
  empty: {
    name: "empty",
    now,
    candidates: [],
    assignment: null,
    events: [],
    expectedResult: "no_candidate",
  },
  ambiguous: {
    name: "ambiguous",
    now,
    candidates: [issue(10), issue(11)],
    assignment: null,
    events: [],
    expectedResult: "selection_ambiguous",
  },
  "busy-reserved": seeded("busy-reserved", "reserved", "provider_busy"),
  "busy-starting": seeded("busy-starting", "starting", "provider_busy"),
  "busy-running": seeded("busy-running", "running", "provider_busy"),
  runnable: {
    name: "runnable",
    now,
    candidates: [issue(12)],
    assignment: null,
    events: [],
    expectedResult: "started",
  },
  "failed-long": seeded("failed-long", "failed", "projection_only", {
    longError: true,
  }),
  "completed-ready": seeded("completed-ready", "completed", "projection_only"),
  "completed-draft": seeded("completed-draft", "completed", "projection_only", {
    draft: true,
  }),
};

export function seedScenario(definition: ScenarioDefinition) {
  return Effect.gen(function* () {
    const state = yield* StateStore;
    yield* state.reset();
    if (definition.assignment) {
      yield* state.seedAssignment(definition.assignment, definition.events);
    }
  });
}
