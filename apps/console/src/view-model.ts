import type { Assignment, CommandResult } from "@irudd-factory/contracts";
import { isProviderBusy } from "@irudd-factory/contracts";

export function assignmentIsBusy(assignment: Assignment | null): boolean {
  return assignment ? isProviderBusy(assignment.state) : false;
}

export function codexCapacityFull(
  assignments: ReadonlyArray<Assignment>,
  slots: number,
): boolean {
  return (
    assignments.filter(({ state }) => isProviderBusy(state)).length >= slots
  );
}

export function resultTitle(result: CommandResult): string {
  switch (result._tag) {
    case "started":
      return "Run accepted";
    case "no_candidate":
      return "No eligible issue";
    case "selection_ambiguous":
      return "Choose one issue first";
    case "provider_busy":
      return "Codex is already working";
    case "dispatch_unavailable":
      return result.reason === "dispatch_paused"
        ? "Dispatch is paused"
        : "Codex is disabled";
  }
}

export function stateLabel(state: Assignment["state"]): string {
  switch (state) {
    case "reserved":
      return "Reserved";
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "interrupted":
      return "Interrupted";
    case "ownership_uncertain":
      return "Process ownership uncertain";
  }
}
