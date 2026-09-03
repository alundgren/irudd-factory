import { assignedState, defaultBehavior, fixtureIssue } from "../factories.ts";
import type { FixtureDefinition } from "../types.ts";

const state = assignedState("reserved", [fixtureIssue(21)]);

export const busyReservedFixture = {
  name: "busy-reserved",
  summary: "A reserved assignment rejects a second command",
  tags: ["busy", "command-result", "reserved"],
  purpose:
    "Verify that a reserved assignment owns the provider and produces a durable busy result.",
  state,
  behavior: defaultBehavior(),
  expectations: {
    initial: {
      candidateCount: 1,
      assignment: state.assignment,
      activeAssignmentCount: 1,
      eventTypes: ["fixture.reserved"],
    },
    command: { result: "provider_busy", assignmentState: "reserved" },
    reset: "deterministic",
    checks: [
      "inspect-initial-snapshot",
      "run-next-command",
      "run-second-client",
    ],
  },
} as const satisfies FixtureDefinition;
