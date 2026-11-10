import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, scanText, buildPatterns, isPlaceholder, DEFAULT_CONFIG } from '../waechter.mjs'

// invented values, only the format matches
const KEY = 'AKIA' + 'Q7XK2MPD4ZRT9WNB'
const GH = 'ghp_' + 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5'
const cfg = (over = {}) => ({ ...DEFAULT_CONFIG, publicRepoPatterns: ['example/public'], writeCheck: 'blocken', ...over })

function repo(remote) {
  const dir = mkdtempSync(join(tmpdir(), 'waechter-w-'))
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' })
  g('init', '-q')
  if (remote) g('remote', 'add', 'origin', remote)
  writeFileSync(join(dir, '.gitignore'), '.env\n')
  return dir
}
const pub = () => repo('git@github.com:example/public.git')
const write = (cwd, file, content) => ({ tool_name: 'Write', cwd, tool_input: { file_path: file, content } })

test('public repo: secret in Write is denied, with kind, line and masked value', () => {
  const d = pub()
  const v = check(write(d, 'a.js', `x\nconst k = "${KEY}"\n`), cfg())
  assert.equal(v.decision, 'deny')
  assert.match(v.reason, /AWS access key, Zeile 2/)
  assert.match(v.reason, /AKIA… \(20 Zeichen\)/)
  assert.ok(!v.reason.includes(KEY))
  assert.match(v.reason, /Umgebungsvariable/)
})
test('private repo, no repo, unknown file outside: nothing happens', () => {
  assert.equal(check(write(repo('git@github.com:example/private.git'), 'a.js', KEY), cfg()), undefined)
  assert.equal(check(write(repo(null), 'a.js', KEY), cfg()), undefined)
  const plain = mkdtempSync(join(tmpdir(), 'waechter-n-'))
  assert.equal(check(write(plain, 'sub/dir/a.js', KEY), cfg()), undefined)
})
test('file in not-yet-existing folder of a public repo is still checked', () => {
  assert.equal(check(write(pub(), 'neu/tief/a.js', KEY), cfg())?.decision, 'deny')
})
test('git-ignored file is allowed, tracked-style file is not', () => {
  const d = pub()
  assert.equal(check(write(d, '.env', 'K=' + KEY), cfg()), undefined)
  assert.equal(check(write(d, join(d, '.env'), 'K=' + KEY), cfg()), undefined)
  assert.equal(check(write(d, '.env.example', 'K=' + KEY), cfg())?.decision, 'deny')
})
test('placeholders are ignored', () => {
  const d = pub()
  for (const c of ['AKIA' + 'X'.repeat(16), 'AKIA' + 'IOSFODNN7EXAMPLE', 'sk-ant-' + 'changeme'.repeat(4), 'ghp_' + '0'.repeat(36)])
    assert.equal(check(write(d, 'a.md', c), cfg()), undefined, c)
  assert.ok(isPlaceholder('<DEIN_KEY>'))
  assert.ok(!isPlaceholder(KEY))
})
test('allow mark on the line', () => {
  const d = pub()
  assert.equal(check(write(d, 'a.js', `k="${KEY}" // waechter:erlaubt`), cfg()), undefined)
  assert.equal(check(write(d, 'a.js', `# waechter:erlaubt\nk="${KEY}"`), cfg())?.decision, 'deny')
})
test('fixture path patterns', () => {
  const d = pub()
  assert.equal(check(write(d, 'test/fixtures/k.txt', KEY), cfg({ writeCheckIgnorePaths: ['^test/fixtures/'] })), undefined)
  assert.equal(check(write(d, 'src/k.txt', KEY), cfg({ writeCheckIgnorePaths: ['^test/fixtures/'] }))?.decision, 'deny')
})
test('binary and oversized content is skipped', () => {
  const d = pub()
  assert.equal(check(write(d, 'a.bin', '\0' + KEY), cfg()), undefined)
  assert.equal(check(write(d, 'a.txt', KEY + ' '.repeat(100)), cfg({ writeCheckMaxBytes: 50 })), undefined)
})
test('Edit checks only the inserted text, MultiEdit each edit', () => {
  const d = pub()
  const edit = { tool_name: 'Edit', cwd: d, tool_input: { file_path: 'a.js', old_string: KEY, new_string: 'process.env.KEY' } }
  assert.equal(check(edit, cfg()), undefined)
  edit.tool_input.new_string = 'k=' + GH
  assert.match(check(edit, cfg()).reason, /GitHub token, Zeile 1/)
  const multi = { tool_name: 'MultiEdit', cwd: d, tool_input: { file_path: 'a.js', edits: [{ old_string: 'a', new_string: 'ok' }, { old_string: 'b', new_string: '\n' + KEY }] } }
  assert.match(check(multi, cfg()).reason, /Zeile 2/)
  assert.equal(check({ tool_name: 'NotebookEdit', cwd: d, tool_input: { notebook_path: 'n.ipynb', new_source: KEY } }, cfg())?.decision, 'deny')
})
test('tolerant against missing fields', () => {
  const d = pub()
  for (const ti of [undefined, {}, { file_path: 'a' }, { content: KEY }, { file_path: 5, content: KEY }, { file_path: 'a', edits: 'x' }])
    for (const tool_name of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
      assert.equal(check({ tool_name, cwd: d, tool_input: ti }, cfg()), undefined)
  assert.equal(check({ tool_name: 'Read', cwd: d, tool_input: { file_path: 'a', content: KEY } }, cfg()), undefined)
})
test('three levels of writeCheck; default is off', () => {
  const d = pub()
  const c = write(d, 'a.js', KEY)
  assert.equal(check(c, cfg({ writeCheck: 'aus' })), undefined)
  assert.equal(check(c, cfg({ writeCheck: 'warnen' }))?.decision, 'ask')
  assert.equal(check(c, cfg({ writeCheck: 'blocken' }))?.decision, 'deny')
  assert.equal(DEFAULT_CONFIG.writeCheck, 'aus')
  assert.equal(check(c, { ...DEFAULT_CONFIG, publicRepoPatterns: ['example/public'] }), undefined)
})
test('same patterns as commit: configured email and private path', () => {
  const d = pub()
  const c = cfg({ privateEmailPatterns: ['me@mailbox\\.test'], privatePathPatterns: ['/home/someone'] })
  assert.match(check(write(d, 'a.md', 'mail me@mailbox.test'), c).reason, /Private email address/)
  assert.match(check(write(d, 'a.md', 'cd /home/someone/x'), c).reason, /Private path/)
  assert.equal(buildPatterns(c, false).some(([k]) => k === 'Private path'), false)
})
test('scanText never returns the value', () => {
  const f = scanText(`a\n${GH}`, buildPatterns(cfg(), true))
  assert.equal(f.length, 1)
  assert.ok(!JSON.stringify(f).includes(GH))
})
test('runtime stays small', () => {
  const d = pub()
  mkdirSync(join(d, 'x'))
  const big = ('const a = 1; // text\n').repeat(20000)
  const t = Date.now()
  for (let i = 0; i < 5; i++) check(write(d, 'x/a.js', big), cfg())
  assert.ok(Date.now() - t < 5000)
})

test('scanText: placeholder before a real key in the same line does not hide the key', () => {
  const patterns = buildPatterns(cfg(), true)
  const found = scanText(`a = "AKIA${'X'.repeat(16)}", b = "${KEY}"`, patterns)
  assert.equal(found.length, 1)
  assert.equal(found[0].kind, 'AWS access key')
  assert.equal(found[0].line, 1)
  // two real keys in one line: both reported
  assert.equal(scanText(`${KEY} ${GH}`, patterns).length, 2)
  // only a placeholder: nothing
  assert.equal(scanText(`AKIA${'X'.repeat(16)}`, patterns).length, 0)
})
