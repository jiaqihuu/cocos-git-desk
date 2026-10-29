# Configuration

Two optional files and a few environment variables. Missing files and missing keys use the defaults below. A file that is present but not valid JSON, or that has an unknown key or a value of the wrong type, is rejected as a whole; see [Invalid configuration](#invalid-configuration).

## `git-desk.config.json` (project, committed)

Location: `<project>/git-desk.config.json`, next to the Creator project's `package.json`. Intended to be committed so every team member and CI see the same settings.

```json
{
  "preview": { "url": null, "engineVersions": ["3.8.x"] },
  "bridge": {
    "controlName": "__COCOS_GIT_DESK_PREVIEW_CONTROL__",
    "debugName": "__COCOS_GIT_DESK_DEBUG__",
    "apiVersion": "cocos-git-desk-preview-bridge/1"
  },
  "revision": { "roots": ["assets", "extensions/*/assets"] },
  "i18n": {
    "keyPattern": null,
    "directory": "assets/resources/language/json",
    "languages": [],
    "csvLayout": "perKey",
    "csvColumns": ["key", "en", "zh"],
    "csvStatus": { "missing": "missing", "present": "present" }
  },
  "clients": []
}
```

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `preview.url` | string \| null | `null` → the URL Creator serves its preview on (`preview` / `query-preview-url`), or `http://localhost:7456/` when Creator gives none | `http:` or `https:` URL of the page loaded by the embedded Debug Preview panel and the external browser. Leave it `null` so a second Creator instance or a changed preview port is followed automatically; set it when the game is served by a separate dev server. Navigation away from this origin and path is blocked inside the panel. |
| `preview.engineVersions` | string[] | `["3.8.x"]` | Engine versions the runtime inspector may inject into. Each dot-separated segment is a number or `x`, so `3.8.8`, `3.8.x` and `3.x` are all valid. The inspector reads `cc.VERSION` in the page and refuses with a reason when no entry matches. Only 3.8.8 has been tested. |
| `bridge.controlName` | string | `__COCOS_GIT_DESK_PREVIEW_CONTROL__` | JavaScript identifier of the `window` object the project's preview bridge exposes for control (`identity()`, `attach()`, `setEnabled()`, `status()`). When the object is absent the page has no project bridge: inspector and capture tools still work, and bridge tools fail with an error saying the project has not loaded a preview bridge. |
| `bridge.debugName` | string | `__COCOS_GIT_DESK_DEBUG__` | JavaScript identifier of the `window` object that serves the 17 `browser_debug_*` bridge tools (hierarchy, state, timeline, UI, language, mocks). |
| `bridge.apiVersion` | string | `cocos-git-desk-preview-bridge/1` | Expected `identity().apiVersion`. The main process also requires `identity().projectId` to equal the current project id (see [Project id](#project-id)); on either mismatch the bridge tools refuse with a mismatch error. |
| `revision.roots` | string[] | `["assets", "extensions/*/assets"]` | Project-relative POSIX directories whose scripts and prefabs are fingerprinted so `browser_debug_identity` and `browser_debug_export` can compare the page with the code on disk. `*` may stand for one whole path segment; roots that do not exist are skipped. The scan stops with an error above 30000 files or 256 MiB, so narrow the roots in large projects. |
| `i18n.keyPattern` | string \| null | `null` (tool disabled) | Regular expression matching language keys in source. A bare pattern such as `"\\bi18n_[a-z0-9_]+\\b"` is case-sensitive; write `"/pattern/flags"` to add flags such as `i`. The global flag is always added. When `null` the `creator_language_keys` tool is not listed and a direct call returns a configuration error. |
| `i18n.directory` | string | `assets/resources/language/json` | Directory with one `<language>.json` fallback file per language. |
| `i18n.languages` | string[] | `[]` → every `*.json` in `i18n.directory` | Languages to check for missing keys and placeholder consistency, in report order. |
| `i18n.csvLayout` | `"perKey"` \| `"perLanguage"` | `"perKey"` | Shape of the CSV draft produced with `csv: "missing"` or `"all"`. `perKey` writes one row per key, and `csv: "missing"` keeps keys that lack at least one language. `perLanguage` writes one row per key and language, the shape many translation back ends import, and `csv: "missing"` keeps only the languages that lack the key. |
| `i18n.csvColumns` | (string \| object)[] | `["key", "en", "zh"]`, or `["key", "usage", "language", "text", "status"]` when `csvLayout` is `perLanguage` | Columns of the CSV draft. Each entry is a field name, or `{ "field": "...", "header": "..." }` to write a different header. Fields: `key`; `usage`, the first `file:line` that uses the key; `status`; a language code, filled with that language's text; and for `perLanguage` also `language` and `text`. Any other name produces an empty column. |
| `i18n.csvStatus` | object | `{ "missing": "missing", "present": "present" }` | Texts of the `status` column. In `perKey` the missing text is followed by the missing languages, for example `missing: zh th`. |
| `clients` | string[] | `[]` | AI client configuration files the panel's "Configure AI client" action may write: `"claude-code"` (`<project>/.mcp.json`) and `"codex"` (`<project>/.codex/config.toml`). With an empty list the panel shows the snippet and never writes files. |

Example for a back end that imports one row per key and language, with its own headers and status words:

```json
{
  "i18n": {
    "keyPattern": "\\blab_[a-z0-9_]+\\b",
    "languages": ["en", "zh", "zh_CN", "th"],
    "csvLayout": "perLanguage",
    "csvColumns": ["key", { "field": "usage", "header": "Scene" }, { "field": "language", "header": "Language" }, { "field": "text", "header": "Text" }, { "field": "status", "header": "Status" }],
    "csvStatus": { "missing": "to translate", "present": "local copy exists" }
  }
}
```

### Invalid configuration

Unknown keys are rejected so typos do not pass silently. When the file cannot be used, the extension writes the reason to the Creator console and to the extension log (`creator_extension_log`) and runs with every default until the file is fixed. Everyone sharing the file therefore needs an extension version that knows all of its keys.

The MCP adapter decides whether to list `creator_language_keys` by reading only `i18n.keyPattern`. If another part of the file is invalid, the tool can still appear in the list, and calling it returns the configuration error.

### Project id

`<projectId>` is the `uuid` field of the Creator project's `package.json`. A project without one uses the first 12 hex digits of the SHA-256 of its real path. The id names the per-machine data directory and is the value a project bridge must return as `identity().projectId`.

## `agent-settings.json` (local, not committed)

Location: `<project>/extensions/cocos-git-desk/.cache/agent-settings.json`. The whole `.cache/` directory is ignored by Git. Isolated worktree contexts have their own `.cache/`; a boolean set there overrides the project value, an empty object inherits it.

```json
{
  "requireHumanReview": true,
  "debug": {
    "stateDir": "~/.cocos-git-desk/<projectId>/state",
    "outputDir": "~/.cocos-git-desk/<projectId>/exports"
  }
}
```

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `requireHumanReview` | boolean | `true` | Whether files classified `preExisting` or `mixed` inside a task scope must be approved in the Creator panel before an MCP `stage`/`commit` may include them. `false` lets scoped pre-existing content through without a review dialog; classification, baselines and existing approvals are unchanged, and out-of-scope paths, conflicts, missing related `.meta`, incompatible HEAD/branch changes and submodule pointers still block. The effective policy and its source are returned in `capabilities.taskScopes.reviewPolicy`. A non-boolean value is an error. |
| `debug.stateDir` | string | `~/.cocos-git-desk/<projectId>/state` | Where the page observer on/off choice is stored, as `observer-<hash>.json` per preview URL. Must be absolute after a leading `~` or `~/` is expanded to the home directory. |
| `debug.outputDir` | string | `~/.cocos-git-desk/<projectId>/exports` | Where `browser_debug_export` writes `evidence-<time>-<id>` folders (identity, UI state, timeline, screenshot, README), created with mode `0700`. Same path rules as `stateDir`. |

This switch never replaces the user's authorization for commits, pushes or destructive actions; it only removes one dialog for content the user has already decided to accept.

## Per-machine data directory

`~/.cocos-git-desk/<projectId>/` also holds two fixed subdirectories that are not configurable:

| Path | Purpose |
| --- | --- |
| `browser-profile/` | Profile of the external debugging browser opened from the panel. Its remote debugging port is also derived from the project id. |
| `backups/` | Previous `.codex/config.toml` and Skill files, saved before the panel overwrites them for a client listed in `clients`. |

Two checkouts of the same Creator project share one id and therefore one data directory.

## Other local files under `.cache/`

| Path | Purpose |
| --- | --- |
| `agent-connection.json` | Loopback RPC port, token and project path, mode `0600`, rewritten on every extension load. Read by `scripts/git-desk-mcp.py`. |
| `agent-tasks/` | Task scope records (metadata and hashes only); `agent-task-archives/{expired,completed}/` for archived tasks. |
| `scope-reviews/`, `scope-review-archives/` | Human review requests with their diffs. |
| `workspaces/` | Registered isolated worktree contexts. |
| `auto-fetch.json` | Panel auto-fetch toggle. |
| `captures/` | PNGs from `creator_screenshot`. |
| `project-update/` | Temporary capture files during fast-forward updates, removed when the task ends. |

Delete `.cache/` only while Creator is closed; the extension recreates what it needs.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `COCOS_GIT_DESK_GIT` | Path to the Git executable to use instead of `git` on `PATH`. Read when Creator starts. |
| `COCOS_GIT_DESK_PYTHON` | Path to the Python 3 executable used for the project update scripts (`updateAll`, force-sync actions). The MCP adapter itself is started by the AI client, so its interpreter is whatever the client config names. |
| `GIT_DESK_LANG` | `en` or `zh`; forces the language of messages produced by the extension. Otherwise the Creator editor language is used, and English when it is not Chinese. |
| `CLAUDE_PROJECT_DIR` | Set by Claude Code; `templates/mcp.json` uses it to locate the project root. |

## Client configuration templates

- `templates/mcp.json` — Claude Code `.mcp.json` entry named `cocos-git-desk`, resolving the project through `CLAUDE_PROJECT_DIR` with the current directory as fallback.
- `templates/codex-config.toml` — Codex `[mcp_servers.cocos-git-desk]` block with `<project>` placeholders.

Both start `scripts/git-desk-mcp.py --project <project>`; the adapter needs no configuration of its own.
