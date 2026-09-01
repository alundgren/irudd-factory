import { getFactorySnapshot, runNextEligibleIssue } from "./client.ts";

const DEFAULT_RPC_URL = "http://127.0.0.1:4317/rpc";
const USAGE = `usage: factory <run-next --command-id ID|snapshot> [--url ${DEFAULT_RPC_URL}]`;

const [command, ...args] = process.argv.slice(2);
const values = new Map<string, string>();
for (let index = 0; index < args.length; index += 2) {
  const key = args[index];
  const value = args[index + 1];
  if (!key?.startsWith("--") || !value) {
    console.error(USAGE);
    process.exit(2);
  }
  values.set(key.slice(2), value);
}
const url = values.get("url") ?? DEFAULT_RPC_URL;

try {
  if (command === "run-next") {
    const commandId = values.get("command-id");
    if (!commandId) {
      console.error("run-next requires --command-id");
      process.exit(2);
    }
    console.log(
      JSON.stringify(await runNextEligibleIssue(url, commandId), null, 2),
    );
  } else if (command === "snapshot") {
    console.log(JSON.stringify(await getFactorySnapshot(url), null, 2));
  } else {
    console.error(USAGE);
    process.exit(2);
  }
} catch (error) {
  console.error(String(error));
  process.exit(1);
}
