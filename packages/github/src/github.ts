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
  REQUIRED_ISSUE_LABELS,
} from "@irudd-factory/application";
import type { PullRequest } from "@irudd-factory/contracts";
import { Effect, Layer, Schema } from "effect";
import { bunCommandRunner, type CommandRunner } from "./runner.ts";

const RepositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PageInfo = Schema.Struct({
  hasNextPage: Schema.Boolean,
  endCursor: Schema.NullOr(Schema.String),
});
const LabelNode = Schema.Struct({ name: Schema.String });
const BlockerNode = Schema.Struct({ state: Schema.String });
const IssueNode = Schema.Struct({
  id: Schema.String,
  number: Schema.Number,
  url: Schema.String,
  title: Schema.String,
  author: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  labels: Schema.Struct({
    nodes: Schema.Array(LabelNode),
    pageInfo: PageInfo,
  }),
  blockedBy: Schema.Struct({
    nodes: Schema.Array(BlockerNode),
    pageInfo: PageInfo,
  }),
});
type DiscoveredIssue = typeof IssueNode.Type;

const DiscoveryResponse = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      defaultBranchRef: Schema.Struct({
        name: Schema.String,
        target: Schema.Struct({ oid: Schema.String }),
      }),
      issues: Schema.Struct({
        nodes: Schema.Array(IssueNode),
        pageInfo: PageInfo,
      }),
    }),
  }),
});
const LabelsPageResponse = Schema.Struct({
  data: Schema.Struct({
    node: Schema.NullOr(
      Schema.Struct({
        labels: Schema.Struct({
          nodes: Schema.Array(LabelNode),
          pageInfo: PageInfo,
        }),
      }),
    ),
  }),
});
const BlockersPageResponse = Schema.Struct({
  data: Schema.Struct({
    node: Schema.NullOr(
      Schema.Struct({
        blockedBy: Schema.Struct({
          nodes: Schema.Array(BlockerNode),
          pageInfo: PageInfo,
        }),
      }),
    ),
  }),
});

const PermissionResponse = Schema.Struct({ permission: Schema.String });
const WorkflowResponse = Schema.Struct({
  sha: Schema.String,
  encoding: Schema.Literal("base64"),
  content: Schema.String,
});
const LabelsResponse = Schema.Array(Schema.Struct({ name: Schema.String }));
const LabelResponse = Schema.Struct({ name: Schema.String });
const NotFoundResponse = Schema.Struct({
  message: Schema.String,
  status: Schema.Union(Schema.String, Schema.Number),
});
const ClosingIssueNode = Schema.Struct({
  number: Schema.Number,
  repository: Schema.Struct({ nameWithOwner: Schema.String }),
});
const PullRequestNode = Schema.Struct({
  id: Schema.String,
  number: Schema.Number,
  url: Schema.String,
  isDraft: Schema.Boolean,
  headRefName: Schema.String,
  closingIssuesReferences: Schema.Struct({
    nodes: Schema.Array(ClosingIssueNode),
    pageInfo: PageInfo,
  }),
});
type PullRequestNode = typeof PullRequestNode.Type;
const PullRequestsResponse = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      pullRequests: Schema.Struct({
        nodes: Schema.Array(PullRequestNode),
        pageInfo: PageInfo,
      }),
    }),
  }),
});
const ClosingIssuesPageResponse = Schema.Struct({
  data: Schema.Struct({
    node: Schema.NullOr(
      Schema.Struct({
        closingIssuesReferences: Schema.Struct({
          nodes: Schema.Array(ClosingIssueNode),
          pageInfo: PageInfo,
        }),
      }),
    ),
  }),
});

