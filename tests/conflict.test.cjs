const { test } = require('node:test');
const { windows, portableName, exoticNames, posixModes, linkTarget } = require('./platform.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { GitDesk } = require('../dist/git');

const work = path.resolve(__dirname, '../.test-work');
process.env.GIT_ALLOW_PROTOCOL = 'file';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(work, 'conflict-no-global-config');
function gitBytes(cwd, args, input) {
    return execFileSync('git', ['--literal-pathspecs', ...args], {
        cwd, input, timeout: 30000, maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
}
const git = (cwd, ...args) => gitBytes(cwd, args).toString('utf8').trimEnd();
const conflictText = '<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs\n';
const combinations = { UU: [1, 2, 3], AA: [2, 3], UD: [1, 2], DU: [1, 3], DD: [1] };

async function write(repo, name, content) {
    await fs.mkdir(path.dirname(path.join(repo, name)), { recursive: true });
    await fs.writeFile(path.join(repo, name), content);
}
function object(repo, content) { return gitBytes(repo, ['hash-object', '-w', '--stdin'], content).toString('utf8').trim(); }
function stages(repo, name, numbers = combinations.UU, options = {}) {
    const result = numbers.map(stage => ({
        stage, mode: options.mode || '100644',
        object: options.object || object(repo, options.contents?.[stage] ?? ['unused', 'base\n', 'ours\n', 'theirs\n'][stage]),
    }));
    const lines = [`0 ${'0'.repeat(40)}\t${name}\0`, ...result.map(entry => `${entry.mode} ${entry.object} ${entry.stage}\t${name}\0`)];
    gitBytes(repo, ['update-index', '-z', '--index-info'], lines.join(''));
    return result;
}
async function fixture(t, name = 'file.txt', numbers = combinations.UU, options = {}) {
    await fs.mkdir(work, { recursive: true });
    const base = await fs.mkdtemp(path.join(work, 'conflict-'));
    t.after(async () => { await fs.rm(base, { recursive: true, force: true }); });
    const repo = path.join(base, 'project'); await fs.mkdir(repo);
    git(repo, 'init', '-b', 'dev');
    git(repo, 'config', 'user.name', 'Git Desk Test'); git(repo, 'config', 'user.email', 'git-desk@example.invalid');
    git(repo, 'config', 'commit.gpgSign', 'false'); git(repo, 'config', 'core.autocrlf', 'false');
    git(repo, 'config', 'core.hooksPath', path.join(base, 'no-hooks'));
    await write(repo, name, 'base\n'); await write(repo, name + '.meta', 'meta base\n'); await write(repo, 'staged.txt', 'base\n');
    git(repo, 'add', '--', name, name + '.meta', 'staged.txt'); git(repo, 'commit', '-m', 'initial');
    const initial = git(repo, 'rev-parse', 'HEAD'), gitDir = git(repo, 'rev-parse', '--absolute-git-dir');
    const entries = stages(repo, name, numbers, options);
    if (options.missing) await fs.unlink(path.join(repo, name));
    else await write(repo, name, options.working ?? conflictText);
    const editor = { dirty: false, calls: [] };
    const desk = new GitDesk(repo, path.join(base, 'cache'), {
        async checkEditor(worktreeChange) { editor.calls.push(['check', worktreeChange]); if (editor.dirty) throw new Error('unsaved scene'); },
        async beforeWorktreeChange() { editor.calls.push(['before']); },
        async afterWorktreeChange() { editor.calls.push(['after']); },
    });
    return { base, repo, desk, editor, entries, initial, gitDir, name };
}
async function view(desk, name = 'file.txt') {
    const diff = await desk.diff({ repo: '.', path: name, area: 'conflict' });
    assert.ok(diff.conflict, 'conflict view must be explicit');
    return diff.conflict;
}
async function request(desk, name = 'file.txt', mode = 'content', conflict) {
    const snapshot = await desk.snapshot(true), current = conflict || await view(desk, name);
    return { repo: '.', version: snapshot.repositories[0].version, action: 'resolveConflict', resolution: { path: name, version: current.version, mode } };
}
async function finish(desk, preview) {
    desk.execute(preview.token);
    const start = Date.now();
    while (desk.task().status === 'running') {
        if (Date.now() - start > 30000) throw new Error('task test timeout');
        await new Promise(resolve => setTimeout(resolve, 15));
    }
    return desk.task();
}
async function resolve(desk, name = 'file.txt', mode = 'content') {
    const preview = await desk.prepare(await request(desk, name, mode));
    assert.deepEqual(preview.paths, [name]);
    const result = await finish(desk, preview);
    assert.equal(result.status, 'success', result.log);
    return preview;
}
async function preserved(repo, name = 'file.txt') {
    return {
        head: git(repo, 'rev-parse', 'HEAD'), branch: git(repo, 'branch', '--show-current'),
        index: await fs.readFile(path.join(git(repo, 'rev-parse', '--absolute-git-dir'), 'index')),
        working: await fs.readFile(path.join(repo, name)).catch(error => { if (error.code === 'ENOENT') return null; throw error; }),
    };
}
function noWorktreeHooks(editor) {
    assert.ok(editor.calls.every(call => call[0] === 'check' && call[1] !== true), JSON.stringify(editor.calls));
}
async function blocked(desk, name = 'file.txt') {
    const current = await view(desk, name);
    assert.equal(current.resolution, undefined); assert.ok(current.blockedReason);
    await assert.rejects(desk.prepare(await request(desk, name, current.workingExists ? 'content' : 'delete', current)));
    return current;
}

test('conflict inspection shows three distinct index stages and working content without modifying anything', async t => {
    const { repo, desk, editor, entries } = await fixture(t), before = await preserved(repo);
    const current = await view(desk);
    assert.equal(current.path, 'file.txt'); assert.equal(current.status, 'UU'); assert.ok(current.version);
    assert.deepEqual(current.stages.map(({ stage, mode, object }) => ({ stage, mode, object })), entries);
    assert.deepEqual(current.stages.map(entry => entry.content.text), ['base\n', 'ours\n', 'theirs\n']);
    assert.equal(current.working.text, conflictText); assert.equal(current.workingExists, true);
    assert.equal(current.resolution, undefined); assert.ok(current.blockedReason);
    assert.deepEqual(await preserved(repo), before); assert.deepEqual(editor.calls, []);
});

test('AA UD DU and DD views preserve missing stages instead of presenting nonexistent empty files', async t => {
    for (const [status, numbers] of Object.entries(combinations).filter(([status]) => status !== 'UU')) {
        const { desk, entries } = await fixture(t, 'file.txt', numbers, { missing: status === 'DD', working: 'resolved\n' });
        const current = await view(desk);
        assert.equal(current.status, status);
        assert.deepEqual(current.stages.map(entry => entry.stage), numbers);
        assert.deepEqual(current.stages.map(entry => entry.object), entries.map(entry => entry.object));
        assert.equal(current.workingExists, status !== 'DD');
        assert.equal(current.resolution, status === 'DD' ? 'delete' : 'content');
        if (status === 'DD') { assert.equal(current.working.text, undefined); assert.ok(current.working.notice); }
    }
});

test('resolving a normal text file stages exactly the saved bytes and preserves executable mode and HEAD', async t => {
    for (const mode of ['100644', '100755']) {
        const content = '中文 first\r\n\tlast without newline', { repo, desk, editor, initial } = await fixture(t, 'file.txt', combinations.UU, { mode, working: content });
        await fs.chmod(path.join(repo, 'file.txt'), mode === '100755' ? 0o755 : 0o644);
        await resolve(desk);
        assert.equal(git(repo, 'ls-files', '-u', '--', 'file.txt'), '');
        assert.match(git(repo, 'ls-files', '--stage', '--', 'file.txt'), new RegExp(`^${mode} [a-f0-9]+ 0\\tfile[.]txt$`));
        assert.deepEqual(gitBytes(repo, ['show', ':0:file.txt']), Buffer.from(content));
        assert.deepEqual(await fs.readFile(path.join(repo, 'file.txt')), Buffer.from(content));
        assert.equal(git(repo, 'rev-parse', 'HEAD'), initial); assert.ok(editor.calls.some(call => call[0] === 'check')); noWorktreeHooks(editor);
    }
});

test('an explicit deletion decision removes only the missing conflicted path from the index', async t => {
    for (const numbers of [combinations.UD, combinations.DU, combinations.DD]) {
        const { repo, desk, editor, initial } = await fixture(t, 'file.txt', numbers, { missing: true });
        const meta = git(repo, 'ls-files', '--stage', '--', 'file.txt.meta');
        assert.equal((await view(desk)).resolution, 'delete');
        await resolve(desk, 'file.txt', 'delete');
        assert.equal(git(repo, 'ls-files', '--stage', '--', 'file.txt'), '');
        await assert.rejects(fs.stat(path.join(repo, 'file.txt')), { code: 'ENOENT' });
        assert.equal(git(repo, 'ls-files', '--stage', '--', 'file.txt.meta'), meta);
        assert.equal(git(repo, 'rev-parse', 'HEAD'), initial); noWorktreeHooks(editor);
    }
});

test('content and delete resolutions cannot be substituted for the actual saved-file state', async t => {
    for (const missing of [false, true]) {
        const { repo, desk } = await fixture(t, 'file.txt', combinations.UD, { missing, working: 'resolved\n' });
        const before = await preserved(repo);
        await assert.rejects(desk.prepare(await request(desk, 'file.txt', missing ? 'content' : 'delete')));
        assert.deepEqual(await preserved(repo), before);
    }
});

test('resolving one conflict retains other conflicts, unrelated staging, dirty meta files and untracked assets', async t => {
    const { repo, desk, editor } = await fixture(t, 'file.txt', combinations.UU, { working: 'chosen\n' });
    stages(repo, 'other.txt'); await write(repo, 'other.txt', conflictText);
    await write(repo, 'staged.txt', 'already staged\n'); git(repo, 'add', '--', 'staged.txt');
    await write(repo, 'staged.txt', 'later work\n'); await write(repo, 'file.txt.meta', 'dirty meta\n'); await write(repo, 'new.asset', 'untracked\n');
    const other = gitBytes(repo, ['ls-files', '--stage', '-z', '--', 'other.txt', 'staged.txt', 'file.txt.meta']);
    await resolve(desk);
    assert.deepEqual(gitBytes(repo, ['ls-files', '--stage', '-z', '--', 'other.txt', 'staged.txt', 'file.txt.meta']), other);
    assert.equal(await fs.readFile(path.join(repo, 'other.txt'), 'utf8'), conflictText);
    assert.equal(await fs.readFile(path.join(repo, 'staged.txt'), 'utf8'), 'later work\n');
    assert.equal(await fs.readFile(path.join(repo, 'file.txt.meta'), 'utf8'), 'dirty meta\n');
    assert.equal(await fs.readFile(path.join(repo, 'new.asset'), 'utf8'), 'untracked\n'); noWorktreeHooks(editor);
});

test('literal Unicode whitespace wildcard and option-like paths resolve only their selected path', { skip: exoticNames }, async t => {
    for (const name of ['assets/中文 [x]*?.txt', 'line\nbreak\tname.txt', '--ours.txt', ':(glob)literal.txt']) {
        const { repo, desk } = await fixture(t, name, combinations.UU, { working: 'literal resolution\n' });
        const current = await view(desk, name); assert.equal(current.path, name);
        await resolve(desk, name);
        assert.equal(git(repo, 'ls-files', '-u', '--', name), '');
        const staged = git(repo, 'ls-files', '--stage', '-z', '--', name).split(' ')[1];
        assert.deepEqual(gitBytes(repo, ['cat-file', 'blob', staged]), Buffer.from('literal resolution\n'));
        assert.equal(await fs.readFile(path.join(repo, name), 'utf8'), 'literal resolution\n');
    }
});

test('remaining regular diff3 and configured-width conflict markers cannot be marked resolved', async t => {
    for (const content of [conflictText, '||||||| base\nbase\n', '=======\n', '>>>>>>> theirs\n', '<<<<<<<<<<<< ours\nours\n============\ntheirs\n>>>>>>>>>>>> theirs\n']) {
        const { repo, desk } = await fixture(t, 'file.txt', combinations.UU, { working: content });
        if (content.startsWith('<<<<<<<<<<<<')) await write(repo, '.gitattributes', 'file.txt conflict-marker-size=12\n');
        const before = await preserved(repo); await blocked(desk); assert.deepEqual(await preserved(repo), before);
    }
});

test('a conflict view becomes stale when saved contents change before preparing its resolution', async t => {
    const { repo, desk } = await fixture(t, 'file.txt', combinations.UU, { working: 'first choice\n' });
    const current = await view(desk); await write(repo, 'file.txt', 'second choice\n');
    const before = await preserved(repo);
    await assert.rejects(desk.prepare(await request(desk, 'file.txt', 'content', current)));
    assert.deepEqual(await preserved(repo), before);
});

test('editing deleting or replacing a file with a symlink after preview invalidates the operation', async t => {
    for (const change of ['edit', 'delete', 'symlink']) {
        const { repo, base, desk } = await fixture(t, 'file.txt', combinations.UU, { working: 'confirmed\n' });
        const preview = await desk.prepare(await request(desk));
        const outside = path.join(base, 'outside.txt'); await fs.writeFile(outside, 'outside\n');
        if (change === 'edit') await write(repo, 'file.txt', 'newer saved content\n');
        else { await fs.unlink(path.join(repo, 'file.txt')); if (change === 'symlink') await fs.symlink(outside, path.join(repo, 'file.txt')); }
        const before = await preserved(repo), result = await finish(desk, preview);
        assert.equal(result.status, 'failed'); assert.deepEqual(await preserved(repo), before);
        assert.equal(await fs.readFile(outside, 'utf8'), 'outside\n');
    }
});

test('changing conflict stages or unrelated staged content after preview cannot apply an old resolution', async t => {
    for (const change of ['stage', 'unrelated']) {
        const { repo, desk } = await fixture(t, 'file.txt', combinations.UU, { working: 'confirmed\n' });
        const preview = await desk.prepare(await request(desk));
        if (change === 'stage') stages(repo, 'file.txt', combinations.UU, { contents: { 3: 'new incoming\n' } });
        else { await write(repo, 'staged.txt', 'new staged version\n'); git(repo, 'add', '--', 'staged.txt'); }
        const before = await preserved(repo), result = await finish(desk, preview);
        assert.equal(result.status, 'failed'); assert.deepEqual(await preserved(repo), before);
    }
});

test('changing merge or rebase operation metadata after preview invalidates the operation without continuing it', async t => {
    for (const kind of ['merge', 'rebase']) {
        const { repo, desk, gitDir, initial } = await fixture(t, 'file.txt', combinations.UU, { working: 'resolved\n' });
        const filename = kind === 'merge' ? path.join(gitDir, 'MERGE_MSG') : path.join(gitDir, 'rebase-merge', 'git-rebase-todo');
        if (kind === 'merge') await fs.writeFile(path.join(gitDir, 'MERGE_HEAD'), initial + '\n');
        else { await fs.mkdir(path.join(gitDir, 'rebase-merge')); await fs.writeFile(path.join(gitDir, 'rebase-merge', 'head-name'), 'refs/heads/dev\n'); await fs.writeFile(path.join(gitDir, 'rebase-merge', 'onto'), initial + '\n'); }
        await fs.writeFile(filename, kind === 'merge' ? 'first merge message\n' : `pick ${initial} original\n`);
        const preview = await desk.prepare(await request(desk));
        const changed = kind === 'merge' ? 'revised merge message\n' : `edit ${initial} revised\n`;
        await fs.writeFile(filename, changed);
        const before = await preserved(repo), result = await finish(desk, preview);
        assert.equal(result.status, 'failed'); assert.deepEqual(await preserved(repo), before);
        assert.equal(await fs.readFile(filename, 'utf8'), changed);
    }
});

test('changes to attributes and conversion configuration after preview cannot silently transform confirmed content', async t => {
    for (const change of ['info-attributes', 'working-attributes', 'config']) {
        const { repo, desk, gitDir } = await fixture(t, 'file.txt', combinations.UU, { working: 'confirmed\r\n' });
        const preview = await desk.prepare(await request(desk));
        if (change === 'config') git(repo, 'config', 'core.autocrlf', 'true');
        else if (change === 'info-attributes') await fs.writeFile(path.join(gitDir, 'info', 'attributes'), 'file.txt text eol=lf\n');
        else await write(repo, '.gitattributes', 'file.txt text eol=lf\n');
        const before = await preserved(repo), result = await finish(desk, preview);
        assert.equal(result.status, 'failed'); assert.deepEqual(await preserved(repo), before);
    }
});

test('unsaved editor content rejects preparation and a new unsaved edit also blocks execution', async t => {
    const { repo, desk, editor } = await fixture(t, 'file.txt', combinations.UU, { working: 'saved\n' });
    editor.dirty = true; const before = await preserved(repo);
    await assert.rejects(desk.prepare(await request(desk)), /unsaved scene/);
    assert.deepEqual(await preserved(repo), before);
    editor.dirty = false; const preview = await desk.prepare(await request(desk));
    editor.dirty = true; const result = await finish(desk, preview);
    assert.equal(result.status, 'failed'); assert.match(result.log, /unsaved scene/);
    assert.deepEqual(await preserved(repo), before); noWorktreeHooks(editor);
});

test('ordinary staging unstaging and commit actions cannot bypass the dedicated conflict decision', async t => {
    const { repo, desk } = await fixture(t, 'file.txt', combinations.UU, { working: 'resolved\n' });
    await write(repo, 'staged.txt', 'pending\n'); git(repo, 'add', '--', 'staged.txt');
    const before = await preserved(repo), snapshot = await desk.snapshot(true);
    for (const action of ['stage', 'unstage', 'stageLines', 'unstageLines', 'commit']) {
        await assert.rejects(desk.prepare({ repo: '.', version: snapshot.repositories[0].version, action, paths: ['file.txt'], message: 'must not commit', lines: { path: 'file.txt', version: 'invalid', ids: ['0:0'] } }));
    }
    assert.deepEqual(await preserved(repo), before);
});

test('resolving during merge cherry-pick revert and rebase leaves operation metadata and HEAD in place', async t => {
    for (const operation of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
        const { repo, desk, gitDir, initial } = await fixture(t, 'file.txt', combinations.UU, { working: 'manually merged\n' });
        let stateFile = path.join(gitDir, operation);
        if (operation.startsWith('rebase-')) {
            await fs.mkdir(stateFile); await fs.writeFile(path.join(stateFile, 'head-name'), 'refs/heads/dev\n');
            await fs.writeFile(path.join(stateFile, 'onto'), initial + '\n'); stateFile = path.join(stateFile, 'orig-head');
        }
        await fs.writeFile(stateFile, initial + '\n');
        assert.ok((await view(desk)).operation);
        await resolve(desk);
        assert.equal(await fs.readFile(stateFile, 'utf8'), initial + '\n'); assert.equal(git(repo, 'rev-parse', 'HEAD'), initial);
    }
});

test('an ordinary merge conflict can be resolved without committing or finishing the merge', async t => {
    const { repo, desk, gitDir, initial } = await fixture(t);
    git(repo, 'read-tree', 'HEAD'); await write(repo, 'file.txt', 'base\n');
    git(repo, 'switch', '-c', 'incoming'); await write(repo, 'file.txt', 'incoming\n'); git(repo, 'add', '--', 'file.txt'); git(repo, 'commit', '-m', 'incoming');
    git(repo, 'switch', 'dev'); await write(repo, 'file.txt', 'local\n'); git(repo, 'add', '--', 'file.txt'); git(repo, 'commit', '-m', 'local');
    assert.throws(() => git(repo, 'merge', '--no-edit', 'incoming'), error => error.status === 1);
    const mergeHead = await fs.readFile(path.join(gitDir, 'MERGE_HEAD')), head = git(repo, 'rev-parse', 'HEAD');
    assert.notEqual(head, initial); assert.equal((await view(desk)).status, 'UU');
    await write(repo, 'file.txt', 'local and incoming\n'); await resolve(desk);
    assert.deepEqual(await fs.readFile(path.join(gitDir, 'MERGE_HEAD')), mergeHead);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head); assert.equal(git(repo, 'ls-files', '-u'), '');
});

test('LFS pointers binary and invalid UTF-8 contents remain inspectable but cannot be resolved here', async t => {
    const unsupported = [Buffer.from('binary\0data'), Buffer.from([0xff, 0xfe, 0x61]), 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 12\n'];
    for (const content of unsupported) for (const location of ['stage', 'working']) {
        const { repo, desk } = await fixture(t, 'file.txt', combinations.UU, { contents: location === 'stage' ? { 3: content } : undefined, working: location === 'working' ? content : 'resolved\n' });
        const before = await preserved(repo), current = await blocked(desk);
        assert.ok(location === 'stage' ? current.stages.find(entry => entry.stage === 3).content.notice : current.working.notice);
        assert.deepEqual(await preserved(repo), before);
    }
});

test('oversized and excessive-line conflicts are blocked for either saved or staged content', async t => {
    for (const content of ['x'.repeat(5 * 1024 * 1024 + 1), 'line\n'.repeat(15001)]) for (const location of ['stage', 'working']) {
        const { repo, desk } = await fixture(t, 'file.txt', combinations.UU, { contents: location === 'stage' ? { 2: content } : undefined, working: location === 'working' ? content : 'resolved\n' });
        const before = await preserved(repo); await blocked(desk); assert.deepEqual(await preserved(repo), before);
    }
});

test('symlink submodule mode-change and directory conflicts cannot be resolved as ordinary text', async t => {
    for (const kind of ['symlink-stage', 'symlink-working', 'submodule', 'mode-change', 'directory']) {
        const { repo, base, desk, initial } = await fixture(t, 'file.txt', combinations.UU, { working: 'resolved\n' });
        if (kind === 'symlink-stage') stages(repo, 'file.txt', combinations.UU, { mode: '120000', contents: { 1: 'target', 2: 'ours', 3: 'theirs' } });
        else if (kind === 'submodule') { stages(repo, 'file.txt', combinations.UU, { mode: '160000', object: initial }); await fs.unlink(path.join(repo, 'file.txt')); await fs.mkdir(path.join(repo, 'file.txt')); }
        else if (kind === 'mode-change') {
            const chosen = object(repo, 'theirs\n'); gitBytes(repo, ['update-index', '-z', '--index-info'], `100755 ${chosen} 3\tfile.txt\0`);
        } else {
            await fs.unlink(path.join(repo, 'file.txt'));
            if (kind === 'directory') { await fs.mkdir(path.join(repo, 'file.txt')); await write(repo, 'file.txt/child.txt', 'keep child\n'); }
            else { const target = path.join(base, 'target.txt'); await fs.writeFile(target, 'outside\n'); await fs.symlink(target, path.join(repo, 'file.txt')); }
        }
        const index = await fs.readFile(path.join(git(repo, 'rev-parse', '--absolute-git-dir'), 'index'));
        await blocked(desk); assert.deepEqual(await fs.readFile(path.join(git(repo, 'rev-parse', '--absolute-git-dir'), 'index')), index);
        if (kind === 'directory') assert.equal(await fs.readFile(path.join(repo, 'file.txt/child.txt'), 'utf8'), 'keep child\n');
    }
});

test('custom conversion and diff attributes are refused without executing an external filter', async t => {
    for (const attribute of ['filter=desk', 'working-tree-encoding=UTF-16', 'ident', 'diff=desk', 'merge=desk']) {
        const { repo, desk } = await fixture(t, 'file.txt', combinations.UU, { working: 'resolved\n' });
        await write(repo, '.gitattributes', 'file.txt ' + attribute + '\n');
        git(repo, 'config', 'filter.desk.clean', 'echo invoked > filter-invoked; cat'); git(repo, 'config', 'filter.desk.required', 'true');
        git(repo, 'config', 'diff.desk.textconv', 'echo invoked > diff-invoked');
        const before = await preserved(repo); await blocked(desk); assert.deepEqual(await preserved(repo), before);
        await assert.rejects(fs.stat(path.join(repo, 'filter-invoked')), { code: 'ENOENT' });
        await assert.rejects(fs.stat(path.join(repo, 'diff-invoked')), { code: 'ENOENT' });
    }
});

test('invalid paths missing conflicts unsupported operations and malformed resolutions cannot create a plan', async t => {
    const { repo, desk, gitDir } = await fixture(t, 'file.txt', combinations.UU, { working: 'resolved\n' });
    const good = await request(desk), before = await preserved(repo);
    for (const resolution of [undefined, {}, { ...good.resolution, path: '../outside.txt' }, { ...good.resolution, path: '.git/index' }, { ...good.resolution, path: 'staged.txt' }, { ...good.resolution, path: 'file.txt\0more' }, { ...good.resolution, mode: 'ours' }, { ...good.resolution, version: '' }]) {
        await assert.rejects(desk.prepare({ ...good, resolution }));
    }
    assert.deepEqual(await preserved(repo), before);
    await fs.writeFile(path.join(gitDir, 'BISECT_LOG'), 'git bisect start\n');
    await assert.rejects(desk.prepare(await request(desk)));
    assert.deepEqual(await preserved(repo), before);
});

test('mutating the input resolution or public preview cannot redirect a confirmed single-path operation', async t => {
    const { repo, desk } = await fixture(t, 'file.txt', combinations.UU, { working: 'confirmed\n' });
    stages(repo, 'other.txt'); await write(repo, 'other.txt', 'other resolved\n');
    const other = gitBytes(repo, ['ls-files', '--stage', '-z', '--', 'other.txt']);
    const input = await request(desk), preview = await desk.prepare(input);
    input.resolution.path = 'other.txt'; input.resolution.mode = 'delete'; input.resolution.version = 'changed';
    input.action = 'stage'; input.paths = ['staged.txt']; preview.paths.splice(0, preview.paths.length, 'other.txt'); preview.title = 'mutated'; preview.warnings.push('mutated');
    const result = await finish(desk, preview);
    assert.equal(result.status, 'success', result.log);
    assert.equal(git(repo, 'ls-files', '-u', '--', 'file.txt'), '');
    assert.deepEqual(gitBytes(repo, ['ls-files', '--stage', '-z', '--', 'other.txt']), other);
    assert.equal(await fs.readFile(path.join(repo, 'file.txt'), 'utf8'), 'confirmed\n');
    assert.equal(await fs.readFile(path.join(repo, 'other.txt'), 'utf8'), 'other resolved\n');
});
