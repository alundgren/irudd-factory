import { describe, expect, test } from "bun:test";
import { buildAssignmentPrompt, parseWorkflow } from "../src/index.ts";

const source = `---
poll_interval: 5m
required_labels: [ready-for-agent]
concurrency: 1
runtime: bun
test: bun test
---
Follow the repository guidance.`;

describe("workflow policy", () => {
  test("validates policy and hashes the exact blob bytes", () => {
    const parsed = parseWorkflow(source);
    expect(parsed.policy.requiredLabels).toEqual(["ready-for-agent"]);
    expect(parsed.policy.concurrency).toBe(1);
    expect(parsed.digest).toHaveLength(64);
    expect(parseWorkflow(`${source}\n`).digest).not.toBe(parsed.digest);
  });

  test("builds the narrow preclaimed prompt", () => {
    const prompt = buildAssignmentPrompt(
      "Follow the repository guidance.",
      "owner/repository",
      14,
    );
    expect(prompt).toContain("/implement-issue owner/repository#14");
    expect(prompt).toContain("Factory has already added the claimed label");
    expect(prompt).not.toContain("draft pull request");
  });

  test("rejects incomplete front matter", () => {
    expect(() => parseWorkflow("No front matter")).toThrow(
      "needs YAML front matter",
    );
  });
});
