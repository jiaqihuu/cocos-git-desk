"""Git Desk adapter for the existing Fork fast-forward workflow."""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import subprocess
import signal
import sys
import tempfile
import time
sys.path.insert(0, str(Path(__file__).resolve().parent))
import update_all_current_branches as pipeline
from update_all_current_branches import Msg, Join

pipeline.MESSAGES.update({
    'outputLimit': 'A Git query timed out or produced more than 8 MiB of output',
    'outputLimitAction': 'Check the log and the actual state; nothing is retried automatically.',
    'outputTooLarge': 'Git produced more than 8 MiB of output',
    'outputTooLargeAction': 'Narrow the repository operation and retry.',
    'pathThroughSymlink': 'A changed path goes through a symbolic link',
    'pathThroughSymlinkAction': 'Check the path first to avoid reading or writing across directories.',
    'changesTooLarge': 'The changes to protect exceed 100 MiB',
    'changesTooLargeAction': 'Save or commit the large changes separately first.',
    'fileGrew': 'A file grew while it was being read',
    'fileChanged': 'A file changed while it was being read',
    'repreviewAction': 'Preview again before updating.',
    'stateChanged': 'Repository {repo}: local state changed {when} ({checks})',
    'stateChangedAction': 'Save the edits you want to keep, wait for other Git operations to finish, then click "Reread and preview" and confirm the new preview; do not retry the old plan.',
    'when.afterPreview': 'after the preview',
    'when.waiting': 'while waiting',
    'when.fetching': 'while fetching',
    'check.commit': 'commit',
    'check.branch': 'branch',
    'check.indexEntries': 'index entries',
    'check.indexFlags': 'index flags',
    'check.config': 'Git config',
    'check.refs': 'local branches or stash',
    'check.worktree': 'working tree status',
    'check.operations': 'unfinished Git operations',
    'check.content': 'file contents',
    'scopeChanged': 'The project repository list changed after the preview',
    'scopeChangedAction': 'Click "Reread and preview" and confirm the repository list; repositories are never added automatically.',
    'previewUnreadable': 'This repository could not be read during the preview',
    'result.fastForward': 'Fast-forwarded',
    'result.upToDate': 'Already up to date',
    'result.ahead': 'Local is ahead; nothing rolled back',
    'result.attach': 'Attached to the branch',
    'result.attachFastForward': 'Attached and fast-forwarded',
})

OUTPUT_LIMIT = 8 * 1024 * 1024
MAX_REPOS = 200
ACTIVE = None


def stop_child(child):
    if child and child.poll() is None:
        try:
            if os.name == 'posix':
                os.killpg(child.pid, signal.SIGKILL)
            else:
                child.kill()
        except ProcessLookupError:
            pass
        child.wait()


def terminate(signum, frame):
    stop_child(ACTIVE)
    raise SystemExit(128 + signum)


def bounded_run(args, **options):
    global ACTIVE
    # Git can emit large diffs or authentication errors; keep capture off the heap.
    args = [os.environ.get('GIT_DESK_GIT', 'git'), *args[1:]]
    with tempfile.TemporaryFile(dir=os.environ['GIT_DESK_TEMP']) as out, tempfile.TemporaryFile(dir=os.environ['GIT_DESK_TEMP']) as err:
        child = subprocess.Popen(args, stdout=out, stderr=err, stdin=subprocess.DEVNULL, start_new_session=os.name == 'posix')
        ACTIVE = child
        started = time.monotonic()
        try:
            while child.poll() is None:
                if time.monotonic() - started > 180 or os.fstat(out.fileno()).st_size + os.fstat(err.fileno()).st_size > OUTPUT_LIMIT:
                    raise pipeline.PipelineError(Msg('outputLimit'), Msg('outputLimitAction'))
                try:
                    child.wait(timeout=0.05)
                except subprocess.TimeoutExpired:
                    continue
            if os.fstat(out.fileno()).st_size + os.fstat(err.fileno()).st_size > OUTPUT_LIMIT:
                raise pipeline.PipelineError(Msg('outputTooLarge'), Msg('outputTooLargeAction'))
            out.seek(0); err.seek(0)
            return subprocess.CompletedProcess(args, child.returncode, out.read(), err.read())
        finally:
            stop_child(child)
            ACTIVE = None


