#!/usr/bin/env node
// waechter: Claude Code PreToolUse hook that checks `git commit` and `git push`
// for secrets, private identifiers and risky branches. No dependencies.
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Built-in secret patterns (checked on added diff lines only)
export const SECRET_PATTERNS = [
  ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI key', /sk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ['ElevenLabs key', /\bsk_[a-f0-9]{40,}/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Twilio SID', /\bAC[a-f0-9]{32}\b/],
  ['Private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
]

export const DEFAULT_CONFIG = {
  publicRepoPatterns: [], // regexes matched against the origin URL; matches get strict mode (deny)
  alwaysAskRepoPatterns: [], // regexes; every push to a matching remote asks first
  blockedBranches: [], // branch names that may never be pushed from a public repo
  privateEmailPatterns: [], // regexes for addresses that must not appear in diffs
  privatePathPatterns: [], // regexes for paths (e.g. your home dir) not allowed in public repos
  phonePatterns: [], // regexes for phone numbers
  requiredEmailPattern: 'noreply\\.github\\.com', // authors/committers in public repos must match
}

export function loadConfig(path) {
  const candidates = [path, process.env.WAECHTER_CONFIG, join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'waechter', 'config.json')]
  for (const p of candidates) {
    if (!p || !existsSync(p)) continue
    let config
    try {
      const roh = JSON.parse(readFileSync(p, 'utf8'))
      if (roh === null || typeof roh !== 'object' || Array.isArray(roh)) throw new Error('must be a JSON object')
      config = { ...DEFAULT_CONFIG, ...roh }
      for (const [key, value] of Object.entries(config)) {
        if (key === 'requiredEmailPattern') {
          if (typeof value !== 'string' || !value) throw new Error(`${key} must be a non-empty string`)
          new RegExp(value, 'i')
        }
        else if (Array.isArray(DEFAULT_CONFIG[key])) {
          if (!Array.isArray(value)) throw new Error(`${key} must be a list`)
          for (const s of value) {
            if (typeof s !== 'string') throw new Error(`${key}: entries must be strings`)
            try { new RegExp(s, 'i') } catch (e) { throw new Error(`${key}: invalid regex "${s}" (${e.message})`) }
          }
        }
      }
    } catch (e) {
      throw new Error(`config.json ungültig (${p}, ${e.message})`)
    }
    return config
  }
  return { ...DEFAULT_CONFIG }
}

const rx = list => list.map(s => new RegExp(s, 'i'))

export function scanDiff(diff, config, isPublic) {
  const patterns = [
    ...SECRET_PATTERNS,
    ...rx(config.privateEmailPatterns).map(r => ['Private email address', r]),
    ...rx(config.phonePatterns).map(r => ['Phone number', r]),
    ...(isPublic ? rx(config.privatePathPatterns).map(r => ['Private path', r]) : []),
  ]
  const findings = []
  let file = '?'
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) { file = line.slice(6); continue }
    if (!line.startsWith('+')) continue
    for (const [name, re] of patterns) {
      const entry = `${name} in ${file}`
      if (re.test(line) && !findings.includes(entry)) findings.push(entry)
    }
  }
  return findings
}

function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { return undefined }
}

