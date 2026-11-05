import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanDiff, check, DEFAULT_CONFIG } from '../waechter.mjs'

const cfg = {
  ...DEFAULT_CONFIG,
  publicRepoPatterns: ['example/public'],
  privateEmailPatterns: ['me@example\\.org'],
  privatePathPatterns: ['/home/someone'],
  blockedBranches: ['old'],
}
const diff = f => `+++ b/${f}\n`
const fake = {
  anthropic: 'sk-ant-' + 'a'.repeat(30),
  aws: 'AKIA' + 'A'.repeat(16),
  gh: 'ghp_' + 'b'.repeat(36),
  pk: '-----BEGIN RSA PRIVATE ' + 'KEY-----',
}

test('detects built-in secrets in added lines', () => {
  for (const v of Object.values(fake)) assert.equal(scanDiff(diff('x') + '+k=' + v, cfg, false).length, 1)
})
test('ignores removed and context lines', () => {
  assert.deepEqual(scanDiff(diff('x') + '-k=' + fake.aws + '\n k=' + fake.aws, cfg, false), [])
})
test('configurable email pattern', () => {
  assert.equal(scanDiff(diff('a.md') + '+mail me@example.org', cfg, false).length, 1)
})
test('path pattern only counts in public repos', () => {
  const d = diff('a') + '+cd /home/someone/x'
  assert.equal(scanDiff(d, cfg, false).length, 0)
  assert.equal(scanDiff(d, cfg, true).length, 1)
})

function repo(remote) {
  const dir = mkdtempSync(join(tmpdir(), 'waechter-'))
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' })
  g('init', '-q'); g('remote', 'add', 'origin', remote)
  g('config', 'user.name', 't'); g('config', 'user.email', 't@users.noreply.github.com')
  writeFileSync(join(dir, 'f.txt'), 'key ' + fake.aws + '\n')
  g('add', 'f.txt')
  return dir
}
const bash = (command, cwd) => ({ tool_name: 'Bash', tool_input: { command }, cwd })

test('commit with secret: public denies, private asks', () => {
  assert.equal(check(bash('git commit -m x', repo('git@github.com:example/public.git')), cfg)?.decision, 'deny')
  assert.equal(check(bash('git commit -m x', repo('git@github.com:example/private.git')), cfg)?.decision, 'ask')
})
test('push of blocked branch / --all to public repo is denied', () => {
  const d = repo('git@github.com:example/public.git')
  assert.equal(check(bash('git push origin old', d), cfg)?.decision, 'deny')
  assert.equal(check(bash('git push --all', d), cfg)?.decision, 'deny')
})
test('unrelated commands pass', () => {
  assert.equal(check(bash('ls -la', '/'), cfg), undefined)
  assert.equal(check({ tool_name: 'Read', tool_input: {} }, cfg), undefined)
})

// Kaputte Config: nur git-Befehle fragen nach, alles andere bleibt unberührt.
function lauf(command, configText) {
  const dir = mkdtempSync(join(tmpdir(), 'waechter-cfg-'))
  const pfad = join(dir, 'config.json')
  writeFileSync(pfad, configText)
  const out = execFileSync('node', [fileURLToPath(new URL('../waechter.mjs', import.meta.url))], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: dir }),
    env: { ...process.env, WAECHTER_CONFIG: pfad },
  }).toString()
  return { pfad, verdict: out ? JSON.parse(out).hookSpecificOutput : undefined }
}
test('kaputte JSON-Config: ls bleibt unberührt, git commit fragt mit Hinweis', () => {
  assert.equal(lauf('ls', '{ kaputt').verdict, undefined)
  const r = lauf('git commit -m x', '{ kaputt')
  assert.equal(r.verdict.permissionDecision, 'ask')
  assert.match(r.verdict.permissionDecisionReason, /config\.json ungültig/)
  assert.ok(r.verdict.permissionDecisionReason.includes(r.pfad))
})
test('ungültige Regex in der Config wird im Grund genannt', () => {
  const text = JSON.stringify({ phonePatterns: ['(offen'] })
  assert.equal(lauf('ls', text).verdict, undefined)
  const r = lauf('git push', text)
  assert.equal(r.verdict.permissionDecision, 'ask')
  assert.match(r.verdict.permissionDecisionReason, /phonePatterns: invalid regex "\(offen"/)
})
test('Config mit falschem Typ wird gemeldet', () => {
  for (const text of ['null', '[]', '{"phonePatterns":"x"}', '{"phonePatterns":[5]}', '{"requiredEmailPattern":""}']) {
    assert.equal(lauf('git commit -m x', text).verdict.permissionDecision, 'ask', text)
  }
})
