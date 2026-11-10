import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseShell } from '../shell.mjs'
import { parseGit, parseCommitArgs, parsePushArgs, parseRefspec, refNames, gitContext, resolveFrom, nativePath } from '../gitargs.mjs'

const git = src => {
  const c = parseShell(src).commands.find(x => x.name === 'git')
  return { c, p: parseGit(c.argv) }
}
const push = src => parsePushArgs(git(src).p.args)
const commit = src => parseCommitArgs(git(src).p.args)

// ---- global options
const GLOBALS = [
  ['git push', { sub: 'push', dirs: [] }],
  ['git -C /a push', { sub: 'push', dirs: ['/a'] }],
  ['git -C "/a b" push', { sub: 'push', dirs: ['/a b'] }],
  ["git -C '/a b' push", { sub: 'push', dirs: ['/a b'] }],
  ['git -C /a -C b push', { sub: 'push', dirs: ['/a', 'b'] }],
  ['git -C /a -c user.name=x push', { sub: 'push', dirs: ['/a'], configs: ['user.name=x'] }],
  ['git -c core.editor=true -c a.b=c commit', { sub: 'commit', configs: ['core.editor=true', 'a.b=c'] }],
  ['git --git-dir=/g push', { sub: 'push', gitDir: '/g' }],
  ['git --git-dir /g --work-tree /w push', { sub: 'push', gitDir: '/g', workTree: '/w' }],
  ['git --work-tree=/w commit', { sub: 'commit', workTree: '/w' }],
  ['git --no-pager push', { sub: 'push' }],
  ['git -p push', { sub: 'push' }],
  ['git --paginate --bare push', { sub: 'push' }],
  ['git --exec-path=/x push', { sub: 'push' }],
  ['git --exec-path push', { sub: 'push' }],
  ['git --namespace=ns --no-optional-locks push', { sub: 'push' }],
  ['git -C a --no-pager -c x.y=z --git-dir=.g push origin', { sub: 'push', dirs: ['a'], gitDir: '.g' }],
  ['git --version', { sub: null, info: true }],
  ['git', { sub: null }],
  ['git status', { sub: 'status' }],
]
for (const [src, want] of GLOBALS) {
  test(`parseGit ${src}`, () => {
    const { p } = git(src)
    for (const [k, v] of Object.entries(want)) assert.deepEqual(p[k], v, k)
    assert.deepEqual(p.unclear, [])
  })
}
test('parseGit: subcommand arguments are kept', () => {
  assert.deepEqual(git('git -C x push origin main').p.args.map(w => w.text), ['origin', 'main'])
})
test('parseGit: unclear cases', () => {
  assert.ok(git('git -C "$D" push').p.unclear.length)
  assert.ok(git('git --frobnicate push').p.unclear.length)
  assert.ok(git('git -c alias.p=push p').p.unclear.length)
  assert.ok(git('git $SUB origin').p.unclear.length)
  assert.ok(git('git -C').p.unclear.length)
})

// ---- directory git would use
test('gitContext: -C chains and absolute paths', () => {
  const ctx = (src, cwd = '/w') => { const { c, p } = git(src); return gitContext(cwd, p, c.assigns, 'linux') }
  assert.equal(ctx('git push').dir, '/w')
  assert.equal(ctx('git -C a push').dir, '/w/a')
  assert.equal(ctx('git -C a -C b push').dir, '/w/a/b')
  assert.equal(ctx('git -C a -C /x push').dir, '/x')
  assert.equal(ctx('git -C "my repo" push').dir, '/w/my repo')
  assert.equal(ctx('git -C .. push').dir, '/')
  assert.equal(ctx('git --git-dir=g push').gitDir, '/w/g')
  assert.equal(ctx('git -C a --git-dir=g push').gitDir, '/w/a/g')
  assert.equal(ctx('git --work-tree=/t push').workTree, '/t')
  assert.equal(ctx('GIT_DIR=/e git push').gitDir, '/e')
  assert.equal(ctx('GIT_DIR=/e git --git-dir=/f push').gitDir, '/f')
  assert.equal(ctx('env GIT_WORK_TREE=/t git push').workTree, '/t')
})
test('resolveFrom: absolute vs relative and Windows paths', () => {
  assert.equal(resolveFrom('/w', '/abs/x', 'linux'), '/abs/x')
  assert.equal(resolveFrom('/w', 'rel', 'linux'), '/w/rel')
  assert.equal(nativePath('/c/Users/x', 'win32'), 'C:\\Users\\x')
  assert.equal(nativePath('/c', 'win32'), 'C:\\')
  assert.equal(nativePath('/c/Users/x', 'linux'), '/c/Users/x')
  assert.equal(nativePath('/usr/x', 'win32'), '/usr/x')
})

