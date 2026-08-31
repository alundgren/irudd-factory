import { resolve } from "node:path";

const target = process.argv[2];
const filter = process.argv[3];

if (!target) {
  console.error("usage: bun scripts/test-suite.ts <component|all> [test name]");
  process.exit(2);
}

const roots =
  target === "all"
    ? [
        "packages/contracts",
        "packages/application",
        "packages/state-sqlite",
        "packages/github",
        "packages/workspaces",
        "packages/codex",
        "apps/service",
        "apps/cli",
        "apps/console",
      ]
    : [target];

const tests = roots.map((root) => resolve(root, "test"));
const command = ["bun", "test", ...tests];
if (filter) command.push("--test-name-pattern", filter);

const child = Bun.spawn(command, {
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, FORCE_COLOR: "0" },
});
const [stdout, stderr, exitCode] = await Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
  child.exited,
]);

if (exitCode === 0) {
  console.log(`PASS ${target}${filter ? ` (${filter})` : ""}`);
} else {
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  console.error(`FAIL ${target}${filter ? ` (${filter})` : ""}`);
  process.exit(exitCode);
}
