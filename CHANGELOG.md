# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/). The Agent IPC protocol version (`protocol: 1`) and the MCP tool catalogue are versioned separately and noted under each release.

## [Unreleased]

## [0.2.1] — 2026-10-29

### Fixed
- The runtime inspector works on a preview opened through a LAN address. Such a page is not a secure context and has no `crypto.randomUUID`; the inspector frame script now falls back to `crypto.getRandomValues` for its session id.
- The embedded preview opens Creator's preview server as `localhost` when the configured or reported host is an address of this machine, so the page is a secure context and browser APIs that need one keep working. Other hosts are kept as they are.
- A project without a preview bridge no longer shows a permanent orange error in the preview toolbar. The toolbar shows a grey "No project preview bridge; the runtime inspector still works" note, and `status()` reports it as `noBridge`.
- Scene editing tools (`creator_property_set`, `creator_component_add`, `creator_component_remove`, `creator_node_create`, `creator_node_remove`, `creator_prefab_instantiate`) now wrap each edit in Creator 3.8.8's `begin-recording` / `end-recording`. Before, the edit changed the scene in memory but Creator did not mark it dirty, so `creator_scene_save` reported nothing to save and the change was never written. Builds without the recording messages fall back to a snapshot after the edit; a failed edit cancels its recording. Found in a smoke test in a real Creator 3.8.8 editor.

### Known issues
- `creator_screenshot` with a `panel` does not find a panel that sits in a floating Creator window. Dock the panel into the main window before capturing it.

## [0.2.0] — 2026-10-29

First public release of the extension that was previously developed inside a private Cocos Creator project as 0.1.x.

### Added
- MIT license, `repository`/`homepage`/`bugs` metadata, English `description`; `private` flag removed.
- GitHub Actions: CI matrix (macOS, Ubuntu, Windows; Node 22; Git LFS; Python 3) running typecheck, build, tests and the English-default check (tests run with `core.autocrlf=false`, checkouts are LF through `.gitattributes`); it runs on pull requests and on manual dispatch, not on every push. A manually started release workflow packages `cocos-git-desk-<version>.zip` with a SHA-256 file.
- i18n: message registry with Chinese and English tables (`src/i18n/{zh,en}/*`), `GIT_DESK_LANG` override, English as the default outside a Chinese editor; Creator `i18n/en.js` and `i18n/zh.js` for panel titles and menu items.
- Project configuration file `git-desk.config.json` (preview URL and engine versions, bridge object names, revision scan roots, language key audit settings, allowed AI client configs) and `debug.stateDir`/`debug.outputDir` in the local `agent-settings.json`. See `docs/CONFIG.md`.
- Tool catalogue split into `static/mcp-tools.core.json`, `mcp-tools.inspector.json`, `mcp-tools.bridge.json` and `mcp-tools.i18n.json`; `tools/list` merges the groups that are enabled. `scripts/tools-doc.cjs` generates `docs/TOOLS.md` from them.
- Client configuration templates `templates/mcp.json` (Claude Code) and `templates/codex-config.toml` (Codex).
- Language key CSV drafts can match the importing system: `i18n.csvLayout` writes one row per key (`perKey`, the default) or one row per key and language (`perLanguage`), `i18n.csvColumns` entries may name their header as `{ "field", "header" }`, and `i18n.csvStatus` sets the texts of the `status` column.
- The embedded preview uses a persistent session partition (`persist:cocos-git-desk-<projectId>`), so localStorage, cookies and IndexedDB survive Creator restarts and the game keeps its signed-in or guest account.
- Startup is shown as waiting, not as an error: while the embedded page connects, the game registers its debug dependencies, or (for 15 seconds after each page load) the project bridge is not there yet, the preview toolbar shows a quiet one-line "Waiting for the game to start…"; while the engine is still loading, the runtime inspector shows "Waiting for the game to load…" and clears it on the next good poll. Matching uses message ids and error codes, not texts in one language.
- Preview messages stay on one line with an ellipsis; the full text is in the tooltip. Page evaluation errors keep only the message, without the `Error:` prefix or code location.
- The release zip ships its own `.gitignore`, so `.cache/`, which holds the loopback MCP token, stays out of the host project's repository even when the project's `.gitignore` does not list it.
- Packaging collects nested `dist/` directories (`dist/i18n/`) and skips compiled files whose source was removed; a test checks that every relative `require`, every manifest entry and every tool catalogue is inside the zip.
- English documentation: `README.md`, `README.zh-CN.md`, `docs/AGENT_API.md`, `docs/RUNTIME_INSPECTOR.md`, `docs/CONFIG.md`, `docs/TOOLS.md`, `SECURITY.md`, `CONTRIBUTING.md`.

