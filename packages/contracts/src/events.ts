export const ASSIGNMENT_EVENTS = {
  reserved: "assignment.reserved",
  completed: "assignment.completed",
  failed: "assignment.failed",
  interrupted: "assignment.interrupted",
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
