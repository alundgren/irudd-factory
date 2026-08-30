import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { ProbeError } from "./types.ts";

export function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export async function canonicalExisting(path: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new ProbeError(
      "assertion_failed",
      "path_not_absolute",
      `Expected an absolute path: ${path}`,
    );
  }
  return realpath(path);
}

export async function requireWithin(
  parent: string,
  candidate: string,
  label: string,
): Promise<string> {
  const [resolvedParent, resolvedCandidate] = await Promise.all([
    canonicalExisting(parent),
    canonicalExisting(candidate),
  ]);
  if (!isWithin(resolvedParent, resolvedCandidate)) {
    throw new ProbeError(
      "assertion_failed",
      "path_outside_allowed_root",
      `${label} is outside ${resolvedParent}: ${resolvedCandidate}`,
    );
  }
  return resolvedCandidate;
}

export function plannedWithin(
  parent: string,
  candidate: string,
  label: string,
): string {
  const resolvedParent = resolve(parent);
  const resolvedCandidate = resolve(candidate);
  if (!isWithin(resolvedParent, resolvedCandidate)) {
    throw new ProbeError(
      "assertion_failed",
      "path_outside_allowed_root",
      `${label} is outside ${resolvedParent}: ${resolvedCandidate}`,
    );
  }
  return resolvedCandidate;
}
