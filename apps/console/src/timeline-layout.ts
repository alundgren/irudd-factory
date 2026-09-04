import type { TimelineAttempt } from "@irudd-factory/contracts";

const MINIMUM_WINDOW_MS = 60 * 60 * 1_000;
const POINT_THRESHOLD_PERCENT = 8;
const POINT_LABEL_PERCENT = 18;

export interface TimelineItemLayout {
  readonly assignment: TimelineAttempt;
  readonly slot: number;
  readonly displaySlot: number;
  readonly labelSide: "left" | "right";
  readonly labelTrack: number;
  readonly leftPercent: number;
  readonly widthPercent: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly openEnded: boolean;
}

export interface TimelineLayout {
  readonly items: ReadonlyArray<TimelineItemLayout>;
  readonly slotCount: number;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
}

function timestamp(value: string, fallback: number): number {
  const parsed = new Date(value).valueOf();
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function layoutTimeline(
  assignments: ReadonlyArray<TimelineAttempt>,
  now: string,
  configuredSlots: number,
): TimelineLayout {
  const fallbackNow = Date.now();
  const nowMs = timestamp(now, fallbackNow);
  const intervals = assignments
    .map((assignment) => {
      const startMs = timestamp(assignment.startedAt, nowMs);
      const openEnded = assignment.endedAt === null;
      const retainedEnd = assignment.endedAt
        ? timestamp(assignment.endedAt, startMs)
        : nowMs;
      const endMs = Math.max(startMs, retainedEnd);
      return { assignment, startMs, endMs, openEnded };
    })
    .sort(
      (left, right) =>
        left.startMs - right.startMs ||
        left.endMs - right.endMs ||
        left.assignment.id.localeCompare(right.assignment.id),
    );

  if (intervals.length === 0) {
    return {
      items: [],
      slotCount: Math.max(1, configuredSlots),
      windowStartMs: nowMs - MINIMUM_WINDOW_MS,
      windowEndMs: nowMs,
    };
  }

  const earliest = Math.min(...intervals.map(({ startMs }) => startMs));
  const latest = Math.max(...intervals.map(({ endMs }) => endMs));
  const contentDuration = Math.max(MINIMUM_WINDOW_MS, latest - earliest);
  const padding = contentDuration * 0.04;
  const windowStartMs = earliest - padding;
  const windowEndMs = Math.max(
    latest + padding,
    windowStartMs + MINIMUM_WINDOW_MS,
  );
  const windowDuration = windowEndMs - windowStartMs;
  const slotEnds: number[] = [];

  const positioned = intervals.map((interval) => {
    const collisionEnd = Math.max(interval.endMs, interval.startMs + 1);
    let slot = slotEnds.findIndex((end) => end <= interval.startMs);
    if (slot === -1) slot = slotEnds.length;
    slotEnds[slot] = collisionEnd;
    return {
      ...interval,
      slot,
      leftPercent: ((interval.startMs - windowStartMs) / windowDuration) * 100,
      widthPercent:
        ((interval.endMs - interval.startMs) / windowDuration) * 100,
    };
  });

  const tracksBySlot = new Map<
    number,
    Array<Array<{ readonly start: number; readonly end: number }>>
  >();
  for (const item of positioned) {
    if (item.widthPercent < POINT_THRESHOLD_PERCENT) continue;
    const tracks = tracksBySlot.get(item.slot) ?? [[]];
    tracks[0]!.push({
      start: item.leftPercent,
      end: item.leftPercent + item.widthPercent,
    });
    tracksBySlot.set(item.slot, tracks);
  }

  const withLabelTracks = positioned.map((item) => {
    const labelSide: TimelineItemLayout["labelSide"] =
      item.leftPercent > 100 - POINT_LABEL_PERCENT ? "left" : "right";
    if (item.widthPercent >= POINT_THRESHOLD_PERCENT) {
      return { ...item, labelSide, labelTrack: 0 };
    }
    const labelInterval =
      labelSide === "left"
        ? {
            start: item.leftPercent - POINT_LABEL_PERCENT,
            end: item.leftPercent,
          }
        : {
            start: item.leftPercent,
            end: item.leftPercent + POINT_LABEL_PERCENT,
          };
    const tracks = tracksBySlot.get(item.slot) ?? [[]];
    let labelTrack = tracks.findIndex((track) =>
      track.every(
        (occupied) =>
          occupied.end <= labelInterval.start ||
          occupied.start >= labelInterval.end,
      ),
    );
    if (labelTrack === -1) {
      labelTrack = tracks.length;
      tracks.push([]);
    }
    tracks[labelTrack]!.push(labelInterval);
    tracksBySlot.set(item.slot, tracks);
    return { ...item, labelSide, labelTrack };
  });

  const slotOffsets = new Map<number, number>();
  let displaySlotCount = 0;
  for (let slot = 0; slot < slotEnds.length; slot += 1) {
    slotOffsets.set(slot, displaySlotCount);
    displaySlotCount += Math.max(1, tracksBySlot.get(slot)?.length ?? 1);
  }
  const items = withLabelTracks.map((item) => ({
    ...item,
    displaySlot: (slotOffsets.get(item.slot) ?? item.slot) + item.labelTrack,
  }));

  return {
    items,
    slotCount: Math.max(1, configuredSlots, displaySlotCount),
    windowStartMs,
    windowEndMs,
  };
}
