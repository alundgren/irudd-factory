export class ServiceRejection extends Error {
  readonly _tag = "ServiceRejection";
}

export class TransportFailure extends Error {
  readonly _tag = "TransportFailure";
}

export function classifyRpcFailure(error: unknown): Error {
  return typeof error === "string"
    ? new ServiceRejection(error)
    : new TransportFailure(String(error));
}
