import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseShell, trackDirs } from '../shell.mjs'

// Each command as "name arg arg" (texts joined by a single space, programs only)
const flat = (src, opts) => parseShell(src, { home: '/h', ...opts }).commands.map(c => c.argv.map(w => w.text).join(' '))
const unclear = (src, opts) => parseShell(src, opts).unclear

const CASES = [
  // [input, expected commands]
  ['git push', ['git push']],
  ['git   push\torigin   main', ['git push origin main']],
  ["git commit -m 'a b  c'", ['git commit -m a b  c']],
  ['git commit -m "a b"', ['git commit -m a b']],
  ['git commit -m "say \\"hi\\""', ['git commit -m say "hi"']],
  ["git commit -m 'it\\'s'x", null], // single quotes have no escapes: open quote afterwards
  ['git\\ push', ['git push']],
  ['g"i"t push', ['git push']],
  ["'git' 'push'", ['git push']],
  ['git push \\\n origin', ['git push origin']],
  ['git push && git commit', ['git push', 'git commit']],
  ['git push || git commit', ['git push', 'git commit']],
  ['git push; git commit', ['git push', 'git commit']],
  ['git push | cat', ['git push', 'cat']],
  ['git push |& cat', ['git push', 'cat']],
  ['git push & git commit', ['git push', 'git commit']],
  ['git push\ngit commit', ['git push', 'git commit']],
  ['echo "a && b" && git push', ['echo a && b', 'git push']],
  ["echo 'a;b'; ls", ['echo a;b', 'ls']],
  ['echo a\\;b', ['echo a;b']],
  ['git push # git commit', ['git push']],
  ['echo a#b', ['echo a#b']],
  // subshell and substitution
  ['(git push)', ['git push']],
  ['( cd x && git push ) && ls', ['cd x', 'git push', 'ls']],
  ['echo $(git push)', ['git push', 'echo $(git push)']],
  ['echo "$(git push)"', ['git push', 'echo $(git push)']],
  ['echo `git push`', ['git push', 'echo `git push`']],
  ['echo "`git commit -m x`"', ['git commit -m x', 'echo `git commit -m x`']],
  ['echo $(echo $(git push))', ['git push', 'echo $(git push)', 'echo $(echo $(git push))']],
  ['x=$(git push)', ['git push']],
  ['diff <(git show a) <(git show b)', ['git show a', 'git show b', 'diff <(...) <(...)']],
  ['echo $((1+2)) && git push', ['echo $((1+2))', 'git push']],
  ['echo ${A:-$(git push)}', ['git push', 'echo ${A:-$(git push)}']],
  ['echo \\$HOME', ['echo $HOME']],
  ["echo '$(git push)'", ['echo $(git push)']],
  // prefixes and wrappers
  ['FOO=1 git push', ['git push']],
  ['A=1 B="x y" git push', ['git push']],
  ['FOO=1', []],
  ['env git push', ['git push']],
  ['env -i FOO=1 git push', ['git push']],
  ['env -u HOME git push', ['git push']],
  ['env -- git push', ['git push']],
  ['command git push', ['git push']],
  ['command -p git push', ['git push']],
  ['command -v git', []],
  ['sudo git push', ['git push']],
  ['sudo -u bob git push', ['git push']],
  ['sudo -E -- git push', ['git push']],
  ['time git push', ['git push']],
  ['nohup git push', ['git push']],
  ['nohup env X=1 sudo time git push', ['git push']],
  ['nice -n 5 git push', ['git push']],
  ['timeout 10 git push', ['git push']],
  ['xargs -n 1 git push', ['git push']],
  ['/usr/bin/git push', ['/usr/bin/git push']],
  ['! git push', ['git push']],
  ['if git push; then echo ok; fi', ['git push', 'echo ok']],
  ['{ git push; }', ['git push']],
  ['for i in 1 2; do git push; done', ['for i in 1 2', 'git push']],
  // redirections do not become arguments
  ['git push origin main 2>&1', ['git push origin main']],
  ['git push > /tmp/x', ['git push']],
  ['git push >>log 2>/dev/null', ['git push']],
  ['git push &> out', ['git push']],
  ['git push < in', ['git push']],
  ['git push <<< "x y"', ['git push']],
  ['cat > f <<EOF\nhello\nEOF\ngit push', ['cat', 'git push']],
  ["cat <<'EOF'\nit's \"open\nEOF\ngit push", ['cat', 'git push']],
  ['cat <<-EOF\n\tx\n\tEOF\ngit push', ['cat', 'git push']],
  ['cat <<EOF\n$(git push)\nEOF', ['cat', 'git push']],
  ["cat <<'EOF'\n$(git push)\nEOF", ['cat']],
  ['git commit -m "$(cat <<\'EOF\'\nit\'s a fix\nEOF\n)"', ['cat', 'git commit -m $(cat <<\'EOF\'\nit\'s a fix\nEOF\n)']],
  // bash -c
  ["bash -c 'git push'", ['git push']],
  ['sh -c "git push origin main"', ['git push origin main']],
  ['zsh -c "git push"', ['git push']],
  ["bash -lc 'git push'", ['git push']],
  ["bash -e -c 'git push; ls'", ['git push', 'ls']],
  ["sudo bash -c 'git push'", ['git push']],
  ["bash -c 'bash -c \"git push\"'", ['git push']],
  ["bash -c 'sh -c \"zsh -c \\\"git push\\\"\"'", ['git push']],
  ['bash script.sh', ['bash script.sh']],
  ["bash -c 'echo $(git commit -m x)'", ['git commit -m x', 'echo $(git commit -m x)']],
  // misc
  ['~/bin/tool push', ['/h/bin/tool push']],
  ["echo '~'", ['echo ~']],
  ["git -C 'my repo' push", ['git -C my repo push']],
  ["$'git' push", ['git push']],
  ['', []],
  ['   ', []],
]

