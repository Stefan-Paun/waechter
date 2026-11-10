#!/usr/bin/env node
// waechter: Claude Code PreToolUse hook that checks `git commit` and `git push`
// for secrets, private identifiers and risky branches. No dependencies.
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, resolve, relative } from 'node:path'
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
  writeCheck: 'aus', // Write/Edit check in public repos: 'aus' | 'warnen' (ask) | 'blocken' (deny)
  writeCheckIgnorePaths: [], // regexes on the repo-relative path (test fixtures etc.) that are never checked
  writeCheckMaxBytes: 1000000, // larger new content is skipped
}

export function loadConfig(path) {
  const candidates = [path, process.env.WAECHTER_CONFIG, join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'waechter', 'config.json')]
  for (const p of candidates) {
    if (p && existsSync(p)) return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(p, 'utf8')) }
  }
  return { ...DEFAULT_CONFIG }
}

const rx = list => list.map(s => new RegExp(s, 'i'))

export function buildPatterns(config, isPublic) {
  return [
    ...SECRET_PATTERNS,
    ...rx(config.privateEmailPatterns).map(r => ['Private email address', r]),
    ...rx(config.phonePatterns).map(r => ['Phone number', r]),
    ...(isPublic ? rx(config.privatePathPatterns).map(r => ['Private path', r]) : []),
  ]
}

export function scanDiff(diff, config, isPublic) {
  const patterns = buildPatterns(config, isPublic)
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

export const ALLOW_MARKS = ['waechter:erlaubt', 'waechter:allow']

// Obvious placeholders: xxx, example, changeme, <...>, or a long run of one character.
export function isPlaceholder(value) {
  return /x{3,}|example|changeme|placeholder|dummy|<[^>]*>|(.)\1{9,}/i.test(value)
}

// Scans new text. Returns [{ kind, line, masked }]; the value itself is never returned.
export function scanText(text, patterns) {
  const findings = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (ALLOW_MARKS.some(m => line.includes(m))) continue
    for (const [kind, re] of patterns) {
      const m = re.exec(line)
      if (!m || isPlaceholder(m[0])) continue
      findings.push({ kind, line: i + 1, masked: `${m[0].slice(0, 4)}… (${m[0].length} Zeichen)` })
    }
  }
  return findings
}

function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { return undefined }
}

function repoAt(dir, config) {
  const top = git(dir, ['rev-parse', '--show-toplevel'])
  if (top === undefined) return undefined
  const remote = git(top, ['remote', 'get-url', 'origin']) ?? ''
  return {
    top, remote,
    isPublic: rx(config.publicRepoPatterns).some(r => r.test(remote)),
    alwaysAsk: rx(config.alwaysAskRepoPatterns).some(r => r.test(remote)),
  }
}

function repoInfo(command, gitPos, cwd, config) {
  const before = command.slice(0, gitPos)
  const dashC = /\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/.exec(command.slice(gitPos))
  const cds = [...before.matchAll(/(?:^|&&|;|\|\|)\s*cd\s+("[^"]+"|'[^']+'|\S+)/g)]
  let dir = (dashC?.[1] ?? cds.at(-1)?.[1] ?? '.').replace(/^["']|["']$/g, '')
  if (dir.startsWith('~')) dir = homedir() + dir.slice(1)
  if (!dir.startsWith('/')) dir = join(cwd, dir)
  return repoAt(dir, config)
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

// New content of a write/edit tool call: Write.content, Edit.new_string,
// MultiEdit.edits[].new_string, NotebookEdit.new_source. Each piece is checked on its own.
function newContents(input) {
  const t = input.tool_input ?? {}
  const pick = v => (typeof v === 'string' ? [v] : [])
  switch (input.tool_name) {
    case 'Write': return pick(t.content)
    case 'Edit': return pick(t.new_string)
    case 'MultiEdit': return Array.isArray(t.edits) ? t.edits.flatMap(e => pick(e?.new_string)) : []
    case 'NotebookEdit': return pick(t.new_source)
    default: return undefined
  }
}

function isIgnored(top, abs) {
  const r = spawnSync('git', ['-C', top, 'check-ignore', '-q', '--', abs], { timeout: 10000, stdio: 'ignore' })
  return r.status === 0
}

const WRITE_HINT = 'Stattdessen: Wert aus einer Umgebungsvariable oder dem Schlüsselbund lesen, oder in eine von git ignorierte Datei (z. B. .env in .gitignore) schreiben. Bewusst erlaubte Zeilen mit "waechter:erlaubt" markieren.'

function checkWrite(input, config) {
  const mode = config.writeCheck
  if (mode === 'aus' || mode === undefined) return
  const pieces = newContents(input)
  if (!pieces?.length) return
  const t = input.tool_input ?? {}
  const file = t.file_path ?? t.notebook_path
  if (typeof file !== 'string' || !file) return
  const abs = resolve(input.cwd || process.cwd(), file)
  // nearest existing directory: the file (and its folders) may not exist yet
  let dir = dirname(abs)
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir)
  const repo = repoAt(dir, config)
  if (!repo?.isPublic) return
  // git reports the real path (macOS: /var -> /private/var), so resolve symlinks before comparing
  const realAbs = join(realpathSync(dir), relative(dir, abs))
  const rel = relative(repo.top, realAbs)
  if (rel.startsWith('..')) return
  if (rx(config.writeCheckIgnorePaths ?? []).some(r => r.test(rel))) return
  const max = Number.isFinite(config.writeCheckMaxBytes) ? config.writeCheckMaxBytes : 1000000
  const patterns = buildPatterns(config, true)
  const findings = []
  for (const text of pieces) {
    if (text.length > max || text.includes('\0')) continue
    findings.push(...scanText(text, patterns))
  }
  if (!findings.length) return
  if (isIgnored(repo.top, realAbs)) return // ignored by git: never lands in the repo (errors count as not ignored)
  const list = findings.map(f => `${f.kind}, Zeile ${f.line} (${f.masked})`).join('; ')
  const reason = `waechter: ${rel} liegt in einem öffentlichen Repo und würde enthalten: ${list}. ${WRITE_HINT}`
  return { decision: mode === 'blocken' ? 'deny' : 'ask', reason }
}

export function check(input, config) {
  if (input.tool_name !== 'Bash') return checkWrite(input, config)
  const command = String(input.tool_input?.command ?? '')
  const m = /\bgit\s+(?:-C\s+\S+\s+)?(push|commit)\b/.exec(command)
  if (!m) return
  const cwd = input.cwd || process.cwd()
  return m[1] === 'push' ? checkPush(command, m.index, cwd, config) : checkCommit(command, m.index, cwd, config)
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
