# Attempt lifecycle consequences

Lifecycle commands keep their admission decision, execution phase, current
effect, and final consequence in `lifecycle_commands`. A repeated command ID
returns that original record, even when the repeated request contains different
arguments.

Each command supplies the attempt's `lastEventSequence` as
`expectedTargetVersion`. Factory stores a final rejection if that value is
stale, the source state is not allowed, the repository requirement is not met,
or the pull request rule fails.

| Command | Allowed source                                                             | Process result                                                                                                                                                         | `claimed` result                            | Queue result                                                        | Workspace and branch                                                          | Pull request rule                                                                                     | History result                                                                              | Reversal                                                                            |
| ------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Stop    | `reserved`, `starting`, `running`, `ownership_uncertain`, `stop_uncertain` | Interrupt the live provider fiber, terminate its recorded process group, and wait for exit. An unconfirmed exit produces `stop_uncertain` and still consumes one slot. | Preserved                                   | None                                                                | Preserved                                                                     | Preserved                                                                                             | State and stop consequence are appended                                                     | A later Stop may confirm exit. Return or Restart becomes available after `stopped`. |
| Return  | `failed`, `interrupted`, `stopped`                                         | None                                                                                                                                                                   | Remove and verify absence                   | Polling may create a new queue tenure after it observes eligibility | Preserved                                                                     | Confirm no pull request exists for the retained branch and issue. Reject present or unknown evidence. | Return consequence is appended                                                              | A later queue admission can start a new attempt. The old attempt is unchanged.      |
| Restart | `failed`, `interrupted`, `stopped`                                         | Start a new provider only after a sibling reservation succeeds                                                                                                         | Must already be present and remains present | Does not create a queue tenure                                      | Create a new worktree and branch for the sibling. Preserve the earlier files. | Reject when the earlier attempt has a pull request                                                    | Link the earlier attempt to the sibling. Keep both attempts.                                | Stop or otherwise control the sibling as a separate attempt.                        |
| Archive | `completed`, `failed`, `interrupted`, `stopped`                            | None                                                                                                                                                                   | Preserved                                   | None                                                                | Preserved                                                                     | Preserved                                                                                             | Hide the attempt from default attempt and timeline reads. Keep all rows and retained files. | Restore                                                                             |
| Restore | An archived `completed`, `failed`, `interrupted`, or `stopped` attempt     | None                                                                                                                                                                   | Preserved                                   | None                                                                | Preserved                                                                     | Preserved                                                                                             | Return the attempt to default attempt and timeline reads                                    | Archive                                                                             |

Return and Restart reject attempts whose repository is absent from the active
configuration. Restart performs fresh issue, blocker, label, author permission,
and `WORKFLOW.md` validation. It uses the current repository model and reasoning
effort. It never resumes the earlier thread or writes into its worktree.

## Recovery checkpoints

Startup reads every non-final lifecycle command before dispatch starts.

- Stop records `process_interrupting`, then records the confirmed result as
  `process_resolved:<result>`. Recovery checks stored process identity before it
  sends a signal. A recorded result is finalized without signaling again.
- Return records `pull_request_inspecting` and `pull_request_absent` before any
  label mutation. It then records `label_removing`, verifies current label
  state, removes the label only when it is still present, and records
  `label_removed`. Recovery repeats an unfinished inspection but finalizes a
  recorded removal without another GitHub mutation.
- Restart records `issue_revalidating`, `issue_validated`, and
  `sibling_reserved`. The sibling uses a durable admission receipt derived from
  the lifecycle command ID. Recovery replays that receipt, so it cannot reserve
  a second sibling.
- Archive and Restore record `visibility_updating`. The attempt event includes
  the command ID, so recovery does not append the same visibility event twice.

Polling writes active-issue eligibility-loss observations. Lifecycle commands
read those observations but do not write queue polling state or call back into
the poller.
