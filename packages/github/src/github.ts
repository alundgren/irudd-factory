import { Buffer } from "node:buffer";
import type {
  Candidate,
  ClaimOutcome,
  GitHubService,
} from "@irudd-factory/application";
import {
  FactoryError,
  GitHub,
  parseWorkflow,
} from "@irudd-factory/application";
import type { PullRequest } from "@irudd-factory/contracts";
import { Effect, Layer, Schema } from "effect";
import { bunCommandRunner, type CommandRunner } from "./runner.ts";

const RepositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ForbiddenLabels = new Set([
  "claimed",
  "ready-for-human",
  "epic",
  "needs-refinement",
]);

const DiscoveryResponse = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      defaultBranchRef: Schema.Struct({
        name: Schema.String,
        target: Schema.Struct({ oid: Schema.String }),
      }),
      issues: Schema.Struct({
        nodes: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            number: Schema.Number,
            url: Schema.String,
            title: Schema.String,
            author: Schema.NullOr(Schema.Struct({ login: Schema.String })),
            labels: Schema.Struct({
              nodes: Schema.Array(Schema.Struct({ name: Schema.String })),
            }),
            blockedBy: Schema.Struct({
              nodes: Schema.Array(Schema.Struct({ state: Schema.String })),
            }),
          }),
        ),
      }),
    }),
  }),
});

const PermissionResponse = Schema.Struct({ permission: Schema.String });
const WorkflowResponse = Schema.Struct({
  sha: Schema.String,
  encoding: Schema.Literal("base64"),
  content: Schema.String,
});
const LabelsResponse = Schema.Array(Schema.Struct({ name: Schema.String }));
const PullRequestsResponse = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      pullRequests: Schema.Struct({
        nodes: Schema.Array(
          Schema.Struct({
            number: Schema.Number,
            url: Schema.String,
            isDraft: Schema.Boolean,
            headRefName: Schema.String,
            closingIssuesReferences: Schema.Struct({
              nodes: Schema.Array(
                Schema.Struct({
                  number: Schema.Number,
                  repository: Schema.Struct({ nameWithOwner: Schema.String }),
                }),
              ),
            }),
          }),
        ),
      }),
    }),
  }),
});

