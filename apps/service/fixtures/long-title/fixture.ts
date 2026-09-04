import { defaultBehavior, emptyState, fixtureIssue } from "../factories.ts";
import type { FixtureDefinition } from "../types.ts";

const issue = {
  ...fixtureIssue(36),
  title:
    "Keep an unusually long ready issue title readable when repository names and status explanations also need room",
};
const state = { ...emptyState([issue]), queue: { candidates: [issue] } };

export const longTitleFixture = {
  name: "long-title",
  summary: "A ready issue has a long title that must wrap on narrow screens.",
  tags: ["console", "queue", "responsive"],
  purpose: "Inspect queue text at desktop and narrow viewport widths.",
  state,
  behavior: defaultBehavior(),
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
