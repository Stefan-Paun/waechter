import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanDiff, check, findGit, DEFAULT_CONFIG } from '../waechter.mjs'

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

function repo(remote, prefix = 'waechter-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
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

const PUB = 'git@github.com:example/public.git'
test('global git options before the subcommand are still checked', () => {
  const d = repo(PUB)
  for (const c of [
    'git -c user.name=a commit -m x',
    'git --no-pager commit -m x',
    'git -c a.b=c --no-pager -c d.e=f commit -m x',
    'git --git-dir=.git commit -m x',
    'git --git-dir .git --work-tree . commit -m x',
    `git --git-dir="${join(d, '.git')}" --work-tree="${d}" commit -m x`,
    'git -C . commit -m x',
    'git commit -m "a; b"',
    'echo `git commit`',
    'bash -c "git commit" && ls',
    'git commit>log -m x',
    'git \\\ncommit -m x',
    'git -c a=b status && git commit -m x',
  ]) assert.equal(check(bash(c, d), cfg)?.decision, 'deny', c)
  for (const c of ['git --no-pager push origin old', 'git -c push.default=current push --all', 'git -C . -c a=b push origin old'])
    assert.equal(check(bash(c, d), cfg)?.decision, 'deny', c)
})
test('every commit/push in one command is checked', () => {
  const d = repo(PUB)
  execFileSync('git', ['-C', d, 'rm', '-q', '--cached', 'f.txt'])
  assert.equal(check(bash('git -c a=b commit -m x', d), cfg), undefined)
  assert.equal(check(bash('git -c a=b commit -m x && git push origin old', d), cfg)?.decision, 'deny')
})
test('redirections and comments are not taken for refs', () => {
  assert.deepEqual(findGit('git push origin main 2>&1 | tail -5')?.rest, ['origin', 'main'])
  assert.deepEqual(findGit('git push > /dev/null origin old')?.rest, ['origin', 'old'])
  assert.deepEqual(findGit('git push origin main # later')?.rest, ['origin', 'main'])
  assert.deepEqual(findGit('git commit -m x<<EOF\nfoo\nEOF')?.rest, ['-m', 'x'])
  assert.equal(findGit('git commit-tree abc'), undefined)
  const d = repo(PUB)
  const marker = join(d, 'marker.txt')
  check(bash(`git push origin +--output=${marker}`, d), cfg)
  assert.equal(existsSync(marker), false)
})
test('-C with a quoted path containing spaces', () => {
  const d = repo(PUB, 'waechter a b-')
  const elsewhere = mkdtempSync(join(tmpdir(), 'waechter-'))
  assert.equal(check(bash(`git -C "${d}" commit -m x`, elsewhere), cfg)?.decision, 'deny')
  assert.equal(check(bash(`git -C '${d}' -c a=b commit -m x`, elsewhere), cfg)?.decision, 'deny')
  assert.equal(check(bash(`git --no-pager -C "${d}" push origin old`, elsewhere), cfg)?.decision, 'deny')
})
test('cd and several -C are resolved one after the other', () => {
  const d = repo(PUB)
  mkdirSync(join(d, 'sub'))
  assert.equal(check(bash('cd sub && git -C .. commit -m x', d), cfg)?.decision, 'deny')
  assert.equal(check(bash('git -C sub -C .. commit -m x', d), cfg)?.decision, 'deny')
})
test('-c user.email overrides the author check in public repos', () => {
  const d = repo(PUB)
  execFileSync('git', ['-C', d, 'rm', '-q', '--cached', 'f.txt'])
  assert.equal(check(bash('git commit -m x', d), cfg), undefined)
  const v = check(bash('git -c user.email=someone@example.org commit -m x', d), cfg)
  assert.equal(v?.decision, 'deny')
  assert.match(v.reason, /author does not match/)
  assert.equal(check(bash('git -c author.email=someone@example.org commit -m x', d), cfg)?.decision, 'deny')
  assert.equal(check(bash('git -c user.email=x@users.noreply.github.com commit -m x', d), cfg), undefined)
})
test('findGit: subcommand detection', () => {
  assert.equal(findGit('git -c alias.x=commit status'), undefined)
  assert.equal(findGit('git log --grep push'), undefined)
  assert.equal(findGit('git status; echo commit'), undefined)
  assert.equal(findGit('git add . && git --no-pager commit -am x')?.sub, 'commit')
  assert.deepEqual(findGit('git -C "a b" -C c push origin +main')?.dirs, ['a b', 'c'])
  assert.deepEqual(findGit('git push origin main && ls')?.rest, ['origin', 'main'])
})