const DISCOVERY_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name target { oid } }
    issues(first: 100, states: OPEN, labels: ["ready-for-agent"]) {
      nodes {
        id number url title author { login }
        labels(first: 100) { nodes { name } }
        blockedBy(first: 100) { nodes { state } }
      }
    }
  }
}`;

const PULL_REQUEST_QUERY = `query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 50, states: OPEN, headRefName: $branch) {
      nodes {
        number url isDraft headRefName
        closingIssuesReferences(first: 50) {
          nodes { number repository { nameWithOwner } }
        }
      }
    }
  }
}`;

function splitRepository(repository: string): readonly [string, string] {
  if (!RepositoryName.test(repository)) {
    throw new FactoryError({
      code: "repository_invalid",
      message: `Invalid GitHub repository name: ${repository}`,
    });
  }
  const [owner, name] = repository.split("/");
  if (!owner || !name) throw new Error("validated repository did not split");
  return [owner, name];
}

function decodeJson<A, I>(schema: Schema.Schema<A, I>, source: string): A {
  try {
    return Schema.decodeUnknownSync(schema)(JSON.parse(source) as unknown);
  } catch (error) {
    throw new FactoryError({
      code: "github_response_invalid",
      message: "GitHub returned an invalid response",
      detail: String(error),
    });
  }
}

async function checked(
  runner: CommandRunner,
  args: ReadonlyArray<string>,
  input?: string,
): Promise<string> {
  const result = await runner.run(args, input);
  if (result.exitCode !== 0) {
    throw new FactoryError({
      code: "github_command_failed",
      message: `GitHub command failed with exit code ${result.exitCode}`,
      detail: result.stderr.trim().slice(0, 4_000),
    });
  }
  return result.stdout;
}

function makeService(runner: CommandRunner): GitHubService {
  return {
    discoverCandidates: (repository) =>
      Effect.tryPromise({
        try: async () => {
          const [owner, name] = splitRepository(repository);
          const discovery = decodeJson(
            DiscoveryResponse,
            await checked(runner, [
              "gh",
              "api",
              "graphql",
              "-f",
              `query=${DISCOVERY_QUERY}`,
              "-F",
              `owner=${owner}`,
              "-F",
              `name=${name}`,
            ]),
          );
          const commit = discovery.data.repository.defaultBranchRef.target.oid;
          const workflowPayload = decodeJson(
            WorkflowResponse,
            await checked(runner, [
              "gh",
              "api",
              "--method",
              "GET",
              `repos/${repository}/contents/WORKFLOW.md`,
              "-f",
              `ref=${commit}`,
            ]),
          );
          const source = Buffer.from(
            workflowPayload.content.replaceAll("\n", ""),
            "base64",
          ).toString("utf8");
          const workflow = parseWorkflow(source);

          const candidates: Candidate[] = [];
          for (const issue of discovery.data.repository.issues.nodes) {
            const labels = new Set(issue.labels.nodes.map(({ name }) => name));
            if (!labels.has("ready-for-agent")) continue;
            if ([...ForbiddenLabels].some((label) => labels.has(label)))
              continue;
            if (issue.blockedBy.nodes.some(({ state }) => state !== "CLOSED")) {
              continue;
            }
            if (!issue.author) continue;
            const permission = decodeJson(
              PermissionResponse,
              await checked(runner, [
                "gh",
                "api",
                `repos/${repository}/collaborators/${issue.author.login}/permission`,
              ]),
            ).permission.toLowerCase();
            if (!new Set(["admin", "maintain", "write"]).has(permission)) {
              continue;
            }
            candidates.push({
              issue: {
                nodeId: issue.id,
                repository,
                number: issue.number,
                url: issue.url,
                title: issue.title,
              },
              workflow: {
                startingCommit: commit,
                blobId: workflowPayload.sha,
                digest: workflow.digest,
                body: workflow.body,
              },
            });
          }
          return candidates;
        },
        catch: (error) =>
          error instanceof FactoryError
            ? error
            : new FactoryError({
                code: "github_discovery_failed",
                message: String(error),
              }),
      }),
    claimIssue: (issue) =>
      Effect.promise(async (): Promise<ClaimOutcome> => {
        let mutation: Awaited<ReturnType<CommandRunner["run"]>> | null = null;
        try {
          mutation = await runner.run(
            [
              "gh",
              "api",
              "--method",
              "POST",
              `repos/${issue.repository}/issues/${issue.number}/labels`,
              "--input",
              "-",
            ],
            JSON.stringify({ labels: ["claimed"] }),
          );
        } catch {
          // A launch or transport failure follows the same one-read reconciliation.
        }
        if (mutation?.exitCode === 0) {
          try {
            const labels = decodeJson(LabelsResponse, mutation.stdout);
            if (labels.some(({ name }) => name === "claimed")) {
              return "confirmed";
            }
          } catch {
            // A successful exit with an invalid response needs reconciliation.
          }
        }

        try {
          const read = await checked(runner, [
            "gh",
            "api",
            `repos/${issue.repository}/issues/${issue.number}/labels`,
          ]);
          const labels = decodeJson(LabelsResponse, read);
          return labels.some(({ name }) => name === "claimed")
            ? "confirmed"
            : "unclaimed";
        } catch {
          return "unknown";
        }
      }),
    verifyPullRequest: (repository, branch, issueNumber) =>
      Effect.tryPromise({
        try: async (): Promise<PullRequest> => {
          const [owner, name] = splitRepository(repository);
          const response = decodeJson(
            PullRequestsResponse,
            await checked(runner, [
              "gh",
              "api",
              "graphql",
              "-f",
              `query=${PULL_REQUEST_QUERY}`,
              "-F",
              `owner=${owner}`,
              "-F",
              `name=${name}`,
              "-F",
              `branch=${branch}`,
            ]),
          );
          const pullRequest = response.data.repository.pullRequests.nodes.find(
            (pull) =>
              pull.headRefName === branch &&
              pull.closingIssuesReferences.nodes.some(
                (issue) =>
                  issue.number === issueNumber &&
                  issue.repository.nameWithOwner === repository,
              ),
          );
          if (!pullRequest) {
            throw new FactoryError({
              code: "pull_request_unverified",
              message: `No pull request from ${branch} closes ${repository}#${issueNumber}`,
            });
          }
          return {
            url: pullRequest.url,
            number: pullRequest.number,
            draft: pullRequest.isDraft,
          };
        },
        catch: (error) =>
          error instanceof FactoryError
            ? error
            : new FactoryError({
                code: "pull_request_verification_failed",
                message: String(error),
              }),
      }),
  };
}

export const makeGitHubService = (
  runner: CommandRunner = bunCommandRunner,
): GitHubService => makeService(runner);

export const layerGitHub = (runner: CommandRunner = bunCommandRunner) =>
  Layer.succeed(GitHub, makeService(runner));
