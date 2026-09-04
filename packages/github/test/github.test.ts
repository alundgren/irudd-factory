import { describe, expect, test } from "vite-plus/test";
import { Effect } from "effect";
import {
  makeGitHubService,
  type CommandResult,
  type CommandRunner,
} from "../src/index.ts";

const workflow = `---
required_labels: [ready-for-agent]
forbidden_labels: [claimed, ready-for-human, epic, needs-refinement]
runtime: node
test: vp run test
---
Implement the issue.`;

class FakeRunner implements CommandRunner {
  readonly calls: Array<{ args: ReadonlyArray<string>; input?: string }> = [];
  private readonly responses: CommandResult[];

  constructor(responses: CommandResult[]) {
    this.responses = responses;
  }

  async run(args: ReadonlyArray<string>, input?: string) {
    this.calls.push({ args, ...(input === undefined ? {} : { input }) });
    const response = this.responses.shift();
    if (!response) throw new Error(`Unexpected command: ${args.join(" ")}`);
    return response;
  }
}

const ok = (value: unknown): CommandResult => ({
  stdout: JSON.stringify(value),
  stderr: "",
  exitCode: 0,
});

const lastPage = { hasNextPage: false, endCursor: null };

function discovery(
  issues: ReadonlyArray<Record<string, unknown>>,
  pageInfo: Record<string, unknown> = lastPage,
) {
  return ok({
    data: {
      repository: {
        defaultBranchRef: {
          name: "main",
          target: { oid: "a".repeat(40) },
        },
        issues: { nodes: issues, pageInfo },
      },
    },
  });
}

function claimedIssueResponse(overrides: Record<string, unknown> = {}) {
  return ok({
    data: {
      repository: {
        defaultBranchRef: { target: { oid: "a".repeat(40) } },
        issue: issue({
          labels: {
            nodes: [{ name: "ready-for-agent" }, { name: "claimed" }],
            pageInfo: lastPage,
          },
          ...overrides,
        }),
      },
    },
  });
}

function issue(overrides: Record<string, unknown> = {}) {
  return {
    id: "I_1",
    state: "OPEN",
    number: 1,
    url: "https://github.com/owner/repository/issues/1",
    title: "Issue one",
    author: { login: "owner" },
    labels: { nodes: [{ name: "ready-for-agent" }], pageInfo: lastPage },
    blockedBy: { nodes: [], pageInfo: lastPage },
    ...overrides,
  };
}

const workflowResponse = ok({
  sha: "b".repeat(40),
  encoding: "base64",
  content: Buffer.from(workflow).toString("base64"),
});

