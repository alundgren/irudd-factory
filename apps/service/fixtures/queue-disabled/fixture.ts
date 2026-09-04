import { defaultBehavior, emptyState, fixtureIssue } from "../factories.ts";
import type { FixtureDefinition } from "../types.ts";

const state = {
  ...emptyState(),
  queue: { candidates: [fixtureIssue(34)] },
  dispatch: { paused: false, codexEnabled: false },
};

export const queueDisabledFixture = {
  name: "queue-disabled",
  summary: "Codex is disabled while ready work remains queued.",
  tags: ["queue", "disabled"],
  purpose: "Inspect the durable provider-disable state.",
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
