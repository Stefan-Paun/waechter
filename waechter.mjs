#!/usr/bin/env node
// waechter: Claude Code PreToolUse hook that checks `git commit` and `git push`
// for secrets, private identifiers and risky branches. No dependencies.
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseShell, trackDirs } from './shell.mjs'
import { parseGit, parseCommitArgs, parsePushArgs, refNames, gitContext } from './gitargs.mjs'
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
  blockedBranches: [], // branch names that may never be pushed from a public repo (checked for source and destination)
  blockForcePush: false, // deny --force, -f, --force-with-lease, --force-if-includes and +ref in public repos
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

// Environment variables from `VAR=x git ...` that change what git would do.
const GIT_ENV = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL'])

/** Runs git the way the checked command would (same -C, --git-dir, --work-tree, -c, env). */
function git(ctx, args) {
  const pre = ['-C', ctx.dir]
  if (ctx.gitDir) pre.push('--git-dir', ctx.gitDir)
  if (ctx.workTree) pre.push('--work-tree', ctx.workTree)
  for (const c of ctx.configs ?? []) pre.push('-c', c)
  try {
    return execFileSync('git', [...pre, ...args], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...ctx.env } }).trim()
  } catch { return undefined }
}

function gitEnv(assigns) {
  const env = {}
  for (const a of assigns) {
    const i = a.indexOf('=')
    if (GIT_ENV.has(a.slice(0, i))) env[a.slice(0, i)] = a.slice(i + 1)
  }
  return env
}

function urlOf(ctx, remote) {
  if (remote === null || remote === undefined) return undefined
  if (/[:/\\]/.test(remote)) return remote // a URL or path instead of a remote name
  return git(ctx, ['remote', 'get-url', '--push', remote])
}

/** `target` = remote named on the command line; public/always-ask count if origin OR the target matches. */
function repoInfo(ctx, config, target) {
  if (git(ctx, ['rev-parse', '--git-dir']) === undefined) return undefined
  const origin = git(ctx, ['remote', 'get-url', 'origin']) ?? ''
  const urls = [origin]
  if (target && target !== 'origin') urls.push(urlOf(ctx, target) ?? '')
  return {
    ctx, remote: origin,
    isPublic: urls.some(u => rx(config.publicRepoPatterns).some(r => r.test(u))),
    alwaysAsk: urls.some(u => rx(config.alwaysAskRepoPatterns).some(r => r.test(u))),
  }
}

const emailOk = (text, config) => new RegExp(config.requiredEmailPattern, 'i').test(text)

function checkCommit(args, repo, config) {
  const opts = parseCommitArgs(args)
  const ctx = repo.ctx
  let diff = git(ctx, ['diff', '--cached', '--no-color', '-U0']) ?? ''
  if (opts.all || opts.paths.length) {
    // -a: everything tracked; with paths: those files as they are in the working tree
    const limit = opts.all || !opts.paths.length ? [] : ['--', ...opts.paths]
    const head = git(ctx, ['diff', 'HEAD', '--no-color', '-U0', ...limit])
    diff += '\n' + (head ?? git(ctx, ['diff', '--no-color', '-U0', ...limit]) ?? '') // no HEAD yet: plain diff
  }
  const findings = scanDiff(diff, config, repo.isPublic)
  if (repo.isPublic) {
    for (const [what, name] of [['author', 'GIT_AUTHOR_IDENT'], ['committer', 'GIT_COMMITTER_IDENT']]) {
      const ident = git(ctx, ['var', name]) ?? ''
      if (!emailOk(ident, config)) findings.push(`${what} does not match ${config.requiredEmailPattern}`)
    }
    if (opts.author?.includes('<') && !emailOk(opts.author, config)) findings.push(`--author does not match ${config.requiredEmailPattern}`)
  }
  if (!findings.length) return
  const text = `waechter: ${findings.join('; ')}`
  return repo.isPublic
    ? { decision: 'deny', reason: `${text}. Public repo, commit blocked.` }
    : { decision: 'ask', reason: `${text}. Commit anyway?` }
}

