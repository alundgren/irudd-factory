import type { FixtureDefinition } from "./types.ts";

export interface FixtureCatalogEntry {
  readonly name: string;
  readonly summary: string;
  readonly tags: ReadonlyArray<string>;
}

export interface FixtureDescription extends FixtureCatalogEntry {
  readonly purpose: string;
  readonly expectations: FixtureDefinition["expectations"];
}

export function fixtureCatalogEntry(
  fixture: FixtureDefinition,
): FixtureCatalogEntry {
  return { name: fixture.name, summary: fixture.summary, tags: fixture.tags };
}

export function fixtureDescription(
  fixture: FixtureDefinition,
): FixtureDescription {
  return {
    ...fixtureCatalogEntry(fixture),
    purpose: fixture.purpose,
    expectations: fixture.expectations,
  };
}

export function renderFixtureCatalog(
  fixtures: ReadonlyArray<FixtureDefinition>,
): string {
  const width = Math.max(...fixtures.map(({ name }) => name.length));
  return fixtures
    .map(
      ({ name, summary, tags }) =>
        `${name.padEnd(width)}  ${summary}  [${tags.join(", ")}]`,
    )
    .join("\n");
}

export function renderFixtureDescription(fixture: FixtureDefinition): string {
  const { initial, command, lifecycle, reset, checks } = fixture.expectations;
  const lines = [
    fixture.name,
    fixture.summary,
    `Tags: ${fixture.tags.join(", ")}`,
    "",
    "Purpose",
    fixture.purpose,
    "",
    "Initial state",
    `Candidate count: ${initial.candidateCount}`,
    `Assignment state: ${initial.assignment?.state ?? "none"}`,
    `Active assignment count: ${initial.activeAssignmentCount}`,
    `Event types: ${initial.eventTypes.length > 0 ? initial.eventTypes.join(", ") : "none"}`,
  ];
  if (initial.assignment) {
    lines.push(`Assignment ID: ${initial.assignment.id}`);
    lines.push(`Issue: ${initial.assignment.issue.url}`);
    lines.push(
      `Workspace: ${initial.assignment.workspace?.worktreePath ?? "none"}`,
    );
    lines.push(`Observed model: ${initial.assignment.observedModel ?? "none"}`);
    lines.push(
      `Observed effort: ${initial.assignment.observedEffort ?? "none"}`,
    );
    lines.push(
      `Pull request: ${initial.assignment.pullRequest?.url ?? "none"}`,
    );
    lines.push(
      `Pull request draft: ${initial.assignment.pullRequest?.draft ?? "none"}`,
    );
    lines.push(`Error code: ${initial.assignment.error?.code ?? "none"}`);
  }
  lines.push("", "Behavior");
  lines.push(`Command result: ${command?.result ?? "not declared"}`);
  if (command?.issueLinkCount !== undefined) {
    lines.push(`Issue link count: ${command.issueLinkCount}`);
  }
  if (command?.assignmentState !== undefined) {
    lines.push(`Command assignment state: ${command.assignmentState}`);
  }
  if (lifecycle) {
    lines.push(`Lifecycle states: ${lifecycle.states.join(", ")}`);
    lines.push(`Terminal state: ${lifecycle.terminalState}`);
    lines.push(`Terminal events: ${lifecycle.terminalEventTypes.join(", ")}`);
    lines.push(`Second client result: ${lifecycle.secondClientResult}`);
    lines.push(`After terminal result: ${lifecycle.afterTerminalResult}`);
  }
  lines.push(`Reset: ${reset}`, "", "Suggested checks");
  lines.push(...checks.map((check) => `- ${check}`));
  return lines.join("\n");
}
