import type { Assignment } from "@irudd-factory/contracts";
import type { FixtureDefinition } from "../types.ts";
import {
  defaultBehavior,
  emptyState,
  fixtureAssignment,
  fixtureIssue,
} from "../factories.ts";

const attempts: ReadonlyArray<Assignment> = Array.from(
  { length: 15 },
  (_, index) => ({
    ...fixtureAssignment("completed"),
    id: `timeline-page-${String(index + 1).padStart(2, "0")}`,
    issue: fixtureIssue(200 + index),
    createdAt: `2026-01-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`,
    updatedAt: `2026-01-${String(index + 1).padStart(2, "0")}T10:30:00.000Z`,
  }),
);

const latestAttempt = {
  ...attempts.at(-1)!,
  lastEventSequence: attempts.length,
};

export const timelinePaginationFixture: FixtureDefinition<"timeline-pagination"> =
  {
    name: "timeline-pagination",
    summary: "Two fixed-watermark timeline pages",
    tags: ["timeline", "pagination", "watermark"],
    purpose:
      "Inspect next and previous timeline navigation while retaining the first page watermark.",
    state: {
      ...emptyState(),
      history: attempts.map((assignment) => ({
        assignment,
        events: [
          {
            assignmentId: assignment.id,
            type: "assignment.completed",
            timestamp: assignment.updatedAt,
            detail: {},
          },
        ],
        providerRecords: [],
      })),
    },
    behavior: defaultBehavior(),
    expectations: {
      initial: {
        candidateCount: 0,
        assignment: latestAttempt,
        activeAssignmentCount: 0,
        eventTypes: ["assignment.completed"],
      },
      command: { result: "no_candidate" },
      reset: "deterministic",
      checks: ["inspect-initial-snapshot"],
    },
  };
