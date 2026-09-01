import { describe, expect, test } from "vite-plus/test";
import type { CommandReceipt } from "@irudd-factory/contracts";

describe("CLI result encoding", () => {
  test("retains the shared command result fields", () => {
    const receipt: CommandReceipt = {
      commandId: "command-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      result: {
        _tag: "selection_ambiguous",
        issueLinks: [
          "https://github.com/owner/repository/issues/1",
          "https://github.com/owner/repository/issues/2",
        ],
      },
    };
    const output = JSON.stringify(receipt);
    expect(output).toContain("selection_ambiguous");
    expect(output).toContain("issues/1");
    expect(output).toContain("issues/2");
  });
});
