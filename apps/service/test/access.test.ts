import { describe, expect, test } from "vite-plus/test";
import { decideAccess, decodeRfc2047Header } from "../src/access.ts";

function request(
  headers: ReadonlyArray<readonly [string, string]>,
  url = "/rpc",
) {
  return {
    url,
    rawHeaders: headers.flatMap(([name, value]) => [name, value]),
  };
}

const LOCAL = { mode: "local" as const };
const TAILSCALE = {
  mode: "tailscale" as const,
  operatorLogin: "büro@example.com",
  localCliPort: 4318,
};

describe("access decisions", () => {
  test("accepts local CLI and same-origin browser requests", () => {
    expect(decideAccess(request([]), LOCAL)).toEqual({ allowed: true });
    expect(
      decideAccess(
        request([
          ["Host", "127.0.0.1:4317"],
          ["Origin", "http://127.0.0.1:4317"],
        ]),
        LOCAL,
      ),
    ).toEqual({ allowed: true });
  });

  test.each([
    {
      headers: [
        ["Host", "127.0.0.1:4317"],
        ["Origin", "http://foreign.example"],
      ],
    },
    {
      headers: [
        ["Host", "127.0.0.1:4317"],
        ["Origin", "null"],
      ],
    },
    {
      headers: [
        ["Host", "127.0.0.1:4317"],
        ["Origin", "https://127.0.0.1:4317"],
      ],
    },
    {
      headers: [
        ["Host", "127.0.0.1:4317"],
        ["Origin", "http://127.0.0.1:4317/path"],
      ],
    },
    {
      headers: [
        ["Host", "127.0.0.1:4317"],
        ["Origin", "http://127.0.0.1:4317"],
        ["Origin", "http://127.0.0.1:4317"],
      ],
    },
  ] as ReadonlyArray<{
    readonly headers: ReadonlyArray<readonly [string, string]>;
  }>)("rejects an invalid local browser origin %#", ({ headers }) => {
    expect(decideAccess(request(headers), LOCAL)).toMatchObject({
      allowed: false,
      reason: "origin_rejected",
    });
  });

  test("decodes plain, Q-encoded, B-encoded, and adjacent identity words", () => {
    expect(decodeRfc2047Header("operator@example.com")).toBe(
      "operator@example.com",
    );
    expect(decodeRfc2047Header("=?utf-8?q?b=C3=BCro@example.com?=")).toBe(
      "büro@example.com",
    );
    expect(decodeRfc2047Header("=?UTF-8?B?YsO8cm9AZXhhbXBsZS5jb20=?=")).toBe(
      "büro@example.com",
    );
    expect(
      decodeRfc2047Header("=?utf-8?q?b=C3=BCro?= =?us-ascii?q?@example.com?="),
    ).toBe("büro@example.com");
  });

  test.each([
    "=?utf-8?q?broken=ZZ?=",
    "=?utf-16?q?login?=",
    "=?utf-8?x?login?=",
    "=?utf-8?b?not-base64?=",
    "=?utf-8?q?unfinished",
    "=?utf-8?q??=",
    `=?utf-8?q?${"a".repeat(64)}?=`,
    '"büro@example.com"',
  ])("rejects malformed identity encoding %s", (value) => {
    expect(decodeRfc2047Header(value)).toBeNull();
  });

  test("accepts an authenticated Tailscale browser RPC request", () => {
    expect(
      decideAccess(
        request([
          ["Host", "factory.tailnet.ts.net"],
          ["Origin", "https://factory.tailnet.ts.net"],
          ["Tailscale-User-Login", "=?utf-8?q?b=C3=BCro@example.com?="],
        ]),
        TAILSCALE,
      ),
    ).toEqual({ allowed: true });
  });

  test("normalizes Host ports for HTTPS", () => {
    const headers = (host: string) =>
      [
        ["Host", host],
        ["Origin", "https://factory.tailnet.ts.net"],
        ["Tailscale-User-Login", "=?utf-8?q?b=C3=BCro@example.com?="],
      ] as const;
    expect(
      decideAccess(request(headers("factory.tailnet.ts.net:443")), TAILSCALE),
    ).toEqual({
      allowed: true,
    });
    expect(
      decideAccess(request(headers("factory.tailnet.ts.net:80")), TAILSCALE)
        .allowed,
    ).toBe(false);
  });

  test("rejects malformed US-ASCII before comparing identity", () => {
    expect(decodeRfc2047Header("=?us-ascii?q?=FF@example.com?=")).toBeNull();
    expect(
      decideAccess(
        request([
          ["Host", "factory.tailnet.ts.net"],
          ["Origin", "https://factory.tailnet.ts.net"],
          ["Tailscale-User-Login", "=?us-ascii?q?=FF@example.com?="],
        ]),
        { ...TAILSCALE, operatorLogin: "ÿ@example.com" },
      ),
    ).toMatchObject({ allowed: false, reason: "identity_rejected" });
  });

  test("rejects a browser RPC request with no Origin after identity validation", () => {
    expect(
      decideAccess(
        request([
          ["Host", "factory.tailnet.ts.net"],
          ["Tailscale-User-Login", "=?utf-8?q?b=C3=BCro@example.com?="],
        ]),
        TAILSCALE,
      ),
    ).toMatchObject({ allowed: false, reason: "origin_rejected" });
  });

  test("does not accept alternate forwarded identity headers", () => {
    expect(
      decideAccess(
        request([
          ["Host", "factory.tailnet.ts.net"],
          ["Origin", "https://factory.tailnet.ts.net"],
          ["X-Forwarded-User", "büro@example.com"],
          ["Tailscale-User-Name", "büro@example.com"],
        ]),
        TAILSCALE,
      ),
    ).toMatchObject({ allowed: false, reason: "identity_rejected" });
  });

  test("rejects malformed identity encoding through the request decision", () => {
    for (const value of [
      "=?utf-8?q?broken=ZZ?=",
      "=?utf-8?q?b=C3=BCro?=@example.com",
    ]) {
      expect(
        decideAccess(
          request([
            ["Host", "factory.tailnet.ts.net"],
            ["Origin", "https://factory.tailnet.ts.net"],
            ["Tailscale-User-Login", value],
          ]),
          TAILSCALE,
        ),
      ).toMatchObject({ allowed: false, reason: "identity_rejected" });
    }
  });

  test.each([
    { headers: [] },
    { headers: [["Host", "factory.tailnet.ts.net"]] },
    {
      headers: [
        ["Host", "factory.tailnet.ts.net:"],
        ["Origin", "https://factory.tailnet.ts.net"],
        ["Tailscale-User-Login", "=?utf-8?q?b=C3=BCro@example.com?="],
      ],
    },
    {
      headers: [
        ["Host", "factory.tailnet.ts.net"],
        ["Host", "factory.tailnet.ts.net"],
        ["Origin", "https://factory.tailnet.ts.net"],
        ["Tailscale-User-Login", "=?utf-8?q?b=C3=BCro@example.com?="],
      ],
    },
    {
      headers: [
        ["Host", "factory.tailnet.ts.net"],
        ["Origin", "https://foreign.tailnet.ts.net"],
        ["Tailscale-User-Login", "=?utf-8?q?b=C3=BCro@example.com?="],
      ],
    },
    {
      headers: [
        ["Host", "factory.tailnet.ts.net"],
        ["Origin", "https://factory.tailnet.ts.net"],
        ["Tailscale-User-Login", "other@example.com"],
      ],
    },
    {
      headers: [
        ["Host", "factory.tailnet.ts.net"],
        ["Origin", "https://factory.tailnet.ts.net"],
        ["Tailscale-User-Login", "=?utf-8?q?b=C3=BCro@example.com?="],
        ["Tailscale-User-Login", "=?utf-8?q?b=C3=BCro@example.com?="],
      ],
    },
  ] as ReadonlyArray<{
    readonly headers: ReadonlyArray<readonly [string, string]>;
  }>)("rejects invalid Tailscale forwarding %#", ({ headers }) => {
    expect(decideAccess(request(headers), TAILSCALE).allowed).toBe(false);
  });

  test("allows static Tailscale requests without Origin after identity checks", () => {
    expect(
      decideAccess(
        request(
          [
            ["Host", "factory.tailnet.ts.net"],
            ["Tailscale-User-Login", "=?utf-8?q?b=C3=BCro@example.com?="],
          ],
          "/",
        ),
        TAILSCALE,
      ),
    ).toEqual({ allowed: true });
  });

  test("keeps the local CLI listener origin-less and RPC-only", () => {
    expect(decideAccess(request([]), TAILSCALE, "local-cli")).toEqual({
      allowed: true,
    });
    expect(
      decideAccess(
        request([["Origin", "https://factory.tailnet.ts.net"]]),
        TAILSCALE,
        "local-cli",
      ).allowed,
    ).toBe(false);
    expect(
      decideAccess(request([], "/"), TAILSCALE, "local-cli"),
    ).toMatchObject({
      allowed: false,
      reason: "rpc_only",
    });
  });
});
