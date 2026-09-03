import { ASSIGNMENT_EVENTS } from "@irudd-factory/contracts";
import { defaultBehavior, emptyState, fixtureIssue } from "../factories.ts";
import type { FixtureDefinition } from "../types.ts";

const behavior = defaultBehavior();
const state = emptyState([fixtureIssue(12)]);

export const runnableFixture = {
  name: "runnable",
  summary: "One eligible issue progresses to a completed pull request",
  tags: ["lifecycle", "second-client", "terminal"],
  purpose:
    "Exercise the complete deterministic command, workspace, provider, pull-request, and shutdown path.",
  state,
  behavior,
  expectations: {
    initial: {
      candidateCount: 1,
      assignment: state.assignment,
      activeAssignmentCount: 0,
      eventTypes: [],
    },
    command: { result: "started", assignmentState: "reserved" },
    lifecycle: {
      states: ["reserved", "starting", "running", "completed"],
      terminalState: "completed",
      terminalEventTypes: [
        ASSIGNMENT_EVENTS.reserved,
        ASSIGNMENT_EVENTS.providerStartRequested,
        ASSIGNMENT_EVENTS.workspaceCreated,
        ASSIGNMENT_EVENTS.providerThreadStarted,
        ASSIGNMENT_EVENTS.providerTurnFinished,
        ASSIGNMENT_EVENTS.completed,
      ],
      pullRequest: behavior.pullRequest,
      secondClientResult: "provider_busy",
      afterTerminalResult: "no_candidate",
    },
    reset: "deterministic",
    checks: [
      "inspect-initial-snapshot",
      "run-next-command",
      "watch-lifecycle",
      "run-second-client",
    ],
  },
} as const satisfies FixtureDefinition;
