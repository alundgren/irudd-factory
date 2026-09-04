import { defaultBehavior, emptyState } from "../factories.ts";
import type { FixtureDefinition } from "../types.ts";

export const disconnectedFixture = {
  name: "disconnected",
  summary: "The console cannot reach the service RPC endpoint.",
  tags: ["console", "connection", "error"],
  purpose: "Inspect the initial service-disconnected state and retry control.",
  state: emptyState(),
  behavior: defaultBehavior(),
  consoleNetwork: "disconnected",
  expectations: {
    initial: {
      candidateCount: 0,
      assignment: null,
      activeAssignmentCount: 0,
      eventTypes: [],
    },
    reset: "deterministic",
    checks: ["inspect-initial-snapshot"],
  },
} as const satisfies FixtureDefinition;
