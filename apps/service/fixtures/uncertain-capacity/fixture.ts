import { assignedState, defaultBehavior, fixtureIssue } from "../factories.ts";
import type { FixtureDefinition } from "../types.ts";

const state = {
  ...assignedState("ownership_uncertain", []),
  queue: { candidates: [fixtureIssue(51)] },
};

export const uncertainCapacityFixture = {
  name: "uncertain-capacity",
  summary: "Provider ownership is uncertain while ready work remains queued.",
  tags: ["console", "capacity", "recovery"],
  purpose: "Inspect uncertain capacity without presenting a free slot.",
  state,
  behavior: defaultBehavior(),
  expectations: {
    initial: {
      candidateCount: 0,
      assignment: state.assignment,
      activeAssignmentCount: 1,
      eventTypes: ["fixture.ownership_uncertain"],
    },
    reset: "deterministic",
    checks: ["inspect-initial-snapshot"],
  },
} as const satisfies FixtureDefinition;
