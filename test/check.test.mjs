import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, DEFAULT_CONFIG } from '../waechter.mjs'

// Tests must not depend on the developer's identity variables.
for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL', 'GIT_DIR', 'GIT_WORK_TREE']) delete process.env[k]

const cfg = {
  ...DEFAULT_CONFIG,
  publicRepoPatterns: ['example/public'],
  alwaysAskRepoPatterns: ['example/costly'],
  blockedBranches: ['old'],
  privateEmailPatterns: ['me@example\\.org'],
}
const cfgForce = { ...cfg, blockForcePush: true }
const PUBLIC = 'git@github.com:example/public.git'
const PRIVATE = 'git@github.com:example/private.git'
const GOOD = 't@users.noreply.github.com'
const BAD = 'bad@example.org'
const fakeKey = 'AKIA' + 'B'.repeat(16)

const root = mkdtempSync(join(tmpdir(), 'waechter-check-'))
let counter = 0

// A temp repo with one commit on `main` (author `email`) and a branch `old`.
function mk(remote, { email = GOOD, name = 'my repo' } = {}) {
  const dir = join(root, String(++counter), name)
  mkdirSync(dir, { recursive: true })
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' })
  g('init', '-q', '-b', 'main')
  g('remote', 'add', 'origin', remote)
  g('config', 'user.name', 't'); g('config', 'user.email', email); g('config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, 'a.txt'), 'hello\n')
  g('add', 'a.txt'); g('commit', '-q', '-m', 'init')
  g('branch', 'old')
  return dir
}
const g = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' })
const q = p => `'${p}'`
const run = (command, cwd, config = cfg) => check({ tool_name: 'Bash', tool_input: { command }, cwd }, config)
const decision = (...a) => run(...a)?.decision

// ---- push: bypasses that used to slip through
const pub = mk(PUBLIC)
const elsewhere = mk(PRIVATE, { name: 'elsewhere' })

const DENIED = [
  'git push origin old',
  'git push origin HEAD:old',
  'git push origin HEAD:refs/heads/old',
  'git push origin main:old',
  'git push origin refs/heads/old:x',
  'git push origin old:x',
  'git push origin old~1:x',
  'git push origin +old',
  'git push origin :old',
  'git push --delete origin old',
  'git push origin main old',
  'git push --all',
  'git push --mirror origin',
  'git push --mir origin',
  'git push --mirro origin',
  'git push --al',
  'git push --force-w origin old',
  'git push origin "refs/heads/*:refs/heads/*"',
  'git push -u origin old',
  'FOO=1 git push origin old',
  'env X=1 git push origin old',
  'sudo git push origin old',
  'command git push origin old',
  'time git push origin old',
  'nohup git push origin old',
  '/usr/bin/git push origin old',
  'git --no-pager push origin old',
  'git -c a.b=c push origin old',
  'git -c a.b=c -c d.e=f --no-pager push origin old',
  "bash -c 'git push origin old'",
  'sh -c "git push origin old"',
  "zsh -c 'bash -c \"git push origin old\"'",
  '(git push origin old)',
  'echo $(git push origin old)',
  'echo `git push origin old`',
  'echo hi && git push origin old',
  'echo hi; git push origin old',
  'false || git push origin old',
  'echo x | git push origin old',
  'git status\ngit push origin old',
  'g"i"t push origin old',
  '"git" \'push\' origin old',
  'git push origin old 2>&1',
  'git push origin old # comment',
  'if true; then git push origin old; fi',
  'git push git@github.com:example/public.git old',
]
for (const cmd of DENIED) test(`public repo denies: ${cmd}`, () => assert.equal(decision(cmd, pub), 'deny'))

const ALLOWED = [
  'git push',
  'git push origin main',
  'git push origin HEAD',
  'git push origin main:main',
  'git push origin refs/heads/main:refs/heads/main',
  'git push --force origin main', // blockForcePush is off by default
  'git push -f origin main',
  'git push --force-with-lease origin main',
  'git push origin +main',
  'echo "git push origin old"',
  "echo 'git push origin old'",
  'git log --grep="git push origin old"',
  'git commit-tree HEAD',
  'git status',
  'ls -la',
  "bash -c 'echo git push origin old'",
  '# git push origin old',
]
for (const cmd of ALLOWED) test(`public repo allows: ${cmd}`, () => assert.equal(run(cmd, pub), undefined))

test('private repo does not block branches', () => {
  assert.equal(run('git push origin old', elsewhere), undefined)
  assert.equal(run('git push --all', elsewhere), undefined)
})

test('empty push and HEAD follow the current branch', () => {
  const d = mk(PUBLIC)
  g(d, 'checkout', '-q', 'old')
  assert.equal(decision('git push', d), 'deny')
  assert.equal(decision('git push origin HEAD', d), 'deny')
  assert.equal(decision('git push origin @', d), 'deny')
  assert.equal(decision('git push origin HEAD~1:other', d), 'deny') // content of a blocked branch
  assert.equal(decision('git push origin main', d), undefined)
  assert.equal(decision('git push origin +main', d), undefined)
})
test('git -C: quoted, repeated, relative', () => {
  assert.equal(decision(`git -C ${q(pub)} push origin old`, '/'), 'deny')
  assert.equal(decision(`git -C "${pub}" push origin old`, '/'), 'deny')
  assert.equal(decision(`git -C ${q(join(pub, '..'))} -C ${q('my repo')} push origin old`, '/'), 'deny')
  assert.equal(decision(`git -C ${q(elsewhere)} -C ${q(pub)} push origin old`, '/'), 'deny') // last absolute path wins
  assert.equal(decision(`git -C ${q(pub)} -C ${q(elsewhere)} push origin old`, '/'), undefined)
  assert.equal(decision(`git -C ${q(elsewhere)} push origin old`, pub), undefined) // -C overrides cwd
})
test('cd is followed, scoped to subshells', () => {
  assert.equal(decision(`cd ${q(pub)} && git push origin old`, '/'), 'deny')
  assert.equal(decision(`cd ${q(pub)}; git push origin old`, elsewhere), 'deny')
  assert.equal(decision(`(cd ${q(pub)} && true); git push origin old`, elsewhere), undefined)
  assert.equal(decision(`cd ${q(elsewhere)} && git push origin old`, pub), undefined)
  assert.equal(decision(`cd ${q(join(pub, '..'))} && cd ${q('my repo')} && git push origin old`, '/'), 'deny')
  assert.equal(decision(`bash -c "cd ${q(pub)} && git push origin old"`, '/'), 'deny')
})
test('--git-dir, --work-tree and GIT_DIR point at the repo', () => {
  assert.equal(decision(`git --git-dir=${q(join(pub, '.git'))} push origin old`, '/'), 'deny')
  assert.equal(decision(`git --git-dir ${q(join(pub, '.git'))} --work-tree ${q(pub)} push origin old`, '/'), 'deny')
  assert.equal(decision(`GIT_DIR=${q(join(pub, '.git'))} git push origin old`, '/'), 'deny')
  assert.equal(decision(`env GIT_DIR=${q(join(pub, '.git'))} git push origin old`, '/'), 'deny')
})
test('pushing to another remote or URL counts that URL too', () => {
  const d = mk(PRIVATE)
  g(d, 'remote', 'add', 'pub', PUBLIC)
  assert.equal(decision('git push origin old', d), undefined)
  assert.equal(decision('git push pub old', d), 'deny')
  assert.equal(decision(`git push ${PUBLIC} old`, d), 'deny')
  assert.equal(decision('git push --repo=pub old', d), 'deny')
  assert.equal(decision('git push pub main', d), undefined)
})
test('always-ask remote asks', () => {
  const d = mk('git@github.com:example/costly.git')
  assert.equal(decision('git push origin main', d), 'ask')
  assert.equal(decision('git push', d), 'ask')
})

// ---- author check on what would be uploaded
test('commits with a wrong address are denied, also for tags', () => {
  const d = mk(PUBLIC, { email: BAD })
  assert.equal(decision('git push origin main', d), 'deny')
  assert.equal(decision('git push', d), 'deny')
  assert.equal(decision('git push origin HEAD:other', d), 'deny')
  const e = mk(PUBLIC)
  assert.equal(decision('git push origin main', e), undefined)
  g(e, 'config', 'user.email', BAD)
  writeFileSync(join(e, 'b.txt'), 'b\n'); g(e, 'add', 'b.txt'); g(e, 'commit', '-q', '-m', 'bad')
  g(e, '-c', 'tag.gpgSign=false', 'tag', 'v1')
  assert.equal(decision('git push origin old', e), 'deny') // blocked list first
  assert.equal(decision('git push --tags', e), 'deny')
  assert.equal(decision('git push origin refs/tags/v1', e), 'deny')
  assert.equal(decision('git push origin tag v1', e), 'deny')
  assert.equal(decision('git push origin old:other', e), 'deny')
})
test('unreadable source asks instead of passing', () => {
  assert.equal(decision('git push origin no-such-branch', mk(PUBLIC)), 'ask')
})

// ---- force push
const FORCE = [
  'git push --force origin main', 'git push -f origin main', 'git push origin main -f',
  'git push --force-with-lease origin main', 'git push --force-with-lease=main:abc origin main',
  'git push --force-if-includes origin main', 'git push origin +main', 'git push origin +HEAD:main',
  'git push -uf origin main', 'git push -fu origin main', "bash -c 'git push -f'", 'git push --force',
  'git push --force --delete origin x', 'git push origin main +main:other', 'git push origin main --force',
]
for (const cmd of FORCE) {
  test(`blockForcePush denies in public repo: ${cmd}`, () => assert.equal(decision(cmd, pub, cfgForce), 'deny'))
  test(`force push is not blocked by default: ${cmd}`, () => assert.notEqual(decision(cmd, pub), 'deny'))
  test(`blockForcePush leaves private repos alone: ${cmd}`, () => assert.equal(run(cmd, elsewhere, cfgForce), undefined))
}
test('blockForcePush leaves normal pushes alone', () => {
  for (const c of ['git push', 'git push origin main', 'git push -u origin main', 'git push --no-force-with-lease origin main', 'git push --tags', 'git push -n origin main'])
    assert.equal(run(c, pub, cfgForce), undefined, c)
})

// ---- commit
test('commit: bypasses are found', () => {
  const secret = d => { writeFileSync(join(d, 'k.txt'), 'key ' + fakeKey + '\n'); g(d, 'add', 'k.txt') }
  const d = mk(PUBLIC); secret(d)
  const p = mk(PRIVATE); secret(p)
  for (const c of ['git commit -m x', 'git -c a.b=c commit -m x', "bash -c 'git commit -m x'", 'FOO=1 git commit -m x', 'sudo git commit -m x', '(git commit -m x)', 'echo ok && git commit -m x', 'git commit --amend --no-edit']) {
    assert.equal(decision(c, d), 'deny', c)
    assert.equal(decision(c, p), 'ask', c)
  }
  assert.equal(decision(`git -C ${q(d)} commit -m x`, '/'), 'deny')
  assert.equal(decision(`cd ${q(d)} && git commit -m x`, '/'), 'deny')
})
test('commit: heredoc message with apostrophes is not "unclear"', () => {
  const clean = mk(PUBLIC)
  writeFileSync(join(clean, 'c.txt'), 'x\n'); g(clean, 'add', 'c.txt')
  const msg = "git commit -m \"$(cat <<'EOF'\nIt's a fix (really)\n\nCo-Authored-By: someone\nEOF\n)\""
  assert.equal(run(msg, clean), undefined)
  const dirty = mk(PRIVATE)
  writeFileSync(join(dirty, 'k.txt'), fakeKey + '\n'); g(dirty, 'add', 'k.txt')
  const r = run(msg, dirty)
  assert.equal(r?.decision, 'ask')
  assert.match(r.reason, /AWS access key in k\.txt/)
})
test('commit -a sees unstaged changes of tracked files, also in clusters', () => {
  const d = mk(PUBLIC)
  writeFileSync(join(d, 'a.txt'), 'hello\nkey ' + fakeKey + '\n')
  assert.equal(run('git commit -m x', d), undefined)
  for (const c of ['git commit -a -m x', 'git commit -am x', 'git commit -vam x', 'git commit --all -m x']) assert.equal(decision(c, d), 'deny', c)
  assert.equal(run('git commit -m a', d), undefined) // "a" is the message
})
test('commit with pathspec uses the working tree of those files', () => {
  const d = mk(PUBLIC)
  writeFileSync(join(d, 'a.txt'), 'hello\nkey ' + fakeKey + '\n')
  assert.equal(decision('git commit -m x a.txt', d), 'deny')
  assert.equal(decision('git commit -m x -- a.txt', d), 'deny')
  assert.equal(run('git commit -m x other.txt', d), undefined)
})
test('commit -a in a repo without commits', () => {
  const dir = join(root, 'fresh', 'r'); mkdirSync(dir, { recursive: true })
  g(dir, 'init', '-q'); g(dir, 'remote', 'add', 'origin', PRIVATE)
  g(dir, 'config', 'user.email', GOOD); g(dir, 'config', 'user.name', 't')
  writeFileSync(join(dir, 'k.txt'), fakeKey + '\n'); g(dir, 'add', 'k.txt')
  assert.equal(decision('git commit -a -m x', dir), 'ask')
})
test('commit: author overrides are checked in public repos', () => {
  const d = mk(PUBLIC)
  writeFileSync(join(d, 'c.txt'), 'x\n'); g(d, 'add', 'c.txt')
  assert.equal(run('git commit -m x', d), undefined)
  assert.equal(decision(`git -c user.email=${BAD} commit -m x`, d), 'deny')
  assert.equal(decision(`GIT_AUTHOR_EMAIL=${BAD} git commit -m x`, d), 'deny')
  assert.equal(decision(`GIT_COMMITTER_EMAIL=${BAD} git commit -m x`, d), 'deny')
  assert.equal(decision(`git commit -m x --author="Me <${BAD}>"`, d), 'deny')
  assert.equal(decision(`git commit -m x --author "Me <${BAD}>"`, d), 'deny')
  assert.equal(run(`git commit -m x --author="Me <${GOOD}>"`, d), undefined)
  assert.equal(run(`git -c user.email=${GOOD} commit -m x`, d), undefined)
})

// ---- unclear commands
test('unclear commands are treated strictly with a readable message', () => {
  for (const c of ['eval "git push origin main"', '$GIT push origin main', 'git push origin "$B"', 'git commit -m "oops', "git push origin 'main", 'echo x | bash', 'bash -c "git push $ARGS"', 'cd "$X" && git push origin main']) {
    const r = run(c, pub)
    assert.equal(r?.decision, 'deny', c)
    assert.match(r.reason, /cannot read this command safely/, c)
    assert.equal(decision(c, elsewhere), 'ask', c)
  }
})
test('unclear without anything git-like does not nag', () => {
  assert.equal(run('echo "unfinished', pub), undefined)
  assert.equal(run('ls $(pwd)', pub), undefined)
  assert.equal(run('"$HOME/bin/tool" x', pub), undefined)
  assert.equal(run('echo $X | wc -l', elsewhere), undefined)
})
test('unclear outside a repo only matters when git is mentioned', () => {
  const none = mkdtempSync(join(tmpdir(), 'waechter-none-'))
  assert.equal(decision('eval "$X"', none), 'ask')
  assert.equal(decision('git push origin "$B"', none), 'ask')
  assert.equal(run('echo "unfinished', none), undefined)
})
test('a definite deny wins over unclear', () => {
  const r = run('git push origin old; eval "$X"', pub)
  assert.equal(r?.decision, 'deny')
  assert.match(r.reason, /blocked list/)
})
test('not a repo: nothing to check', () => {
  const none = mkdtempSync(join(tmpdir(), 'waechter-none-'))
  assert.equal(run('git push origin old', none), undefined)
  assert.equal(run('git commit -m x', none), undefined)
})

test('abbreviated options: --all/--mirror abbreviations, blockForcePush and ambiguity', () => {
  assert.equal(decision('git push --al origin', pub), 'deny')
  assert.equal(decision('git push --force-with origin main', pub, cfgForce), 'deny')
  assert.equal(decision('git push --force-w origin main', pub, cfgForce), 'deny')
  assert.equal(decision('git push --forc origin main', pub, cfgForce), 'deny') // ambiguous: unclear -> deny in public repos
  assert.equal(decision('git push --force-w origin main', pub), undefined) // blockForcePush off
  assert.equal(decision('git push --al', elsewhere), undefined) // private repo: nothing to block
})

// ---- wrappers and programs that run git for the command
const WRAPPED_DENIED = [
  'caffeinate git push origin old',
  'caffeinate -i git push origin old',
  'caffeinate -t 60 -d git push origin old',
  'arch -arm64 git push origin old',
  'arch -x86_64 -e FOO=1 git push origin old',
  'arch -arch arm64 git push origin old',
  'nice -n 5 git push origin old',
  'xargs git push origin old',
  'exec git push origin old',
  'find . -exec git push origin old \;',
  'find . -maxdepth 0 -exec git push origin main \;',
  `python3 -c "import os; os.system('git push origin old')"`,
  `python3 -c 'import subprocess; subprocess.run(["git","push","origin","old"])'`,
  `node -e "require('child_process').execSync('git commit -m x')"`,
  'ssh host git push origin old',
  'watch -n1 "git push origin old"',
  'make -C . "git push"',
]
for (const cmd of WRAPPED_DENIED) test(`public repo denies wrapper/non-git: ${cmd}`, () => assert.equal(decision(cmd, pub), 'deny'))

test('non-git programs that mention git push/commit ask in private repos', () => {
  assert.equal(decision(`python3 -c "import os; os.system('git push origin main')"`, elsewhere), 'ask')
  assert.equal(decision('find . -exec git push origin main \;', elsewhere), 'ask')
})
test('known wrappers are unpacked and checked as git, not blocked blindly', () => {
  assert.equal(decision('caffeinate git push origin main', pub), undefined)
  assert.equal(decision('arch -arm64 git push origin main', pub), undefined)
  assert.equal(decision('caffeinate -i git push origin main', elsewhere), undefined)
  assert.equal(decision('caffeinate git status', pub), undefined)
})
test('text-only programs and lookalikes do not trigger', () => {
  assert.equal(decision('echo "git push origin old"', pub), undefined)
  assert.equal(decision('grep -r "git commit" docs', pub), undefined)
  assert.equal(decision('cat .git/config', pub), undefined)
  assert.equal(decision('ls github-push', pub), undefined)
  assert.equal(decision('gh pr create --title x --body y', pub), undefined)
})

// ---- aliases
test('aliases are resolved and checked', () => {
  const d = mk(PUBLIC)
  g(d, 'config', 'alias.ps', 'push')
  g(d, 'config', 'alias.po', 'push origin')
  g(d, 'config', 'alias.sh', '!git push origin old')
  g(d, 'config', 'alias.chain', 'ps')
  g(d, 'config', 'alias.st', 'status')
  g(d, 'config', 'alias.loop', 'loop')
  assert.equal(decision('git ps origin old', d), 'deny')
  assert.equal(decision('git po old', d), 'deny')
  assert.equal(decision('git sh', d), 'deny')
  assert.equal(decision('git chain origin old', d), 'deny')
  assert.equal(decision('git -C ' + q(d) + ' ps origin old', '/'), 'deny')
  assert.equal(decision('git ps origin main', d), undefined)
  assert.equal(decision('git st', d), undefined)
  assert.equal(decision('git loop', d), 'deny') // not resolvable: unclear -> deny in a public repo
})
test('unknown subcommand without an alias is unclear: ask in private, deny in public', () => {
  assert.equal(decision('git nonsense', pub), 'deny')
  assert.equal(decision('git nonsense', elsewhere), 'ask')
  assert.equal(decision('git status', pub), undefined)
  assert.equal(decision('git lfs pull', pub), undefined)
})
test('an alias that shadows a git command is ignored like git does', () => {
  const d = mk(PUBLIC)
  g(d, 'config', 'alias.status', 'push origin old') // git never uses this
  assert.equal(decision('git status', d), undefined)
})
