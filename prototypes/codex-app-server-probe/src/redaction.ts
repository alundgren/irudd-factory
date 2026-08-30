const REDACTED = "[REDACTED]";

export class Redactor {
  private readonly secrets: string[];

  constructor(secrets: Array<string | undefined>) {
    this.secrets = [
      ...new Set(secrets.filter((value): value is string => Boolean(value))),
    ].sort((left, right) => right.length - left.length);
  }

  add(secret: string | undefined): void {
    if (!secret || this.secrets.includes(secret)) return;
    this.secrets.push(secret);
    this.secrets.sort((left, right) => right.length - left.length);
  }

  text(value: string): string {
    return this.secrets.reduce(
      (current, secret) => current.split(secret).join(REDACTED),
      value,
    );
  }

  value<T>(value: T): T {
    return JSON.parse(this.text(JSON.stringify(value))) as T;
  }

  error(error: unknown): string {
    return this.text(error instanceof Error ? error.message : String(error));
  }
}
