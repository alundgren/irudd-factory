import {
  FactoryError,
  type FactoryErrorCode,
} from "@irudd-factory/application";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export interface ManagedProcess {
  readonly process: ChildProcessWithoutNullStreams;
  readonly pid: number;
  readonly exited: Promise<number | null>;
  hasExited: boolean;
}

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: "SIGTERM" | "SIGKILL" | null;
  readonly cleanupTimedOut: boolean;
}

export function getProcessStartIdentity(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const startTime = fields[19];
    if (!startTime) throw new Error("missing start time");
    return `${pid}:${startTime}`;
  } catch (error) {
    throw new FactoryError({
      code: "process_identity_changed",
      message: `Could not read the start identity for process ${pid}`,
      detail: String(error),
    });
  }
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
  const [executable, ...args] = command;
  if (!executable) {
    throw new FactoryError({
      code: "provider_command_invalid",
      message: "Provider command must be a nonempty argument array",
    });
  }
  const childProcess = spawn(executable, args, {
    cwd,
    env: processEnv(),
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  if (!childProcess.pid || childProcess.pid <= 1) {
    childProcess.once("error", () => {});
    throw new FactoryError({
      code: "child_startup_failed",
      message: "Codex did not return a valid process ID",
    });
  }
  const managed: ManagedProcess = {
    process: childProcess,
    pid: childProcess.pid,
    exited: Promise.resolve(-1),
    hasExited: false,
  };
  const exited = new Promise<number | null>((resolve, reject) => {
    childProcess.once("error", (error) => {
      managed.hasExited = true;
      reject(
        new FactoryError({
          code: "child_startup_failed",
          message: `Codex process failed to start: ${error.message}`,
        }),
      );
    });
    childProcess.once("close", (code) => {
      managed.hasExited = true;
      resolve(code);
    });
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
): Promise<number | null | undefined> {
  if (child.hasExited) return child.exited;
  if (milliseconds <= 0) return undefined;
  return Promise.race([
    child.exited,
    delay(milliseconds).then(() => undefined),
  ]);
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
  if (graceful !== undefined) {
    return { code: graceful, signal: "SIGTERM", cleanupTimedOut: false };
  }
  signal(child, "SIGKILL");
  const forced = await waitUntil(child, Math.max(0, deadline - Date.now()));
  return forced === undefined
    ? { code: null, signal: "SIGKILL", cleanupTimedOut: true }
    : { code: forced, signal: "SIGKILL", cleanupTimedOut: false };
}

export async function runManagedCommand(options: {
  readonly command: ReadonlyArray<string>;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly timeoutCode: FactoryErrorCode;
  readonly terminateProcessGroup?: (
    child: ManagedProcess,
    shutdownMs: number,
  ) => Promise<ProcessExit>;
}): Promise<{ stdout: string; stderr: string; code: number }> {
  const child = spawnManaged(options.command, options.cwd);
  const stdoutPromise = readStream(child.process.stdout);
  const stderrPromise = readStream(child.process.stderr);
  const result = await Promise.race([
    child.exited.then((code) => ({ _tag: "exit" as const, code })),
    delay(options.timeoutMs).then(() => ({ _tag: "timeout" as const })),
  ]);
  if (result._tag === "timeout") {
    let cleanup: ProcessExit;
    try {
      cleanup = await (options.terminateProcessGroup ?? terminateOwnedGroup)(
        child,
        Math.min(options.timeoutMs, 1_000),
      );
    } catch {
      cleanup = { code: null, signal: null, cleanupTimedOut: true };
    }
    throw new FactoryError({
      code: options.timeoutCode,
      message: `Provider command exceeded ${options.timeoutMs} ms`,
      ...(cleanup.cleanupTimedOut ? { detail: "cleanup_timeout" } : {}),
    });
  }
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (result.code === null) {
    throw new FactoryError({
      code: options.timeoutCode,
      message: "Provider command exited after receiving a signal",
    });
  }
  return { stdout, stderr, code: result.code };
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  let output = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) output += String(chunk);
  return output;
}
