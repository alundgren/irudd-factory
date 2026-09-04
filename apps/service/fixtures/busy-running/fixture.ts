import { assignedState, defaultBehavior, fixtureIssue } from "../factories.ts";
import type { FixtureDefinition } from "../types.ts";

const state = {
  ...assignedState("running", [fixtureIssue(21)]),
  queue: { candidates: [fixtureIssue(21)] },
};

export const busyRunningFixture = {
  name: "busy-running",
  summary: "A running assignment rejects a second command",
  tags: ["busy", "command-result", "running", "queue"],
  purpose:
    "Verify that an active provider run remains exclusive until it reaches a terminal state.",
  state,
  behavior: defaultBehavior(),
  expectations: {
    initial: {
      candidateCount: 1,
      assignment: state.assignment,
      activeAssignmentCount: 1,
      eventTypes: ["fixture.running"],
    },
    command: { result: "provider_busy", assignmentState: "running" },
    reset: "deterministic",
    checks: [
      "inspect-initial-snapshot",
      "run-next-command",
      "run-second-client",
    ],
  },
} as const satisfies FixtureDefinition;
