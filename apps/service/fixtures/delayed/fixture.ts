import { defaultBehavior, emptyState, fixtureIssue } from "../factories.ts";
import type { FixtureDefinition } from "../types.ts";

const issue = fixtureIssue(35);
const state = { ...emptyState([issue]), queue: { candidates: [issue] } };

export const delayedFixture = {
  name: "delayed",
  summary: "The console retains data while a later refresh is delayed.",
  tags: ["console", "connection", "delayed"],
  purpose: "Inspect delayed-refresh status after the initial snapshot loads.",
  state,
  behavior: defaultBehavior(),
  consoleNetwork: "delayed",
  expectations: {
    initial: {
      candidateCount: 1,
      assignment: null,
      activeAssignmentCount: 0,
      eventTypes: [],
    },
    reset: "deterministic",
    checks: ["inspect-initial-snapshot"],
  },
} as const satisfies FixtureDefinition;
