import type { FixtureDefinition } from "../types.ts";
import {
  emptyState,
  fixtureAssignment,
  defaultBehavior,
  FIXTURE_NOW,
} from "../factories.ts";

const first = {
  ...fixtureAssignment("failed", { longError: true }),
  id: "attempt-history-failed",
  createdAt: "2026-01-12T12:00:00.000Z",
  updatedAt: "2026-01-12T12:10:00.000Z",
};
const second = {
  ...fixtureAssignment("interrupted"),
  id: "attempt-history-interrupted",
  createdAt: "2026-01-13T12:00:00.000Z",
  updatedAt: "2026-01-13T12:10:00.000Z",
};
const third = {
  ...fixtureAssignment("completed"),
  id: "attempt-history-completed",
  createdAt: "2026-01-14T12:00:00.000Z",
  updatedAt: FIXTURE_NOW,
  lastEventSequence: 8,
};
const fourth = {
  ...fixtureAssignment("stopped"),
  id: "attempt-history-stopped",
  workspace: third.workspace,
  createdAt: "2026-01-11T12:00:00.000Z",
  updatedAt: "2026-01-11T12:10:00.000Z",
};
const fifth = {
  ...fixtureAssignment("completed"),
  id: "attempt-history-completed-older",
  createdAt: "2026-01-10T12:00:00.000Z",
  updatedAt: "2026-01-10T12:10:00.000Z",
};
const sixth = {
  ...fixtureAssignment("failed"),
  id: "attempt-history-failed-older",
  createdAt: "2026-01-09T12:00:00.000Z",
  updatedAt: "2026-01-09T12:10:00.000Z",
};
const seventh = {
  ...fixtureAssignment("completed"),
  id: "attempt-history-completed-oldest",
  createdAt: "2026-01-08T12:00:00.000Z",
  updatedAt: "2026-01-08T12:10:00.000Z",
};
const eighth = {
  ...fixtureAssignment("stopped"),
  id: "attempt-history-stopped-older",
  workspace: third.workspace,
  createdAt: "2026-01-07T12:00:00.000Z",
  updatedAt: "2026-01-07T12:10:00.000Z",
};
const archived = {
  ...fixtureAssignment("stopped"),
  id: "attempt-history-archived",
  workspace: third.workspace,
  createdAt: "2026-01-06T12:00:00.000Z",
  updatedAt: "2026-01-06T12:10:00.000Z",
  archivedAt: "2026-01-06T12:15:00.000Z",
};

function event(assignment: typeof fourth): ReadonlyArray<{
  assignmentId: string;
  type: string;
  timestamp: string;
  detail: Record<string, unknown>;
}> {
  return [
    {
      assignmentId: assignment.id,
      type: `assignment.${assignment.state}`,
      timestamp: assignment.updatedAt,
      detail: {},
    },
  ];
}

export const retainedHistoryFixture: FixtureDefinition<"retained-history"> = {
  name: "retained-history",
  summary:
    "Several retained attempts with long, truncated, and partial evidence",
  tags: ["history", "pagination", "transcript", "recovery", "clipboard"],
  purpose:
    "Exercise paged history for one issue across failed, interrupted, stopped, completed, and archived attempts, including long truncated text, known and unknown tokens, pull request evidence, and clipboard failure.",
  state: {
    ...emptyState(),
    assignment: third,
    events: [
      {
        assignmentId: third.id,
        type: "assignment.completed",
        timestamp: third.updatedAt,
        detail: { pullRequestUrl: third.pullRequest?.url, draft: false },
      },
    ],
    history: [
      {
        assignment: first,
        events: [
          {
            assignmentId: first.id,
            type: "assignment.failed",
            timestamp: first.updatedAt,
            detail: { code: "provider_failed" },
          },
        ],
        providerRecords: [
          {
            kind: "transcript",
            timestamp: first.updatedAt,
            text: `fixture-secret-123 ${"A long retained transcript. ".repeat(80)}`,
          },
          {
            kind: "process_exit",
            timestamp: first.updatedAt,
            code: 1,
            signal: null,
            cleanupTimedOut: false,
          },
        ],
      },
      {
        assignment: second,
        events: [
          {
            assignmentId: second.id,
            type: "assignment.interrupted",
            timestamp: second.updatedAt,
            detail: { processReconciliation: "exited" },
          },
        ],
        providerRecords: [
          {
            kind: "process_exit",
            timestamp: second.updatedAt,
            code: null,
            signal: "SIGTERM",
            cleanupTimedOut: false,
          },
        ],
      },
      { assignment: fourth, events: event(fourth), providerRecords: [] },
      { assignment: fifth, events: event(fifth), providerRecords: [] },
      { assignment: sixth, events: event(sixth), providerRecords: [] },
      { assignment: seventh, events: event(seventh), providerRecords: [] },
      { assignment: eighth, events: event(eighth), providerRecords: [] },
      {
        assignment: third,
        events: [
          {
            assignmentId: third.id,
            type: "assignment.completed",
            timestamp: third.updatedAt,
            detail: { pullRequestUrl: third.pullRequest?.url, draft: false },
          },
        ],
        providerRecords: [
          {
            kind: "transcript",
            timestamp: third.updatedAt,
            text: "Opened the retained fixture pull request.",
          },
          {
            kind: "usage",
            timestamp: third.updatedAt,
            usage: defaultBehavior().provider.result.tokenUsage!,
          },
          {
            kind: "process_exit",
            timestamp: third.updatedAt,
            code: 0,
            signal: null,
            cleanupTimedOut: false,
          },
        ],
      },
      { assignment: archived, events: event(archived), providerRecords: [] },
    ],
  },
  behavior: defaultBehavior(),
  expectations: {
    initial: {
      candidateCount: 0,
      assignment: third,
      activeAssignmentCount: 0,
      eventTypes: ["assignment.completed"],
    },
    command: { result: "no_candidate" },
    reset: "deterministic",
    checks: ["inspect-initial-snapshot"],
  },
  consoleClipboard: "failure",
};
