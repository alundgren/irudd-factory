import { createHash } from "node:crypto";
import { FactoryError } from "./errors.ts";
import {
  FORBIDDEN_ISSUE_LABELS,
  REQUIRED_ISSUE_LABELS,
  WORKFLOW_FILE,
  WORKFLOW_POLICY_KEYS,
} from "./policy.ts";

export interface WorkflowPolicy {
  readonly requiredLabels: ReadonlyArray<string>;
  readonly forbiddenLabels: ReadonlyArray<string>;
  readonly runtime: string;
  readonly test: string;
}

export interface ParsedWorkflow {
  readonly policy: WorkflowPolicy;
  readonly body: string;
  readonly digest: string;
}

function requiredValue(
  entries: ReadonlyMap<string, string>,
  key: string,
): string {
  const value = entries.get(key)?.trim();
  if (!value) {
    throw new FactoryError({
      code: "workflow_invalid",
      message: `${WORKFLOW_FILE} is missing ${key}`,
    });
  }
  return value;
}

function labelList(
  entries: ReadonlyMap<string, string>,
  key: string,
): ReadonlyArray<string> {
  const source = requiredValue(entries, key);
  const match = source.match(/^\[(.*)]$/);
  const labels = match?.[1]
    ?.split(",")
    .map((label) => label.trim())
    .filter(Boolean);
  if (!labels || labels.length === 0) {
    throw new FactoryError({
      code: "workflow_invalid",
      message: `${WORKFLOW_FILE} ${key} must contain at least one label`,
    });
  }
  return labels;
}

function requireExactLabels(
  actual: ReadonlyArray<string>,
  expected: ReadonlyArray<string>,
  key: string,
): void {
  const actualSet = new Set(actual);
  if (
    actualSet.size !== expected.length ||
    expected.some((label) => !actualSet.has(label))
  ) {
    throw new FactoryError({
      code: "workflow_invalid",
      message: `${WORKFLOW_FILE} ${key} must be [${expected.join(", ")}]`,
    });
  }
}

export function parseWorkflow(source: string): ParsedWorkflow {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/);
  if (!match) {
    throw new FactoryError({
      code: "workflow_invalid",
      message: `${WORKFLOW_FILE} needs YAML front matter and a prompt body`,
    });
  }
  const frontMatter = match[1] ?? "";
  const body = (match[2] ?? "").trim();
  if (!body) {
    throw new FactoryError({
      code: "workflow_invalid",
      message: `${WORKFLOW_FILE} prompt body is empty`,
    });
  }

  const entries = new Map<string, string>();
  for (const line of frontMatter.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    entries.set(line.slice(0, separator).trim(), line.slice(separator + 1));
  }

  const allowedKeys = new Set<string>(Object.values(WORKFLOW_POLICY_KEYS));
  const unknownKey = [...entries.keys()].find((key) => !allowedKeys.has(key));
  if (unknownKey) {
    throw new FactoryError({
      code: "workflow_invalid",
      message: `${WORKFLOW_FILE} contains unsupported policy key ${unknownKey}`,
    });
  }

  const requiredLabels = labelList(
    entries,
    WORKFLOW_POLICY_KEYS.requiredLabels,
  );
  const forbiddenLabels = labelList(
    entries,
    WORKFLOW_POLICY_KEYS.forbiddenLabels,
  );
  requireExactLabels(
    requiredLabels,
    REQUIRED_ISSUE_LABELS,
    WORKFLOW_POLICY_KEYS.requiredLabels,
  );
  requireExactLabels(
    forbiddenLabels,
    FORBIDDEN_ISSUE_LABELS,
    WORKFLOW_POLICY_KEYS.forbiddenLabels,
  );

  return {
    policy: {
      requiredLabels,
      forbiddenLabels,
      runtime: requiredValue(entries, WORKFLOW_POLICY_KEYS.runtime),
      test: requiredValue(entries, WORKFLOW_POLICY_KEYS.test),
    },
    body,
    digest: createHash("sha256").update(source).digest("hex"),
  };
}

export function buildAssignmentPrompt(
  workflowBody: string,
  repository: string,
  issueNumber: number,
): string {
  return `${workflowBody.trim()}\n\n/implement-issue ${repository}#${issueNumber}\n\nThis run is unattended. Factory has already added the claimed label for this exact assignment; accept only that existing claim and continue even though the issue is already claimed.`;
}