// ---- commit
const COMMITS = [
  ['git commit -m x', { all: false, paths: [] }],
  ['git commit -a -m x', { all: true }],
  ['git commit -am x', { all: true }],
  ['git commit -am', { all: true }],
  ['git commit --all -m x', { all: true }],
  ['git commit -m a', { all: false }], // the "a" is a message, not a flag
  ['git commit -ma', { all: false }],
  ['git commit -m "-a"', { all: false }],
  ['git commit -F msg.txt', { all: false }],
  ['git commit -vam x', { all: true }],
  ['git commit --amend --no-edit', { all: false, paths: [] }],
  ['git commit --message=hello -a', { all: true }],
  ['git commit --message hello', { all: false, paths: [] }],
  ['git commit -m x a.txt b.txt', { paths: ['a.txt', 'b.txt'] }],
  ['git commit -m x -- a.txt -b', { paths: ['a.txt', '-b'] }],
  ['git commit -S -m x', { all: false, paths: [] }],
]
for (const [src, want] of COMMITS) {
  test(`commit args ${src}`, () => {
    const r = commit(src)
    for (const [k, v] of Object.entries(want)) assert.deepEqual(r[k], v, k)
  })
}
test('commit args: variable is unclear', () => assert.ok(commit('git commit -m "$MSG" $F').unclear.length))

// ---- refspecs
test('parseRefspec', () => {
  assert.deepEqual(parseRefspec('main'), { raw: 'main', force: false, src: 'main', dst: 'main', delete: false, glob: false })
  assert.deepEqual(parseRefspec('+main'), { raw: '+main', force: true, src: 'main', dst: 'main', delete: false, glob: false })
  assert.deepEqual(parseRefspec('HEAD:old'), { raw: 'HEAD:old', force: false, src: 'HEAD', dst: 'old', delete: false, glob: false })
  assert.deepEqual(parseRefspec(':old'), { raw: ':old', force: false, src: '', dst: 'old', delete: true, glob: false })
  assert.equal(parseRefspec('refs/heads/*:refs/heads/*').glob, true)
  assert.equal(parseRefspec('+a:b').force, true)
})
test('refNames: source and destination, refs/heads removed', () => {
  const names = s => refNames(parseRefspec(s))
  assert.deepEqual(names('main'), ['main', 'main'])
  assert.deepEqual(names('HEAD:old'), ['HEAD', 'old'])
  assert.deepEqual(names('HEAD:refs/heads/old'), ['HEAD', 'old'])
  assert.deepEqual(names('refs/heads/old:x'), ['old', 'x'])
  assert.deepEqual(names('heads/old:x'), ['old', 'x'])
  assert.deepEqual(names('+old'), ['old', 'old'])
  assert.deepEqual(names('old~2:x'), ['old', 'x'])
  assert.deepEqual(names('old^:x'), ['old', 'x'])
  assert.deepEqual(names('@:x'), ['HEAD', 'x'])
  assert.deepEqual(names('@{u}:x'), ['x'])
  assert.deepEqual(names(':old'), ['old'])
})

