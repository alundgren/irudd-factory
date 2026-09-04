import { defaultBehavior, emptyState, fixtureIssue } from "../factories.ts";
import type { FixtureDefinition } from "../types.ts";

const state = {
  ...emptyState(),
  queue: { candidates: [fixtureIssue(32)], stale: true },
};

export const queueStaleFixture = {
  name: "queue-stale",
  summary: "Fresh validation rejected a retained queue entry.",
  tags: ["queue", "stale"],
  purpose: "Inspect the reason shown for work that can no longer start.",
  state,
  behavior: defaultBehavior(),
  expectations: {
    initial: {
      candidateCount: 0,
      assignment: null,
      activeAssignmentCount: 0,
      eventTypes: [],
    },
    reset: "deterministic",
    checks: ["inspect-initial-snapshot"],
  },
} as const satisfies FixtureDefinition;
