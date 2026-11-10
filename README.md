# waechter

A dependency-free [Claude Code](https://claude.com/claude-code) `PreToolUse` hook that checks `git commit` and `git push` commands before Claude runs them.

> Catches common mistakes, not a full secret scanner. Use [gitleaks](https://github.com/gitleaks/gitleaks) too.

## What it checks

**On `git commit`** it scans the added lines of the staged diff (or `HEAD` diff with `-a`):

| # | Pattern | Source |
|---|---------|--------|
| 1 | Anthropic API key | built in |
| 2 | OpenAI API key | built in |
| 3 | ElevenLabs key | built in |
| 4 | GitHub token | built in |
| 5 | AWS access key ID | built in |
| 6 | Twilio SID | built in |
| 7 | Private key block | built in |
| 8 | Private email addresses | `privateEmailPatterns` |
| 9 | Phone numbers | `phonePatterns` |
| 10 | Private paths (public repos only) | `privatePathPatterns` |

In a public repo it also requires the author to match `requiredEmailPattern` (default: GitHub `noreply` address).

**On `git push`**: in public repos it denies `--all`/`--mirror`, wildcard refspecs, branches on `blockedBranches` (checked for the source **and** the destination of every refspec: `HEAD:old`, `HEAD:refs/heads/old`, `+old`, `:old`, `--delete origin old`; an empty push or `HEAD` means the current branch), and unpushed commits (including `--tags`) whose author or committer email does not match `requiredEmailPattern`. Remotes on `alwaysAskRepoPatterns` always ask first. If you push to a remote other than `origin` (by name, `--repo` or URL), that URL counts for `publicRepoPatterns`/`alwaysAskRepoPatterns` too.

**Force push** (`blockForcePush`, **off by default**): when `true`, public repos deny `--force`, `-f` (also in clusters like `-uf`), `--force-with-lease`, `--force-if-includes` and `+ref` refspecs.

**How commands are read.** A small built-in shell parser (`shell.mjs`, no dependencies) replaces the old regex. It understands quotes and backslashes, `&&` `||` `;` `|` `&` and newlines, `( ... )`, `$( ... )`, backticks, heredocs, redirections, leading `VAR=x`, `env`, `command`, `sudo`, `time`, `nohup`, `nice`, `timeout`, `xargs`, `cd` (also inside subshells) and `bash -c '...'` / `sh -c` / `zsh -c` (nested up to 8 levels). `gitargs.mjs` then reads global git options (`-C <path>` repeated and quoted, `-c k=v`, `--git-dir`, `--work-tree`, `GIT_DIR=...`, `--no-pager`, `-p`, `--exec-path`) so the check inspects exactly the repository git would use.

Anything it cannot read safely is **unclear**: an open quote, `eval`, a variable or substitution as the command name, a variable in a push argument, `cd "$X"`, `cd -`, a shell reading from stdin, `git -c alias.*`. Unclear commands are treated strictly with an explanatory message: **deny** in a public repo, **ask** otherwise (and only when `git` or something that could hide it is involved).

**Changes to earlier behaviour** (things that used to slip through are now found): `git -C` with quotes or several times, `git -c k=v push`, `bash -c 'git push'`, `VAR=x git push`, `$(git push)`, `git push origin HEAD:old`, `+old`, `old:other` and the destination of a refspec; `git commit -am`, `git commit <paths>` and `-c user.email=...`, `GIT_AUTHOR_EMAIL=...`, `--author=...`; the committer address is now checked on commit as well. The directory of an earlier `cd` is followed. If the commits to push cannot be read, waechter asks instead of silently passing.

Findings in a public repo are **denied**; in any other repo Claude Code **asks** you. If the hook itself fails, it asks.

Limitations: it parses the command string (it never executes or evaluates anything), so `git add && git commit` in one command sees the old stage (run them separately); aliases and scripts that call git are not detected.

## Write check (optional)

With `writeCheck` set, the hook also looks at `Write`, `Edit`, `MultiEdit` and `NotebookEdit` calls and scans only the **new** content (for edits: each inserted text on its own) with the same patterns as the commit check, *before* the file is written.

- Applies only to files inside a git repo that counts as public (`publicRepoPatterns`) and that are **not** git-ignored (`git check-ignore`), so a `.env` listed in `.gitignore` is fine. No repo or a private repo: nothing happens.
- `writeCheck`: `"aus"` (default, off), `"warnen"` (Claude Code asks you), `"blocken"` (denied, Claude sees the reason). **The default is `aus`, so existing installs do not get stricter**; you also have to add `Write|Edit|MultiEdit|NotebookEdit` to the hook matcher.
- Skipped: obvious placeholders (`xxx`, `example`, `changeme`, `<...>`, long runs of one character), paths matching `writeCheckIgnorePaths` (regexes on the repo-relative path, e.g. test fixtures), lines containing `waechter:erlaubt` (or `waechter:allow`), binary content and content larger than `writeCheckMaxBytes` (default 1000000).
- The message names the pattern and line; the value is never printed or logged, only masked (first 4 characters + length). It tells the agent to use an environment variable, a git-ignored file or the keychain instead.

Matcher for the hook: `"matcher": "Bash|Write|Edit|MultiEdit|NotebookEdit"`.

## Install

Requires Node 18+. Clone this repo, then add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "node $HOME/path/to/waechter/waechter.mjs" }]
      }
    ]
  }
}
```

## Configure

Copy `config.example.json` to `~/.config/waechter/config.json` (or point `WAECHTER_CONFIG` at it) and edit. All keys are optional (lists of regex strings, plus the boolean `blockForcePush`); without a config only the 7 built-in secret patterns run and no repo counts as public.

Large diffs: if the staged diff (or the push log) is bigger than `maxDiffMegabytes` (default 20) or git takes longer than 10 s, waechter does not pass silently but asks: "diff too large or too slow to scan, check manually". To keep big commits scannable, `skipScanPaths` (default empty, opt-in) takes git globs such as `**/package-lock.json` or `**/*.min.js` that are excluded from the commit scan. Skipped paths are not checked at all, so use it sparingly.

### Windows

Claude Code runs Bash commands through Git Bash on Windows, so the parser reads POSIX shell syntax. Quote Windows paths (`git -C "C:\work\repo" push`) or use Git-Bash style (`/c/work/repo`, converted automatically). Hook entry in `%USERPROFILE%\.claude\settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "node \"%USERPROFILE%\\tools\\waechter\\waechter.mjs\"" }]
      }
    ]
  }
}
```

The default config path is `%USERPROFILE%\.config\waechter\config.json`; set `XDG_CONFIG_HOME` or `WAECHTER_CONFIG` to use another place.

## Test

```
npm test
```

Modules: `shell.mjs` (tokenizer), `gitargs.mjs` (git options, push, refspecs), `waechter.mjs` (checks and hook). Tests: `test/shell.test.mjs`, `test/gitargs.test.mjs`, `test/check.test.mjs` (temporary repos, made-up data), `test/waechter.test.mjs`. A CI matrix (ubuntu/macos/windows x Node 18/20/22) is in `.github/workflows/test.yml`.

## License

MIT
