import { describe, expect, test } from "vite-plus/test";
import type { Assignment, CommandResult } from "@irudd-factory/contracts";
import {
  assignmentIsBusy,
  capacityIsUncertain,
  codexCapacityFull,
  commandErrorKind,
  commandPhaseLabel,
  loadErrorMessage,
  occupiedCapacity,
  queueStatus,
  resultTitle,
  stateLabel,
  tokenTotal,
} from "../src/view-model.ts";
import { ServiceRejection } from "../src/errors.ts";

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
        "stopped",
        "stop_uncertain",
        "ownership_uncertain",
      ].map((state) => stateLabel(state as Assignment["state"])),
    ).toEqual([
      "Reserved",
      "Starting",
      "Running",
      "Completed",
      "Failed",
      "Interrupted",
      "Stopped",
      "Stop unconfirmed",
      "Process ownership uncertain",
    ]);
  });

  test("disables admission only when all Codex slots are occupied", () => {
    const assignment = (state: Assignment["state"]) =>
      ({ state }) as Assignment;
    expect(codexCapacityFull([assignment("running")], 2)).toBe(false);
    expect(
      codexCapacityFull(
        [assignment("running"), assignment("stop_uncertain")],
        2,
      ),
    ).toBe(true);
  });

  test("maps capacity, usage, and queue values without inventing numbers", () => {
    const assignment = (state: Assignment["state"], id = state) =>
      ({ state, id }) as Assignment;
    const active = [assignment("running"), assignment("ownership_uncertain")];
    expect(occupiedCapacity(active)).toBe(2);
    expect(capacityIsUncertain(active)).toBe(true);
    expect(tokenTotal("running", [])).toBeNull();
    expect(
      tokenTotal("running", [
        {
          attemptId: "running",
          timestamp: "2026-01-01T00:00:00.000Z",
          total: {
            inputTokens: 6,
            cachedInputTokens: 0,
            outputTokens: 4,
            reasoningOutputTokens: 0,
            totalTokens: 10,
          },
          last: {
            inputTokens: 6,
            cachedInputTokens: 0,
            outputTokens: 4,
            reasoningOutputTokens: 0,
            totalTokens: 10,
          },
          modelContextWindow: null,
        },
      ]),
    ).toBe(10);
    expect(queueStatus({ startable: true } as never)).toBe("Ready");
    expect(
      queueStatus({
        startable: false,
        reason: { code: "stale", message: "Issue is stale" },
      } as never),
    ).toBe("Issue is stale");
  });

  test("names every visible command phase and distinguishes service rejection", () => {
    expect(
      ["accepted", "executing", "final", "rejected", "transport"].map((phase) =>
        commandPhaseLabel(phase as never),
      ),
    ).toEqual([
      "Accepted",
      "Executing",
      "Final",
      "Rejected",
      "Transport failure",
    ]);
    expect(
      commandErrorKind(
        new ServiceRejection(
          "repository_not_configured: Repository is not configured",
        ),
      ),
    ).toBe("rejected");
    expect(commandErrorKind("dispatch_paused: Dispatch is paused")).toBe(
      "transport",
    );
    expect(commandErrorKind(new TypeError("fetch failed"))).toBe("transport");
    expect(loadErrorMessage("Transport error (POST /rpc)\nstack trace")).toBe(
      "Factory could not reach the service. Check that it is running and reachable.",
    );
  });
});
