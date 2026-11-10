// shell.mjs: a small, pure tokenizer for POSIX-ish shell command lines.
// It is NOT a shell: nothing is executed and no variable is evaluated. It splits
// a command line into simple commands, looks through common wrappers and
// `bash -c`, and marks everything it cannot understand as "unclear".
import { resolve } from 'node:path'

export const MAX_SHELL_DEPTH = 8 // nesting limit for `bash -c '...'`
const HARD_DEPTH = 50 // protects the recursion itself

const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}', 'time', 'nohup', 'exec', 'builtin', 'setsid'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash'])
const SUDO_ARG_OPTS = new Set(['-u', '-g', '-h', '-p', '-C', '-r', '-t', '-U', '-D', '-R', '-T', '-a', '-c'])
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Lower-case program name without directory and `.exe`. */
export function programName(text) {
  return text.replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.exe$/, '')
}

/**
 * Parse a command line.
 * @returns {{commands: Array<{name:string, argv:object[], assigns:string[], scope:number[]}>, unclear: string[]}}
 *  `argv[0]` is the program word. Words are `{text, dyn, tailDyn, quoted}`:
 *  `dyn` = contains an expansion ($VAR, $(...), backticks), `tailDyn` = the part after the last `/` does.
 *  Commands are listed in execution order (nested ones before the command that contains them).
 */
export function parseShell(src, opts = {}) {
  const ctx = { commands: [], unclear: [], home: opts.home, nextScope: 1, maxDepth: opts.maxDepth ?? MAX_SHELL_DEPTH }
  parseList(String(src), 0, [], ctx, 0, null)
  return { commands: ctx.commands, unclear: [...new Set(ctx.unclear)] }
}

const newScope = (scope, ctx) => [...scope, ctx.nextScope++]

function parseList(src, start, scope, ctx, depth, stop) {
  if (depth > HARD_DEPTH) { ctx.unclear.push('nested too deeply'); return src.length }
  const n = src.length
  let i = start
  let words = []
  let w = null
  let redir = null // 'skip' | 'heredoc' | 'heredoc-'
  const heredocs = []

  const add = (s, o = {}) => {
    w ??= { text: '', dyn: false, tailDyn: false, quoted: false }
    w.text += s
    if (o.quoted) w.quoted = true
    if (o.dyn) { w.dyn = true; w.tailDyn = true } else if (s.includes('/')) w.tailDyn = false
  }
  const flush = () => {
    if (!w) return
    const word = w
    w = null
    if (redir === 'skip') { redir = null; return }
    if (redir) { heredocs.push({ delim: word.text, quoted: word.quoted, strip: redir === 'heredoc-' }); redir = null; return }
    words.push(word)
  }
  const endCmd = () => {
    flush()
    redir = null
    if (words.length) finalize(words, scope, ctx, depth)
    words = []
  }

  while (i < n) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\r') { flush(); i++; continue }
    if (c === '\\') {
      if (src[i + 1] === '\n') { i += 2; continue }
      if (i + 1 < n) { add(src[i + 1], { quoted: true }); i += 2 } else i++
      continue
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1)
      if (j < 0) { ctx.unclear.push('open single quote'); add(src.slice(i + 1), { quoted: true }); i = n } else { add(src.slice(i + 1, j), { quoted: true }); i = j + 1 }
      continue
    }
    if (c === '"') { i = readDouble(src, i, add, scope, ctx, depth); continue }
    if (c === '$' && src[i + 1] === "'") { i = readAnsiC(src, i, add, ctx); continue }
    if (c === '$' && src[i + 1] === '"') { i++; continue }
    if (c === '$' || c === '`') {
      const e = readExpansion(src, i, scope, ctx, depth)
      if (e) { add(src.slice(i, e), { dyn: true }); i = e } else { add('$'); i++ }
      continue
    }
    if (c === '#' && !w) { while (i < n && src[i] !== '\n') i++; continue }
    if (c === '\n') {
      endCmd(); i++
      if (heredocs.length) i = readHeredocs(src, i, heredocs.splice(0), scope, ctx, depth)
      continue
    }
    if (c === ';') { endCmd(); i += src[i + 1] === ';' || src[i + 1] === '&' ? 2 : 1; continue }
    if (c === '&') {
      if (src[i + 1] === '&') { endCmd(); i += 2; continue }
      if (src[i + 1] === '>') { flush(); redir = 'skip'; i += src[i + 2] === '>' ? 3 : 2; continue }
      endCmd(); i++; continue
    }
    if (c === '|') { endCmd(); i += src[i + 1] === '|' || src[i + 1] === '&' ? 2 : 1; continue }
    if (c === '<' || c === '>') {
      if (w && !w.quoted && /^\d+$/.test(w.text)) w = null; else flush()
      if (src[i + 1] === '(') { // process substitution <( ... ) / >( ... )
        i = parseList(src, i + 2, newScope(scope, ctx), ctx, depth + 1, ')')
        add('<(...)', { dyn: true })
        continue
      }
      if (c === '<' && src[i + 1] === '<' && src[i + 2] === '<') { redir = 'skip'; i += 3; continue }
      if (c === '<' && src[i + 1] === '<') { const strip = src[i + 2] === '-'; redir = strip ? 'heredoc-' : 'heredoc'; i += strip ? 3 : 2; continue }
      i++
      if (c === '>' && (src[i] === '>' || src[i] === '&' || src[i] === '|')) i++
      else if (c === '<' && (src[i] === '&' || src[i] === '>')) i++
      redir = 'skip'
      continue
    }
    if (c === '(') {
      endCmd()
      i = parseList(src, i + 1, newScope(scope, ctx), ctx, depth + 1, ')')
      continue
    }
    if (c === ')') {
      endCmd(); i++
      if (stop === ')') return i
      continue
    }
    if (c === '~' && !w && ctx.home && (i + 1 >= n || /[/\s;&|)<>]/.test(src[i + 1]))) { add(ctx.home); i++; continue }
    add(c); i++
  }
  endCmd()
  if (stop) ctx.unclear.push('unterminated $( ... ) or ( ... )')
  return n
}

