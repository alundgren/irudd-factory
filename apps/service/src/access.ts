import type { IncomingMessage } from "node:http";
import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { NodeHttpServerRequest } from "@effect/platform-node";
import { RPC_PATH } from "@irudd-factory/contracts";
import { Effect } from "effect";
import { LOCAL_ACCESS_MODE, type FactoryConfig } from "./config.ts";

export const ACCESS_DECISION_HEADER = "x-factory-access-decision";
export const TAILSCALE_LOGIN_HEADER = "tailscale-user-login";
const HOST_HEADER = "host";
const ORIGIN_HEADER = "origin";
const HOST_REJECTED = "host_rejected";
const IDENTITY_REJECTED = "identity_rejected";
const ORIGIN_REJECTED = "origin_rejected";
const RPC_ONLY = "rpc_only";

type AccessDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

type AccessConfig = NonNullable<FactoryConfig["access"]>;

function rawHeaderValues(
  request: Pick<IncomingMessage, "rawHeaders">,
  name: string,
): ReadonlyArray<string> {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  return values;
}

function singleHeader(
  request: Pick<IncomingMessage, "rawHeaders">,
  name: string,
): string | null {
  const values = rawHeaderValues(request, name);
  return values.length === 1 ? values[0]! : null;
}

function normalizedHost(
  value: string,
  protocol: "http:" | "https:",
): string | null {
  if (!value || value.endsWith(":") || /[\s\\/@,]/.test(value)) return null;
  try {
    const url = new URL(`${protocol}//${value}`);
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.host;
  } catch {
    return null;
  }
}

function matchingOrigin(
  value: string,
  protocol: "http:" | "https:",
  host: string,
): boolean {
  try {
    const origin = new URL(value);
    return (
      value === origin.origin &&
      origin.protocol === protocol &&
      origin.host === host &&
      !origin.username &&
      !origin.password
    );
  } catch {
    return false;
  }
}

function decodeQuotedPrintableWord(value: string): Uint8Array | null {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (character === "_") {
      bytes.push(0x20);
    } else if (character === "=") {
      const encoded = value.slice(index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(encoded)) return null;
      bytes.push(Number.parseInt(encoded, 16));
      index += 2;
    } else {
      const code = character.charCodeAt(0);
      if (code > 0x7f || code < 0x21 || code > 0x7e) return null;
      bytes.push(code);
    }
  }
  return Uint8Array.from(bytes);
}

