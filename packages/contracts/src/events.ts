export const ASSIGNMENT_EVENTS = {
  reserved: "assignment.reserved",
  completed: "assignment.completed",
  failed: "assignment.failed",
  interrupted: "assignment.interrupted",
  workspaceCreated: "workspace.created",
  providerStartRequested: "provider.start.requested",
  providerProcessStartPending: "provider.process.start_pending",
  providerProcessStarted: "provider.process.started",
  providerSettingsObserved: "provider.settings.observed",
  providerThreadStarted: "provider.thread.started",
  providerTurnStarted: "provider.turn.started",
  providerTurnFinished: "provider.turn.finished",
  providerFailed: "provider.failed",
  pullRequestLookupStarted: "pull_request.lookup_started",
  pullRequestReconciled: "pull_request.reconciled",
  stopped: "attempt.stopped",
  stopUncertain: "attempt.stop_uncertain",
  returned: "attempt.returned",
  restarted: "attempt.restarted",
  archived: "attempt.archived",
  restored: "attempt.restored",
} as const;

export type AssignmentEventType =
  (typeof ASSIGNMENT_EVENTS)[keyof typeof ASSIGNMENT_EVENTS];
