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

Copy `config.example.json` to `~/.config/waechter/config.json` (or point `WAECHTER_CONFIG` at it) and edit. Most keys are optional lists of regex strings; without a config only the 7 built-in secret patterns run and no repo counts as public.

Large diffs: if the staged diff (or the push log) is bigger than `maxDiffMegabytes` (default 20) or git takes longer than 10 s, waechter does not pass silently but asks: "diff too large or too slow to scan, check manually". To keep big commits scannable, `skipScanPaths` (default empty, opt-in) takes git globs such as `**/package-lock.json` or `*.min.js` that are excluded from the commit scan. Skipped paths are not checked at all, so use it sparingly.

## Test

```
npm test
```

## License

MIT