function decodeBase64Word(value: string): Uint8Array | null {
  if (
    !value ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    return null;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? Uint8Array.from(decoded) : null;
}

function decodeMimeWord(
  charset: string,
  encoding: string,
  value: string,
): string | null {
  if (!/^(utf-8|us-ascii)$/i.test(charset)) return null;
  const bytes =
    encoding.toLowerCase() === "q"
      ? decodeQuotedPrintableWord(value)
      : encoding.toLowerCase() === "b"
        ? decodeBase64Word(value)
        : null;
  if (!bytes) return null;
  if (
    charset.toLowerCase() === "us-ascii" &&
    bytes.some((byte) => byte > 0x7f)
  ) {
    return null;
  }
  try {
    return new TextDecoder(charset.toLowerCase(), { fatal: true }).decode(
      bytes,
    );
  } catch {
    return null;
  }
}

export function decodeRfc2047Header(value: string): string | null {
  if (/[^\t\x20-\x7e]/.test(value)) return null;
  const encodedWord = /=\?([^?\s]+)\?([bBqQ])\?([^?]+)\?=/g;
  let decoded = "";
  let cursor = 0;
  let previousWasEncoded = false;
  let match: RegExpExecArray | null;
  while ((match = encodedWord.exec(value)) !== null) {
    if (match[0].length > 75) return null;
    const beforeCharacter = value[match.index - 1];
    const afterCharacter = value[match.index + match[0].length];
    if (
      (beforeCharacter !== undefined && !/[\t ]/.test(beforeCharacter)) ||
      (afterCharacter !== undefined && !/[\t ]/.test(afterCharacter))
    ) {
      return null;
    }
    const between = value.slice(cursor, match.index);
    if (!previousWasEncoded || !/^\s*$/.test(between)) decoded += between;
    const word = decodeMimeWord(match[1]!, match[2]!, match[3]!);
    if (word === null) return null;
    decoded += word;
    cursor = match.index + match[0].length;
    previousWasEncoded = true;
  }
  const remainder = value.slice(cursor);
  decoded += remainder;
  if (decoded.includes("=?") || decoded.includes("?=")) return null;
  return decoded;
}

function denied(reason: string): AccessDecision {
  return { allowed: false, reason };
}

function validateHost(
  request: Pick<IncomingMessage, "rawHeaders">,
  protocol: "http:" | "https:",
): string | AccessDecision {
  const hostValue = singleHeader(request, HOST_HEADER);
  if (hostValue === null) return denied(HOST_REJECTED);
  const host = normalizedHost(hostValue, protocol);
  return host ?? denied(HOST_REJECTED);
}

function localAccessDecision(
  request: Pick<IncomingMessage, "rawHeaders">,
): AccessDecision {
  const origins = rawHeaderValues(request, ORIGIN_HEADER);
  if (origins.length === 0) return { allowed: true };
  if (origins.length !== 1) return denied(ORIGIN_REJECTED);
  const host = validateHost(request, "http:");
  if (typeof host !== "string") return host;
  return matchingOrigin(origins[0]!, "http:", host)
    ? { allowed: true }
    : denied(ORIGIN_REJECTED);
}

function tailscaleAccessDecision(
  request: Pick<IncomingMessage, "rawHeaders" | "url">,
  operatorLogin: string,
): AccessDecision {
  const host = validateHost(request, "https:");
  if (typeof host !== "string") return host;
  const loginValue = singleHeader(request, TAILSCALE_LOGIN_HEADER);
  if (loginValue === null) return denied(IDENTITY_REJECTED);
  const decodedLogin = decodeRfc2047Header(loginValue);
  if (decodedLogin === null || decodedLogin !== operatorLogin) {
    return denied(IDENTITY_REJECTED);
  }
  const origins = rawHeaderValues(request, ORIGIN_HEADER);
  if (request.url === RPC_PATH || request.url?.startsWith(`${RPC_PATH}?`)) {
    if (origins.length !== 1 || !matchingOrigin(origins[0]!, "https:", host)) {
      return denied(ORIGIN_REJECTED);
    }
  } else if (
    origins.length > 1 ||
    (origins.length === 1 && !matchingOrigin(origins[0]!, "https:", host))
  ) {
    return denied(ORIGIN_REJECTED);
  }
  return { allowed: true };
}

function localCliAccessDecision(
  request: Pick<IncomingMessage, "rawHeaders" | "url">,
): AccessDecision {
  if (rawHeaderValues(request, ORIGIN_HEADER).length !== 0) {
    return denied(ORIGIN_REJECTED);
  }
  if (request.url !== RPC_PATH && !request.url?.startsWith(`${RPC_PATH}?`)) {
    return denied(RPC_ONLY);
  }
  return { allowed: true };
}

export function decideAccess(
  request: Pick<IncomingMessage, "rawHeaders" | "url">,
  access: AccessConfig,
  listener: "main" | "local-cli" = "main",
): AccessDecision {
  if (listener === "local-cli") return localCliAccessDecision(request);
  return access.mode === LOCAL_ACCESS_MODE
    ? localAccessDecision(request)
    : tailscaleAccessDecision(request, access.operatorLogin);
}

export function accessMiddleware(
  access: AccessConfig,
  listener: "main" | "local-cli" = "main",
) {
  return <E, R>(
    app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
      const incoming = NodeHttpServerRequest.toIncomingMessage(request);
      const decision = decideAccess(incoming, access, listener);
      return decision.allowed
        ? app
        : Effect.succeed(
            HttpServerResponse.text("Request denied", {
              status: 403,
              headers: { [ACCESS_DECISION_HEADER]: decision.reason },
            }),
          );
    });
}