function checkPush(args, ctxIn, config) {
  const push = parsePushArgs(args)
  const repo = repoInfo(ctxIn, config, push.remote)
  if (!repo) return
  const ctx = repo.ctx

  if (repo.isPublic) {
    if (push.all || push.mirror)
      return { decision: 'deny', reason: 'waechter: --all/--mirror on a public repo would upload every local branch.' }
    const wild = push.refspecs.filter(s => s.glob)
    if (wild.length)
      return { decision: 'deny', reason: `waechter: refspec ${wild.map(s => s.raw).join(', ')} contains a wildcard and may upload several branches.` }

    const current = git(ctx, ['symbolic-ref', '--short', '-q', 'HEAD'])
    const names = (push.refspecs.length ? push.refspecs.flatMap(refNames) : push.tags ? [] : ['HEAD'])
      .map(n => (n === 'HEAD' && current ? current : n))
    const blocked = [...new Set(names.filter(n => config.blockedBranches.includes(n)))]
    if (blocked.length)
      return { decision: 'deny', reason: `waechter: branch ${blocked.join(', ')} is on the blocked list and must not be pushed.` }

    if (config.blockForcePush && push.forceKinds.length)
      return { decision: 'deny', reason: `waechter: force push (${[...new Set(push.forceKinds)].join(', ')}) to a public repo is blocked (blockForcePush).` }

    const sources = push.refspecs.length
      ? push.refspecs.filter(s => !s.delete).map(s => s.src.replace(/^\+/, ''))
      : push.tags ? [] : ['HEAD']
    if (sources.length || push.tags) {
      const idents = git(ctx, ['log', ...sources, ...(push.tags ? ['--tags'] : []), '--not', '--remotes', '--format=%ae%n%ce'])
      if (idents === undefined)
        return { decision: 'ask', reason: 'waechter: could not read the commits to push, so their author addresses are unchecked. Really push?' }
      const bad = [...new Set(idents.split('\n').filter(a => a && !emailOk(a, config)))]
      if (bad.length)
        return { decision: 'deny', reason: `waechter: new commits carry ${bad.join(', ')} instead of an address matching ${config.requiredEmailPattern}.` }
    }
  }
  if (repo.alwaysAsk) return { decision: 'ask', reason: 'waechter: this remote is on the always-ask list. Really push?' }
}

const SEVERITY = { deny: 2, ask: 1 }

export function check(input, config) {
  if (input.tool_name !== 'Bash') return
  const command = String(input.tool_input?.command ?? '')
  const cwd = input.cwd || process.cwd()
  const parsed = parseShell(command, { home: homedir() })
  trackDirs(parsed.commands, cwd, { home: homedir() })
  const unclear = [...parsed.unclear]
  const verdicts = []

  for (const cmd of parsed.commands) {
    if (cmd.name !== 'git') continue
    const g = parseGit(cmd.argv)
    unclear.push(...g.unclear)
    if (g.sub !== 'push' && g.sub !== 'commit') continue
    if (cmd.dir === null) { unclear.push('the directory is unknown after a cd with a variable or "cd -"'); continue }
    const ctx = { ...gitContext(cmd.dir, g, cmd.assigns), configs: g.configs, env: gitEnv(cmd.assigns) }
    let v
    if (g.sub === 'push') {
      const pa = parsePushArgs(g.args)
      unclear.push(...pa.unclear)
      v = checkPush(g.args, ctx, config)
    } else {
      const repo = repoInfo(ctx, config)
      const ca = parseCommitArgs(g.args)
      unclear.push(...ca.unclear)
      v = repo && checkCommit(g.args, repo, config)
    }
    if (v) verdicts.push(v)
  }

  const worst = verdicts.sort((a, b) => SEVERITY[b.decision] - SEVERITY[a.decision])[0]
  if (worst?.decision === 'deny') return worst
  const uniq = [...new Set(unclear)]
  const hard = uniq.some(u => /eval|variable|stdin/.test(u)) // could hide a git call even without the word "git"
  if (uniq.length && (hard || /git/i.test(command))) {
    const repo = repoInfo({ dir: cwd }, config)
    const text = `waechter: cannot read this command safely (${uniq.join('; ')})`
    if (repo?.isPublic) return { decision: 'deny', reason: `${text}. Public repo, blocked. Split it into plain git commands.` }
    return worst ?? { decision: 'ask', reason: `${text}. Run it anyway?` }
  }
  return worst
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
