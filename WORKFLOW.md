---
required_labels: [ready-for-agent]
forbidden_labels: [claimed, ready-for-human, epic, needs-refinement]
runtime: bun
test: bun run test
---

Implement the selected issue at the pinned default-branch commit. Preserve the
requested behavior and repository instructions, run the relevant component
tests and the full suite, then commit, push `factory/<assignment-id>`, and open
a pull request that closes the selected issue. A draft pull request is
acceptable when a supported review finding remains unresolved; record the
finding and the validation already completed in the pull request body.