// ---- push
const PUSHES = [
  ['git push', { remote: null, refspecs: [], forceKinds: [] }],
  ['git push origin', { remote: 'origin', refspecs: [] }],
  ['git push origin main', { remote: 'origin', refspecs: ['main'] }],
  ['git push origin HEAD:old', { refspecs: ['HEAD:old'] }],
  ['git push origin HEAD:refs/heads/old', { refspecs: ['HEAD:refs/heads/old'] }],
  ['git push origin +main', { forceKinds: ['+main'] }],
  ['git push origin a b c', { refspecs: ['a', 'b', 'c'] }],
  ['git push origin a:b +c:d', { refspecs: ['a:b', '+c:d'], forceKinds: ['+c'] }],
  ['git push --force', { forceKinds: ['--force'] }],
  ['git push -f origin main', { forceKinds: ['-f'], remote: 'origin', refspecs: ['main'] }],
  ['git push origin main -f', { forceKinds: ['-f'], refspecs: ['main'] }],
  ['git push -uf origin main', { forceKinds: ['-f'] }],
  ['git push -fu origin main', { forceKinds: ['-f'] }],
  ['git push --force-with-lease', { forceKinds: ['--force-with-lease'] }],
  ['git push --force-with-lease=main:abc123 origin main', { forceKinds: ['--force-with-lease'], remote: 'origin' }],
  ['git push --force-if-includes', { forceKinds: ['--force-if-includes'] }],
  ['git push --force --force-with-lease', { forceKinds: ['--force', '--force-with-lease'] }],
  ['git push --no-force-with-lease', { forceKinds: [] }],
  ['git push -u origin main', { forceKinds: [], remote: 'origin', refspecs: ['main'] }],
  ['git push --set-upstream origin main', { remote: 'origin', refspecs: ['main'] }],
  ['git push --all', { all: true }],
  ['git push --mirror origin', { mirror: true, remote: 'origin' }],
  ['git push --tags', { tags: true }],
  ['git push origin --tags', { tags: true, remote: 'origin' }],
  ['git push --delete origin old', { delete: true, remote: 'origin', refspecs: ['old'] }],
  ['git push -d origin old', { delete: true, refspecs: ['old'] }],
  ['git push origin :old', { refspecs: [':old'] }],
  ['git push origin tag v1', { refspecs: ['refs/tags/v1'] }],
  ['git push --repo=up main', { remote: 'up', refspecs: ['main'] }],
  ['git push --repo up main', { remote: 'up', refspecs: ['main'] }],
  ['git push -o ci.skip origin main', { remote: 'origin', refspecs: ['main'] }],
  ['git push --push-option ci.skip origin main', { remote: 'origin', refspecs: ['main'] }],
  ['git push --push-option=ci.skip origin main', { remote: 'origin', refspecs: ['main'] }],
  ['git push -n -v -q origin main', { remote: 'origin', refspecs: ['main'], forceKinds: [] }],
  ['git push --receive-pack=x origin main', { remote: 'origin' }],
  ['git push --prune origin "refs/heads/*:refs/heads/*"', { prune: true, refspecs: ['refs/heads/*:refs/heads/*'] }],
  ['git push -- origin -weird', { remote: 'origin', refspecs: ['-weird'] }],
  ['git -C x push -f', { forceKinds: ['-f'] }],
]
for (const [src, want] of PUSHES) {
  test(`push args ${src}`, () => {
    const r = push(src)
    for (const [k, v] of Object.entries(want)) {
      if (k === 'refspecs') assert.deepEqual(r.refspecs.map(s => s.raw), v, k)
      else assert.deepEqual(r[k], v, k)
    }
  })
}
test('push args: delete flag marks every refspec', () => {
  const r = push('git push --delete origin a b')
  assert.deepEqual(r.refspecs.map(s => [s.src, s.dst, s.delete]), [['', 'a', true], ['', 'b', true]])
})
test('push args: variables are unclear', () => {
  assert.ok(push('git push origin "$BRANCH"').unclear.length)
  assert.ok(push('git push $FLAGS origin main').unclear.length)
  assert.deepEqual(push('git push origin main').unclear, [])
})