def emit(kind, **data):
    # `message` is the structured form of `detail` that Git Desk localizes; `detail` stays English.
    if isinstance(data.get('detail'), (Msg, Join)):
        data['message'] = pipeline.to_json(data['detail'])
        data['codes'] = pipeline.codes(data['detail'])
    for key in ['detail', 'phase', 'branch']:
        if key in data:
            data[key] = str(data[key])[:1000 if key == 'detail' else 200]
    sys.__stdout__.write(json.dumps({'kind': kind, **data}, ensure_ascii=True) + '\n')
    sys.__stdout__.flush()


class StateChangedError(pipeline.PipelineError):
    pass


def fingerprint(repo):
    checks = {}
    for label, args in [('commit', ('rev-parse', 'HEAD')), ('branch', ('symbolic-ref', '--quiet', '--short', 'HEAD')),
                        ('indexEntries', ('ls-files', '--stage', '-z')), ('indexFlags', ('ls-files', '-v', '-z')),
                        ('config', ('config', '--null', '--list', '--show-origin')),
                        ('refs', ('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/stash')),
                        ('worktree', ('status', '--porcelain=v1', '-z', '--untracked-files=all'))]:
        data = pipeline.git(repo.path, *args, allowed=(0, 1))
        checks[label] = hashlib.sha256(data).hexdigest()
    operations = []
    for name in ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG']:
        location = Path(os.fsdecode(pipeline.git(repo.path, 'rev-parse', '--git-path', name)).strip())
        if not location.is_absolute():
            location = repo.path / location
        if location.exists():
            operations.append(name)
    checks['operations'] = hashlib.sha256(json.dumps(operations).encode()).hexdigest()
    digest = hashlib.sha256()
    total = 0
    for name in sorted(pipeline.dirty_paths(repo.path)):
        digest.update(name)
        filename = repo.path / os.fsdecode(name)
        if filename.parent.resolve() != filename.parent:
            raise pipeline.PipelineError(Msg('pathThroughSymlink'), Msg('pathThroughSymlinkAction'))
        if filename.is_symlink():
            digest.update(os.fsencode(os.readlink(filename)))
        elif filename.is_file():
            stat = filename.stat(); total += stat.st_size
            if total > 100 * 1024 * 1024:
                raise pipeline.PipelineError(Msg('changesTooLarge'), Msg('changesTooLargeAction'))
            digest.update(str(stat.st_mode).encode())
            read_bytes = 0
            with filename.open('rb') as stream:
                for chunk in iter(lambda: stream.read(65536), b''):
                    read_bytes += len(chunk)
                    if read_bytes > stat.st_size:
                        raise pipeline.PipelineError(Msg('fileGrew'), Msg('repreviewAction'))
                    digest.update(chunk)
            after = filename.stat()
            if (stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_mode) != (after.st_ino, after.st_size, after.st_mtime_ns, after.st_mode):
                raise pipeline.PipelineError(Msg('fileChanged'), Msg('repreviewAction'))
        else:
            digest.update(b'directory-or-missing')
    checks['content'] = digest.hexdigest()
    return {'state': hashlib.sha256(json.dumps(checks, sort_keys=True).encode()).hexdigest(), 'checks': checks}


def assert_unchanged(repo, entry, when):
    current = fingerprint(repo)
    if current['state'] == entry['state']:
        return
    changed = [Msg('check.' + name) for name, value in current['checks'].items() if entry.get('checks', {}).get(name) != value]
    raise StateChangedError(Msg('stateChanged', repo=repo.relative, when=Msg('when.' + when), checks=Join('list', changed)),
                            Msg('stateChangedAction'))


