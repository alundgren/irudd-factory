import { describe, expect, test } from "vite-plus/test";
import type { Assignment, CommandResult } from "@irudd-factory/contracts";
import {
  assignmentIsBusy,
  codexCapacityFull,
  resultTitle,
  stateLabel,
} from "../src/view-model.ts";

describe("console state labels", () => {
  test("renders every command outcome", () => {
    const outcomes: CommandResult[] = [
      { _tag: "no_candidate" },
      { _tag: "selection_ambiguous", issueLinks: [] },
    ];
    expect(outcomes.map(resultTitle)).toEqual([
      "No eligible issue",
      "Choose one issue first",
    ]);
  });

  test("disables admission for every nonterminal state", () => {
    const assignment = (state: Assignment["state"]) =>
      ({ state }) as Assignment;
    expect(assignmentIsBusy(assignment("reserved"))).toBe(true);
    expect(assignmentIsBusy(assignment("starting"))).toBe(true);
    expect(assignmentIsBusy(assignment("running"))).toBe(true);
    expect(assignmentIsBusy(assignment("ownership_uncertain"))).toBe(true);
    expect(assignmentIsBusy(assignment("interrupted"))).toBe(false);
    expect(assignmentIsBusy(assignment("completed"))).toBe(false);
    expect(assignmentIsBusy(assignment("failed"))).toBe(false);
    expect(assignmentIsBusy(null)).toBe(false);
  });

  test("names all visible assignment states", () => {
    expect(
      [
        "reserved",
        "starting",
        "running",
        "completed",
        "failed",
        "interrupted",
        "ownership_uncertain",
      ].map((state) => stateLabel(state as Assignment["state"])),
    ).toEqual([
      "Reserved",
      "Starting",
      "Running",
      "Completed",
      "Failed",
      "Interrupted",
      "Process ownership uncertain",
    ]);
  });

  test("disables admission only when all Codex slots are occupied", () => {
    const assignment = (state: Assignment["state"]) =>
      ({ state }) as Assignment;
    expect(codexCapacityFull([assignment("running")], 2)).toBe(false);
    expect(
      codexCapacityFull(
        [assignment("running"), assignment("ownership_uncertain")],
        2,
      ),
    ).toBe(true);
  });
});
