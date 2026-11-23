# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/parsaturky83/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/parsaturky83/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

Entry for the make.fun bounty
[Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
(`hidden-spec-cli-01-run-20261122`).

## What it is

`main.ts` is a pure Node 22 standard-library command-line tool. It applies
AI-written edits in five formats to a tree of files, to one written
specification (`SPEC.md` in the kit):

- **Unified diff** — including diffs with wrong line numbers
- **SEARCH/REPLACE** blocks
- **V4A** patches
- **JSON** tool calls
- **Command line** edits

It finds the lines an edit names even when the model drifted their
whitespace or indentation, using three-tier line matching (exact →
normalised → fuzzy), and changes every file or none (all-or-nothing per
patch). No network, no clock, no randomness, no model calls: every run is
fully deterministic.

## Practice score

**100/100** on the kit's public practice checker, in three consecutive runs
(score 1000), plus 107/107 self-authored strict edge-case tests (fuzzy and
normalised matching, complex multi-file diffs, duplicate and missing
anchors, V4A edge cases, unsafe paths, CRLF, unicode, tabs vs spaces).

## Run it

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` absent or `-` means stdin; the working directory is the tree root.
Exit 0 prints one `A|D|M|R <path>` line per changed file and `ok: <n> files`;
exit 1 lists the failed edits and `failed: <k> of <n> edits` (nothing is
written); exit 2 is a usage or parse error. `--check` prints the identical
output and writes nothing.

`runner.ts` (kept verbatim from the kit) runs the trial checks: in a trial
it reads the checks from the environment, runs `node main.ts` on each one
in a fresh directory, and posts the exit code, stdout and resulting files.

## License

MIT — see [LICENSE](LICENSE).
