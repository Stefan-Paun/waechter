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

**On `git push`**: in public repos it denies `--all`/`--mirror`, branches on `blockedBranches`, and unpushed commits whose author or committer email does not match `requiredEmailPattern`. Remotes on `alwaysAskRepoPatterns` always ask first.

Findings in a public repo are **denied**; in any other repo Claude Code **asks** you. If the hook itself fails, it asks.

Limitations: it parses the command string, so `git add && git commit` in one command sees the old stage (run them separately); aliases and scripts that call git are not detected.

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

Copy `config.example.json` to `~/.config/waechter/config.json` (or point `WAECHTER_CONFIG` at it) and edit. All keys are optional lists of regex strings; without a config only the 7 built-in secret patterns run and no repo counts as public.

## Test

```
npm test
```

## License

MIT
