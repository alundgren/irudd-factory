import { describe, expect, test } from "vite-plus/test";
import { buildAssignmentPrompt, parseWorkflow } from "../src/index.ts";

const source = `---
required_labels: [ready-for-agent]
forbidden_labels: [claimed, ready-for-human, epic, needs-refinement]
runtime: bun
test: bun run test
---
Follow the repository guidance.`;

describe("workflow policy", () => {
  test("validates policy and hashes the exact blob bytes", () => {
    const parsed = parseWorkflow(source);
    expect(parsed.policy.requiredLabels).toEqual(["ready-for-agent"]);
    expect(parsed.policy.forbiddenLabels).toEqual([
      "claimed",
      "ready-for-human",
      "epic",
      "needs-refinement",
    ]);
    expect(parsed.digest).toHaveLength(64);
    expect(parseWorkflow(`${source}\n`).digest).not.toBe(parsed.digest);
  });

  test("accepts the checked-in repository policy", async () => {
    const parsed = parseWorkflow(await Bun.file("WORKFLOW.md").text());
    expect(parsed.policy.requiredLabels).toEqual(["ready-for-agent"]);
    expect(parsed.policy.forbiddenLabels).toEqual([
      "claimed",
      "ready-for-human",
      "epic",
      "needs-refinement",
    ]);
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

  test("rejects unsupported and ineffective policy", () => {
    expect(() =>
      parseWorkflow(source.replace("runtime: bun", "poll_interval: 5m")),
    ).toThrow("unsupported policy key poll_interval");
    expect(() =>
      parseWorkflow(
        source.replace(
          "required_labels: [ready-for-agent]",
          "required_labels: [another-label]",
        ),
      ),
    ).toThrow("required_labels must be [ready-for-agent]");
  });
});
