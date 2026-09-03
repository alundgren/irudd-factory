import { defaultBehavior, emptyState, fixtureIssue } from "../factories.ts";
import type { FixtureDefinition } from "../types.ts";

const state = {
  ...emptyState(),
  queue: { candidates: [fixtureIssue(31)] },
};

export const queueReadyFixture = {
  name: "queue-ready",
  summary: "One issue has durable FIFO tenure and is ready to start.",
  tags: ["queue", "ready"],
  purpose: "Inspect a startable queue entry before admission.",
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