/** Reads "..." starting at src[i]; returns the index after the closing quote. */
function readDouble(src, i, add, scope, ctx, depth) {
  const n = src.length
  let j = i + 1
  let buf = ''
  add('', { quoted: true })
  while (j < n) {
    const ch = src[j]
    if (ch === '"') { add(buf, { quoted: true }); return j + 1 }
    if (ch === '\\' && j + 1 < n) {
      const nx = src[j + 1]
      if ('$`"\\\n'.includes(nx)) { if (nx !== '\n') buf += nx; j += 2 } else { buf += '\\'; j++ }
      continue
    }
    if (ch === '$' || ch === '`') {
      const e = readExpansion(src, j, scope, ctx, depth)
      if (e) {
        add(buf, { quoted: true }); buf = ''
        add(src.slice(j, e), { quoted: true, dyn: true })
        j = e
        continue
      }
    }
    buf += ch; j++
  }
  ctx.unclear.push('open double quote')
  add(buf, { quoted: true })
  return n
}

/** $'...' with the usual backslash escapes. */
function readAnsiC(src, i, add, ctx) {
  const n = src.length
  let j = i + 2
  let buf = ''
  const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' }
  while (j < n) {
    const ch = src[j]
    if (ch === "'") { add(buf, { quoted: true }); return j + 1 }
    if (ch === '\\' && j + 1 < n) { buf += map[src[j + 1]] ?? '\\' + src[j + 1]; j += 2; continue }
    buf += ch; j++
  }
  ctx.unclear.push('open $\' quote')
  add(buf, { quoted: true })
  return n
}

/**
 * src[i] is `$` or a backtick. Parses a substitution (its commands are added to ctx)
 * and returns the index after it, or null if this is not an expansion.
 */
