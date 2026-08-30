import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { ProbeError } from "./types.ts";

const REQUIRED_SCHEMA_MARKERS: Record<string, string[]> = {
  initialization: ["InitializeParams"],
  thread_start: ["ThreadStartParams", "ThreadStartedNotification"],
  turn_start_and_completion: ["TurnStartParams", "TurnCompletedNotification"],
  interruption: ["TurnInterruptParams"],
  item_lifecycle: ["ItemStartedNotification", "ItemCompletedNotification"],
  command_approval: ["CommandExecutionRequestApprovalParams"],
  file_approval: ["FileChangeRequestApprovalParams"],
  network_approval: ["PermissionsRequestApprovalParams"],
  approval_resolution: ["ServerRequestResolvedNotification"],
  token_usage: ["ThreadTokenUsageUpdatedNotification"],
  errors: ["ErrorNotification"],
  model_rerouting: ["ModelReroutedNotification"],
};

async function filesRecursively(
  root: string,
  current = root,
): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(current, entry.name);
      return entry.isDirectory()
        ? filesRecursively(root, path)
        : Promise.resolve([path]);
    }),
  );
  return nested.flat();
}

export async function inspectSchemas(schemaRoot: string): Promise<{
  digest: string;
  files: string[];
  coverage: Record<string, boolean>;
}> {
  const paths = (await filesRecursively(schemaRoot)).sort((a, b) =>
    relative(schemaRoot, a).localeCompare(relative(schemaRoot, b)),
  );
  const hasher = new Bun.CryptoHasher("sha256");
  const names = paths.map((path) =>
    relative(schemaRoot, path).replaceAll("\\", "/"),
  );
  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index];
    const name = names[index];
    if (!path || !name) continue;
    hasher.update(name);
    hasher.update(new Uint8Array([0]));
    hasher.update(await Bun.file(path).arrayBuffer());
  }
  const coverage = Object.fromEntries(
    Object.entries(REQUIRED_SCHEMA_MARKERS).map(([key, markers]) => [
      key,
      markers.every((marker) => names.some((name) => name.includes(marker))),
    ]),
  );
  const missing = Object.entries(coverage)
    .filter(([, present]) => !present)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new ProbeError(
      "protocol_error",
      "schema_coverage_missing",
      `Generated App Server schema lacks: ${missing.join(", ")}`,
    );
  }
  return { digest: hasher.digest("hex"), files: names, coverage };
}

export async function requireRestrictedReadSchema(
  schemaRoot: string,
): Promise<void> {
  let root: JsonSchema;
  try {
    root = (await Bun.file(
      join(schemaRoot, "v2", "TurnStartParams.json"),
    ).json()) as JsonSchema;
  } catch {
    throw unsupportedRestrictedRead("TurnStartParams.json is not valid JSON");
  }
  const policy = resolveNode(root, property(root, "sandboxPolicy"));
  const readOnly = variantForType(root, policy, "readOnly");
  const workspaceWrite = variantForType(root, policy, "workspaceWrite");
  const readAccess = resolveNode(root, property(readOnly, "access"));
  const workspaceAccess = resolveNode(
    root,
    property(workspaceWrite, "readOnlyAccess"),
  );
  if (
    !supportsRestrictedAccess(root, readAccess) ||
    !supportsRestrictedAccess(root, workspaceAccess)
  ) {
    throw new ProbeError(
      "protocol_error",
      "restricted_read_schema_unsupported",
      "Installed App Server schema cannot express restricted readable roots for both readOnly.access and workspaceWrite.readOnlyAccess",
    );
  }
}

type JsonSchema = Record<string, unknown>;

function object(value: unknown): JsonSchema | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonSchema)
    : null;
}

function property(schema: JsonSchema | null, name: string): JsonSchema | null {
  return object(object(schema?.properties)?.[name]);
}

function resolveNode(
  root: JsonSchema,
  value: JsonSchema | null,
): JsonSchema | null {
  const reference = value?.$ref;
  if (typeof reference !== "string" || !reference.startsWith("#/")) {
    return value;
  }
  let current: unknown = root;
  for (const encoded of reference.slice(2).split("/")) {
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    current = object(current)?.[key];
  }
  return object(current);
}

function alternatives(
  root: JsonSchema,
  schema: JsonSchema | null,
  visited = new Set<JsonSchema>(),
): JsonSchema[] {
  const resolved = resolveNode(root, schema);
  if (!resolved || visited.has(resolved)) return [];
  const nextVisited = new Set(visited).add(resolved);
  for (const key of ["oneOf", "anyOf"] as const) {
    const entries = resolved[key];
    if (Array.isArray(entries)) {
      return entries.flatMap((entry) =>
        alternatives(root, object(entry), nextVisited),
      );
    }
  }
  return [resolved];
}

function acceptsType(schema: JsonSchema | null, expected: string): boolean {
  const typeProperty = property(schema, "type");
  return (
    typeProperty?.const === expected ||
    (Array.isArray(typeProperty?.enum) && typeProperty.enum.includes(expected))
  );
}

function variantForType(
  root: JsonSchema,
  schema: JsonSchema | null,
  expected: string,
): JsonSchema | null {
  return (
    alternatives(root, schema).find((entry) => acceptsType(entry, expected)) ??
    null
  );
}

function hasDeclaredType(schema: JsonSchema | null, expected: string): boolean {
  if (!schema) return false;
  return (
    schema.type === expected ||
    (Array.isArray(schema.type) && schema.type.includes(expected))
  );
}

function supportsRestrictedAccess(
  root: JsonSchema,
  schema: JsonSchema | null,
): boolean {
  return alternatives(root, schema).some((entry) => {
    if (!acceptsType(entry, "restricted")) return false;
    return (
      hasDeclaredType(property(entry, "readableRoots"), "array") &&
      hasDeclaredType(property(entry, "includePlatformDefaults"), "boolean")
    );
  });
}

function unsupportedRestrictedRead(detail: string): ProbeError {
  return new ProbeError(
    "protocol_error",
    "restricted_read_schema_unsupported",
    `Installed App Server schema cannot express restricted readable roots: ${detail}`,
  );
}
