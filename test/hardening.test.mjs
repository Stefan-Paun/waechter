// The hook must never run code that comes from the command it checks (or from its environment):
// own git calls are hardened. All repos and marker files live in temp folders.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, DEFAULT_CONFIG } from '../waechter.mjs'

for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL', 'GIT_DIR', 'GIT_WORK_TREE']) delete process.env[k]

const posix = process.platform !== 'win32' // the marker scripts are POSIX shell
const cfg = { ...DEFAULT_CONFIG, publicRepoPatterns: ['example/public'] }
const root = mkdtempSync(join(tmpdir(), 'waechter-hard-'))
let n = 0

function mk(remote = 'git@github.com:example/public.git') {
  const dir = join(root, `r${++n}`)
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' })
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  g('remote', 'add', 'origin', remote)
  g('config', 'user.name', 't'); g('config', 'user.email', 't@users.noreply.github.com'); g('config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  g('add', 'a.txt'); g('commit', '-q', '-m', 'init')
  writeFileSync(join(dir, 'a.txt'), 'two\n')
  g('add', 'a.txt')
  return { dir, g }
}
const marker = name => join(root, `marker-${++n}-${name}`)
const run = (command, cwd, config = cfg) => check({ tool_name: 'Bash', tool_input: { command }, cwd }, config)

test('-c core.fsmonitor from the checked command does not run code in the hook', { skip: !posix }, () => {
  const { dir } = mk()
  const m = marker('fsmonitor')
  run(`git -c core.fsmonitor="touch ${m}" commit -m x`, dir)
  run(`git -c core.fsmonitor="touch ${m}" commit -a -m x`, dir)
  assert.equal(existsSync(m), false)
})
test('-c core.hooksPath / -c diff.external from the command are not passed on either', { skip: !posix }, () => {
  const { dir } = mk()
  const m = marker('external')
  const script = join(root, 'ext.sh')
  writeFileSync(script, `#!/bin/sh\ntouch ${m}\n`)
  chmodSync(script, 0o755)
  run(`git -c diff.external=${script} -c core.hooksPath=${root} commit -a -m x`, dir)
  assert.equal(existsSync(m), false)
})
test('core.fsmonitor and diff.external in the repo config do not run code either', { skip: !posix }, () => {
  const { dir, g } = mk()
  const m1 = marker('cfg-fsmonitor')
  const m2 = marker('cfg-external')
  const script = join(root, 'ext2.sh')
  writeFileSync(script, `#!/bin/sh\ntouch ${m2}\n`)
  chmodSync(script, 0o755)
  g('config', 'core.fsmonitor', `touch ${m1}`)
  g('config', 'diff.external', script)
  run('git commit -a -m x', dir)
  assert.equal(existsSync(m1), false)
  assert.equal(existsSync(m2), false)
})
test('GIT_EXTERNAL_DIFF / GIT_PAGER in the hook environment are cleaned', { skip: !posix }, () => {
  const { dir } = mk()
  const m = marker('env')
  const script = join(root, 'ext3.sh')
  writeFileSync(script, `#!/bin/sh\ntouch ${m}\n`)
  chmodSync(script, 0o755)
  const saved = { ...process.env }
  process.env.GIT_EXTERNAL_DIFF = script
  process.env.GIT_PAGER = `touch ${m}`
  process.env.GIT_CONFIG_COUNT = '1'
  process.env.GIT_CONFIG_KEY_0 = 'core.fsmonitor'
  process.env.GIT_CONFIG_VALUE_0 = `touch ${m}`
  try { run('git commit -a -m x', dir) } finally {
    for (const k of ['GIT_EXTERNAL_DIFF', 'GIT_PAGER', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) {
      if (k in saved) process.env[k] = saved[k]; else delete process.env[k]
    }
  }
  assert.equal(existsSync(m), false)
})
test('harmless -c keys (identity) still count: -c user.email makes the author wrong in a public repo', () => {
  const { dir } = mk()
  assert.equal(run('git -c user.email=bad@example.org commit -m x', dir)?.decision, 'deny')
  assert.equal(run('git -c user.email=t@users.noreply.github.com commit -m x', dir), undefined)
})
