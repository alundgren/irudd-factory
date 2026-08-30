# Symphony-inspired software factory

An issue-driven software factory for one developer working on repositories they
own. It is heavily inspired by
[Symphony](https://github.com/openai/symphony/blob/main/SPEC.md).

The initial product supports Claude Code and Codex, with GitHub issues as its
only work source.

Notable deviations from Symphony:

- GitHub issues only. Other trackers may be added later.
- One operator and one trust domain per installation. Repository contents and
  issue authors are trusted.
- Agent processes may read other files on the dedicated development VM. Do not
  install this on a general-purpose host or connect repositories where
  untrusted people can submit issues.

Very much a work in progress.
