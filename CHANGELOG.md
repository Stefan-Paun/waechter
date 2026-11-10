# Changelog

## Unreleased

### Added
- Shell parser (`shell.mjs`) and git argument parser (`gitargs.mjs`) replace the `git push|commit` regex.
- `blockForcePush` (default `false`): deny `--force`, `-f`, `--force-with-lease`, `--force-if-includes` and `+ref` in public repos.
- Push: refspecs are split into source and destination, both are checked against `blockedBranches` (`refs/heads/` removed, `+` recognised, `HEAD`/empty push = current branch); wildcard refspecs are denied in public repos; `--tags` commits are author-checked.
- CI matrix workflow (ubuntu/macos/windows x Node 18/20/22) and a Windows example in the README.

### Changed (earlier bypasses are now found; defaults otherwise unchanged)
- `git -C` with quotes/spaces/several times, `--git-dir`, `--work-tree`, `GIT_DIR=`, `-c k=v`, `--no-pager` and other global options are understood; the repository git would use is inspected (`cd` is followed, also in subshells).
- Commands inside `bash -c`, `$( )`, backticks, `( )`, after `VAR=x`, `env`, `sudo`, `time`, `nohup`, `command` are checked.
- Commands that cannot be read (open quotes, `eval`, variable command names, variable push arguments) are treated strictly: deny in public repos, ask otherwise.
- Pushing to a remote other than `origin` (name, `--repo`, URL) also checks that remote's URL against `publicRepoPatterns`/`alwaysAskRepoPatterns`.
- Commit: `-a` is found inside flag clusters only when it is a flag (not in a message), `git commit <paths>` scans those files' working-tree content, `-c user.email=`, `GIT_AUTHOR_EMAIL=`, `--author=` are checked, the committer address is checked too, `-a` also works before the first commit.
- Push: if the commits to push cannot be read, waechter asks instead of silently passing.
- `npm test` now runs all test files.