### Fixed
- Windows: worktree paths printed by Git (`D:/work/x`) are converted to the platform form before they are compared, so isolated worktree contexts register and work; branch worktree paths are reported in the same form.
- Windows: a replaced file is detected by creation time, modification time and size as well as its file id, which some Windows volumes repeat.
- Windows: generated Codex configuration uses forward slashes in paths.

### Changed
- Project identity is read from the Creator project's `package.json` `uuid`; the hard-coded project uuid check is gone.
- Preview bridge object names and API version strings are configurable with neutral defaults (`__COCOS_GIT_DESK_PREVIEW_CONTROL__`, `__COCOS_GIT_DESK_DEBUG__`, `cocos-git-desk-preview-bridge/1`). The control object and the debug object report the same API version.
- With `preview.url` unset, the embedded preview and the external browser follow the URL Creator serves its preview on (`preview` / `query-preview-url`) and fall back to `http://localhost:7456/` only when Creator gives none, so a second Creator instance no longer inspects another project's game.
- Debug state and exports move from a fixed developer directory to `~/.cocos-git-desk/<projectId>/{state,exports}`.
- Revision fingerprint scan roots default to `assets` plus `extensions/*/assets` instead of a fixed list.
- Runtime inspector accepts the engine versions listed in `preview.engineVersions` (default `3.8.x`) instead of exactly 3.8.8.
- `creator_language_keys` is enabled only when `i18n.keyPattern` is configured; key pattern, directory, languages and CSV columns come from configuration.
- MCP server name in generated client configs is `cocos-git-desk`; writing client configuration from the panel is opt-in via `clients`.
- Page injection scripts and Creator console prefixes are English (`[Git Desk]`).
- The "Connect Codex" panel action becomes "Configure AI client" and shows a snippet by default instead of editing files.

### Removed
- Internal documents `VALIDATION.md`, `ROADMAP.md`, `docs/TEAM_GUIDE.md` and the project-specific `scripts/load-in-editor.js`.
- Project-specific skills and the business implementation of the preview bridge (kept in the originating project).

## [0.1.8] — 2026-10-29

Last version developed inside the private project; summarised from the Chinese change log.

### Added
- Editor tools over Creator messages: asset query/open/reveal/refresh/write/delete/meta/users, editor state, TypeScript diagnostics, preview status, project log, extension log, screenshot, extension reload, read-only `creator_message` allowlist.
- Scene and prefab editing under task scope: `creator_scene_tree`, `node_inspect`, `node_create`, `node_remove`, `component_add`, `component_remove`, `property_set`, `scene_save`, `scene_open`, `prefab_instantiate` with undo snapshots and explicit save.
- Asset/`.meta` consistency check (`creator_meta_check`), also enforced by `git_desk_commit_check` and commit plans (`META_BLOCKED`).
- Semantic `.prefab`/`.scene` diff (`creator_prefab_diff`): node add/remove/move/rename, component changes, property changes with references resolved to node and asset paths, prefab instance overrides, asset reference counts; LFS history read from the local object store.
- Runtime inspector merged into the extension: Runtime Hierarchy and Runtime Properties dock panels, floating inspector, click-to-select, property editing with undo, print to console, related assets, flat UI layout (`runtime_inspector_layout`) and comparison against design coordinates (`runtime_inspector_layout_compare`), DrawCall capture, `runtime_inspector_status` self-check.
- Page event capture and project bridge tools inside the Creator main process (`browser_debug_*`): observer toggle, identity and revision check, hierarchy/state/timeline, console/exception/HTTP/WebSocket capture, marks, reload wait, range comparison, evidence export, render stats, optional redacted body capture, UI list/open/close, language switch, preview-only mocks.
- Language key audit (`creator_language_keys`) with CSV draft.
- `git_desk_execute` waits for task completion by default (`wait`/`waitMs`, up to 60 s); `git_desk_task_status` long-polls (`waitMs`); calls arriving during another task queue for up to 45 s instead of failing immediately.
- Compact MCP replies by default (`verbose: true` returns fingerprints, object ids and patch bodies).
- Automatic archiving of completed tasks when the 32-task limit is reached.

