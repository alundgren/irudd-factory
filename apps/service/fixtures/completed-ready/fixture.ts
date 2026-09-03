import { assignedState, defaultBehavior } from "../factories.ts";
import type { FixtureDefinition } from "../types.ts";

const state = assignedState("completed", []);

export const completedReadyFixture = {
  name: "completed-ready",
  summary: "A completed assignment projects a ready pull request",
  tags: ["projection", "pull-request", "terminal"],
  purpose:
    "Verify the terminal projection for a completed assignment with a ready pull request.",
  state,
  behavior: defaultBehavior(),
  expectations: {
    initial: {
      candidateCount: 0,
      assignment: state.assignment,
      activeAssignmentCount: 0,
      eventTypes: ["fixture.completed"],
    },
    reset: "deterministic",
    checks: ["inspect-initial-snapshot"],
  },
} as const satisfies FixtureDefinition;
