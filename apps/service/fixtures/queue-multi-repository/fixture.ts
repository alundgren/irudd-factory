import { defaultBehavior, emptyState, fixtureIssue } from "../factories.ts";
import type { FixtureDefinition } from "../types.ts";

const state = {
  ...emptyState(),
  queue: {
    candidates: [
      {
        ...fixtureIssue(7),
        nodeId: "I_owner_two_7",
        repository: "owner/two",
        url: "https://github.com/owner/two/issues/7",
      },
      {
        ...fixtureIssue(7),
        nodeId: "I_owner_one_7",
        repository: "owner/one",
        url: "https://github.com/owner/one/issues/7",
      },
    ],
  },
};

export const queueMultiRepositoryFixture = {
  name: "queue-multi-repository",
  summary: "Matching issue numbers from two repositories have stable order.",
  tags: ["queue", "repositories"],
  purpose: "Inspect repository tie-breaking for simultaneous observations.",
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
