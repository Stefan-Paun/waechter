// gitargs.mjs: pure helpers that understand git command lines (as produced by shell.mjs).
// No I/O, no git calls: they only interpret words.
import { isAbsolute, join, normalize } from 'node:path'

const GLOBAL_WITH_ARG = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source'])
const GLOBAL_FLAGS = new Set([
  '-p', '--paginate', '-P', '--no-pager', '--no-replace-objects', '--bare', '--literal-pathspecs', '--glob-pathspecs',
  '--noglob-pathspecs', '--icase-pathspecs', '--no-optional-locks', '--no-advice', '--exec-path', '--html-path', '--man-path', '--info-path',
])
const INFO_FLAGS = new Set(['--version', '-v', '--help', '-h'])

/**
 * Splits `git [global options] <subcommand> <args...>`.
 * @param {{text:string,dyn:boolean}[]} argv words, argv[0] is the git program
 * @returns {{dirs:string[], gitDir?:string, workTree?:string, configs:string[], sub:string|null, args:object[], unclear:string[]}}
 */
export function parseGit(argv) {
  const r = { dirs: [], configs: [], sub: null, args: [], unclear: [] }
  let i = 1
  const dynCheck = w => { if (w.dyn) r.unclear.push(`git option value "${w.text}" contains a variable`) }
  while (i < argv.length) {
    const w = argv[i]
    const t = w.text
    if (!t.startsWith('-') || t === '-') break
    const eq = t.startsWith('--') ? t.indexOf('=') : -1
    const name = eq > 0 ? t.slice(0, eq) : t
    const inline = eq > 0 ? t.slice(eq + 1) : undefined
    if (INFO_FLAGS.has(t)) { r.info = true; i++; continue }
    if (GLOBAL_FLAGS.has(name)) { i++; continue }
    if (GLOBAL_WITH_ARG.has(name)) {
      let val = inline
      if (val === undefined) { const next = argv[i + 1]; if (!next) { r.unclear.push(`git ${name} without value`); break } dynCheck(next); val = next.text; i++ }
      else dynCheck(w)
      i++
      if (name === '-C') r.dirs.push(val)
      else if (name === '--git-dir') r.gitDir = val
      else if (name === '--work-tree') r.workTree = val
      else if (name === '-c') { r.configs.push(val); if (/^alias\./i.test(val)) r.unclear.push('git -c alias.* defines a command that waechter cannot follow') }
      else if (name === '--config-env' && /^alias\./i.test(val)) r.unclear.push('git --config-env alias.* defines a command that waechter cannot follow')
      continue
    }
    if (name === '--exec-path') { i++; continue } // --exec-path=<path>
    if (/^-c.+/.test(t) && !t.startsWith('--')) { r.configs.push(t.slice(2)); i++; continue }
    r.unclear.push(`unknown global git option ${t}`)
    i++
  }
  if (i < argv.length) {
    const s = argv[i]
    if (s.dyn) r.unclear.push(`git subcommand "${s.text}" is a variable`)
    r.sub = s.text
    r.args = argv.slice(i + 1)
  }
  return r
}

/** Converts Git-Bash style /c/dir to C:\dir on Windows; leaves everything else alone. */
export function nativePath(p, platform = process.platform) {
  const m = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(p)
  if (platform === 'win32' && m) return `${m[1].toUpperCase()}:\\${(m[2] ?? '').replace(/\//g, '\\')}`
  return p
}

/** Joins like the shell would: absolute paths win, relative ones hang off `base`. */
export function resolveFrom(base, p, platform = process.platform) {
  const q = nativePath(p, platform)
  return normalize(isAbsolute(q) ? q : join(base, q))
}

/**
 * The directory (and git-dir/work-tree) git would use.
 * `cwd` is the shell's directory at that point (after cd), `assigns` the `VAR=x` prefixes.
 */
export function gitContext(cwd, parsed, assigns = [], platform = process.platform) {
  let dir = cwd
  for (const d of parsed.dirs) dir = resolveFrom(dir, d, platform)
  const env = name => assigns.findLast(a => a.startsWith(name + '='))?.slice(name.length + 1)
  const gd = parsed.gitDir ?? env('GIT_DIR')
  const wt = parsed.workTree ?? env('GIT_WORK_TREE')
  return {
    dir,
    gitDir: gd === undefined ? undefined : resolveFrom(dir, gd, platform),
    workTree: wt === undefined ? undefined : resolveFrom(dir, wt, platform),
  }
}

const COMMIT_SHORT_WITH_ARG = new Set(['m', 'F', 'C', 'c', 't'])
const COMMIT_LONG_WITH_ARG = new Set(['--message', '--file', '--reuse-message', '--reedit-message', '--fixup', '--squash', '--template', '--author', '--date', '--cleanup', '--pathspec-from-file', '--trailer', '--gpg-sign'])

