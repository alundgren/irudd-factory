#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { initializeCampaign } from "./config.ts";
import { buildChildEnvironment } from "./environment.ts";
import { ProbeError } from "./types.ts";

const campaignIndex = Bun.argv.indexOf("--campaign");
const campaignValue =
  campaignIndex >= 0 ? Bun.argv[campaignIndex + 1] : undefined;
const codexIndex = Bun.argv.indexOf("--codex");
const codexExecutable = codexIndex >= 0 ? Bun.argv[codexIndex + 1] : "codex";

if (!campaignValue || !campaignValue.startsWith("/")) {
  throw new ProbeError(
    "rejected",
    "campaign_required",
    "Usage: bun run login --campaign /absolute/campaign",
  );
}

const campaign = await initializeCampaign(resolve(campaignValue));
const loginHome = join(campaign.campaignRoot, "login-home");
await mkdir(loginHome, { recursive: true, mode: 0o700 });
const environment = buildChildEnvironment({
  codexHome: campaign.codexHome,
  agentHome: loginHome,
  scenario: "doctor",
});
delete environment.CI;
const child = Bun.spawn([codexExecutable ?? "codex", "login"], {
  cwd: campaign.campaignRoot,
  env: environment,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exitCode = await child.exited;
