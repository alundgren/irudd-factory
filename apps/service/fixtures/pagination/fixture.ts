import { defaultBehavior, emptyState, fixtureIssue } from "../factories.ts";
import type { FixtureDefinition } from "../types.ts";

const issues = Array.from({ length: 9 }, (_, index) =>
  fixtureIssue(40 + index),
);
const state = { ...emptyState(issues), queue: { candidates: issues } };

export const paginationFixture = {
  name: "pagination",
  summary: "The ready queue spans two stable bounded pages.",
  tags: ["console", "queue", "pagination"],
  purpose: "Inspect next and previous queue navigation with a fixed watermark.",
  state,
  behavior: defaultBehavior(),
  expectations: {
    initial: {
      candidateCount: 9,
      assignment: null,
      activeAssignmentCount: 0,
      eventTypes: [],
    },
    reset: "deterministic",
    checks: ["inspect-initial-snapshot"],
  },
} as const satisfies FixtureDefinition;
