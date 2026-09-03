import { defaultBehavior, emptyState, fixtureIssue } from "../factories.ts";
import type { FixtureDefinition } from "../types.ts";

const state = emptyState([fixtureIssue(10), fixtureIssue(11)]);

export const ambiguousFixture = {
  name: "ambiguous",
  summary: "Two eligible issues prevent automatic selection",
  tags: ["command-result", "selection"],
  purpose:
    "Verify that Factory reports every candidate and starts no assignment when selection is ambiguous.",
  state,
  behavior: defaultBehavior(),
  expectations: {
    initial: {
      candidateCount: 2,
      assignment: state.assignment,
      activeAssignmentCount: 0,
      eventTypes: [],
    },
    command: { result: "selection_ambiguous", issueLinkCount: 2 },
    reset: "deterministic",
    checks: ["inspect-initial-snapshot", "run-next-command"],
  },
} as const satisfies FixtureDefinition;
