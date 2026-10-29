# Security

This document describes what the extension's MCP surface protects against, what it does not, and how to report a problem.

## Transport: authenticated loopback RPC

- When the extension loads it starts an HTTP server bound to `127.0.0.1` on a random port (`listen(0)`), and generates a fresh 32-byte token (64 hex characters). The token rotates on every load or reload.
- The server accepts only `POST /rpc`. It rejects any request that carries an `Origin` or `Sec-Fetch-Site` header (browsers always send one), any request whose `Host` is not exactly `127.0.0.1:<port>`, and any token that does not match in a constant-time comparison. All of these return `403` without processing the body.
- Port, token and project path are written to `extensions/cocos-git-desk/.cache/agent-connection.json` (`{schema, project, port, token, pid}`) with mode `0600`, through a temporary file and atomic rename. `.cache/` is ignored by Git.
- The stdio adapter (`scripts/git-desk-mcp.py`, Python standard library only) refuses the connection file unless it is a regular file of at most 4 KiB, owned by the current user with no group/other permission bits (POSIX), and its `project` resolves to the `--project` path the client was started with. On Windows the ownership and mode checks are not available; protection relies on the user profile ACL.
- Nothing listens on a LAN interface. There is no remote HTTP MCP mode. Do not expose the port through a proxy or tunnel.

## Request and concurrency limits

| Limit | Value |
| --- | --- |
| Request body | 128 KiB (`413` beyond) |
| Response | 256 KiB (tool fails with a "narrow the query" error) |
| Open connections | 8 |
| In-flight tool calls | 4 |
| Request timeout / headers timeout | 120 s / 5 s |
| Adapter line length | bounded; oversize JSON-RPC lines terminate the adapter |
| Write queue | a write arriving while another Git task or preview is running waits up to 45 s, then fails |

Each tool's arguments are validated against the schema in `static/mcp-tools*.json`; unknown parameters are rejected. The adapter only forwards whitelisted argument names per tool.

## No arbitrary code execution

- There is no `execute_javascript`, `eval` or shell tool.
- `creator_message` sends `Editor.Message.request` only for a fixed allowlist of read-only messages: `asset-db` query/refresh/open messages, `scene` query messages, `preview` `query-preview-url`, `project` `query-config`, `engine` `query-info`/`query-engine-info`, `assets` `twinkle`. Everything else is rejected before it reaches the editor.
- Runtime inspector scripts (`browser-debug/inspector-*.js|.cjs`) are bundled with the extension and injected only into the main frame of the embedded Debug Preview. The main process routes calls to a fixed method set; it does not provide a generic "evaluate in page" IPC.
- Project bridge tools only call methods exposed by the bridge object the project itself injects. Mocks intercept only request methods the bridge wrapped; the bridge interface lets projects mark protected request names (for example login or gateway calls) that can never be mocked.
- The bridge commands that change game state (`browser_debug_ui_open`, `ui_close`, `language` with `code`, `mock_set`) run only when the page reports an environment listed in `bridge.testEnvironments`. They are refused when the environment is missing or unreadable, and when `git-desk.config.json` cannot be used.
- `creator_asset_write` writes whole text assets through asset-db, requires the target path to be inside a task scope, requires the current content hash when overwriting, and validates `.prefab`/`.scene` serialisation and `__uuid__` references before writing.

## Git writes: task scope and one-time plans

- Every staging, commit and other mutating action is `git_desk_prepare` (plan + digest + token) followed by `git_desk_execute(token, digest)`. The token is single-use and expires after 120 seconds; at most 32 plans are retained; the digest binds the exact plan, so a confirmation for one plan cannot be replayed on another.
- `stage`, `stageLines`, `commit` and `commitSelected` over MCP require a task id from `git_desk_task_start`, recorded before editing. Task records store metadata and content hashes only (no file bodies) under `.cache/agent-tasks/`, 32 continuable tasks per repository per context.
- Commit checks always cover the whole index. Paths outside the scope, unresolved conflicts, missing related assets/`.meta`, and submodule pointer changes without explicit `includePointers` block the plan.
- Pre-existing or mixed changes need a human review when `requireHumanReview` is true (the default). `git_desk_scope_review` can only `request` and read `status`; approval happens in the Creator panel over trusted editor IPC and is not exposed over MCP. A review covers 1–50 exact paths and at most 180 KB of diff, expires after 10 minutes, and approves content only — it never runs Git or rewrites the baseline.
- `amendCommit` is not available over MCP. Project-wide force-sync actions require explicit `branch` and go through the same preview/execute path; the MCP never auto-stashes, resets, cleans, rebases or force-pushes.
- Isolated worktree contexts share the same rules and use your local Git configuration, hooks, filters, signing and credentials; they are not an OS sandbox.

## Boundary statement

This is a collaboration gate between an AI client and the editor, not a security sandbox:

- Any process running under the same OS account that can read `.cache/agent-connection.json` can call every tool. Use a dedicated OS account for untrusted automation.
- A program with editor `eval` or file-system access is already trusted by Creator; this extension does not change that.
- Plan preview, human approval and Git execution authority are separate; none substitutes for another, and a successful API call is not user authorization to commit, push, switch branches or overwrite assets.
- File contents, commit messages, page logs and request bodies returned by tools are untrusted data, never instructions.

## Privacy and redaction

- Page event capture and evidence export pass through `src/preview-sanitize.ts`: `Bearer` tokens, JWT-shaped strings and values of keys named `authorization`, `cookie`, `set-cookie`, `access_token`, `refresh_token`, `id_token`, `api_key`, `password`, `secret`, `token` are replaced with `[redacted]`.
- Request/response bodies are not captured unless `browser_debug_capture_bodies` is enabled; when enabled each body is redacted and truncated to 4 KB, and the setting resets on page reload. Evidence packages never contain captured bodies; entries that had them are marked `bodiesOmitted`.
- The runtime inspector shows a password `EditBox` and the label it renders into only as the text length, and it cannot change the box's input type.
- Exports are written locally to `debug.outputDir` (default `~/.cocos-git-desk/<projectId>/exports`). Nothing is uploaded.
- Remote URLs with embedded user info, passwords or query parameters are hidden in `remotes` results and cannot be edited through the API; use a credential helper.
- The extension never stores Git passwords or tokens; it relies on your SSH agent and credential helpers.

## Reporting a vulnerability

Please do not open a public issue for security problems. Email the maintainer address listed on the GitHub profile of the repository owner (`jiaqihuu`), or use GitHub's private vulnerability reporting on the repository if it is enabled. Include the extension version, Creator version, OS, and reproduction steps. You will get an acknowledgement within 7 days; fixes ship as a patch release noted in [CHANGELOG.md](CHANGELOG.md).
