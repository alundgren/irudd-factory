import type { FixtureDefinition } from "../types.ts";
import { defaultBehavior, emptyState } from "../factories.ts";

export const timelineEmptyFixture: FixtureDefinition<"timeline-empty"> = {
  name: "timeline-empty",
  summary: "An empty retained Codex timeline",
  tags: ["timeline", "empty", "narrow"],
  purpose:
    "Inspect the empty timeline at desktop and narrow widths without page-level horizontal overflow.",
  state: emptyState(),
  behavior: defaultBehavior(),
  expectations: {
    initial: {
      candidateCount: 0,
      assignment: null,
      activeAssignmentCount: 0,
      eventTypes: [],
    },
    command: { result: "no_candidate" },
    reset: "deterministic",
    checks: ["inspect-initial-snapshot"],
  },
};
