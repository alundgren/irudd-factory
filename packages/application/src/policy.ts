/**
 * Vocabulary the adapters and the service all have to agree on. Each value is
 * read by at least two modules, so it lives here rather than being repeated at
 * the places that use it.
 */

/** The only provider Factory drives today. */
export const CODEX_PROVIDER = "codex";

/** `owner/name`, the only repository form Factory accepts. */
export const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The workflow contract Factory reads from the default branch. */
export const WORKFLOW_FILE = "WORKFLOW.md";

/** The label Factory adds to take an issue, and reads back to confirm it. */
export const CLAIM_LABEL = "claimed";

/** Repository permissions that make an issue author eligible. */
export const AUTHOR_WRITE_PERMISSIONS = ["admin", "maintain", "write"] as const;

export const REQUIRED_ISSUE_LABELS = ["ready-for-agent"] as const;
export const FORBIDDEN_ISSUE_LABELS = [
  CLAIM_LABEL,
  "ready-for-human",
  "epic",
  "needs-refinement",
] as const;

/** Front matter keys `WORKFLOW.md` may declare. */
export const WORKFLOW_POLICY_KEYS = {
  requiredLabels: "required_labels",
  forbiddenLabels: "forbidden_labels",
  runtime: "runtime",
  test: "test",
} as const;
