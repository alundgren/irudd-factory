import { ProbeError } from "./types.ts";

export interface ManagedProcess {
  process: Bun.Subprocess<"pipe", "pipe", "pipe">;
  pid: number;
  exited: Promise<number>;
}

export interface TerminationResult {
  code: number;
  signal: "SIGTERM" | "SIGKILL";
}

export function spawnManaged(options: {
  command: string[];
  cwd: string;
  env: Record<string, string>;
}): ManagedProcess {
  if (
    options.command.length === 0 ||
    options.command.some((part) => part.includes("\0"))
  ) {
    throw new ProbeError(
      "rejected",
      "invalid_command",
      "Child command must be a nonempty argument array",
    );
  }
  const process = Bun.spawn(options.command, {
    cwd: options.cwd,
    env: options.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  if (!process.pid || process.pid <= 1) {
    throw new ProbeError(
      "provider_exited",
      "child_not_started",
      "Child process did not return a valid PID",
    );
  }
  return { process, pid: process.pid, exited: process.exited };
}

function signalOwnedGroup(child: ManagedProcess, signal: NodeJS.Signals): void {
  if (child.process.pid !== child.pid || child.pid <= 1) {
    throw new ProbeError(
      "assertion_failed",
      "process_identity_changed",
      "Refusing to signal an unverified process",
    );
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") throw error;
  }
}

export async function terminateOwnedGroup(
  child: ManagedProcess,
  graceMs: number,
  signalGroup: (
    child: ManagedProcess,
    signal: NodeJS.Signals,
  ) => void = signalOwnedGroup,
): Promise<TerminationResult> {
  signalGroup(child, "SIGTERM");
  const graceful = await Promise.race([
    child.exited.then((code) => ({ exited: true as const, code })),
    Bun.sleep(graceMs).then(() => ({ exited: false as const, code: -1 })),
  ]);
  if (graceful.exited) return { code: graceful.code, signal: "SIGTERM" };
  signalGroup(child, "SIGKILL");
  const forced = await Promise.race([
    child.exited.then((code) => ({ exited: true as const, code })),
    Bun.sleep(graceMs).then(() => ({ exited: false as const, code: -1 })),
  ]);
  if (forced.exited) return { code: forced.code, signal: "SIGKILL" };
  throw new ProbeError(
    "timed_out",
    "cleanup_timeout",
    `Owned process group did not exit within ${graceMs}ms after SIGKILL`,
    { pid: child.pid, lastSignal: "SIGKILL" },
  );
}
