#!/usr/bin/env bun
import { parseArgs } from "./config.ts";
import { runDoctor } from "./doctor.ts";
import { Redactor } from "./redaction.ts";
import { runScenario } from "./scenarios.ts";
import { ProbeError } from "./types.ts";

const redactor = new Redactor([]);

try {
  const options = parseArgs(Bun.argv.slice(2), process.cwd());
  const outcome =
    options.command === "doctor"
      ? await runDoctor(options)
      : await runScenario(options);
  process.stderr.write(`result=${outcome.result}\nrun=${outcome.runRoot}\n`);
  process.exitCode =
    outcome.result === "completed" || outcome.result === "interrupted" ? 0 : 1;
} catch (error) {
  const probeError =
    error instanceof ProbeError
      ? error
      : new ProbeError(
          "protocol_error",
          "uncaught_error",
          redactor.error(error),
        );
  process.stderr.write(`${probeError.code}: ${redactor.error(probeError)}\n`);
  process.exitCode = 1;
}