/** @returns {{all:boolean, paths:string[], author?:string, unclear:string[]}} `all` = -a/--all, `paths` = pathspecs (commit only these) */
export function parseCommitArgs(args) {
  const r = { all: false, paths: [], unclear: [] }
  let afterDD = false
  const dyn = w => r.unclear.push(`commit argument "${w.text}" contains a variable`)
  for (let i = 0; i < args.length; i++) {
    const w = args[i]
    const t = w.text
    if (afterDD || !t.startsWith('-') || t === '-') { if (w.dyn) dyn(w); r.paths.push(t); continue }
    if (t === '--') { afterDD = true; continue }
    if (t.startsWith('--')) {
      const eq = t.indexOf('=')
      const name = eq > 0 ? t.slice(0, eq) : t
      if (name === '--all') r.all = true
      if (name === '--author') { const v = eq > 0 ? t.slice(eq + 1) : args[++i]?.text; if (v !== undefined) r.author = v; continue }
      if (COMMIT_LONG_WITH_ARG.has(name)) { if (eq < 0 && name !== '--gpg-sign') i++; continue }
      if (w.dyn) dyn(w)
      continue
    }
    let takesValue = false
    for (let k = 1; k < t.length; k++) {
      const ch = t[k]
      if (ch === 'a') r.all = true
      if (COMMIT_SHORT_WITH_ARG.has(ch)) { takesValue = true; if (k === t.length - 1) i++; break }
    }
    if (w.dyn && !takesValue) dyn(w)
  }
  return r
}

const PUSH_LONG_WITH_ARG = new Set(['--receive-pack', '--exec', '--push-option'])

export const stripHeads = n => n.replace(/^refs\/heads\//, '').replace(/^heads\//, '')

/** `[+]src[:dst]` -> parts. Delete is `:dst`. */
export function parseRefspec(raw) {
  const force = raw.startsWith('+')
  const s = force ? raw.slice(1) : raw
  const idx = s.indexOf(':')
  const src = idx < 0 ? s : s.slice(0, idx)
  const dst = idx < 0 ? s : s.slice(idx + 1) || src
  return { raw, force, src, dst, delete: idx >= 0 && src === '', glob: /[*?[]/.test(s) }
}

/**
 * @returns {{remote:string|null, refspecs:object[], forceKinds:string[], all:boolean, mirror:boolean, tags:boolean, delete:boolean, prune:boolean, unclear:string[]}}
 */
export function parsePushArgs(args) {
  const r = { remote: null, refspecs: [], forceKinds: [], all: false, mirror: false, tags: false, delete: false, prune: false, unclear: [] }
  const positional = []
  let repo = null
  let afterDD = false
  const dynSeen = new Set()
  for (let i = 0; i < args.length; i++) {
    const w = args[i]
    const t = w.text
    if (w.dyn && !dynSeen.has(t)) { dynSeen.add(t); r.unclear.push(`push argument "${t}" contains a variable`) }
    if (afterDD || !t.startsWith('-') || t === '-') { positional.push(t); continue }
    if (t === '--') { afterDD = true; continue }
    if (t.startsWith('--')) {
      const eq = t.indexOf('=')
      const name = eq > 0 ? t.slice(0, eq) : t
      const val = eq > 0 ? t.slice(eq + 1) : undefined
      if (name === '--force') r.forceKinds.push('--force')
      else if (name === '--force-with-lease' || name === '--force-if-includes') r.forceKinds.push(name)
      else if (name === '--all' || name === '--branches') r.all = true
      else if (name === '--mirror') r.mirror = true
      else if (name === '--tags') r.tags = true
      else if (name === '--delete') r.delete = true
      else if (name === '--prune') r.prune = true
      else if (name === '--repo') { if (val !== undefined) repo = val; else if (args[i + 1]) repo = args[++i].text }
      else if (PUSH_LONG_WITH_ARG.has(name) && val === undefined) i++
      continue
    }
    for (let k = 1; k < t.length; k++) {
      const ch = t[k]
      if (ch === 'f') r.forceKinds.push('-f')
      else if (ch === 'd') r.delete = true
      else if (ch === 'o') { if (k === t.length - 1) i++; break }
    }
  }
  if (repo !== null) r.remote = repo
  else if (positional.length) r.remote = positional.shift()
  for (let k = 0; k < positional.length; k++) {
    let raw = positional[k]
    if (raw === 'tag' && k + 1 < positional.length) raw = 'refs/tags/' + positional[++k]
    const spec = parseRefspec(raw)
    if (r.delete && !spec.delete) { spec.delete = true; spec.src = '' }
    if (spec.force) r.forceKinds.push('+' + spec.src)
    r.refspecs.push(spec)
  }
  return r
}

/**
 * Branch-like names a refspec reads from or writes to (source base and destination),
 * `refs/heads/` removed. `HEAD` and `@` stay as `HEAD` so the caller can map them to the current branch.
 */
export function refNames(spec) {
  const out = []
  let src = spec.src.replace(/(?:[~^]|@\{).*$/, '')
  if (src === '@') src = 'HEAD'
  if (src) out.push(stripHeads(src))
  if (spec.dst) out.push(stripHeads(spec.dst === '@' ? 'HEAD' : spec.dst))
  return out
}
