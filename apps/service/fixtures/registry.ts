import { FactoryError } from "@irudd-factory/application";
import { ambiguousFixture } from "./ambiguous/fixture.ts";
import { busyReservedFixture } from "./busy-reserved/fixture.ts";
import { busyRunningFixture } from "./busy-running/fixture.ts";
import { busyStartingFixture } from "./busy-starting/fixture.ts";
import { completedDraftFixture } from "./completed-draft/fixture.ts";
import { completedReadyFixture } from "./completed-ready/fixture.ts";
import { emptyFixture } from "./empty/fixture.ts";
import { disconnectedFixture } from "./disconnected/fixture.ts";
import { delayedFixture } from "./delayed/fixture.ts";
import { failedLongFixture } from "./failed-long/fixture.ts";
import { fullCapacityFixture } from "./full-capacity/fixture.ts";
import { longTitleFixture } from "./long-title/fixture.ts";
import { paginationFixture } from "./pagination/fixture.ts";
import { runnableFixture } from "./runnable/fixture.ts";
import { queueDisabledFixture } from "./queue-disabled/fixture.ts";
import { queueMultiRepositoryFixture } from "./queue-multi-repository/fixture.ts";
import { queuePausedFixture } from "./queue-paused/fixture.ts";
import { queueReadyFixture } from "./queue-ready/fixture.ts";
import { queueStaleFixture } from "./queue-stale/fixture.ts";
import { retainedHistoryFixture } from "./retained-history/fixture.ts";
import { stopUncertainFixture } from "./stop-uncertain/fixture.ts";
import { uncertainCapacityFixture } from "./uncertain-capacity/fixture.ts";
import type { FixtureDefinition } from "./types.ts";

const TAG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateFixtureRegistry<
  const Entries extends ReadonlyArray<FixtureDefinition>,
>(entries: Entries): Entries {
  const names = new Set<string>();
  for (const fixture of entries) {
    if (names.has(fixture.name)) {
      throw new FactoryError({
        code: "fixture_catalog_invalid",
        message: `Duplicate fixture name: ${fixture.name}`,
      });
    }
    names.add(fixture.name);
    if (
      fixture.summary.length === 0 ||
      fixture.summary.length > 100 ||
      fixture.summary.includes("\n") ||
      fixture.summary.includes("\r")
    ) {
      throw new FactoryError({
        code: "fixture_catalog_invalid",
        message: `Fixture ${fixture.name} has an invalid summary`,
      });
    }
    if (
      fixture.tags.length > 5 ||
      new Set(fixture.tags).size !== fixture.tags.length
    ) {
      throw new FactoryError({
        code: "fixture_catalog_invalid",
        message: `Fixture ${fixture.name} has invalid tags`,
      });
    }
    for (const tag of fixture.tags) {
      if (tag.length === 0 || tag.length > 24 || !TAG_PATTERN.test(tag)) {
        throw new FactoryError({
          code: "fixture_catalog_invalid",
          message: `Fixture ${fixture.name} has invalid tag: ${tag}`,
        });
      }
    }
  }
  return entries;
}

export const FIXTURE_REGISTRY = validateFixtureRegistry([
  emptyFixture,
  disconnectedFixture,
  delayedFixture,
  ambiguousFixture,
  busyReservedFixture,
  busyStartingFixture,
  busyRunningFixture,
  stopUncertainFixture,
  runnableFixture,
  failedLongFixture,
  fullCapacityFixture,
  uncertainCapacityFixture,
  completedReadyFixture,
  completedDraftFixture,
  queueReadyFixture,
  queueStaleFixture,
  queuePausedFixture,
  queueDisabledFixture,
  queueMultiRepositoryFixture,
  longTitleFixture,
  paginationFixture,
  retainedHistoryFixture,
] as const);

export type FixtureName = (typeof FIXTURE_REGISTRY)[number]["name"];

export function getFixture(
  name: string,
): (typeof FIXTURE_REGISTRY)[number] | undefined {
  return FIXTURE_REGISTRY.find((fixture) => fixture.name === name);
}
