import { describe, expect, test } from "vite-plus/test";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { FIXTURE_REGISTRY } from "../fixtures/registry.ts";

describe("fixture import boundaries", () => {
  test("keeps production entry points and exports independent of fixtures", async () => {
    for (const path of [
      "apps/service/src/main.ts",
      "apps/service/src/index.ts",
      "apps/service/src/service.ts",
    ]) {
      const source = await readFile(resolve(path), "utf8");
      expect(source).not.toMatch(/fixtures\//);
    }
  });

  test("keeps concrete production adapters out of fixture definitions", async () => {
    const forbidden = [
      "@irudd-factory/github",
      "@irudd-factory/workspaces",
      "@irudd-factory/codex",
    ];
    const directories = (
      await readdir(resolve("apps/service/fixtures"), { withFileTypes: true })
    ).filter((entry) => entry.isDirectory());
    expect(directories).toHaveLength(FIXTURE_REGISTRY.length);
    for (const fixture of FIXTURE_REGISTRY) {
      const source = await readFile(
        resolve(`apps/service/fixtures/${fixture.name}/fixture.ts`),
        "utf8",
      );
      for (const moduleName of forbidden) {
        expect(source).not.toContain(moduleName);
      }
    }
  });
});
