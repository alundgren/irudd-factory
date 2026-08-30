import { describe, expect, test } from "bun:test";
import type { Assignment, CommandResult } from "@irudd-factory/contracts";
import {
  assignmentIsBusy,
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
    expect(assignmentIsBusy(assignment("completed"))).toBe(false);
    expect(assignmentIsBusy(assignment("failed"))).toBe(false);
    expect(assignmentIsBusy(null)).toBe(false);
  });

  test("names all visible assignment states", () => {
    expect(
      ["reserved", "starting", "running", "completed", "failed"].map((state) =>
        stateLabel(state as Assignment["state"]),
      ),
    ).toEqual(["Reserved", "Starting", "Running", "Completed", "Failed"]);
  });
});
