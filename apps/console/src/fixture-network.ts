const FIXTURE_NETWORK_PARAMETER = "fixture-network";

export function installFixtureNetworkMode(): void {
  const parameters = new URLSearchParams(window.location.search);
  if (parameters.get("fixture-clipboard") === "failure") {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () => Promise.reject(new Error("Fixture clipboard failure")),
      },
    });
  }
  const mode = parameters.get(FIXTURE_NETWORK_PARAMETER);
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
