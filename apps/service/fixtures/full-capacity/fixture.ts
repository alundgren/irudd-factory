import { assignedState, defaultBehavior, fixtureIssue } from "../factories.ts";
import type { FixtureDefinition } from "../types.ts";

const state = {
  ...assignedState("running", []),
  queue: { candidates: [fixtureIssue(50)] },
};

export const fullCapacityFixture = {
  name: "full-capacity",
  summary: "The configured Codex slot is occupied while work remains queued.",
  tags: ["console", "capacity", "queue"],
  purpose: "Inspect occupied capacity and disabled manual admission.",
  state,
  behavior: defaultBehavior(),
  expectations: {
    initial: {
      candidateCount: 0,
      assignment: state.assignment,
      activeAssignmentCount: 1,
      eventTypes: ["fixture.running"],
    },
    reset: "deterministic",
    checks: ["inspect-initial-snapshot"],
  },
} as const satisfies FixtureDefinition;