describe("GitHub adapter", () => {
  test("pins candidate policy and workflow to one commit", async () => {
    const runner = new FakeRunner([
      discovery([issue()]),
      workflowResponse,
      ok({ permission: "write" }),
    ]);
    const candidates = await Effect.runPromise(
      makeGitHubService(runner).discoverCandidates("owner/repository"),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.workflow.startingCommit).toBe("a".repeat(40));
    expect(candidates[0]?.workflow.blobId).toBe("b".repeat(40));
    expect(runner.calls[1]?.args).toContain(`ref=${"a".repeat(40)}`);
    expect(runner.calls.every(({ args }) => Array.isArray(args))).toBe(true);
  });

  test("revalidates the issue and pinned workflow before start", async () => {
    const runner = new FakeRunner([
      discovery([issue()]),
      workflowResponse,
      ok({ permission: "write" }),
      discovery([issue()]),
      workflowResponse,
      ok({ permission: "write" }),
    ]);
    const service = makeGitHubService(runner);
    const [candidate] = await Effect.runPromise(
      service.discoverCandidates("owner/repository"),
    );
    expect(candidate).toBeDefined();
    await expect(
      Effect.runPromise(service.revalidateIssue!(candidate!)),
    ).resolves.toEqual(candidate);
  });

  test("rejects a workflow revision that changed after selection", async () => {
    const runner = new FakeRunner([
      discovery([issue()]),
      workflowResponse,
      ok({ permission: "write" }),
      discovery([issue()]),
      ok({
        sha: "d".repeat(40),
        encoding: "base64",
        content: Buffer.from(workflow).toString("base64"),
      }),
      ok({ permission: "write" }),
    ]);
    const service = makeGitHubService(runner);
    const [candidate] = await Effect.runPromise(
      service.discoverCandidates("owner/repository"),
    );
    await expect(
      Effect.runPromise(service.revalidateIssue!(candidate!)),
    ).rejects.toThrow("changed before start");
  });

  test("freshly validates a claimed issue for restart", async () => {
    const runner = new FakeRunner([
      claimedIssueResponse(),
      workflowResponse,
      ok({ permission: "write" }),
    ]);
    const candidate = await Effect.runPromise(
      makeGitHubService(runner).revalidateClaimedIssue!({
        nodeId: "I_1",
        repository: "owner/repository",
        number: 1,
        url: "https://github.com/owner/repository/issues/1",
        title: "Issue one",
      }),
    );
    expect(candidate.workflow.startingCommit).toBe("a".repeat(40));
    expect(candidate.workflow.blobId).toBe("b".repeat(40));
    expect(runner.calls[0]?.args).toContain("number=1");
  });

  test("rejects restart when claimed is absent or a blocker is open", async () => {
    const unclaimed = new FakeRunner([
      claimedIssueResponse({
        labels: {
          nodes: [{ name: "ready-for-agent" }],
          pageInfo: lastPage,
        },
      }),
      workflowResponse,
    ]);
    const blocked = new FakeRunner([
      claimedIssueResponse({
        blockedBy: { nodes: [{ state: "OPEN" }], pageInfo: lastPage },
      }),
      workflowResponse,
    ]);
    const ref = {
      nodeId: "I_1",
      repository: "owner/repository",
      number: 1,
      url: "https://github.com/owner/repository/issues/1",
      title: "Issue one",
    };
    await expect(
      Effect.runPromise(
        makeGitHubService(unclaimed).revalidateClaimedIssue!(ref),
      ),
    ).rejects.toThrow("invalid restart labels");
    await expect(
      Effect.runPromise(
        makeGitHubService(blocked).revalidateClaimedIssue!(ref),
      ),
    ).rejects.toThrow("open blocker");
  });

  test("rejects restart when the claimed issue is closed", async () => {
    const runner = new FakeRunner([claimedIssueResponse({ state: "CLOSED" })]);
    await expect(
      Effect.runPromise(
        makeGitHubService(runner).revalidateClaimedIssue!({
          nodeId: "I_1",
          repository: "owner/repository",
          number: 1,
          url: "https://github.com/owner/repository/issues/1",
          title: "Issue one",
        }),
      ),
    ).rejects.toThrow("is not open");
  });

  test("rejects forbidden labels, blockers, and non-writers", async () => {
    const runner = new FakeRunner([
      discovery([
        issue({
          id: "I_claimed",
          labels: {
            nodes: [{ name: "ready-for-agent" }, { name: "claimed" }],
            pageInfo: lastPage,
          },
        }),
        issue({
          id: "I_blocked",
          blockedBy: { nodes: [{ state: "OPEN" }], pageInfo: lastPage },
        }),
        issue({ id: "I_reader", number: 3 }),
      ]),
      workflowResponse,
      ok({ permission: "read" }),
    ]);
    const candidates = await Effect.runPromise(
      makeGitHubService(runner).discoverCandidates("owner/repository"),
    );
    expect(candidates).toEqual([]);
    expect(runner.calls).toHaveLength(3);
  });

  test("paginates the complete issue candidate set", async () => {
    const runner = new FakeRunner([
      discovery([issue()], {
        hasNextPage: true,
        endCursor: "issue-page-2",
      }),
      discovery([
        issue({
          id: "I_2",
          number: 2,
          url: "https://github.com/owner/repository/issues/2",
        }),
      ]),
      workflowResponse,
      ok({ permission: "write" }),
      ok({ permission: "write" }),
    ]);
    const candidates = await Effect.runPromise(
      makeGitHubService(runner).discoverCandidates("owner/repository"),
    );
    expect(candidates).toHaveLength(2);
    expect(runner.calls[1]?.args).toContain("issueCursor=issue-page-2");
  });

  test("paginates labels and blockers before eligibility", async () => {
    const runner = new FakeRunner([
      discovery([
        issue({
          id: "I_late_label",
          labels: {
            nodes: [{ name: "ready-for-agent" }],
            pageInfo: { hasNextPage: true, endCursor: "label-page-2" },
          },
        }),
        issue({
          id: "I_late_blocker",
          number: 2,
          blockedBy: {
            nodes: [],
            pageInfo: { hasNextPage: true, endCursor: "blocker-page-2" },
          },
        }),
      ]),
      workflowResponse,
      ok({
        data: {
          node: {
            labels: {
              nodes: [{ name: "claimed" }],
              pageInfo: lastPage,
            },
          },
        },
      }),
      ok({
        data: {
          node: {
            blockedBy: {
              nodes: [{ state: "OPEN" }],
              pageInfo: lastPage,
            },
          },
        },
      }),
    ]);
    const candidates = await Effect.runPromise(
      makeGitHubService(runner).discoverCandidates("owner/repository"),
    );
    expect(candidates).toEqual([]);
    expect(runner.calls[2]?.args).toContain("cursor=label-page-2");
    expect(runner.calls[3]?.args).toContain("cursor=blocker-page-2");
  });

  test("reconciles a failed claim with exactly one read", async () => {
    const runner = new FakeRunner([
      { stdout: "", stderr: "timeout", exitCode: 1 },
      ok({
        labels: [
          ...Array.from({ length: 35 }, (_, index) => ({
            name: `label-${index}`,
          })),
          { name: "claimed" },
        ],
      }),
    ]);
    const outcome = await Effect.runPromise(
      makeGitHubService(runner).claimIssue({
        nodeId: "I_1",
        repository: "owner/repository",
        number: 1,
        url: "https://github.com/owner/repository/issues/1",
        title: "Issue",
      }),
    );
    expect(outcome).toBe("confirmed");
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0]?.input).toBe('{"labels":["claimed"]}');
    expect(runner.calls[1]?.args).toContain("repos/owner/repository/issues/1");
  });

  test("distinguishes unclaimed and unknown reconciliation", async () => {
    const unclaimed = new FakeRunner([
      { stdout: "", stderr: "failed", exitCode: 1 },
      ok({ labels: [{ name: "ready-for-agent" }] }),
    ]);
    const unknown = new FakeRunner([
      { stdout: "", stderr: "failed", exitCode: 1 },
      { stdout: "", stderr: "failed", exitCode: 1 },
    ]);
    const ref = {
      nodeId: "I_1",
      repository: "owner/repository",
      number: 1,
      url: "https://github.com/owner/repository/issues/1",
      title: "Issue",
    };
    expect(
      await Effect.runPromise(makeGitHubService(unclaimed).claimIssue(ref)),
    ).toBe("unclaimed");
    expect(
      await Effect.runPromise(makeGitHubService(unknown).claimIssue(ref)),
    ).toBe("unknown");
  });

  test("removes claimed and verifies the resulting label state", async () => {
    const runner = new FakeRunner([
      ok({}),
      ok({ labels: [{ name: "ready-for-agent" }] }),
    ]);
    const outcome = await Effect.runPromise(
      makeGitHubService(runner).removeClaim!({
        nodeId: "I_1",
        repository: "owner/repository",
        number: 1,
        url: "https://github.com/owner/repository/issues/1",
        title: "Issue one",
      }),
    );
    expect(outcome).toBe("unclaimed");
    expect(runner.calls[0]?.args).toContain("DELETE");
    expect(runner.calls[1]?.args).toContain("repos/owner/repository/issues/1");
  });

  test("verifies repository, branch, closing issue, and draft state", async () => {
    const runner = new FakeRunner([
      ok({
        data: {
          repository: {
            pullRequests: {
              nodes: [
                {
                  id: "PR_7",
                  number: 7,
                  url: "https://github.com/owner/repository/pull/7",
                  isDraft: true,
                  headRefName: "factory/assignment-1",
                  closingIssuesReferences: {
                    nodes: [
                      {
                        number: 1,
                        repository: { nameWithOwner: "owner/repository" },
                      },
                    ],
                    pageInfo: lastPage,
                  },
                },
              ],
              pageInfo: lastPage,
            },
          },
        },
      }),
    ]);
    const pull = await Effect.runPromise(
      makeGitHubService(runner).verifyPullRequest(
        "owner/repository",
        "factory/assignment-1",
        1,
      ),
    );
    expect(pull).toEqual({
      url: "https://github.com/owner/repository/pull/7",
      number: 7,
      draft: true,
    });
  });

  test("finds the assigned issue on a later closing-reference page", async () => {
    const runner = new FakeRunner([
      ok({
        data: {
          repository: {
            pullRequests: {
              nodes: [
                {
                  id: "PR_8",
                  number: 8,
                  url: "https://github.com/owner/repository/pull/8",
                  isDraft: false,
                  headRefName: "factory/assignment-1",
                  closingIssuesReferences: {
                    nodes: [],
                    pageInfo: {
                      hasNextPage: true,
                      endCursor: "closing-page-2",
                    },
                  },
                },
              ],
              pageInfo: lastPage,
            },
          },
        },
      }),
      ok({
        data: {
          node: {
            closingIssuesReferences: {
              nodes: [
                {
                  number: 1,
                  repository: { nameWithOwner: "owner/repository" },
                },
              ],
              pageInfo: lastPage,
            },
          },
        },
      }),
    ]);
    const pull = await Effect.runPromise(
      makeGitHubService(runner).verifyPullRequest(
        "owner/repository",
        "factory/assignment-1",
        1,
      ),
    );
    expect(pull.number).toBe(8);
    expect(runner.calls[1]?.args).toContain("cursor=closing-page-2");
  });

  test("searches all pull request states and reports any historic match", async () => {
    const closingIssuesReferences = {
      nodes: [
        {
          number: 1,
          repository: { nameWithOwner: "owner/repository" },
        },
      ],
      pageInfo: lastPage,
    };
    const runner = new FakeRunner([
      ok({
        data: {
          repository: {
            pullRequests: {
              nodes: [
                {
                  id: "PR_7",
                  number: 7,
                  url: "https://github.com/owner/repository/pull/7",
                  isDraft: false,
                  headRefName: "factory/assignment-1",
                  closingIssuesReferences,
                },
                {
                  id: "PR_8",
                  number: 8,
                  url: "https://github.com/owner/repository/pull/8",
                  isDraft: true,
                  headRefName: "factory/assignment-1",
                  closingIssuesReferences,
                },
              ],
              pageInfo: lastPage,
            },
          },
        },
      }),
    ]);
    const lookup = makeGitHubService(runner).lookupPullRequest;
    expect(lookup).toBeDefined();
    expect(
      await Effect.runPromise(
        lookup!("owner/repository", "factory/assignment-1", 1),
      ),
    ).toMatchObject({ _tag: "present", pullRequest: { number: 7 } });
    expect(runner.calls[0]?.args.join(" ")).toContain(
      "states: [OPEN, CLOSED, MERGED]",
    );
  });

  test("reports a branch pull request even when it does not close the issue", async () => {
    const runner = new FakeRunner([
      ok({
        data: {
          repository: {
            pullRequests: {
              nodes: [
                {
                  id: "PR_9",
                  number: 9,
                  url: "https://github.com/owner/repository/pull/9",
                  isDraft: true,
                  headRefName: "factory/assignment-1",
                  closingIssuesReferences: { nodes: [], pageInfo: lastPage },
                },
              ],
              pageInfo: lastPage,
            },
          },
        },
      }),
    ]);
    expect(
      await Effect.runPromise(
        makeGitHubService(runner).inspectAttemptPullRequest!(
          "owner/repository",
          "factory/assignment-1",
        ),
      ),
    ).toMatchObject({ _tag: "present", pullRequest: { number: 9 } });
    expect(runner.calls).toHaveLength(1);
  });

  test("distinguishes absent pull requests from unknown lookup evidence", async () => {
    const absent = new FakeRunner([
      ok({
        data: {
          repository: {
            pullRequests: { nodes: [], pageInfo: lastPage },
          },
        },
      }),
    ]);
    const unknown = new FakeRunner([
      { stdout: "", stderr: "timeout", exitCode: 1 },
    ]);
    expect(
      await Effect.runPromise(
        makeGitHubService(absent).lookupPullRequest!(
          "owner/repository",
          "factory/assignment-1",
          1,
        ),
      ),
    ).toEqual({ _tag: "absent" });
    expect(
      await Effect.runPromise(
        makeGitHubService(unknown).lookupPullRequest!(
          "owner/repository",
          "factory/assignment-1",
          1,
        ),
      ),
    ).toEqual({ _tag: "unknown" });
  });
});
