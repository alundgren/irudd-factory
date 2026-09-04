import type {
  Assignment,
  RetainedProviderRecord,
} from "@irudd-factory/contracts";
import type { FixtureDefinition } from "../types.ts";
import {
  defaultBehavior,
  emptyState,
  fixtureAssignment,
  fixtureIssue,
} from "../factories.ts";

const states: ReadonlyArray<Assignment["state"]> = [
  "completed",
  "failed",
  "interrupted",
  "stopped",
  "stop_uncertain",
  "running",
];

function attempt(
  state: Assignment["state"],
  index: number,
  createdAt: string,
  updatedAt: string,
): Assignment {
  const issue = fixtureIssue(100 + index);
  return {
    ...fixtureAssignment(state),
    id: `timeline-${state}-${index}`,
    issue: {
      ...issue,
      title:
        index === 5
          ? "A deliberately long repository issue title that must remain identifiable after truncation"
          : `Timeline ${state} attempt ${index}`,
    },
    createdAt,
    updatedAt,
    archivedAt:
      index === 3 || state === "stop_uncertain"
        ? "2026-01-15T11:50:00.000Z"
        : null,
  };
}

const attempts = states.map((state, index) =>
  attempt(
    state,
    index,
    `2026-01-15T${String(8 + Math.floor(index / 3)).padStart(2, "0")}:${String((index % 3) * 10).padStart(2, "0")}:00.000Z`,
    `2026-01-15T${String(9 + Math.floor(index / 3)).padStart(2, "0")}:${String(20 + (index % 3) * 10).padStart(2, "0")}:00.000Z`,
  ),
);

const knownUsage: RetainedProviderRecord = {
  kind: "usage",
  timestamp: "2026-01-15T10:30:00.000Z",
  usage: defaultBehavior().provider.result.tokenUsage!,
};

const currentAttempt = {
  ...attempts.at(-1)!,
  lastEventSequence: attempts.length,
};

export const timelineDenseFixture: FixtureDefinition<"timeline-dense"> = {
  name: "timeline-dense",
  summary: "Dense overlapping Codex attempts in every retained state",
  tags: ["timeline", "overlap", "archived", "unknown-token", "narrow"],
  purpose:
    "Inspect dense overlap, a long-running attempt, a long title, archived styling, authoritative and unknown tokens, keyboard selection, and contained narrow scrolling.",
  state: {
    ...emptyState(),
    dispatch: { paused: false, codexEnabled: true },
    history: attempts.map((assignment, index) => ({
      assignment,
      events: [
        {
          assignmentId: assignment.id,
          type: `assignment.${assignment.state}`,
          timestamp: assignment.updatedAt,
          detail: {},
        },
      ],
      providerRecords: index % 2 === 0 ? [knownUsage] : [],
    })),
  },
  behavior: defaultBehavior(),
  expectations: {
    initial: {
      candidateCount: 0,
      assignment: currentAttempt,
      activeAssignmentCount: 2,
      eventTypes: ["assignment.running"],
    },
    command: { result: "provider_busy" },
    reset: "deterministic",
    checks: ["inspect-initial-snapshot"],
  },
};