const DISCOVERY_QUERY = `query($owner: String!, $name: String!, $issueCursor: String) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name target { oid } }
    issues(first: 100, after: $issueCursor, states: OPEN, labels: ${JSON.stringify(REQUIRED_ISSUE_LABELS)}) {
      nodes {
        id number url title author { login }
        labels(first: 100) {
          nodes { name }
          pageInfo { hasNextPage endCursor }
        }
        blockedBy(first: 100) {
          nodes { state }
          pageInfo { hasNextPage endCursor }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const LABELS_PAGE_QUERY = `query($id: ID!, $cursor: String!) {
  node(id: $id) {
    ... on Issue {
      labels(first: 100, after: $cursor) {
        nodes { name }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const BLOCKERS_PAGE_QUERY = `query($id: ID!, $cursor: String!) {
  node(id: $id) {
    ... on Issue {
      blockedBy(first: 100, after: $cursor) {
        nodes { state }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const PULL_REQUEST_QUERY = `query($owner: String!, $name: String!, $branch: String!, $pullCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 50, after: $pullCursor, states: OPEN, headRefName: $branch) {
      nodes {
        id number url isDraft headRefName
        closingIssuesReferences(first: 50) {
          nodes { number repository { nameWithOwner } }
          pageInfo { hasNextPage endCursor }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const CLOSING_ISSUES_PAGE_QUERY = `query($id: ID!, $cursor: String!) {
  node(id: $id) {
    ... on PullRequest {
      closingIssuesReferences(first: 50, after: $cursor) {
        nodes { number repository { nameWithOwner } }
        pageInfo { hasNextPage endCursor }
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

function decodeIncludedJson<A, I>(
  schema: Schema.Schema<A, I>,
  source: string,
  expectedStatus: number,
): A {
  const normalized = source.replaceAll("\r\n", "\n");
  const status = Number(normalized.match(/^HTTP\/\S+\s+(\d{3})/)?.[1]);
  const separator = normalized.indexOf("\n\n");
  if (status !== expectedStatus || separator < 0) {
    throw new FactoryError({
      code: "github_response_invalid",
      message: "GitHub returned an invalid included response",
    });
  }
  return decodeJson(schema, normalized.slice(separator + 2));
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

async function graphql(
  runner: CommandRunner,
  query: string,
  variables: Readonly<Record<string, string>>,
): Promise<string> {
  const args = ["gh", "api", "graphql", "-f", `query=${query}`];
  for (const [name, value] of Object.entries(variables)) {
    args.push("-F", `${name}=${value}`);
  }
  return checked(runner, args);
}

function nextCursor(
  pageInfo: typeof PageInfo.Type,
  connection: string,
): string | null {
  if (!pageInfo.hasNextPage) return null;
  if (!pageInfo.endCursor) {
    throw new FactoryError({
      code: "github_response_invalid",
      message: `GitHub returned no cursor for paginated ${connection}`,
    });
  }
  return pageInfo.endCursor;
}

async function allLabels(
  runner: CommandRunner,
  issue: DiscoveredIssue,
): Promise<ReadonlyArray<string>> {
  const labels = issue.labels.nodes.map(({ name }) => name);
  let cursor = nextCursor(issue.labels.pageInfo, "labels");
  while (cursor) {
    const response = decodeJson(
      LabelsPageResponse,
      await graphql(runner, LABELS_PAGE_QUERY, { id: issue.id, cursor }),
    );
    if (!response.data.node) {
      throw new FactoryError({
        code: "github_response_invalid",
        message: `GitHub issue node ${issue.id} disappeared during label pagination`,
      });
    }
    labels.push(...response.data.node.labels.nodes.map(({ name }) => name));
    cursor = nextCursor(response.data.node.labels.pageInfo, "labels");
  }
  return labels;
}

async function allBlockerStates(
  runner: CommandRunner,
  issue: DiscoveredIssue,
): Promise<ReadonlyArray<string>> {
  const states = issue.blockedBy.nodes.map(({ state }) => state);
  let cursor = nextCursor(issue.blockedBy.pageInfo, "blockers");
  while (cursor) {
    const response = decodeJson(
      BlockersPageResponse,
      await graphql(runner, BLOCKERS_PAGE_QUERY, { id: issue.id, cursor }),
    );
    if (!response.data.node) {
      throw new FactoryError({
        code: "github_response_invalid",
        message: `GitHub issue node ${issue.id} disappeared during blocker pagination`,
      });
    }
    states.push(
      ...response.data.node.blockedBy.nodes.map(({ state }) => state),
    );
    cursor = nextCursor(response.data.node.blockedBy.pageInfo, "blockers");
  }
  return states;
}

function includesClosingIssue(
  nodes: ReadonlyArray<typeof ClosingIssueNode.Type>,
  repository: string,
  issueNumber: number,
): boolean {
  return nodes.some(
    (issue) =>
      issue.number === issueNumber &&
      issue.repository.nameWithOwner === repository,
  );
}

async function pullClosesIssue(
  runner: CommandRunner,
  pull: PullRequestNode,
  repository: string,
  issueNumber: number,
): Promise<boolean> {
  if (
    includesClosingIssue(
      pull.closingIssuesReferences.nodes,
      repository,
      issueNumber,
    )
  ) {
    return true;
  }
  let cursor = nextCursor(
    pull.closingIssuesReferences.pageInfo,
    "closing issues",
  );
  while (cursor) {
    const response = decodeJson(
      ClosingIssuesPageResponse,
      await graphql(runner, CLOSING_ISSUES_PAGE_QUERY, {
        id: pull.id,
        cursor,
      }),
    );
    if (!response.data.node) {
      throw new FactoryError({
        code: "github_response_invalid",
        message: `GitHub pull request node ${pull.id} disappeared during closing-issue pagination`,
      });
    }
    const page = response.data.node.closingIssuesReferences;
    if (includesClosingIssue(page.nodes, repository, issueNumber)) return true;
    cursor = nextCursor(page.pageInfo, "closing issues");
  }
  return false;
}

function makeService(runner: CommandRunner): GitHubService {
  return {
    discoverCandidates: (repository) =>
      Effect.tryPromise({
        try: async () => {
          const [owner, name] = splitRepository(repository);
          const issues: DiscoveredIssue[] = [];
          let issueCursor: string | null = null;
          let commit: string | null = null;
          do {
            const discovery = decodeJson(
              DiscoveryResponse,
              await graphql(runner, DISCOVERY_QUERY, {
                owner,
                name,
                ...(issueCursor ? { issueCursor } : {}),
              }),
            );
            commit ??= discovery.data.repository.defaultBranchRef.target.oid;
            issues.push(...discovery.data.repository.issues.nodes);
            issueCursor = nextCursor(
              discovery.data.repository.issues.pageInfo,
              "issues",
            );
          } while (issueCursor);
          if (!commit) {
            throw new FactoryError({
              code: "github_response_invalid",
              message: "GitHub returned no default branch commit",
            });
          }
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
          const requiredLabels = new Set(workflow.policy.requiredLabels);
          const forbiddenLabels = new Set(workflow.policy.forbiddenLabels);

          const candidates: Candidate[] = [];
          for (const issue of issues) {
            const labels = new Set(await allLabels(runner, issue));
            if ([...requiredLabels].some((label) => !labels.has(label))) {
              continue;
            }
            if ([...forbiddenLabels].some((label) => labels.has(label)))
              continue;
            const blockerStates = await allBlockerStates(runner, issue);
            if (blockerStates.some((state) => state !== "CLOSED")) {
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
          const read = await runner.run([
            "gh",
            "api",
            "--include",
            `repos/${issue.repository}/issues/${issue.number}/labels/claimed`,
          ]);
          if (read.exitCode === 0) {
            const label = decodeIncludedJson(LabelResponse, read.stdout, 200);
            return label.name === "claimed" ? "confirmed" : "unknown";
          }
          try {
            decodeIncludedJson(NotFoundResponse, read.stdout, 404);
            return "unclaimed";
          } catch {
            return "unknown";
          }
        } catch {
          return "unknown";
        }
      }),
    verifyPullRequest: (repository, branch, issueNumber) =>
      Effect.tryPromise({
        try: async (): Promise<PullRequest> => {
          const [owner, name] = splitRepository(repository);
          let pullCursor: string | null = null;
          do {
            const response = decodeJson(
              PullRequestsResponse,
              await graphql(runner, PULL_REQUEST_QUERY, {
                owner,
                name,
                branch,
                ...(pullCursor ? { pullCursor } : {}),
              }),
            );
            for (const pull of response.data.repository.pullRequests.nodes) {
              if (
                pull.headRefName === branch &&
                (await pullClosesIssue(runner, pull, repository, issueNumber))
              ) {
                return {
                  url: pull.url,
                  number: pull.number,
                  draft: pull.isDraft,
                };
              }
            }
            pullCursor = nextCursor(
              response.data.repository.pullRequests.pageInfo,
              "pull requests",
            );
          } while (pullCursor);
          throw new FactoryError({
            code: "pull_request_unverified",
            message: `No pull request from ${branch} closes ${repository}#${issueNumber}`,
          });
        },
        catch: (error) =>
          error instanceof FactoryError
            ? error
            : new FactoryError({
                code: "pull_request_verification_failed",
                message: "Pull request verification failed unexpectedly",
              }),
      }),
  };
}

export const makeGitHubService = (
  runner: CommandRunner = bunCommandRunner,
): GitHubService => makeService(runner);

export const layerGitHub = (runner: CommandRunner = bunCommandRunner) =>
  Layer.succeed(GitHub, makeService(runner));
