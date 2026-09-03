import { FactoryError, asFactoryError } from "@irudd-factory/application";
import {
  fixtureCatalogEntry,
  fixtureDescription,
  renderFixtureCatalog,
  renderFixtureDescription,
} from "./catalog.ts";
import { FIXTURE_REGISTRY, getFixture } from "./registry.ts";
import type { FixtureDefinition } from "./types.ts";

const USAGE = "usage: vp run fixture [--json] | <name> [--describe [--json]]";

export interface FixtureCommandIO {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

export interface FixtureCommandActions {
  readonly buildConsole: () => Promise<void>;
  readonly launch: (fixture: FixtureDefinition) => Promise<void>;
}

function invalid(message: string): FactoryError {
  return new FactoryError({ code: "fixture_arguments_invalid", message });
}

function writeFailure(io: FixtureCommandIO, error: FactoryError): number {
  io.stderr(`${error.code}: ${error.message}\n${USAGE}\n`);
  return 2;
}

export async function runFixtureCommand(
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
  io: FixtureCommandIO,
  actions: FixtureCommandActions,
): Promise<number> {
  if (args.length === 0) {
    io.stdout(`${renderFixtureCatalog(FIXTURE_REGISTRY)}\n`);
    return 0;
  }
  if (args.length === 1 && args[0] === "--json") {
    io.stdout(`${JSON.stringify(FIXTURE_REGISTRY.map(fixtureCatalogEntry))}\n`);
    return 0;
  }

  const name = args[0];
  if (!name || name.startsWith("--"))
    return writeFailure(io, invalid("A fixture name is required"));
  const fixture = getFixture(name);
  if (!fixture) return writeFailure(io, invalid(`Unknown fixture: ${name}`));

  if (args.length === 2 && args[1] === "--describe") {
    io.stdout(`${renderFixtureDescription(fixture)}\n`);
    return 0;
  }
  if (args.length === 3 && args[1] === "--describe" && args[2] === "--json") {
    io.stdout(`${JSON.stringify(fixtureDescription(fixture))}\n`);
    return 0;
  }
  if (args.length !== 1) {
    return writeFailure(
      io,
      invalid("Arguments cannot be combined in that form"),
    );
  }
  if (environment.NODE_ENV === "production") {
    return writeFailure(
      io,
      new FactoryError({
        code: "fixture_production_forbidden",
        message: "Fixtures cannot launch when NODE_ENV=production",
      }),
    );
  }

  try {
    await actions.buildConsole();
    await actions.launch(fixture);
    return 0;
  } catch (error) {
    const failure = asFactoryError(error);
    io.stderr(`${failure.code}: ${failure.message}\n`);
    return 1;
  }
}
