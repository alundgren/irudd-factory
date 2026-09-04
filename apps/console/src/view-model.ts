import type {
  Assignment,
  AttemptUsage,
  CommandResult,
  LifecycleCommand,
  QueueEntry,
} from "@irudd-factory/contracts";
import { isProviderBusy } from "@irudd-factory/contracts";
import { ServiceRejection } from "./errors.ts";

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

export function occupiedCapacity(
  assignments: ReadonlyArray<Assignment>,
): number {
  return assignments.filter(({ state }) => isProviderBusy(state)).length;
}

export function capacityIsUncertain(
  assignments: ReadonlyArray<Assignment>,
): boolean {
  return assignments.some(
    ({ state }) =>
      state === "ownership_uncertain" || state === "stop_uncertain",
  );
}

export function tokenTotal(
  assignmentId: string,
  usage: ReadonlyArray<AttemptUsage>,
): number | null {
  return (
    usage.find((entry) => entry.attemptId === assignmentId)?.total
      .totalTokens ?? null
  );
}

export function queueStatus(entry: QueueEntry): string {
  if (entry.startable) return "Ready";
  return entry.reason?.message ?? "Not startable";
}

export function commandErrorKind(error: unknown): "rejected" | "transport" {
  return error instanceof ServiceRejection ? "rejected" : "transport";
}

export function loadErrorMessage(error: unknown): string {
  const value = String(error);
  if (
    value.includes("Failed to send HTTP request") ||
    value.includes("Transport error") ||
    value.includes("fetch failed")
  ) {
    return "Factory could not reach the service. Check that it is running and reachable.";
  }
  return value.split("\n", 1)[0] || "Factory state could not be loaded.";
}

export type CommandPhase =
  | "accepted"
  | "executing"
  | "final"
  | "rejected"
  | "transport";

export function commandPhaseLabel(phase: CommandPhase): string {
  switch (phase) {
    case "accepted":
      return "Accepted";
    case "executing":
      return "Executing";
    case "final":
      return "Final";
    case "rejected":
      return "Rejected";
    case "transport":
      return "Transport failure";
  }
}

export function lifecycleCommandPhase(command: LifecycleCommand): CommandPhase {
  if (
    command.admission._tag === "rejected" ||
    command.consequence?._tag === "rejected"
  ) {
    return "rejected";
  }
  return command.phase;
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
    case "stopped":
      return "Stopped";
    case "stop_uncertain":
      return "Stop unconfirmed";
    case "ownership_uncertain":
      return "Process ownership uncertain";
  }
}
