import { assignedState, defaultBehavior } from "../factories.ts";
import type { FixtureDefinition } from "../types.ts";

const state = assignedState("completed", [], { draft: true });

export const completedDraftFixture = {
  name: "completed-draft",
  summary: "A completed assignment projects a draft pull request",
  tags: ["draft", "projection", "terminal"],
  purpose:
    "Verify the terminal projection for a completed assignment with a draft pull request.",
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
