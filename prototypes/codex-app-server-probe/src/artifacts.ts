import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Redactor } from "./redaction.ts";
import type { RpcMessage, RunManifest } from "./types.ts";

export class RunArtifacts {
  readonly capturePath: string;
  readonly manifestPath: string;
  readonly reportPath: string;
  private readonly captureLines: string[] = [];
  private bytes = 0;

  constructor(
    readonly runRoot: string,
    private readonly redactor: Redactor,
  ) {
    this.capturePath = join(runRoot, "protocol.redacted.jsonl");
    this.manifestPath = join(runRoot, "manifest.json");
    this.reportPath = join(runRoot, "report.md");
  }

  async initialize(): Promise<void> {
    await mkdir(this.runRoot, { recursive: true });
  }

  record(
    direction: "client" | "server" | "child-stderr" | "probe",
    message: unknown,
  ): void {
    const entry = this.redactor.value({
      timestamp: new Date().toISOString(),
      direction,
      message,
    });
    const line = JSON.stringify(entry);
    this.bytes += Buffer.byteLength(line, "utf8") + 1;
    this.captureLines.push(line);
  }

  recordRpc(direction: "client" | "server", message: RpcMessage): void {
    this.record(direction, message);
  }

  serializedBytes(): number {
    return this.bytes;
  }

  redactText(value: string): string {
    return this.redactor.text(value);
  }

  async flushCapture(): Promise<void> {
    await writeFile(this.capturePath, `${this.captureLines.join("\n")}\n`, {
      mode: 0o600,
    });
  }

  async finish(manifest: RunManifest): Promise<void> {
    const safeManifest = this.redactor.value(manifest);
    await this.flushCapture();
    await writeFile(
      this.manifestPath,
      `${JSON.stringify(safeManifest, null, 2)}\n`,
      {
        mode: 0o600,
      },
    );
    const assertions = safeManifest.assertions
      .map(
        (assertion) =>
          `- ${assertion.passed ? "PASS" : "FAIL"}: ${assertion.name}, ${assertion.detail}`,
      )
      .join("\n");
    const report = [
      `# Probe run ${safeManifest.runId}`,
      "",
      `- Scenario: ${safeManifest.scenario}`,
      `- Result: ${safeManifest.result}`,
      `- Model: requested ${safeManifest.requestedModel}, observed ${safeManifest.observedModel ?? "none"}`,
      `- Effort: requested ${safeManifest.requestedEffort}, observed ${safeManifest.observedEffort ?? "none"}`,
      `- Effort: ${safeManifest.requestedEffort}`,
      `- Duration: ${safeManifest.durationMs} ms`,
      `- Schema digest: ${safeManifest.schemaDigest}`,
      "",
      "## Assertions",
      "",
      assertions || "- None",
      "",
    ].join("\n");
    await writeFile(this.reportPath, this.redactor.text(report), {
      mode: 0o600,
    });
  }
}
