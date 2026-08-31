/**
 * The durable assignment event vocabulary.
 *
 * These names are written to `assignment_events.type` and read back by the
 * console and the CLI, so they are part of the stored contract. Emitters
 * reference them from here rather than repeating the literal, which is what
 * keeps a typo from creating a silently new event type.
 */
export const ASSIGNMENT_EVENTS = {
  reserved: "assignment.reserved",
  completed: "assignment.completed",
  failed: "assignment.failed",
  workspaceCreated: "workspace.created",
  providerStartRequested: "provider.start.requested",
  providerProcessStarted: "provider.process.started",
  providerSettingsObserved: "provider.settings.observed",
  providerThreadStarted: "provider.thread.started",
  providerTurnStarted: "provider.turn.started",
  providerTurnFinished: "provider.turn.finished",
  providerFailed: "provider.failed",
} as const;

export type AssignmentEventType =
  (typeof ASSIGNMENT_EVENTS)[keyof typeof ASSIGNMENT_EVENTS];
