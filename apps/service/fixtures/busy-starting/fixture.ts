import { assignedState, defaultBehavior, fixtureIssue } from "../factories.ts";
import type { FixtureDefinition } from "../types.ts";

const state = assignedState("starting", [fixtureIssue(21)]);

export const busyStartingFixture = {
  name: "busy-starting",
  summary: "A starting assignment rejects a second command",
  tags: ["busy", "command-result", "starting"],
  purpose:
    "Verify that workspace and provider startup keep the provider unavailable to another command.",
  state,
  behavior: defaultBehavior(),
  expectations: {
    initial: {
      candidateCount: 1,
      assignment: state.assignment,
      activeAssignmentCount: 1,
      eventTypes: ["fixture.starting"],
    },
    command: { result: "provider_busy", assignmentState: "starting" },
    reset: "deterministic",
    checks: [
      "inspect-initial-snapshot",
      "run-next-command",
      "run-second-client",
    ],
  },
} as const satisfies FixtureDefinition;
