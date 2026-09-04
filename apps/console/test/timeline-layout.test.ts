import type { Assignment, TimelineAttempt } from "@irudd-factory/contracts";
import { describe, expect, test } from "vite-plus/test";
import { layoutTimeline } from "../src/timeline-layout.ts";

function attempt(
  id: string,
  state: Assignment["state"],
  createdAt: string,
  updatedAt: string,
): TimelineAttempt {
  const openEnded =
    state === "reserved" ||
    state === "starting" ||
    state === "running" ||
    state === "stop_uncertain" ||
    state === "ownership_uncertain";
  return {
    id,
    state,
    createdAt,
    updatedAt,
    startedAt: createdAt,
    endedAt: openEnded ? null : updatedAt,
  } as TimelineAttempt;
}

describe("timeline layout", () => {
  test("maps timestamps to stable positions and separate overlap slots", () => {
    const assignments = [
      attempt(
        "later",
        "completed",
        "2026-01-01T10:20:00Z",
        "2026-01-01T11:00:00Z",
      ),
      attempt(
        "first",
        "completed",
        "2026-01-01T10:00:00Z",
        "2026-01-01T10:30:00Z",
      ),
      attempt(
        "after",
        "completed",
        "2026-01-01T11:00:00Z",
        "2026-01-01T11:10:00Z",
      ),
    ];
    const layout = layoutTimeline(assignments, "2026-01-01T12:00:00Z", 2);

    expect(layout.items.map(({ assignment }) => assignment.id)).toEqual([
      "first",
      "later",
      "after",
    ]);
    expect(layout.items.map(({ slot }) => slot)).toEqual([0, 1, 0]);
    expect(layout.slotCount).toBe(2);
    expect(layout.items[1]!.leftPercent).toBeGreaterThan(
      layout.items[0]!.leftPercent,
    );
  });

  test("uses the supplied read time for an open-ended running attempt", () => {
    const layout = layoutTimeline(
      [
        attempt(
          "running",
          "running",
          "2026-01-01T10:00:00Z",
          "2026-01-01T10:05:00Z",
        ),
      ],
      "2026-01-01T12:00:00Z",
      1,
    );
    expect(layout.items[0]).toMatchObject({
      endMs: new Date("2026-01-01T12:00:00Z").valueOf(),
      openEnded: true,
    });
  });

  test("places equal timestamps deterministically without invalid widths", () => {
    const assignments = [
      attempt("b", "completed", "2026-01-01T10:00:00Z", "2026-01-01T10:00:00Z"),
      attempt("a", "completed", "2026-01-01T10:00:00Z", "2026-01-01T10:00:00Z"),
    ];
    const layout = layoutTimeline(assignments, "2026-01-01T10:00:00Z", 1);
    expect(layout.items.map(({ assignment }) => assignment.id)).toEqual([
      "a",
      "b",
    ]);
    expect(layout.items.map(({ slot }) => slot)).toEqual([0, 1]);
    expect(
      layout.items.every(({ widthPercent }) => Number.isFinite(widthPercent)),
    ).toBe(true);
  });

  test("reuses a row for adjacent short attempts and preserves duration order", () => {
    const layout = layoutTimeline(
      [
        attempt(
          "short",
          "completed",
          "2026-01-01T10:00:00Z",
          "2026-01-01T10:01:00Z",
        ),
        attempt(
          "adjacent",
          "completed",
          "2026-01-01T10:02:00Z",
          "2026-01-01T10:03:00Z",
        ),
        attempt(
          "long",
          "completed",
          "2026-01-01T10:10:00Z",
          "2026-01-01T10:40:00Z",
        ),
      ],
      "2026-01-01T11:00:00Z",
      1,
    );
    expect(layout.items.map(({ slot }) => slot)).toEqual([0, 0, 0]);
    expect(layout.items[0]!.displaySlot).not.toBe(layout.items[1]!.displaySlot);
    expect(layout.items[2]!.widthPercent).toBeGreaterThan(
      layout.items[0]!.widthPercent,
    );
  });

  test("flips a point label before the right board boundary", () => {
    const layout = layoutTimeline(
      [
        attempt(
          "long",
          "completed",
          "2026-01-01T10:00:00Z",
          "2026-01-01T10:50:00Z",
        ),
        attempt(
          "edge",
          "completed",
          "2026-01-01T10:59:00Z",
          "2026-01-01T11:00:00Z",
        ),
      ],
      "2026-01-01T11:00:00Z",
      1,
    );
    expect(
      layout.items.find(({ assignment }) => assignment.id === "edge")
        ?.labelSide,
    ).toBe("left");
  });
});
