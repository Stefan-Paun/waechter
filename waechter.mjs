#!/usr/bin/env node
// waechter: Claude Code PreToolUse hook that checks `git commit` and `git push`
// for secrets, private identifiers and risky branches. No dependencies.
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
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
    if (p && existsSync(p)) return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(p, 'utf8')) }
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

function git(pre, args) {
  try {
    return execFileSync('git', [...pre, ...args], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { return undefined }
}

// Splits the shell words that follow position `from`, up to the next command separator.
// Understands single quotes, double quotes and backslash escapes; no expansions.
function shellWords(s, from) {
  const out = []
  let cur = '', open = false, q = ''
  for (let i = from; i < s.length; i++) {
    const c = s[i]
    if (q) {
      if (c === q) q = ''
      else if (q === '"' && c === '\\' && '"\\$`'.includes(s[i + 1] ?? ' ')) cur += s[++i]
      else cur += c
    } else if (c === '"' || c === "'") { q = c; open = true }
    else if (c === '\\' && i + 1 < s.length) { cur += s[++i]; open = true }
    else if (';&|\n()'.includes(c)) break
    else if (/\s/.test(c)) { if (open) out.push(cur); cur = ''; open = false }
    else { cur += c; open = true }
  }
  if (open) out.push(cur)
  return out
}

// Global git options that take their value as a separate word
const VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source'])

// Finds the first `git ... push|commit` in a command, skipping global options
// (`-c k=v`, `--no-pager`, `-C <dir>`, `--git-dir=`, `--work-tree=` ...) before the subcommand.
export function findGit(command) {
  for (const m of command.matchAll(/\bgit(?:\.exe)?(?=\s)/g)) {
    const words = shellWords(command, m.index + m[0].length)
    const g = { pos: m.index, dirs: [], conf: {} }
    let i = 0
    for (; i < words.length && words[i].startsWith('-'); i++) {
      let name = words[i], value
      const eq = name.indexOf('=')
      if (name.startsWith('--') && eq > 0) [name, value] = [name.slice(0, eq), name.slice(eq + 1)]
      else if (VALUE_OPTIONS.has(name)) value = words[++i] ?? ''
      if (name === '-C') g.dirs.push(value)
      else if (name === '--git-dir') g.gitDir = value
      else if (name === '--work-tree') g.workTree = value
      else if (name === '-c') {
        const cut = value.indexOf('=')
        if (cut > 0) g.conf[value.slice(0, cut).toLowerCase()] = value.slice(cut + 1)
      }
    }
    if (words[i] !== 'push' && words[i] !== 'commit') continue
    return { ...g, sub: words[i], rest: words.slice(i + 1) }
  }
}

function repoInfo(command, g, cwd, config) {
  const cds = [...command.slice(0, g.pos).matchAll(/(?:^|&&|;|\|\|)\s*cd\s+("[^"]+"|'[^']+'|\S+)/g)]
  // like the shell and git do: a `cd` first, then every -C relative to the one before
  let dir = cwd
  for (const d of [cds.at(-1)?.[1].replace(/^["']|["']$/g, ''), ...g.dirs]) {
    if (d) dir = resolve(dir, d.startsWith('~') ? homedir() + d.slice(1) : d)
  }
  const pre = ['-C', dir]
  if (g.gitDir) pre.push(`--git-dir=${g.gitDir}`)
  if (g.workTree) pre.push(`--work-tree=${g.workTree}`)
  if (git(pre, ['rev-parse', '--show-toplevel']) === undefined) return undefined
  const remote = git(pre, ['remote', 'get-url', 'origin']) ?? ''
  return {
    pre, remote,
    isPublic: rx(config.publicRepoPatterns).some(r => r.test(remote)),
    alwaysAsk: rx(config.alwaysAskRepoPatterns).some(r => r.test(remote)),
  }
}

function checkCommit(command, g, cwd, config) {
  const repo = repoInfo(command, g, cwd, config)
  if (!repo) return
  const all = g.rest.some(w => w === '--all' || /^-[a-zA-Z]*a/.test(w))
  const diff = git(repo.pre, ['diff', all ? 'HEAD' : '--cached', '--no-color', '-U0']) ?? ''
  const findings = scanDiff(diff, config, repo.isPublic)
  if (repo.isPublic) {
    // `git -c user.email=... commit` overrides the configured identity
    const author = g.conf['user.email'] ?? git(repo.pre, ['var', 'GIT_AUTHOR_IDENT']) ?? ''
    if (!new RegExp(config.requiredEmailPattern, 'i').test(author)) findings.push(`author does not match ${config.requiredEmailPattern}`)
  }
  if (!findings.length) return
  const text = `waechter: ${findings.join('; ')}`
  return repo.isPublic
    ? { decision: 'deny', reason: `${text}. Public repo, commit blocked.` }
    : { decision: 'ask', reason: `${text}. Commit anyway?` }
}

function checkPush(command, g, cwd, config) {
  const repo = repoInfo(command, g, cwd, config)
  if (!repo) return
  const afterPush = g.rest
  const args = afterPush.filter(w => !w.startsWith('-'))
  const refs = args.slice(1).map(r => r.replace(/^\+/, '').split(':')[0] ?? '').filter(Boolean)
  const sources = refs.length ? refs : ['HEAD']

  if (repo.isPublic) {
    if (afterPush.some(w => w === '--all' || w === '--mirror'))
      return { decision: 'deny', reason: 'waechter: --all/--mirror on a public repo would upload every local branch.' }
    const blocked = sources.filter(s => config.blockedBranches.includes(s))
    if (blocked.length)
      return { decision: 'deny', reason: `waechter: branch ${blocked.join(', ')} is on the blocked list and must not be pushed.` }
    const idents = git(repo.pre, ['log', ...sources, '--not', '--remotes', '--format=%ae%n%ce']) ?? ''
    const bad = [...new Set(idents.split('\n').filter(a => a && !new RegExp(config.requiredEmailPattern, 'i').test(a)))]
    if (bad.length)
      return { decision: 'deny', reason: `waechter: new commits carry ${bad.join(', ')} instead of an address matching ${config.requiredEmailPattern}.` }
  }
  if (repo.alwaysAsk) return { decision: 'ask', reason: 'waechter: this remote is on the always-ask list. Really push?' }
}

export function check(input, config) {
  if (input.tool_name !== 'Bash') return
  const command = String(input.tool_input?.command ?? '')
  const g = findGit(command)
  if (!g) return
  const cwd = input.cwd || process.cwd()
  return g.sub === 'push' ? checkPush(command, g, cwd, config) : checkCommit(command, g, cwd, config)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let verdict
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'))
    verdict = check(input, loadConfig())
  } catch {
    verdict = { decision: 'ask', reason: 'waechter: check failed, please decide yourself.' }
  }
  if (verdict) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: verdict.decision, permissionDecisionReason: verdict.reason },
    }))
  }
}