### Changed
- Normal merge requires only paths overlapping the merge to be clean; `syncSubmodules` accepts `paths`.
- Debug preview refresh and IPC reduced to one evaluation per frame call with digest short-circuit.
- Runtime panels copy Creator theme variables so light themes render correctly.

### Removed
- The separate browser-debug MCP process; everything runs inside the extension.

## [0.1.7] — 2026-10-27

### Added
- Fast-forward and no-conflict auto-commit merges; `commitSelected` (stage selected whole files and commit in one plan); lightweight remote check every 15 s with fetch only on change; auto-fetch toggle.
- Isolated worktrees can begin, resolve, finish and abort merges.
- Plan and task metrics (`elapsedMs`, `gitCalls`, `gitMs`, `networkGitMs`).

### Changed
- Stage/unstage/commit refresh only the target repository and its ancestors; unrelated working tree edits no longer invalidate a commit plan.
- Selective stash handles renamed and staged-deleted paths and literal special characters.
- Abort merge clears resolved files before the native abort.

### Fixed
- Duplicate reads and paging false positives in file comparison.

## [0.1.6] — 2026-10-26

### Added
- `git_desk_task_extend`; continuation of a task across unrelated fast-forward commits and verified scoped commits on the same branch.
- Review requests open the matching dialog in Creator automatically, with per-file trigger reasons, AI-provided summary/focus/validation, per-file diff navigation and colouring.
- Panel `refresh-remote` message with fixed refspec fetch.

### Changed
- Isolated worktrees inherit the project review policy and report its source.
- Pure script/config/doc commits are no longer blocked by unrelated unsaved scenes.

## [0.1.5] — 2026-10-25

### Added
- Isolated worktree contexts (`git_desk_context_*`, `git_desk_worktree_*`) and human review of pre-existing or mixed changes (`git_desk_scope_review`, `requireHumanReview` in `agent-settings.json`).
- Repository/branch dropdowns, Working Changes / History tabs, virtual scrolling for large diffs and long history, incremental row reuse.
- Update results kept per project with a status icon.

### Changed
- Background refresh: 15 s lightweight probe when visible, fetch only on change, polling paused while hidden.

## [0.1.3] — 2026-10-24

### Added
- Standard stdio MCP adapter (`scripts/git-desk-mcp.py`) over an authenticated loopback RPC; task scopes (`task_start`, `task_changes`, `commit_check`) and whole-index commit checks; `git_desk_query` read-only operations.

## [0.1.2] — 2026-10

### Added
- First standalone package: recursive repository discovery, working tree and index diffs with image comparison, LFS object reads, file staging with related `.meta` expansion, commit/push/fetch, fast-forward update, branch creation and switching, submodule sync, previewed writes with two-minute expiry, Agent IPC protocol v1 (`details(repo, {kind: 'agent', protocol: 1, ...})`).

[Unreleased]: https://github.com/jiaqihuu/cocos-git-desk/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/jiaqihuu/cocos-git-desk/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/jiaqihuu/cocos-git-desk/releases/tag/v0.2.0