function repoInfo(command, gitPos, cwd, config) {
  const before = command.slice(0, gitPos)
  const dashC = /\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/.exec(command.slice(gitPos))
  const cds = [...before.matchAll(/(?:^|&&|;|\|\|)\s*cd\s+("[^"]+"|'[^']+'|\S+)/g)]
  let dir = (dashC?.[1] ?? cds.at(-1)?.[1] ?? '.').replace(/^["']|["']$/g, '')
  if (dir.startsWith('~')) dir = homedir() + dir.slice(1)
  if (!dir.startsWith('/')) dir = join(cwd, dir)
  const top = git(dir, ['rev-parse', '--show-toplevel'])
  if (top === undefined) return undefined
  const remote = git(top, ['remote', 'get-url', 'origin']) ?? ''
  return {
    top, remote,
    isPublic: rx(config.publicRepoPatterns).some(r => r.test(remote)),
    alwaysAsk: rx(config.alwaysAskRepoPatterns).some(r => r.test(remote)),
  }
}

function checkCommit(command, pos, cwd, config) {
  const repo = repoInfo(command, pos, cwd, config)
  if (!repo) return
  const all = /\bcommit\b[^&;|]*\s-[a-zA-Z]*a/.test(command.slice(pos))
  const diff = git(repo.top, ['diff', all ? 'HEAD' : '--cached', '--no-color', '-U0']) ?? ''
  const findings = scanDiff(diff, config, repo.isPublic)
  if (repo.isPublic) {
    const author = git(repo.top, ['var', 'GIT_AUTHOR_IDENT']) ?? ''
    if (!new RegExp(config.requiredEmailPattern, 'i').test(author)) findings.push(`author does not match ${config.requiredEmailPattern}`)
  }
  if (!findings.length) return
  const text = `waechter: ${findings.join('; ')}`
  return repo.isPublic
    ? { decision: 'deny', reason: `${text}. Public repo, commit blocked.` }
    : { decision: 'ask', reason: `${text}. Commit anyway?` }
}

function checkPush(command, pos, cwd, config) {
  const repo = repoInfo(command, pos, cwd, config)
  if (!repo) return
  const part = command.slice(pos).split(/&&|;|\|\|/)[0] ?? ''
  const words = part.trim().split(/\s+/)
  const afterPush = words.slice(words.indexOf('push') + 1)
  const args = afterPush.filter(w => !w.startsWith('-'))
  const refs = args.slice(1).map(r => r.replace(/^\+/, '').split(':')[0] ?? '').filter(Boolean)
  const sources = refs.length ? refs : ['HEAD']

  if (repo.isPublic) {
    if (afterPush.some(w => w === '--all' || w === '--mirror'))
      return { decision: 'deny', reason: 'waechter: --all/--mirror on a public repo would upload every local branch.' }
    const blocked = sources.filter(s => config.blockedBranches.includes(s))
    if (blocked.length)
      return { decision: 'deny', reason: `waechter: branch ${blocked.join(', ')} is on the blocked list and must not be pushed.` }
    const idents = git(repo.top, ['log', ...sources, '--not', '--remotes', '--format=%ae%n%ce']) ?? ''
    const bad = [...new Set(idents.split('\n').filter(a => a && !new RegExp(config.requiredEmailPattern, 'i').test(a)))]
    if (bad.length)
      return { decision: 'deny', reason: `waechter: new commits carry ${bad.join(', ')} instead of an address matching ${config.requiredEmailPattern}.` }
  }
  if (repo.alwaysAsk) return { decision: 'ask', reason: 'waechter: this remote is on the always-ask list. Really push?' }
}

// Erkennt `git push`/`git commit` im Bash-Befehl; sonst undefined (Config wird dann gar nicht geladen).
export function gitMatch(input) {
  if (input.tool_name !== 'Bash') return
  const command = String(input.tool_input?.command ?? '')
  const m = /\bgit\s+(?:-C\s+\S+\s+)?(push|commit)\b/.exec(command)
  return m ? { command, m } : undefined
}

export function check(input, config) {
  const hit = gitMatch(input)
  if (!hit) return
  const { command, m } = hit
  const cwd = input.cwd || process.cwd()
  return m[1] === 'push' ? checkPush(command, m.index, cwd, config) : checkCommit(command, m.index, cwd, config)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let verdict
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'))
    if (gitMatch(input)) {
      let config
      try {
        config = loadConfig()
      } catch (e) {
        verdict = { decision: 'ask', reason: `waechter: ${e.message}` }
      }
      if (config) verdict = check(input, config)
    }
  } catch {
    verdict = { decision: 'ask', reason: 'waechter: check failed, please decide yourself.' }
  }
  if (verdict) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: verdict.decision, permissionDecisionReason: verdict.reason },
    }))
  }
}
