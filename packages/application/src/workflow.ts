import { createHash } from "node:crypto";
import { FactoryError } from "./errors.ts";

export interface WorkflowPolicy {
  readonly pollInterval: string;
  readonly requiredLabels: ReadonlyArray<string>;
  readonly concurrency: number;
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
      message: `WORKFLOW.md is missing ${key}`,
    });
  }
  return value;
}

export function parseWorkflow(source: string): ParsedWorkflow {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/);
  if (!match) {
    throw new FactoryError({
      code: "workflow_invalid",
      message: "WORKFLOW.md needs YAML front matter and a prompt body",
    });
  }
  const frontMatter = match[1] ?? "";
  const body = (match[2] ?? "").trim();
  if (!body) {
    throw new FactoryError({
      code: "workflow_invalid",
      message: "WORKFLOW.md prompt body is empty",
    });
  }

  const entries = new Map<string, string>();
  for (const line of frontMatter.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    entries.set(line.slice(0, separator).trim(), line.slice(separator + 1));
  }

  const concurrency = Number(requiredValue(entries, "concurrency"));
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new FactoryError({
      code: "workflow_invalid",
      message: "WORKFLOW.md concurrency must be a positive integer",
    });
  }
  const labelsSource = requiredValue(entries, "required_labels");
  const labelsMatch = labelsSource.match(/^\[(.*)]$/);
  const requiredLabels = labelsMatch?.[1]
    ?.split(",")
    .map((label) => label.trim())
    .filter(Boolean);
  if (!requiredLabels || requiredLabels.length === 0) {
    throw new FactoryError({
      code: "workflow_invalid",
      message: "WORKFLOW.md required_labels must contain at least one label",
    });
  }

  return {
    policy: {
      pollInterval: requiredValue(entries, "poll_interval"),
      requiredLabels,
      concurrency,
      runtime: requiredValue(entries, "runtime"),
      test: requiredValue(entries, "test"),
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