def discovery(root):
    repos, missing = pipeline.discover(root)
    if len(repos) + len(missing) > MAX_REPOS:
        raise pipeline.PipelineError(Msg('tooManyRepos'), Msg('splitProjectPlease'))
    return repos, missing


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', required=True)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, terminate)
    pipeline.subprocess.run = bounded_run
    root = Path(args.repo).resolve()
    repos, missing = discovery(root)
    if not args.execute:
        entries = []
        for repo in repos:
            try:
                state = fingerprint(repo)
                branch = pipeline.decoded(pipeline.git(repo.path, 'symbolic-ref', '--quiet', '--short', 'HEAD', allowed=(0, 1)))
                entries.append({'id': repo.relative, **state, 'branch': branch, 'detail': ''})
            except pipeline.PipelineError as error:
                entries.append({'id': repo.relative, 'state': '', 'branch': '', 'detail': str(error)[:1000], 'message': error.message().json(), 'codes': [error.code]})
        entries.extend({'id': name, 'state': '', 'branch': '', 'detail': str(issue)[:1000], 'message': issue.json(), 'codes': pipeline.codes(issue)} for name, issue in missing)
        emit('preview', root=str(root), entries=entries)
        return 0
    expected = json.loads(sys.stdin.read(1024 * 1024))
    entries = expected['entries']
    current_ids = [repo.relative for repo in repos] + [name for name, _ in missing]
    if expected['root'] != str(root) or current_ids != [entry['id'] for entry in entries]:
        raise StateChangedError(Msg('scopeChanged'), Msg('scopeChangedAction'))
    by_id = {entry['id']: entry for entry in entries}
    for repo in repos:
        entry = by_id[repo.relative]
        if entry['state']:
            assert_unchanged(repo, entry, 'afterPreview')
    failed = False
    for name, issue in missing:
        emit('progress', id=name, status='skipped', phase='uninitialized', detail=issue)
    for repo in repos:
        entry = by_id[repo.relative]
        try:
            if not entry['state']:
                raise pipeline.PipelineError(Msg('previewUnreadable'), entry['detail'])
            emit('progress', id=repo.relative, status='running', phase='fetchCheck', detail='')
            assert_unchanged(repo, entry, 'waiting')
            pipeline.select_branches([repo], {}, {})
            pipeline.fetch_targets([repo])
            pipeline.plan_updates([repo])
            if repo.skip_reason:
                emit('progress', id=repo.relative, status='skipped' if repo.skip_no_remote else 'failed', phase='notUpdated', detail=repo.skip_reason, branch=repo.branch)
                failed = failed or not repo.skip_no_remote
                continue
            assert_unchanged(repo, entry, 'fetching')
            emit('progress', id=repo.relative, status='running', phase='stashFastForward' if repo.stash_paths else 'fastForward', detail=f'{repo.branch} → {repo.remote}/{repo.remote_branch}', branch=repo.branch)
            pipeline.apply_one(repo)
            head = pipeline.decoded(pipeline.git(repo.path, 'rev-parse', 'HEAD'))
            results = {'fast-forward': 'fastForward', 'up to date': 'upToDate', 'already ahead of upstream': 'ahead', 'attach branch': 'attach', 'attach and fast-forward': 'attachFastForward'}
            emit('progress', id=repo.relative, status='success', phase='done', detail=Msg('result.' + results[repo.action]) if repo.action in results else repo.action, branch=repo.branch, head=head)
        except (pipeline.PipelineError, OSError) as error:
            print(str(error), file=sys.stderr, flush=True)
            failed = True
            emit('progress', id=repo.relative, status='failed', phase='unfinished', detail=error.message() if isinstance(error, pipeline.PipelineError) else str(error))
    return 2 if failed else 0


if __name__ == '__main__':
    try:
        with contextlib.redirect_stdout(sys.stderr):
            result = main()
    except Exception as error:
        emit('error', detail=error.message() if isinstance(error, pipeline.PipelineError) else str(error), code='PROJECT_UPDATE_STATE_CHANGED' if isinstance(error, StateChangedError) else '')
        result = 1
    sys.exit(result)
