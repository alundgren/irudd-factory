# Issue #14 pull request visualizations

This directory contains a review presentation for open pull requests #18 through #23. Open [`index.html`](index.html) through a local HTTP server, then move through the PRs in number order. Each diagram remains a standalone Archify viewer with search, focus, guided views, theme controls, and export actions.

## Review basis

I read the implementation files that establish each behavior and ignored lockfile churn, formatting, CSS detail, and repetitive tests. PRs #18 through #22 use their GitHub base and head branches. PR #23 targets `main` for issue-closing behavior, but it is the sixth change in the stack, so its diagrams use `issue-14/05-service ... issue-14/06-console`. This keeps #23 focused on the console and final provider corrections instead of repeating the previous five PRs.

| PR | Diagram | Reviewer question |
| --- | --- | --- |
| #18 | Assignment lifecycle | Which visible states exist, and where can orchestration fail? |
| #19 | Serialized durable admission | How do replay, provider concurrency, candidate count, and atomic writes determine the receipt? |
| #20 | Pinned GitHub discovery | Which policy revision and eligibility checks produce a candidate? |
| #20 | Retained linked worktree | How does a reusable clone produce safe retained paths at the pinned commit? |
| #21 | Codex App Server run | Which preflight checks, RPC calls, and normalized events make up one run? |
| #21 | Terminal provider cleanup | What happens after an approval, reroute, RPC failure, timeout, or unexpected exit? |
| #22 | Shared RPC service composition | How do the CLI, service, application ports, and production adapters connect? |
| #23 | Operator console loop | How do command submission, durable receipts, polling, reload, and busy state interact? |
| #23 | First terminal failure wins | How do late errors preempt success while cleanup stays within one deadline? |

## Files

- [`index.html`](index.html) is the presentation entrypoint.
- [`html/`](html/) contains nine delivered standalone Archify viewers.
- [`specs/`](specs/) contains the typed Archify inputs used to render the viewers.

## Validation

Every specification passed Archify's showcase validation with all 9 artifact checks, 0 composition errors, and 0 warnings. `deliver` completed successfully for every HTML file.

| Output | Type | Specification SHA-256 | Artifact SHA-256 |
| --- | --- | --- | --- |
| `pr18-assignment-lifecycle.html` | lifecycle | `5e48499015845bd3e5e29a364ef0416accb5511042753809fce90fa51e061837` | `6965d588d4d1ef1b24c1d9d559e10d926754ddf71de97747f8ddf4b86a3f73d8` |
| `pr19-durable-admission.html` | workflow | `cd3f5c2e46873f5d20efbb680ad8d42f3e5a31134cffbf07b5225594f8f80a28` | `5968d85f50dd2aad058af24019a743bb776d0a38cf29d8ad167225174bd8b1bb` |
| `pr20-github-discovery.html` | workflow | `511e97d00d04f05b63eeca2363e6051417acde320e6738913db1a3b81da642fe` | `05481dd66f00f34df6dd4b0bf90c9cb0e0b25cd4f9f037e9ac750df1754b9a93` |
| `pr20-retained-worktree.html` | workflow | `cd5307c5bea4627aa12d0aa51ad894505f90c04ee6eae47ad111f12700028738` | `330e9f6a894a173c51ff9086edbc2cf0fefc8716b5dd7e4147c776707c72e737` |
| `pr21-codex-rpc.html` | sequence | `16d4fad354f672a62167fc0ab4c4365a0cc6a36ee21076270b521171d7fae5cb` | `200905ac61a0dada1f35eca32859ec373df33871fa5d929ebb040948ede4260c` |
| `pr21-provider-cleanup.html` | sequence | `f216c6a947446b73b7e279827a416f4219a52e6fd80a4b6670ee5ec5d0ff0337` | `7be47fc806095e22f15c6c046e8b538722a1f3a031caef164c0520561e83bb46` |
| `pr22-service-composition.html` | architecture | `38b838fee4e312632a7a2aac3b055ce595f87253038817c4973a8d29fe5942ed` | `769f133a0c9553157ef5c8a16d85df8f131352972606df3e907c6468afa39019` |
| `pr23-console-review.html` | sequence | `c4c8cf70e8a969c06c9c7db09847d1755c823719dfc2be8fba4bd1df8c4395f3` | `ea94363b85f3c606fabd2b3317203925d29bfa78d5f1f67cda6debb680624bc8` |
| `pr23-terminal-failure.html` | workflow | `4848d3977efb461e38cab7a92d70896e74b2cbf7c0bae0a9af9447b5d4fce132` | `5850fc055bd5e119e14200713b63979f1486a41fbacf3a7e7139b6e92d66f20a` |

Archify's bundled visual check could not find Chrome or Chromium in this environment. The T3 collaborative preview loaded the delivered viewer, but its resize and screenshot controls timed out, so the required multi-viewport perceptual review remains unverified. The deterministic layout, readability, containment, light and dark parity, and export checks inside Archify all passed.

## Rebuild

Run these commands from the repository root with the Archify skill installed:

```sh
node /home/dev/.agents/skills/archify/bin/archify.mjs validate <type> docs/pr-visual/specs/<file>.json --quality showcase --json
node /home/dev/.agents/skills/archify/bin/archify.mjs deliver <type> docs/pr-visual/specs/<file>.json docs/pr-visual/html/<file>.html --quality showcase --json
```

The architecture diagram also needs `--repo-root <repository-root>` so Archify can verify its source references.
