import { spawn } from "node:child_process";
import { FactoryError } from "@irudd-factory/application";
import { runFixtureCommand } from "../fixtures/command.ts";

async function buildConsole(): Promise<void> {
  await new Promise<void>((resolveBuild, rejectBuild) => {
    const child = spawn("vp", ["run", "build:console"], { stdio: "inherit" });
    child.once("error", (error) =>
      rejectBuild(
        new FactoryError({
          code: "fixture_build_failed",
          message: "Fixture console build could not start",
          detail: String(error),
        }),
      ),
    );
    child.once("exit", (code, signal) => {
      if (code === 0) resolveBuild();
      else
        rejectBuild(
          new FactoryError({
            code: "fixture_build_failed",
            message: `Fixture console build failed with ${signal ?? code}`,
          }),
        );
    });
  });
}

process.exitCode = await runFixtureCommand(
  process.argv.slice(2),
  process.env,
  {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  },
  {
    buildConsole,
    launch: async (fixture) => {
      const { launchFixture } = await import("../fixtures/launch.ts");
      await launchFixture(fixture);
    },
  },
);
