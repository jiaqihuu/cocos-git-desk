#!/usr/bin/env python3
"""Fast-forward a repository and its initialized submodules, preserving local work.

Repositories are handled independently. Overlapping changes are stashed by
path, then restored with their staged state after a successful fast-forward.
History divergence and unsafe conflicts are reported without discarding work.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Union


# Messages are structured so Git Desk can localize them (ids map to `misc.update.<id>` in its
# message tables); this script itself only renders English, for the command line and the log.
MESSAGES = {
    "error": "Reason: {reason}\n  Action: {action}",
    "errorWithDetail": "Reason: {reason}\n  Action: {action}\n  Git details: {detail}",
    "reasonAndDetail": "{reason}; {detail}",
    "listSeparator": ", ",
    "exitCode": "exit code {code}",
    "gitFailed": "{repo}: Git command failed (git {args})",
    "gitFailedAction": "Check the Git details and git status of this repository, fix the problem and run again.",
    "ancestryFailed": "{repo}: cannot tell which of the two commits comes first",
    "ancestryAction": "Make sure the commits still exist and the repository is not damaged, then run again.",
    "remoteQueryFailed": "{repo}: cannot query the remote branch {remote}/{branch}",
    "checkNetworkRetry": "Check the network connection, remote URL and access rights, then retry.",
    "noBranches": "{repo}: there is no local or remote branch to switch to",
    "noBranchesAction": "Make sure a remote is configured and reachable, or name the target with --branch path=branch.",
    "ambiguousLatest": "{repo}: several branches share the newest commit time ({choices}); cannot choose automatically",
    "ambiguousLatestAction": "Decide on the target branch, then run again with --branch {repo}=branch.",
    "invalidRepoPath": "Invalid repository path: {path}",
    "invalidRepoPathAction": "Use --repo with a path inside an existing Git repository.",
    "submoduleInvalid": "The submodule path is invalid or duplicated",
    "checkGitmodulesPath": "Check the path settings in .gitmodules.",
    "tooManyRepos": "The project has more than 200 repositories",
    "splitProject": "Split the project before running this.",
    "splitProjectPlease": "Please split the project before running this.",
    "submoduleUninitialized": "The submodule is not initialized or cannot be read",
    "submoduleUninitializedAction": "Check the path and Git state in its parent repository, then initialize the submodule.",
    "rootMismatch": "The repository root differs from {root}",
    "rootMismatchAction": "Check the repository path given to --repo.",
    "submoduleElsewhere": "The submodule path points to another repository or is not initialized",
    "submoduleElsewhereAction": "Check .gitmodules and the Git state in its parent repository, then initialize the submodule.",
    "submoduleOutside": "The submodule path lies outside the main repository",
    "badAssignment": "Malformed {option} argument: {value}",
    "badAssignmentAction": "Use {option} path=value; the main repository path is written as .",
    "duplicateAssignment": "The {option} argument repeats a path or has an empty value: {value}",
    "duplicateAssignmentAction": "Give each repository once, with a non-empty value.",
    "unknownPaths": "Repository paths in the arguments were not found: {paths}",
    "unknownPathsAction": "Use paths relative to the main repository; the main repository is ., and submodule paths are listed in .gitmodules.",
    "branchMismatch": "{repo}: already on branch {attached}, but --branch asks for {configured}",
    "branchMismatchAction": "Remove that --branch argument; to switch branches, check the working tree and switch yourself first.",
    "refreshFailed": "{repo}: refreshing remote branches failed; no target branch was chosen",
    "localRefMissing": "{repo}: the local ref of the current branch {branch} does not exist",
    "localRefMissingAction": "Check git status and git branch, repair the repository refs, then retry.",
    "branchInOtherWorktree": "{repo}: the target branch {branch} is checked out in another worktree: {holder}",
    "branchInOtherWorktreeAction": "Switch that worktree to another branch first, or update from that worktree.",
    "badUpstream": "{repo}: malformed --upstream: {value}",
    "badUpstreamAction": "Use --upstream {repo}=remote:branch.",
    "invalidUpstream": "{repo}: the upstream {value} is invalid or the remote does not exist",
    "invalidUpstreamAction": "Run git remote -v to check the remote name, confirm the branch name and retry.",
    "upstreamIncomplete": "{repo}: the upstream configuration of branch {branch} is incomplete or unsupported",
    "upstreamIncompleteAction": "Check git branch -vv, or name it explicitly with --upstream {repo}=remote:branch.",
    "noRemoteBranch": "The remote has no branch {branch}; pull skipped, the current branch and local changes are kept.",
    "ambiguousUpstream": "{repo}: cannot pick a single upstream remote for {branch} (matches: {found})",
    "ambiguousUpstreamAction": "Confirm the remote branch, then name it with --upstream {repo}=remote:branch.",
    "upstreamUnavailable": "{repo}: the upstream remote {remote} is unavailable",
    "upstreamUnavailableAction": "Run git remote -v to check the remotes; fix the tracking configuration or name a usable remote with --upstream.",
    "unmergedIndex": "The index has unresolved conflicts",
    "unmergedIndexAction": "Run git status, resolve the conflicts and finish the current Git operation, then retry.",
    "operationInProgress": "A Git operation is in progress ({operation})",
    "operationInProgressAction": "Run git status, finish or abort that operation, then retry.",
    "remoteBranchMissing": "The remote branch {remote}/{branch} was not found",
    "remoteBranchMissingAction": "Make sure the remote branch still exists; if needed, name the right branch with --upstream.",
    "fetchFailed": "Cannot fetch {remote}/{branch}",
    "fetchFailedAction": "Check the network connection, remote URL and access rights, and make sure the branch still exists.",
    "diverged": "Local {branch} and {remote}/{remoteBranch} have diverged; cannot fast-forward",
    "divergedAction": "Review the commits on both sides and choose merge or rebase first; this command never rewrites history.",
    "detachedUnreferenced": "The current detached commit {head} is not kept by any branch or tag",
    "detachedUnreferencedAction": "Create a branch to keep that commit first, then name the branch to switch to with --branch {repo}=target.",
    "gitmodulesChanged": "The target branch changes .gitmodules; the submodule layout may change",
    "gitmodulesChangedAction": "Handle .gitmodules and the submodule layout of the main repository separately, then run the update again.",
    "submodulePointerConflict": "Staged submodule pointers conflict with the update and cannot be stashed safely: {paths}",
    "submodulePointerConflictAction": "Check who owns these submodule pointer changes and resolve them manually in this repository, then retry.",
    "indexChanged": "The staged contents changed: {path}",
    "indexChangedAction": "Run git status in that repository to check the staged changes; confirm who owns them, then run again.",
    "stashNotDropped": "The update and the restore of local changes finished, but the temporary stash could not be dropped automatically",
    "stashNotDroppedAction": "Check git status and git stash list first; once everything is in place, drop stash {stash} manually.",
    "headChanged": "HEAD changed after the checks; the update stopped",
    "headChangedAction": "Check the current branch and commit, then run the command again.",
    "worktreeChanged": "Working tree changes differ from the checks; the update stopped",
    "worktreeChangedAction": "Check git status, then run the command again.",
    "stashFailed": "Cannot create a temporary stash for the conflicting paths",
    "stashFailedAction": "Check git status and git stash list and make sure the local changes are still there, then retry.",
    "stashConflict": "Unresolved conflicts remain after restoring the temporary stash",
    "stashConflictAction": "Run git status to see the conflicting files, resolve them manually and check the index; the kept stash is shown below.",
    "stillDetached": "The repository is still on a detached HEAD after switching",
    "stillDetachedAction": "Run git status and git branch -vv to check the current commit and the target branch, then handle it manually.",
    "actionWithStash": "{action} The temporary stash {stash} is kept; check git stash list and do not delete it before the changes are restored.",
}
SEPARATORS = {"lines": "\n  "}
Node = Union["Msg", "Join", str]


class Msg:
    """A message id with parameters; `json()` is what Git Desk localizes, `str()` is English."""

    def __init__(self, id: str, **params: object) -> None:
        self.id = id
        self.params = params
        self.code = ""

    def json(self) -> dict:
        return {"id": self.id, "params": {key: to_json(value) for key, value in self.params.items()}}

    def __str__(self) -> str:
        return render(self)


class Join:
    """Messages joined by a separator (`lines`) or by the localized list separator (`list`)."""

    def __init__(self, separator: str, items: list) -> None:
        self.separator = separator
        self.items = list(items)

    def __str__(self) -> str:
        return render(self)


def to_json(node: object) -> object:
    # Plain values are often raw Git output; bound each one like the English `detail` line.
    if isinstance(node, Msg):
        return node.json()
    if isinstance(node, Join):
        return {"join": node.separator, "items": [to_json(item) for item in node.items]}
    return str(node)[:1000]


def render(node: object) -> str:
    if isinstance(node, Msg):
        return MESSAGES[node.id].format(**{key: render(value) for key, value in node.params.items()})
    if isinstance(node, Join):
        separator = SEPARATORS.get(node.separator, MESSAGES["listSeparator"])
        return separator.join(render(item) for item in node.items)
    return str(node)


def codes(node: object) -> list:
    """Error codes inside a message, for Git Desk to choose follow-up guidance without parsing text."""
    if isinstance(node, Msg):
        return [node.code] if node.code else []
    if isinstance(node, Join):
        return [code for item in node.items for code in codes(item)]
    return []


class PipelineError(Exception):
    def __init__(self, reason: Msg, action: Node, detail: Node = "", code: str = "") -> None:
        super().__init__(render(reason))
        self.reason = reason
        self.action = action
        self.detail = detail
        self.code = code or reason.id

    def message(self) -> Msg:
        if self.detail:
            result = Msg("errorWithDetail", reason=self.reason, action=self.action, detail=self.detail)
        else:
            result = Msg("error", reason=self.reason, action=self.action)
        result.code = self.code
        return result

    def __str__(self) -> str:
        return render(self.message())


def git(repo: Path, *args: str, allowed: tuple[int, ...] = (0,)) -> bytes:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode not in allowed:
        detail = result.stderr.decode("utf-8", "replace").strip()
        raise PipelineError(
            Msg("gitFailed", repo=repo, args=" ".join(args)),
            Msg("gitFailedAction"),
            detail or Msg("exitCode", code=result.returncode),
        )
    return result.stdout


def decoded(data: bytes) -> str:
    return os.fsdecode(data).strip()


def split_z(data: bytes) -> set[bytes]:
    return set(filter(None, data.split(b"\0")))


def ref_sha(repo: Path, ref: str) -> Optional[str]:
    value = decoded(git(repo, "rev-parse", "--verify", "--quiet", ref, allowed=(0, 1)))
    return value or None


def is_ancestor(repo: Path, older: str, newer: str) -> bool:
    result = subprocess.run(
        ["git", "-C", str(repo), "merge-base", "--is-ancestor", older, newer],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode not in (0, 1):
        raise PipelineError(
            Msg("ancestryFailed", repo=repo),
            Msg("ancestryAction"),
            decoded(result.stderr),
        )
    return result.returncode == 0


def git_config(repo: Path, key: str, config_file: Optional[Path] = None) -> Optional[str]:
    args = ["config"]
    if config_file is not None:
        args.extend(["--file", str(config_file)])
    args.extend(["--get", key])
    value = decoded(git(repo, *args, allowed=(0, 1)))
    return value or None


def refs(repo: Path, namespace: str) -> dict[str, str]:
    output = decoded(git(repo, "for-each-ref", "--format=%(refname) %(objectname)", namespace))
    return dict(line.split(" ", 1) for line in output.splitlines() if line)


def remote_names(repo: Path) -> list[str]:
    return decoded(git(repo, "remote")).splitlines()


def remote_branch_exists(repo: Path, remote: str, branch: str) -> bool:
    branch_ref = f"refs/heads/{branch}"
    result = subprocess.run(
        ["git", "-C", str(repo), "ls-remote", "--exit-code", "--heads", remote, branch_ref],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode == 2:
        return False
    if result.returncode != 0:
        raise PipelineError(
            Msg("remoteQueryFailed", repo=repo, remote=remote, branch=branch),
            Msg("checkNetworkRetry"),
            decoded(result.stderr) or Msg("exitCode", code=result.returncode),
        )
    return any(
        line.split()[1:] == [branch_ref]
        for line in decoded(result.stdout).splitlines()
    )


def matching_remote_refs(repo: Path, branch: str) -> list[tuple[str, str]]:
    return [
        (remote, f"refs/remotes/{remote}/{branch}")
        for remote in remote_names(repo)
        if remote_branch_exists(repo, remote, branch)
    ]


def latest_branch(repo: Path, relative: str) -> str:
    output = git(
        repo, "for-each-ref", "--format=%(refname)%00%(committerdate:unix)",
        "refs/heads", "refs/remotes",
    )
    candidates: list[tuple[int, str]] = []
    remotes = sorted(remote_names(repo), key=len, reverse=True)
    for record in filter(None, output.splitlines()):
        ref, timestamp = os.fsdecode(record).split("\0", 1)
        if ref.startswith("refs/heads/"):
            branch = ref[len("refs/heads/"):]
        else:
            branch = ""
            for remote in remotes:
                prefix = f"refs/remotes/{remote}/"
                if ref.startswith(prefix):
                    branch = ref[len(prefix):]
                    break
            if branch == "HEAD":
                continue
        if branch and timestamp:
            candidates.append((int(timestamp), branch))
    if not candidates:
        raise PipelineError(
            Msg("noBranches", repo=relative),
            Msg("noBranchesAction"),
        )
    newest = max(timestamp for timestamp, _ in candidates)
    branches = {branch for timestamp, branch in candidates if timestamp == newest}
    if len(branches) != 1:
        choices = ", ".join(sorted(branches))
        raise PipelineError(
            Msg("ambiguousLatest", repo=relative, choices=choices),
            Msg("ambiguousLatestAction", repo=relative),
        )
    return next(iter(branches))


def staged_entries(repo: Path) -> dict[bytes, tuple[bytes, ...]]:
    staged = split_z(git(repo, "diff", "--cached", "--name-only", "-z"))
    if not staged:
        return {}
    result: dict[bytes, list[bytes]] = {path: [] for path in staged}
    for entry in filter(None, git(repo, "ls-files", "--stage", "-z").split(b"\0")):
        _, path = entry.split(b"\t", 1)
        if path in result:
            result[path].append(entry)
    return {path: tuple(entries) for path, entries in result.items()}


def dirty_paths(repo: Path) -> set[bytes]:
    paths = split_z(git(repo, "diff", "--cached", "--name-only", "-z"))
    unstaged = split_z(git(repo, "diff", "--name-only", "--ignore-submodules=none", "-z"))
    gitlinks = set()
    for entry in filter(None, git(repo, "ls-files", "--stage", "-z").split(b"\0")):
        metadata, path = entry.split(b"\t", 1)
        if metadata.startswith(b"160000 "):
            gitlinks.add(path)
    # A child checkout is checked separately; its changed HEAD is not a parent file edit.
    paths |= unstaged - gitlinks
    paths |= split_z(git(repo, "ls-files", "--others", "--exclude-standard", "-z"))
    return paths


def overlaps(left: bytes, right: bytes) -> bool:
    return left == right or left.startswith(right + b"/") or right.startswith(left + b"/")


def submodules(repo: Path) -> list[str]:
    config_file = repo / ".gitmodules"
    if not config_file.is_file():
        return []
    output = git(
        repo, "config", "-z", "--file", str(config_file),
        "--get-regexp", r"^submodule\..*\.path$", allowed=(0, 1),
    )
    result = []
    for record in filter(None, output.split(b"\0")):
        _, path = record.split(b"\n", 1)
        result.append(os.fsdecode(path))
    return result


@dataclass
class Repo:
    path: Path
    relative: str
    head: str = ""
    detached: bool = False
    branch: str = ""
    local_branch: bool = False
    remote: str = ""
    remote_branch: str = ""
    remote_ref: str = ""
    target: str = ""
    staged: dict[bytes, tuple[bytes, ...]] = field(default_factory=dict)
    dirty: set[bytes] = field(default_factory=set)
    stash_paths: set[bytes] = field(default_factory=set)
    rebased_staged: set[bytes] = field(default_factory=set)
    action: str = ""
    skip_reason: Node = ""
    skip_no_remote: bool = False


def discover(root: Path) -> tuple[list[Repo], list[tuple[str, Msg]]]:
    repos: list[Repo] = []
    skipped: list[tuple[str, Msg]] = []
    visited: set[Path] = set()

    def visit(path: Path, relative: str, parent: Optional[str]) -> None:
        resolved = path.resolve()
        if resolved in visited or os.path.commonpath((root, resolved)) != str(root):
            if parent is None:
                raise PipelineError(Msg("invalidRepoPath", path=path), Msg("invalidRepoPathAction"))
            skipped.append((relative, PipelineError(
                Msg("submoduleInvalid"), Msg("checkGitmodulesPath"),
            ).message()))
            return
        if len(visited) >= 200:
            raise PipelineError(Msg("tooManyRepos"), Msg("splitProject"))
        visited.add(resolved)
        try:
            actual_root = decoded(git(path, "rev-parse", "--show-toplevel"))
        except PipelineError as error:
            if parent is None:
                raise
            skipped.append((relative, PipelineError(
                Msg("submoduleUninitialized"),
                Msg("submoduleUninitializedAction"),
                error.detail,
            ).message()))
            return
        if Path(actual_root).resolve() != resolved:
            if parent is None:
                raise PipelineError(Msg("rootMismatch", root=root), Msg("rootMismatchAction"))
            skipped.append((relative, PipelineError(
                Msg("submoduleElsewhere"),
                Msg("submoduleElsewhereAction"),
            ).message()))
            return
        repos.append(Repo(resolved, relative))
        for child_path in submodules(resolved):
            child = resolved / child_path
            try:
                child_relative = child.relative_to(root).as_posix()
            except ValueError:
                skipped.append((f"{relative}/{child_path}", PipelineError(
                    Msg("submoduleOutside"), Msg("checkGitmodulesPath"),
                ).message()))
                continue
            visit(child, child_relative, relative)

    visit(root, ".", None)
    return repos, skipped


def assignments(values: list[str], option: str) -> dict[str, str]:
    result = {}
    for value in values:
        if "=" not in value:
            raise PipelineError(Msg("badAssignment", option=option, value=value), Msg("badAssignmentAction", option=option))
        path, selected = value.split("=", 1)
        key = Path(path).as_posix().rstrip("/") or "."
        if key in result or not selected:
            raise PipelineError(Msg("duplicateAssignment", option=option, value=value), Msg("duplicateAssignmentAction"))
        result[key] = selected
    return result


def checked_out_elsewhere(repo: Repo) -> Optional[str]:
    current_path = ""
    # With core.worktree set on a submodule, its main worktree is listed by its gitdir path; treat both as current.
    own_paths = {repo.path, Path(decoded(git(repo.path, "rev-parse", "--absolute-git-dir"))).resolve()}
    for line in decoded(git(repo.path, "worktree", "list", "--porcelain")).splitlines():
        if line.startswith("worktree "):
            current_path = line[len("worktree "):]
        elif line == f"branch refs/heads/{repo.branch}":
            if Path(current_path).resolve() not in own_paths:
                return current_path
    return None


def select_branches(repos: list[Repo], overrides: dict[str, str], upstreams: dict[str, str]) -> None:
    known_paths = {repo.relative for repo in repos}
    unknown = (set(overrides) | set(upstreams)) - known_paths
    if unknown:
        raise PipelineError(
            Msg("unknownPaths", paths=", ".join(sorted(unknown))),
            Msg("unknownPathsAction"),
        )
    for repo in repos:
        repo.head = decoded(git(repo.path, "rev-parse", "HEAD"))
        attached = decoded(git(repo.path, "symbolic-ref", "--quiet", "--short", "HEAD", allowed=(0, 1)))
        repo.detached = not bool(attached)
        if attached:
            configured = overrides.get(repo.relative)
            if configured and configured != attached:
                raise PipelineError(
                    Msg("branchMismatch", repo=repo.relative, attached=attached, configured=configured),
                    Msg("branchMismatchAction"),
                )
            repo.branch = attached
        elif repo.relative in overrides:
            repo.branch = overrides[repo.relative]
        else:
            print(f"[fetch] {repo.relative}: refreshing all remote branches", flush=True)
            try:
                git(repo.path, "fetch", "--all", "--prune", "--no-tags", "--no-recurse-submodules")
            except PipelineError as error:
                raise PipelineError(
                    Msg("refreshFailed", repo=repo.relative),
                    Msg("checkNetworkRetry"),
                    Msg("reasonAndDetail", reason=error.reason, detail=error.detail),
                ) from error
            repo.branch = latest_branch(repo.path, repo.relative)
            print(f"[select] {repo.relative}: detached HEAD -> branch with the newest commit {repo.branch}")
        local_ref = f"refs/heads/{repo.branch}"
        repo.local_branch = ref_sha(repo.path, local_ref) is not None
        if not repo.local_branch and not repo.detached:
            raise PipelineError(
                Msg("localRefMissing", repo=repo.relative, branch=repo.branch),
                Msg("localRefMissingAction"),
            )
        if repo.detached:
            holder = checked_out_elsewhere(repo) if repo.local_branch else None
            if holder:
                raise PipelineError(
                    Msg("branchInOtherWorktree", repo=repo.relative, branch=repo.branch, holder=holder),
                    Msg("branchInOtherWorktreeAction"),
                )

        remote_branch_checked = False
        if repo.relative in upstreams:
            value = upstreams[repo.relative]
            if ":" not in value:
                raise PipelineError(
                    Msg("badUpstream", repo=repo.relative, value=value),
                    Msg("badUpstreamAction", repo=repo.relative),
                )
            repo.remote, repo.remote_branch = value.split(":", 1)
            if not repo.remote or not repo.remote_branch or repo.remote not in remote_names(repo.path):
                raise PipelineError(
                    Msg("invalidUpstream", repo=repo.relative, value=value),
                    Msg("invalidUpstreamAction"),
                )
        else:
            configured_remote = git_config(repo.path, f"branch.{repo.branch}.remote") if repo.local_branch else None
            configured_merge = git_config(repo.path, f"branch.{repo.branch}.merge") if repo.local_branch else None
            if configured_remote or configured_merge:
                if not configured_remote or not configured_merge or not configured_merge.startswith("refs/heads/"):
                    raise PipelineError(
                        Msg("upstreamIncomplete", repo=repo.relative, branch=repo.branch),
                        Msg("upstreamIncompleteAction", repo=repo.relative),
                    )
                repo.remote = configured_remote
                repo.remote_branch = configured_merge[len("refs/heads/"):]
            else:
                matches = matching_remote_refs(repo.path, repo.branch)
                if not matches:
                    repo.skip_no_remote = True
                    repo.skip_reason = Msg("noRemoteBranch", branch=repo.branch)
                    continue
                if len(matches) != 1:
                    found = ", ".join(remote for remote, _ in matches)
                    raise PipelineError(
                        Msg("ambiguousUpstream", repo=repo.relative, branch=repo.branch, found=found),
                        Msg("ambiguousUpstreamAction", repo=repo.relative),
                    )
                repo.remote = matches[0][0]
                repo.remote_branch = repo.branch
                remote_branch_checked = True
            if repo.remote not in remote_names(repo.path) or repo.remote == ".":
                raise PipelineError(
                    Msg("upstreamUnavailable", repo=repo.relative, remote=repo.remote),
                    Msg("upstreamUnavailableAction"),
                )
        repo.remote_ref = f"refs/remotes/{repo.remote}/{repo.remote_branch}"
        if not remote_branch_checked and not remote_branch_exists(repo.path, repo.remote, repo.remote_branch):
            repo.skip_no_remote = True
            repo.skip_reason = Msg("noRemoteBranch", branch=f"{repo.remote}/{repo.remote_branch}")
            continue
        repo.staged = staged_entries(repo.path)
        repo.dirty = dirty_paths(repo.path)
        if git(repo.path, "ls-files", "--unmerged", "-z"):
            repo.skip_reason = PipelineError(
                Msg("unmergedIndex"), Msg("unmergedIndexAction"),
            ).message()
        for state_file in ("MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"):
            state_path = Path(decoded(git(repo.path, "rev-parse", "--git-path", state_file)))
            if not state_path.is_absolute():
                state_path = repo.path / state_path
            if state_path.exists():
                repo.skip_reason = PipelineError(
                    Msg("operationInProgress", operation=state_file),
                    Msg("operationInProgressAction"),
                ).message()


def fetch_targets(repos: list[Repo]) -> None:
    for repo in repos:
        if repo.skip_reason:
            print(f"[skip] {repo.relative}\n  {repo.skip_reason}")
            continue
        print(f"[fetch] {repo.relative}: {repo.remote}/{repo.remote_branch}", flush=True)
        try:
            git(
                repo.path, "fetch", "--no-tags", "--no-recurse-submodules", repo.remote,
                f"refs/heads/{repo.remote_branch}:{repo.remote_ref}",
            )
            repo.target = ref_sha(repo.path, repo.remote_ref) or ""
            if not repo.target:
                raise PipelineError(
                    Msg("remoteBranchMissing", remote=repo.remote, branch=repo.remote_branch),
                    Msg("remoteBranchMissingAction"),
                )
        except PipelineError as error:
            if error.detail:
                error = PipelineError(
                    Msg("fetchFailed", remote=repo.remote, branch=repo.remote_branch),
                    Msg("fetchFailedAction"),
                    Msg("reasonAndDetail", reason=error.reason, detail=error.detail),
                )
            repo.skip_reason = error.message()
            print(f"[skip] {repo.relative}\n  {repo.skip_reason}")


def plan_updates(repos: list[Repo]) -> None:
    for repo in repos:
        if repo.skip_reason:
            continue
        errors = []
        branch_tip = ref_sha(repo.path, f"refs/heads/{repo.branch}") if repo.local_branch else repo.target
        assert branch_tip is not None
        if not is_ancestor(repo.path, branch_tip, repo.target):
            if is_ancestor(repo.path, repo.target, branch_tip):
                repo.action = "already ahead of upstream"
            else:
                errors.append(PipelineError(
                    Msg("diverged", branch=repo.branch, remote=repo.remote, remoteBranch=repo.remote_branch),
                    Msg("divergedAction"),
                ).message())
        elif branch_tip == repo.target:
            repo.action = "attach branch" if repo.detached else "up to date"
        else:
            repo.action = "attach and fast-forward" if repo.detached else "fast-forward"

        final_tip = branch_tip if repo.action == "already ahead of upstream" else repo.target
        if repo.detached and not git(
            repo.path, "for-each-ref", f"--contains={repo.head}", "--format=%(refname)",
            "refs/heads", "refs/remotes", "refs/tags",
        ):
            errors.append(PipelineError(
                Msg("detachedUnreferenced", head=repo.head[:12]),
                Msg("detachedUnreferencedAction", repo=repo.relative),
            ).message())
        changes = split_z(git(repo.path, "diff", "--no-renames", "--name-only", "-z", repo.head, final_tip))
        if b".gitmodules" in changes:
            errors.append(PipelineError(
                Msg("gitmodulesChanged"),
                Msg("gitmodulesChangedAction"),
            ).message())
        collisions = {local for local in repo.dirty if any(overlaps(local, remote) for remote in changes)}
        if repo.detached and repo.head != branch_tip:
            collisions |= repo.dirty
        if collisions:
            repo.stash_paths = collisions | set(repo.staged)
            repo.rebased_staged = {
                path for path in repo.staged if any(overlaps(path, remote) for remote in changes)
            }
            gitlinks = {
                path for entry in filter(None, git(repo.path, "ls-files", "--stage", "-z").split(b"\0"))
                for metadata, path in (entry.split(b"\t", 1),)
                if metadata.startswith(b"160000 ")
            }
            unsafe = repo.stash_paths & gitlinks
            if unsafe:
                paths = ", ".join(os.fsdecode(path) for path in sorted(unsafe))
                errors.append(PipelineError(
                    Msg("submodulePointerConflict", paths=paths),
                    Msg("submodulePointerConflictAction"),
                ).message())
        if errors:
            repo.skip_reason = Join("lines", errors)
            print(f"[skip] {repo.relative}\n  {repo.skip_reason}")
        else:
            suffix = f"; {len(repo.stash_paths)} paths are stashed temporarily and restored" if repo.stash_paths else ""
            print(f"[plan] {repo.relative}: {repo.branch} <- {repo.remote}/{repo.remote_branch}: {repo.action}{suffix}")


def verify_stage(repo: Repo, rebased: bool = False) -> None:
    after = staged_entries(repo.path)
    for path, entries in repo.staged.items():
        if rebased and path in repo.rebased_staged:
            continue
        if after.get(path) != entries:
            raise PipelineError(
                Msg("indexChanged", path=os.fsdecode(path)),
                Msg("indexChangedAction"),
            )


def stash_ref(repo: Repo, oid: str) -> Optional[str]:
    output = decoded(git(repo.path, "stash", "list", "--format=%gd:%H"))
    for line in output.splitlines():
        ref, sha = line.split(":", 1)
        if sha == oid:
            return ref
    return None


def drop_stash(repo: Repo, oid: str) -> None:
    ref = stash_ref(repo, oid)
    if ref:
        try:
            git(repo.path, "stash", "drop", ref)
        except PipelineError as error:
            raise PipelineError(
                Msg("stashNotDropped"),
                Msg("stashNotDroppedAction", stash=oid),
                error.detail,
            ) from error
    else:
        print(
            f"[stash kept] {repo.relative}: the temporary stash {oid} of this run was not found; "
            "check git stash list and drop it manually once the working tree is restored."
        )


def apply_one(repo: Repo) -> None:
    if decoded(git(repo.path, "rev-parse", "HEAD")) != repo.head:
        raise PipelineError(Msg("headChanged"), Msg("headChangedAction"))
    verify_stage(repo)
    if dirty_paths(repo.path) != repo.dirty:
        raise PipelineError(Msg("worktreeChanged"), Msg("worktreeChangedAction"))

    saved: Optional[str] = None
    if repo.stash_paths:
        before = ref_sha(repo.path, "refs/stash")
        paths = [os.fsdecode(path) for path in sorted(repo.stash_paths)]
        git(repo.path, "stash", "push", "--include-untracked", "-m",
            f"git pipeline {repo.relative} {repo.head[:12]}", "--", *paths)
        saved = ref_sha(repo.path, "refs/stash")
        if not saved or saved == before:
            raise PipelineError(
                Msg("stashFailed"),
                Msg("stashFailedAction"),
            )
        print(f"[stash] {repo.relative}: {saved[:12]} ({len(paths)} paths)")

    restore_attempted = False
    try:
        if repo.detached:
            if repo.local_branch:
                git(repo.path, "-c", "submodule.recurse=false", "switch", repo.branch)
            else:
                git(repo.path, "-c", "submodule.recurse=false", "switch", "--create", repo.branch, repo.target)
                git(repo.path, "branch", "--set-upstream-to", repo.remote_ref, repo.branch)
        if repo.action in ("fast-forward", "attach and fast-forward"):
            git(
                repo.path, "-c", "submodule.recurse=false", "-c", "merge.autostash=false",
                "merge", "--ff-only", "--no-stat", repo.remote_ref,
            )
        if saved:
            restore_attempted = True
            git(repo.path, "stash", "apply", "--index", saved)
        if git(repo.path, "ls-files", "--unmerged", "-z"):
            raise PipelineError(
                Msg("stashConflict"),
                Msg("stashConflictAction"),
            )
        verify_stage(repo, rebased=bool(saved))
        if not decoded(git(repo.path, "symbolic-ref", "--quiet", "--short", "HEAD", allowed=(0, 1))):
            raise PipelineError(
                Msg("stillDetached"),
                Msg("stillDetachedAction"),
            )
    except PipelineError as error:
        if saved and not restore_attempted:
            # Git retains the stash on conflict. An unsuccessful checkout is restored if possible.
            if not git(repo.path, "ls-files", "--unmerged", "-z"):
                try:
                    git(repo.path, "stash", "apply", "--index", saved)
                except PipelineError:
                    pass
        if saved:
            raise PipelineError(error.reason, Msg("actionWithStash", action=error.action, stash=saved), error.detail, "stashRetained") from error
        raise
    if saved:
        drop_stash(repo, saved)


def apply_updates(repos: list[Repo]) -> int:
    completed = 0
    for repo in repos:
        if repo.skip_reason:
            continue
        try:
            apply_one(repo)
            completed += 1
            print(f"[done] {repo.relative}: {decoded(git(repo.path, 'rev-parse', '--short', 'HEAD'))}")
        except PipelineError as error:
            repo.skip_reason = error.message()
            print(f"[failed] {repo.relative}\n  {repo.skip_reason}", file=sys.stderr)
    return completed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=os.getcwd(), help="repository root or a path inside it")
    parser.add_argument("--apply", action="store_true", help="fast-forward safely and restore temporarily stashed changes")
    parser.add_argument("--branch", action="append", default=[], metavar="PATH=BRANCH", help="target branch for a repository on a detached HEAD")
    parser.add_argument("--upstream", action="append", default=[], metavar="PATH=REMOTE:BRANCH", help="remote and branch when the upstream is ambiguous")
    args = parser.parse_args()
    try:
        root = Path(decoded(git(Path(args.repo), "rev-parse", "--show-toplevel"))).resolve()
        repos, missing = discover(root)
        for path, issue in missing:
            print(f"[skip] {path}\n  {issue}")
        branches = assignments(args.branch, "--branch")
        upstreams = assignments(args.upstream, "--upstream")
        select_branches(repos, branches, upstreams)
        fetch_targets(repos)
        plan_updates(repos)
        if args.apply:
            completed = apply_updates(repos)
            no_remote = sum(repo.skip_no_remote for repo in repos)
            print(f"[summary] {completed}/{len(repos) + len(missing)} repositories done; {no_remote} skipped normally without a remote branch.")
        else:
            print("[summary] Preview finished; no branch was switched and nothing was stashed. Add --apply to run the plan.")
        unfinished = [repo.relative for repo in repos if repo.skip_reason and not repo.skip_no_remote]
        unfinished.extend(path for path, _ in missing)
        if unfinished:
            print(f"[summary] Unfinished: {', '.join(unfinished)}; see the matching repository above for what to do.", file=sys.stderr)
        return 2 if unfinished else 0
    except PipelineError as error:
        print(f"[aborted]\n  {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
