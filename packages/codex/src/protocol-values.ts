import {
  FactoryError,
  type ProviderTokenUsage,
  type TokenUsageBreakdown,
} from "@irudd-factory/application";
import { APP_SERVER_METHODS, type RpcMessage } from "./connection.ts";

export function supportsModel(
  result: unknown,
  model: string,
  effort: string,
): boolean {
  const data = (result as { data?: unknown })?.data;
  if (!Array.isArray(data)) return false;
  const entry = data.find((value) => {
    const item = value as Record<string, unknown>;
    return item.id === model || item.model === model;
  }) as Record<string, unknown> | undefined;
  if (!entry || !Array.isArray(entry.supportedReasoningEfforts)) return false;
  return entry.supportedReasoningEfforts.some(
    (value) =>
      value === effort ||
      (value as Record<string, unknown>)?.reasoningEffort === effort,
  );
}

export function stringAt(value: unknown, ...path: string[]): string | null {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : null;
}

export function normalizedItem(
  message: RpcMessage,
): Readonly<Record<string, unknown>> {
  const item = message.params?.item as Record<string, unknown> | undefined;
  return {
    phase:
      message.method === APP_SERVER_METHODS.itemStarted
        ? "started"
        : "completed",
    ...(typeof item?.id === "string" ? { id: item.id } : {}),
    ...(typeof item?.type === "string" ? { type: item.type } : {}),
    ...(typeof item?.status === "string" ? { status: item.status } : {}),
  };
}

function numericField(
  value: Readonly<Record<string, unknown>>,
  key: string,
): number {
  const field = value[key];
  if (!Number.isSafeInteger(field) || (field as number) < 0) {
    throw new FactoryError({
      code: "provider_protocol_error",
      message: `Codex token usage has an invalid ${key}`,
    });
  }
  return field as number;
}

function tokenBreakdown(value: unknown): TokenUsageBreakdown {
  if (!value || typeof value !== "object") {
    throw new FactoryError({
      code: "provider_protocol_error",
      message: "Codex token usage breakdown is missing",
    });
  }
  const record = value as Readonly<Record<string, unknown>>;
  return {
    inputTokens: numericField(record, "inputTokens"),
    cachedInputTokens: numericField(record, "cachedInputTokens"),
    outputTokens: numericField(record, "outputTokens"),
    reasoningOutputTokens: numericField(record, "reasoningOutputTokens"),
    totalTokens: numericField(record, "totalTokens"),
    ...(record.cacheWriteInputTokens === undefined
      ? {}
      : {
          cacheWriteInputTokens: numericField(record, "cacheWriteInputTokens"),
        }),
  };
}

export function normalizeTokenUsage(value: unknown): ProviderTokenUsage {
  if (!value || typeof value !== "object") {
    throw new FactoryError({
      code: "provider_protocol_error",
      message: "Codex token usage is missing",
    });
  }
  const record = value as Readonly<Record<string, unknown>>;
  const contextWindow = record.modelContextWindow;
  if (
    contextWindow !== null &&
    contextWindow !== undefined &&
    (!Number.isSafeInteger(contextWindow) || (contextWindow as number) <= 0)
  ) {
    throw new FactoryError({
      code: "provider_protocol_error",
      message: "Codex token usage has an invalid modelContextWindow",
    });
  }
  return {
    total: tokenBreakdown(record.total),
    last: tokenBreakdown(record.last),
    modelContextWindow:
      contextWindow === undefined ? null : (contextWindow as number | null),
  };
}
