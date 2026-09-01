import { FactoryError } from "@irudd-factory/application";
import { spawn } from "node:child_process";

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface CommandRunner {
  readonly run: (
    args: ReadonlyArray<string>,
    input?: string,
  ) => Promise<CommandResult>;
}

export const nodeCommandRunner: CommandRunner = {
  run: async (args, input) => {
    if (args.length === 0 || args.some((part) => part.includes("\0"))) {
      throw new FactoryError({
        code: "github_command_invalid",
        message: "GitHub command must be a nonempty argument array",
      });
    }
    const [executable, ...commandArgs] = args;
    if (!executable) {
      throw new FactoryError({
        code: "github_command_invalid",
        message: "GitHub command must be a nonempty argument array",
      });
    }
    const child = spawn(executable, commandArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (input !== undefined) {
      child.stdin.write(input);
    }
    child.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      readStream(child.stdout),
      readStream(child.stderr),
      exitCodeFor(child),
    ]);
    return { stdout, stderr, exitCode };
  },
};

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  let output = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) output += String(chunk);
  return output;
}

function exitCodeFor(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", (error) =>
      reject(
        new FactoryError({
          code: "github_command_failed",
          message: `GitHub command failed to start: ${error.message}`,
        }),
      ),
    );
    child.once("close", (code) => resolve(code ?? 1));
  });
}
