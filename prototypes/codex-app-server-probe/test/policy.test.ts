import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initializeCampaign,
  parseArgs,
  providerAuthReady,
} from "../src/config.ts";
import { buildChildEnvironment, leakedKeys } from "../src/environment.ts";
import {
  readLocalOrigin,
  sanitizeCopiedGitDirectory,
} from "../src/git-policy.ts";
import { isWithin, plannedWithin, requireWithin } from "../src/paths.ts";
import { inspectSchemas, requireScenarioSandboxSchema } from "../src/schema.ts";
import { ProbeError } from "../src/types.ts";

describe("configuration and containment", () => {
  test("parses distinct scenario commands and recorded timeouts", () => {
    const options = parseArgs(
      ["read", "--campaign", "/tmp/campaign", "--turnMs", "1234"],
      "/tmp",
    );
    expect(options.command).toBe("read");
    expect(options.timeouts.turnMs).toBe(1234);
  });

  test("rejects a relative campaign", () => {
    expect(() => parseArgs(["read", "--campaign", "relative"], "/tmp")).toThrow(
      "campaign_not_absolute",
    );
  });

  test("rejects misspelled option names", () => {
    expect(() =>
      parseArgs(["read", "--campaign", "/tmp/run", "--trunMs", "1"], "/tmp"),
    ).toThrow("unknown_option");
  });

  test("filters credentials and unrelated configuration", () => {
    const environment = buildChildEnvironment({
      source: {
        PATH: "/bin",
        LANG: "C",
        GITHUB_TOKEN: "operator-token",
        AWS_SECRET_ACCESS_KEY: "cloud-secret",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        CODEX_CONFIG: "operator-config",
      },
      codexHome: "/campaign/codex-home",
      agentHome: "/campaign/run/agent-home",
      scenario: "read",
    });
    expect(environment).toEqual({
      PATH: "/bin",
      LANG: "C",
      HOME: "/campaign/run/agent-home",
      CODEX_HOME: "/campaign/codex-home",
      NO_COLOR: "1",
      CI: "1",
    });
    expect(leakedKeys(environment)).toEqual([]);
  });

  test("gives pr the operator home and no credential variables", () => {
    const environment = buildChildEnvironment({
      source: { PATH: "/bin", GH_TOKEN: "operator", HOME: "/Users/operator" },
      codexHome: "/campaign/codex-home",
      agentHome: "/campaign/run/agent-home",
      scenario: "pr",
      operatorHome: "/Users/operator",
    });
    expect(environment.HOME).toBe("/Users/operator");
    expect(environment.GH_TOKEN).toBeUndefined();
    expect(environment.GIT_TERMINAL_PROMPT).toBe("0");
    expect(leakedKeys(environment)).toEqual([]);
    expect(() =>
      buildChildEnvironment({
        source: { PATH: "/bin" },
        codexHome: "/campaign/codex-home",
        agentHome: "/campaign/run/agent-home",
        scenario: "pr",
      }),
    ).toThrow();
  });

  test("keeps every other scenario in the empty run-local home", () => {
    expect(
      buildChildEnvironment({
        source: { PATH: "/bin", HOME: "/Users/operator" },
        codexHome: "/campaign/codex-home",
        agentHome: "/campaign/run/agent-home",
        scenario: "edit",
      }).HOME,
    ).toBe("/campaign/run/agent-home");
  });

  for (const linkedPath of ["config", "refs", "objects"]) {
    test(`rejects linked copied Git ${linkedPath}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "probe-linked-git-"));
      const external = await mkdtemp(join(tmpdir(), "probe-external-git-"));
      await mkdir(join(root, ".git"), { recursive: true });
      await writeFile(join(external, "target"), "external\n");
      if (linkedPath === "config") {
        await symlink(join(external, "target"), join(root, ".git", "config"));
      } else {
        await writeFile(
          join(root, ".git", "config"),
          '[remote "origin"]\n\turl = https://github.com/alundgren/irudd-factory-agent-testing.git\n',
        );
        await symlink(external, join(root, ".git", linkedPath));
      }
      await expect(
        sanitizeCopiedGitDirectory(
          root,
          "https://github.com/alundgren/irudd-factory-agent-testing.git",
        ),
      ).rejects.toMatchObject({ code: "git_metadata_link_rejected" });
    });
  }

  test("requires usable data in the isolated file credential store", async () => {
    const root = await mkdtemp(join(tmpdir(), "probe-auth-"));
    await writeFile(join(root, "auth.json"), "{}");
    expect(await providerAuthReady(root)).toBe(false);
    await writeFile(
      join(root, "auth.json"),
      JSON.stringify({ tokens: { access_token: "synthetic" } }),
    );
    expect(await providerAuthReady(root)).toBe(true);
  });

  test("constructs only the isolated file-store configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "probe-config-"));
    const campaign = await initializeCampaign(root);
    const config = await Bun.file(
      join(campaign.codexHome, "config.toml"),
    ).text();
    expect(config).toContain('cli_auth_credentials_store = "file"');
    expect(config).toContain('sandbox_mode = "read-only"');
    expect(config).toContain("[mcp_servers]");
    expect(config).not.toContain("keyring");
    expect(config).not.toContain("auto");
  });

  test("removes copied Git credentials, hooks, and external object references", async () => {
    const root = await mkdtemp(join(tmpdir(), "probe-git-policy-"));
    await mkdir(join(root, ".git", "hooks"), { recursive: true });
    await mkdir(join(root, ".git", "objects", "info"), { recursive: true });
    await writeFile(
      join(root, ".git", "config"),
      '[core]\n\tbare = false\n[credential]\n\thelper = operator-helper\n[remote "origin"]\n\turl = https://github.com/alundgren/irudd-factory-agent-testing.git\n',
    );
    await writeFile(
      join(root, ".git", "hooks", "pre-commit"),
      "operator hook\n",
    );
    await writeFile(
      join(root, ".git", "objects", "info", "alternates"),
      "/operator/objects\n",
    );
    await sanitizeCopiedGitDirectory(
      root,
      "https://github.com/alundgren/irudd-factory-agent-testing.git",
    );
    expect(await readLocalOrigin(root)).toBe(
      "https://github.com/alundgren/irudd-factory-agent-testing.git",
    );
    const config = await Bun.file(join(root, ".git", "config")).text();
    expect(config).not.toContain("operator-helper");
    expect(
      await Bun.file(join(root, ".git", "hooks", "pre-commit")).exists(),
    ).toBe(false);
    expect(
      await Bun.file(
        join(root, ".git", "objects", "info", "alternates"),
      ).exists(),
    ).toBe(false);
  });

  test("rejects path escapes before and after symlink resolution", async () => {
    expect(() => plannedWithin("/campaign", "/other/run", "run")).toThrow(
      "path_outside_allowed_root",
    );
    const root = await mkdtemp(join(tmpdir(), "probe-path-"));
    const child = join(root, "child");
    await mkdir(child);
    expect(isWithin(root, child)).toBe(true);
    expect(await requireWithin(root, child, "child")).toBe(
      await realpath(child),
    );
  });

  test("computes a stable schema digest and rejects missing coverage", async () => {
    const root = await mkdtemp(join(tmpdir(), "probe-schema-"));
    const names = [
      "InitializeParams",
      "ThreadStartParams",
      "ThreadStartedNotification",
      "TurnStartParams",
      "TurnCompletedNotification",
      "TurnInterruptParams",
      "ItemStartedNotification",
      "ItemCompletedNotification",
      "CommandExecutionRequestApprovalParams",
      "FileChangeRequestApprovalParams",
      "PermissionsRequestApprovalParams",
      "ServerRequestResolvedNotification",
      "ThreadTokenUsageUpdatedNotification",
      "ErrorNotification",
      "ModelReroutedNotification",
    ];
    for (const name of names) {
      const path =
        name === "TurnStartParams"
          ? join(root, "v2", `${name}.json`)
          : join(root, `${name}.json`);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(
        path,
        name === "TurnStartParams"
          ? JSON.stringify(supportedTurnSchema())
          : `{ "title": "${name}" }`,
      );
    }
    const first = await inspectSchemas(root);
    const second = await inspectSchemas(root);
    expect(first.digest).toBe(second.digest);
    await expect(requireScenarioSandboxSchema(root)).resolves.toBeUndefined();
    const incomplete = await mkdtemp(join(tmpdir(), "probe-schema-missing-"));
    await writeFile(join(incomplete, "InitializeParams.json"), "{}");
    await expect(inspectSchemas(incomplete)).rejects.toBeInstanceOf(ProbeError);
  });

  test("rejects an installed schema without the scenario sandbox policies", async () => {
    const root = await mkdtemp(join(tmpdir(), "probe-schema-policy-"));
    await mkdir(join(root, "v2"));
    await writeFile(
      join(root, "v2", "TurnStartParams.json"),
      '{"type":"object"}',
    );
    await expect(requireScenarioSandboxSchema(root)).rejects.toMatchObject({
      code: "scenario_sandbox_schema_unsupported",
    });
  });

  test("rejects scenario fields declared outside the sandbox definitions", async () => {
    const root = await mkdtemp(join(tmpdir(), "probe-schema-decoy-"));
    await mkdir(join(root, "v2"));
    await writeFile(
      join(root, "v2", "TurnStartParams.json"),
      JSON.stringify({
        description:
          "workspaceWrite writableRoots networkAccess excludeSlashTmp excludeTmpdirEnvVar",
        type: "object",
        properties: { sandboxPolicy: { type: "string" } },
      }),
    );
    await expect(requireScenarioSandboxSchema(root)).rejects.toMatchObject({
      code: "scenario_sandbox_schema_unsupported",
    });
  });
});

function supportedTurnSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      sandboxPolicy: {
        anyOf: [{ $ref: "#/definitions/SandboxPolicy" }, { type: "null" }],
      },
    },
    definitions: {
      SandboxPolicy: {
        oneOf: [
          {
            properties: {
              type: { enum: ["readOnly"] },
              networkAccess: { type: "boolean" },
            },
          },
          {
            properties: {
              type: { enum: ["workspaceWrite"] },
              writableRoots: { type: "array" },
              networkAccess: { type: "boolean" },
              excludeSlashTmp: { type: "boolean" },
              excludeTmpdirEnvVar: { type: "boolean" },
            },
          },
        ],
      },
    },
  };
}
