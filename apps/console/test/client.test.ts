import { Effect } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { runCommandEffect } from "../src/client.ts";
import { ServiceRejection, TransportFailure } from "../src/errors.ts";

describe("console RPC command boundary", () => {
  test("preserves declared service errors outside Effect", async () => {
    const result = runCommandEffect(
      Effect.fail("repository_not_configured: Repository is not configured"),
    );
    await expect(result).rejects.toBeInstanceOf(ServiceRejection);
  });

  test("classifies client failures as transport failures", async () => {
    const result = runCommandEffect(Effect.fail(new TypeError("fetch failed")));
    await expect(result).rejects.toBeInstanceOf(TransportFailure);
  });
});
