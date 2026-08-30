import { FactoryError } from "@irudd-factory/application";

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

export const bunCommandRunner: CommandRunner = {
  run: async (args, input) => {
    if (args.length === 0 || args.some((part) => part.includes("\0"))) {
      throw new FactoryError({
        code: "github_command_invalid",
        message: "GitHub command must be a nonempty argument array",
      });
    }
    const child = Bun.spawn([...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (input !== undefined) {
      child.stdin.write(input);
    }
    child.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  },
};
