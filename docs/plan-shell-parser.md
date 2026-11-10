# Plan: shell parser instead of regex

## Goal
Replace the regex `git\s+(?:-C\s+\S+\s+)?(push|commit)` with a small dependency-free
shell tokenizer plus git argument parsing, so quoting, wrappers, nesting, global git
options and refspecs are understood. Adds an opt-in `blockForcePush` switch.

## Stages
1. **Tokenizer** (`shell.mjs`, pure): words with quotes/backslash, separators
   (`&&`, `||`, `;`, `|`, `&`, newline), subshell, `$( )`, backticks, heredocs,
   redirections, wrapper skipping (assignments, `env`, `sudo`, `time`, `nohup`, `command` ...),
   `bash -c` recursion with depth limit, "unclear" markers (open quote, `eval`, variable command name).
   Tests: `test/shell.test.mjs` (table, 60+ cases).
2. **git argument parser** (`gitargs.mjs`, pure): global options, subcommand,
   commit flags (`-a` in clusters, pathspecs), push options, remote, refspecs
   (`+`, `src:dst`, `refs/heads/`, delete, globs), force detection. Tests: `test/gitargs.test.mjs`.
3. **Integration** in `waechter.mjs`: iterate parsed commands, track `cd` per scope,
   `repoInfo` gets the directory git would really use (`-C`, `--git-dir`, `--work-tree`),
   source and destination checked against `blockedBranches`, unclear -> strict verdict.
   Existing tests stay unchanged; new tests in `test/check.test.mjs` with temp repos.
4. **`blockForcePush`** (default off): deny force pushes to public repos.
5. **CI + docs**: `.github/workflows/test.yml` (ubuntu/macos/windows x Node 18/20/22),
   README (both languages), Windows example, `config.example.json`, changelog.

## Not included
No dependencies, no variable evaluation, no execution, no full shell interpreter,
no alias resolution from repo config (only `-c alias.*` is flagged as unclear).

## Status
All five stages are done: `shell.mjs`, `gitargs.mjs`, integration in `waechter.mjs`,
`blockForcePush`, CI workflow, READMEs, `CHANGELOG.md`. Known limits: no alias resolution
from repo config, no `find -exec`/`parallel`, heredoc bodies with unquoted delimiter are only
searched for `$( )`/backticks, `cd` in pipelines is treated like a normal `cd`.