function readExpansion(src, i, scope, ctx, depth) {
  const n = src.length
  const c = src[i]
  if (c === '`') {
    let j = i + 1
    let inner = ''
    while (j < n && src[j] !== '`') {
      if (src[j] === '\\' && j + 1 < n && '`\\$'.includes(src[j + 1])) { inner += src[j + 1]; j += 2; continue }
      inner += src[j]; j++
    }
    if (j >= n) ctx.unclear.push('open backtick')
    parseList(inner, 0, newScope(scope, ctx), ctx, depth + 1, null)
    return Math.min(j + 1, n)
  }
  const nx = src[i + 1]
  if (nx === '(') {
    if (src[i + 2] === '(') { // maybe arithmetic $(( ... ))
      let d = 2
      let j = i + 3
      while (j < n && d > 0) { if (src[j] === '(') d++; else if (src[j] === ')') d--; j++ }
      if (d === 0 && src[j - 2] === ')') {
        scanExpansions(src.slice(i + 3, j - 2), scope, ctx, depth)
        return j
      }
    }
    return parseList(src, i + 2, newScope(scope, ctx), ctx, depth + 1, ')')
  }
  if (nx === '{') {
    let d = 1
    let j = i + 2
    while (j < n && d > 0) {
      if (src[j] === '\\') j++
      else if (src[j] === '{') d++
      else if (src[j] === '}') d--
      j++
    }
    if (d > 0) ctx.unclear.push('open ${')
    scanExpansions(src.slice(i + 2, Math.max(i + 2, j - 1)), scope, ctx, depth)
    return Math.min(j, n)
  }
  if (nx !== undefined && /[A-Za-z_]/.test(nx)) {
    let j = i + 2
    while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++
    return j
  }
  if (nx !== undefined && /[0-9@*#?!$-]/.test(nx)) return i + 2
  return null
}

/** Finds substitutions inside plain text (heredoc bodies, ${...}) and parses them. */
function scanExpansions(text, scope, ctx, depth) {
  for (let i = 0; i < text.length;) {
    const ch = text[i]
    if (ch === '\\') { i += 2; continue }
    if (ch === '$' || ch === '`') {
      const e = readExpansion(text, i, scope, ctx, depth)
      if (e) { i = e; continue }
    }
    i++
  }
}

function readHeredocs(src, i, list, scope, ctx, depth) {
  const n = src.length
  for (const hd of list) {
    let body = ''
    while (i < n) {
      let e = src.indexOf('\n', i)
      if (e < 0) e = n
      const line = src.slice(i, e)
      i = e + 1
      if ((hd.strip ? line.replace(/^\t+/, '') : line) === hd.delim) break
      body += line + '\n'
    }
    if (!hd.quoted) scanExpansions(body, scope, ctx, depth)
  }
  return Math.min(i, n)
}

function isAssign(word) { return ASSIGN.test(word.text) }

/** Looks through wrappers; records the real command in ctx.commands. */
function finalize(words, scope, ctx, depth) {
  const assigns = []
  let i = 0
  const lit = k => (words[k] && !words[k].dyn ? words[k].text : null)
  const unclear = msg => { ctx.unclear.push(msg) }
  for (;;) {
    while (i < words.length && isAssign(words[i])) assigns.push(words[i++].text)
    if (i >= words.length) return
    const name = lit(i) === null ? null : programName(lit(i))
    if (name === null) break
    if (KEYWORDS.has(name)) {
      i++
      if (name === 'time' && lit(i) === '-p') i++
      continue
    }
    if (name === 'command') {
      i++
      while (i < words.length && lit(i)?.startsWith('-')) {
        if (/^-[a-zA-Z]*[vV]/.test(lit(i))) return // `command -v git` only looks something up
        i++
      }
      continue
    }
    if (name === 'env') {
      i++
      for (; i < words.length; ) {
        const t = lit(i)
        if (t === '--') { i++; break }
        if (t !== null && t.startsWith('-')) {
          if (t === '-u' || t === '--unset') i += 2
          else if (/^(-C|--chdir|-S|--split-string)/.test(t) || /^-[a-zA-Z]*[CS]/.test(t)) { unclear('env -C/-S changes the directory or the command in a way waechter cannot follow'); return }
          else i++
        } else if (isAssign(words[i])) assigns.push(words[i++].text)
        else break
      }
      continue
    }
    if (name === 'sudo' || name === 'doas') {
      i++
      while (i < words.length && lit(i)?.startsWith('-')) {
        const t = lit(i)
        if (t === '--') { i++; break }
        i += SUDO_ARG_OPTS.has(t) ? 2 : 1
      }
      continue
    }
    if (name === 'nice' || name === 'ionice') {
      i++
      while (i < words.length && lit(i)?.startsWith('-')) i += /^-(n|c|p)$/.test(lit(i)) ? 2 : 1
      continue
    }
    if (name === 'timeout') {
      i++
      while (i < words.length && lit(i)?.startsWith('-')) i += /^-(s|k)$/.test(lit(i)) ? 2 : 1
      i++ // duration
      continue
    }
    if (name === 'stdbuf') {
      i++
      while (i < words.length && lit(i)?.startsWith('-')) i += /^-[ioe]$/.test(lit(i)) ? 2 : 1
      continue
    }
    if (name === 'xargs') {
      i++
      while (i < words.length && lit(i)?.startsWith('-')) i += /^-(I|n|P|L|d|E|s)$/.test(lit(i)) ? 2 : 1
      continue
    }
    break
  }
  const prog = words[i]
  if (prog.tailDyn) { unclear(`command name "${prog.text}" is a variable or substitution`); return }
  const name = programName(prog.text)
  if (name === 'eval') { unclear('eval runs text that waechter cannot read'); return }
  if (SHELLS.has(name)) {
    const args = words.slice(i + 1)
    let script = null
    let found = false
    let hasFile = false
    for (let j = 0; j < args.length; j++) {
      const t = args[j].text
      if (t === '--') { hasFile = j + 1 < args.length; break }
      if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(t)) { found = true; script = args[j + 1] ?? null; break }
      if (t === '-o' || t === '+o' || t === '-O' || t === '+O') { j++; continue }
      if (t.startsWith('-') || t.startsWith('+')) continue
      hasFile = true
      break
    }
    if (found) {
      if (!script) unclear(`${name} -c without a command`)
      else if (depth + 1 > ctx.maxDepth) unclear('shells nested too deeply')
      else parseList(script.text, 0, newScope(scope, ctx), ctx, depth + 1, null)
    } else if (!hasFile) unclear(`${name} reads commands from stdin`)
    else ctx.commands.push({ name, argv: words.slice(i), assigns, scope })
    return
  }
  ctx.commands.push({ name, argv: words.slice(i), assigns, scope })
}

/**
 * Adds `dir` to every command: the directory it runs in, following `cd`/`pushd`
 * (scoped: a `cd` inside ( ) or $( ) does not leak out). `null` = unknown.
 */
export function trackDirs(commands, cwd, opts = {}) {
  const entries = []
  const inScope = (outer, inner) => outer.length <= inner.length && outer.every((v, k) => inner[k] === v)
  for (const cmd of commands) {
    const last = entries.findLast(e => inScope(e.scope, cmd.scope))
    cmd.dir = last ? last.dir : cwd
    if (cmd.name === 'cd' || cmd.name === 'pushd' || cmd.name === 'popd') {
      let target = null
      if (cmd.name !== 'popd' && cmd.dir !== null) {
        const args = cmd.argv.slice(1)
        let k = 0
        while (k < args.length && args[k].text.startsWith('-') && args[k].text !== '-') { if (args[k].text === '--') { k++; break } k++ }
        const a = args[k]
        if (!a) target = opts.home ? resolve(opts.home) : null
        else if (a.dyn || a.text === '-') target = null
        else target = resolve(cmd.dir, a.text)
      }
      entries.push({ scope: cmd.scope, dir: target })
    }
  }
  return commands
}
