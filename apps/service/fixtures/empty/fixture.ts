import { defaultBehavior, emptyState } from "../factories.ts";
import type { FixtureDefinition } from "../types.ts";

const state = emptyState();

export const emptyFixture = {
  name: "empty",
  summary: "No eligible issue is available",
  tags: ["command-result", "empty-state"],
  purpose:
    "Verify the durable no-candidate result when discovery returns no eligible issues.",
  state,
  behavior: defaultBehavior(),
  expectations: {
    initial: {
      candidateCount: 0,
      assignment: state.assignment,
      activeAssignmentCount: 0,
      eventTypes: [],
    },
    command: { result: "no_candidate" },
    reset: "deterministic",
    checks: ["inspect-initial-snapshot", "run-next-command"],
  },
} as const satisfies FixtureDefinition;
