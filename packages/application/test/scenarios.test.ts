import { describe, expect, test } from "bun:test";
import { SCENARIOS, SCENARIO_NAMES } from "../src/index.ts";

describe("deterministic application scenarios", () => {
  test("defines every named scenario with stable identities", () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual([...SCENARIO_NAMES].sort());
    expect(SCENARIOS.ambiguous.candidates).toHaveLength(2);
    expect(SCENARIOS.runnable.candidates).toHaveLength(1);
    expect(SCENARIOS.empty.candidates).toHaveLength(0);
    for (const name of SCENARIO_NAMES) {
      expect(SCENARIOS[name].now).toBe("2026-01-15T12:00:00.000Z");
    }
  });

  test("busy scenarios use a distinct eligible candidate", () => {
    for (const name of [
      "busy-reserved",
      "busy-starting",
      "busy-running",
    ] as const) {
      const scenario = SCENARIOS[name];
      expect(scenario.candidates).toHaveLength(1);
      expect(scenario.candidates[0]?.nodeId).not.toBe(
        scenario.assignment?.issue.nodeId,
      );
    }
  });
});
