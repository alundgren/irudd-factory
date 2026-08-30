import { Data } from "effect";

export class FactoryError extends Data.TaggedError("FactoryError")<{
  readonly code: string;
  readonly message: string;
  readonly detail?: string;
}> {}

export function asFactoryError(
  error: unknown,
  code = "unexpected_error",
): FactoryError {
  if (error instanceof FactoryError) return error;
  return new FactoryError({ code, message: String(error) });
}
