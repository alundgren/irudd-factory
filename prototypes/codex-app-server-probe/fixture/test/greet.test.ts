import { expect, test } from "bun:test";
import { greeting } from "../src/greet.ts";

test("returns the fixture greeting", () => {
  expect(greeting()).toBe("Hello, probe!");
});
