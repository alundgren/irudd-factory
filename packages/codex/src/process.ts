import { FactoryError } from "@irudd-factory/application";

export interface ManagedProcess {
  readonly process: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly pid: number;
  readonly exited: Promise<number>;
  hasExited: boolean;
}

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: "SIGTERM" | "SIGKILL" | null;
  readonly cleanupTimedOut: boolean;
}

export function spawnManaged(
  command: ReadonlyArray<string>,
  cwd: string,
): ManagedProcess {
  if (command.length === 0 || command.some((part) => part.includes("\0"))) {
    throw new FactoryError({
      code: "provider_command_invalid",
      message: "Provider command must be a nonempty argument array",
    });
  }
  const process = Bun.spawn([...command], {
    cwd,
    env: processEnv(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  if (!process.pid || process.pid <= 1) {
    throw new FactoryError({
      code: "child_startup_failed",
      message: "Codex did not return a valid process ID",
    });
  }
  const managed: ManagedProcess = {
    process,
    pid: process.pid,
    exited: Promise.resolve(-1),
    hasExited: false,
  };
  const exited = process.exited.then((code) => {
    managed.hasExited = true;
    return code;
  });
  Object.defineProperty(managed, "exited", { value: exited });
  return managed;
}

function processEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function signalGroup(child: ManagedProcess, signal: NodeJS.Signals): void {
  if (child.hasExited) return;
  if (child.process.pid !== child.pid || child.pid <= 1) {
    throw new FactoryError({
      code: "process_identity_changed",
      message: "Refusing to signal an unverified Codex process group",
    });
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitUntil(
  child: ManagedProcess,
  milliseconds: number,
): Promise<number | null> {
  if (child.hasExited) return child.exited;
  if (milliseconds <= 0) return null;
  return Promise.race([child.exited, Bun.sleep(milliseconds).then(() => null)]);
}

export async function terminateOwnedGroup(
  child: ManagedProcess,
  shutdownMs: number,
  signal: (child: ManagedProcess, signal: NodeJS.Signals) => void = signalGroup,
): Promise<ProcessExit> {
  if (child.hasExited) {
    return { code: await child.exited, signal: null, cleanupTimedOut: false };
  }
  const deadline = Date.now() + shutdownMs;
  signal(child, "SIGTERM");
  const termWait = Math.min(250, Math.max(0, Math.floor(shutdownMs / 2)));
  const graceful = await waitUntil(child, termWait);
  if (graceful !== null) {
    return { code: graceful, signal: "SIGTERM", cleanupTimedOut: false };
  }
  signal(child, "SIGKILL");
  const forced = await waitUntil(child, Math.max(0, deadline - Date.now()));
  return forced === null
    ? { code: null, signal: "SIGKILL", cleanupTimedOut: true }
    : { code: forced, signal: "SIGKILL", cleanupTimedOut: false };
}

export async function runManagedCommand(options: {
  readonly command: ReadonlyArray<string>;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly timeoutCode: string;
}): Promise<{ stdout: string; stderr: string; code: number }> {
  const child = spawnManaged(options.command, options.cwd);
  const stdoutPromise = new Response(child.process.stdout).text();
  const stderrPromise = new Response(child.process.stderr).text();
  const result = await Promise.race([
    child.exited.then((code) => ({ _tag: "exit" as const, code })),
    Bun.sleep(options.timeoutMs).then(() => ({ _tag: "timeout" as const })),
  ]);
  if (result._tag === "timeout") {
    await terminateOwnedGroup(child, Math.min(options.timeoutMs, 1_000));
    throw new FactoryError({
      code: options.timeoutCode,
      message: `Provider command exceeded ${options.timeoutMs} ms`,
    });
  }
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  return { stdout, stderr, code: result.code };
}
