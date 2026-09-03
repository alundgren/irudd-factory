import { assignedState, defaultBehavior } from "../factories.ts";
import type { FixtureDefinition } from "../types.ts";

const state = assignedState("failed", [], { longError: true });

export const failedLongFixture = {
  name: "failed-long",
  summary: "A failed assignment retains a long diagnostic",
  tags: ["error", "projection", "terminal"],
  purpose:
    "Verify that the console and snapshot retain a multiline provider failure without truncating it.",
  state,
  behavior: defaultBehavior(),
  expectations: {
    initial: {
      candidateCount: 0,
      assignment: state.assignment,
      activeAssignmentCount: 0,
      eventTypes: ["fixture.failed"],
    },
    reset: "deterministic",
    checks: ["inspect-initial-snapshot"],
  },
} as const satisfies FixtureDefinition;
