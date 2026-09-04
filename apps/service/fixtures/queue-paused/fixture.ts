import { defaultBehavior, emptyState, fixtureIssue } from "../factories.ts";
import type { FixtureDefinition } from "../types.ts";

const state = {
  ...emptyState(),
  queue: { candidates: [fixtureIssue(33)] },
  dispatch: { paused: true, codexEnabled: true },
};

export const queuePausedFixture = {
  name: "queue-paused",
  summary: "Automatic dispatch is paused while ready work remains queued.",
  tags: ["queue", "paused"],
  purpose: "Inspect persistent dispatch pause without interrupting work.",
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
