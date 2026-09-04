import { assignedState, defaultBehavior, fixtureIssue } from "../factories.ts";
import type { FixtureDefinition } from "../types.ts";

const state = assignedState("stop_uncertain", [fixtureIssue(21)]);

export const stopUncertainFixture = {
  name: "stop-uncertain",
  summary: "An unconfirmed stop keeps its Codex slot occupied",
  tags: ["busy", "command-result", "stop", "recovery"],
  purpose:
    "Show the unconfirmed Stop state and verify that it blocks another provider admission.",
  state,
  behavior: defaultBehavior(),
  expectations: {
    initial: {
      candidateCount: 1,
      assignment: state.assignment,
      activeAssignmentCount: 1,
      eventTypes: ["fixture.stop_uncertain"],
    },
    command: { result: "provider_busy", assignmentState: "stop_uncertain" },
    reset: "deterministic",
    checks: [
      "inspect-initial-snapshot",
      "run-next-command",
      "run-second-client",
    ],
  },
} as const satisfies FixtureDefinition;