for (const [src, expected] of CASES) {
  test(`parse ${JSON.stringify(src)}`, () => {
    if (expected === null) { assert.ok(unclear(src).length > 0); return }
    assert.deepEqual(flat(src), expected)
  })
}
test('table has at least 60 cases', () => assert.ok(CASES.length >= 60))

const UNCLEAR = [
  ["git commit -m 'oops", 'open single quote'],
  ['git commit -m "oops', 'open double quote'],
  ['eval "git push"', 'eval'],
  ['eval $CMD', 'eval'],
  ['$GIT push', 'variable'],
  ['"$(which git)" push', 'variable'],
  ['${CMD} push', 'variable'],
  ['FOO=1 $CMD', 'variable'],
  ['echo $(git push', 'unterminated'],
  ['(git push', 'unterminated'],
  ['echo `git push', 'open backtick'],
  ['echo ${A', 'open ${'],
  ['echo "x" | bash', 'stdin'],
  ['bash <<< "git push"', 'stdin'],
  ['sh -c', 'without a command'],
  ['bash -c "$X"', 'variable'],
  ['env -S "git push"', 'env'],
  ["bash -c 'bash -c \"bash -c \\\"bash -c x\\\"\"'", null],
]
for (const [src, part] of UNCLEAR) {
  test(`unclear ${JSON.stringify(src)}`, () => {
    const u = unclear(src, { maxDepth: 2 })
    if (part === null) return assert.ok(u.length > 0)
    assert.ok(u.some(m => m.includes(part)), JSON.stringify(u))
  })
}

test('clear commands are not unclear', () => {
  for (const s of ['git push', "bash -c 'git push'", '$HOME/bin/tool x', 'echo $X && ls "$Y"', 'git commit -m "a $(date)"']) assert.deepEqual(unclear(s), [], s)
})
test('nested shells beyond maxDepth are unclear', () => {
  assert.ok(unclear("bash -c \"bash -c 'git push'\"", { maxDepth: 1 }).some(m => m.includes('deeply')))
  assert.deepEqual(unclear("bash -c \"bash -c 'git push'\"", { maxDepth: 2 }), [])
})
test('words carry dyn flags', () => {
  const [c] = parseShell('git push "$REMOTE" main').commands
  assert.deepEqual(c.argv.map(w => w.dyn), [false, false, true, false])
  assert.equal(c.argv[2].quoted, true)
})
test('assignments are kept', () => {
  assert.deepEqual(parseShell('GIT_DIR=/x A=1 env B=2 git push').commands[0].assigns, ['GIT_DIR=/x', 'A=1', 'B=2'])
})
test('very deep nesting does not crash', () => {
  const u = unclear('echo ' + '$('.repeat(200) + 'ls' + ')'.repeat(200))
  assert.ok(u.some(m => m.includes('deeply')))
})

// trackDirs
const dirs = (src, cwd = '/w') => trackDirs(parseShell(src, { home: '/h' }).commands, cwd, { home: '/h' }).map(c => `${c.name}@${c.dir}`)
test('cd is followed and composed', () => {
  assert.deepEqual(dirs('git push'), ['git@/w'])
  assert.deepEqual(dirs('cd a && git push'), ['cd@/w', 'git@/w/a'])
  assert.deepEqual(dirs('cd a; cd b; git push'), ['cd@/w', 'cd@/w/a', 'git@/w/a/b'])
  assert.deepEqual(dirs('cd /abs && git push'), ['cd@/w', 'git@/abs'])
  assert.deepEqual(dirs('cd ~/x && git push'), ['cd@/w', 'git@/h/x'])
  assert.deepEqual(dirs('cd && git push'), ['cd@/w', 'git@/h'])
  assert.deepEqual(dirs("cd 'my dir' && git push"), ['cd@/w', 'git@/w/my dir'])
})
test('cd inside a subshell does not leak', () => {
  assert.deepEqual(dirs('(cd a && git push); git commit'), ['cd@/w', 'git@/w/a', 'git@/w'])
  assert.deepEqual(dirs('x=$(cd a; pwd); git push'), ['cd@/w', 'pwd@/w/a', 'git@/w'])
})
test('subshell inherits the outer cd', () => {
  assert.deepEqual(dirs('cd a && (git push)'), ['cd@/w', 'git@/w/a'])
})
test('unknown cd targets give null', () => {
  assert.deepEqual(dirs('cd "$X" && git push'), ['cd@/w', 'git@null'])
  assert.deepEqual(dirs('cd - && git push'), ['cd@/w', 'git@null'])
  assert.deepEqual(dirs('cd a && popd && git push'), ['cd@/w', 'popd@/w/a', 'git@null'])
})
