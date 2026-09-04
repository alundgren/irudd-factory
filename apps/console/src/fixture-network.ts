const FIXTURE_NETWORK_PARAMETER = "fixture-network";

export function installFixtureNetworkMode(): void {
  const mode = new URLSearchParams(window.location.search).get(
    FIXTURE_NETWORK_PARAMETER,
  );
  if (mode !== "disconnected" && mode !== "delayed") return;

  const originalFetch = globalThis.fetch.bind(globalThis);
  const delayAfter = Date.now() + 3_000;
  globalThis.fetch = (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (!url.endsWith("/rpc")) return originalFetch(input, init);
    if (mode === "disconnected") {
      return Promise.reject(new TypeError("Fixture service connection failed"));
    }
    if (Date.now() < delayAfter) return originalFetch(input, init);
    return new Promise<Response>((resolve) => {
      window.setTimeout(
        () => void originalFetch(input, init).then(resolve),
        60_000,
      );
    });
  };
}
