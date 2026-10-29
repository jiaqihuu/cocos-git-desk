# Git Desk for Cocos Creator

[中文说明](README.zh-CN.md)

A Cocos Creator 3.8 extension that puts Git for the project and its submodules inside the editor, and exposes the same Git service, the editor and the running preview to AI clients through a scoped, token-gated MCP. No arbitrary code execution: every write goes through a reviewed one-time plan.

![Git Desk panel: working tree changes and a line-staging diff of main.scene](store/screenshot-2-git-desk.png)

![Runtime inspector: live node tree and component fields of the running game, docked next to Creator's panels](store/screenshot-1-runtime-inspector.png)

## How it differs from funplay-cocos-mcp

| | funplay-cocos-mcp | cocos-git-desk |
| --- | --- | --- |
| License | MIT | MIT |
| Transport | HTTP on `127.0.0.1:8765` | stdio adapter → loopback RPC on a random port, per-launch token, connection file `0600` |
| Code execution | `execute_javascript` runs arbitrary code in the editor | None. Fixed tool set, read-only message allowlist, inspector scripts with a method allowlist |
| Git | — | Full Git panel plus 15 `git_desk_*` tools; writes require a task scope and a one-time token + digest |
| Tools | about 90 | 77 in four groups: core (43), runtime inspector + event capture (16), project bridge (17), i18n audit (1) |
| Editor UI | — | Git Desk panel, Debug Preview panel, Runtime Hierarchy / Runtime Properties panels |

The two are not exclusive; this extension covers the editor operations we actually used day to day so a second editor MCP is not required.

## What is included

- **Git Desk panel.** Main repository and recursive submodules; working tree and index diffs, line staging, history, blame, reflog, branches, tags, stashes, remotes, merge and conflict resolution, LFS object reads, isolated worktrees, fast-forward update of the whole project. Every write is previewed first; the preview expires after two minutes.
- **Git MCP.** `git_desk_query` for bounded read-only queries; `task_start → prepare → execute` for writes with a persisted task baseline; commit checks over the whole index including asset/`.meta` consistency; human review requests for pre-existing or mixed changes; isolated worktree contexts.
- **Editor tools.** 28 `creator_*` tools over Creator's asset-db, scene and preview messages: asset query/open/reveal/write/delete, `.meta` check, semantic `.prefab`/`.scene` diff, scene and prefab node editing under task scope, TypeScript diagnostics, project log, screenshots, extension reload.
- **Runtime inspector.** Hierarchy and properties of the running game in the embedded Debug Preview, docked next to Creator's own panels; click-to-select, property editing with undo, print to console, flat UI layout export and comparison against design coordinates, DrawCall capture. See [docs/RUNTIME_INSPECTOR.md](docs/RUNTIME_INSPECTOR.md).
- **Page event capture.** Console, exceptions, failed HTTP, WebSocket metadata and navigations of the preview, collected over CDP with redaction; marks, reload waits, range comparison and evidence export.
- **Project bridge (optional).** If your project injects a small bridge script into the preview, 17 more tools can list and open UI, switch language, inspect the UI tree and state, read the request timeline and register preview-only mock responses. The bridge interface is documented in `docs/BRIDGE.md` (phase 2).

The full tool list with parameters is generated into [docs/TOOLS.md](docs/TOOLS.md).

## Requirements

- Cocos Creator 3.8.x (`editor: ">=3.8.0 <3.9.0"`). Tested on 3.8.8 only.
- Git 2.26 or newer on `PATH` (or `COCOS_GIT_DESK_GIT`). "Create branch at commit" needs Git 2.54+.
- Python 3.9+ on `PATH` for the MCP adapter and the project update scripts (or `COCOS_GIT_DESK_PYTHON`).
- Git LFS only if the project uses it. Without LFS installed, pointer files are shown as pointers; nothing else changes.
- No Node.js or npm at runtime: the release package ships compiled `dist/` and has no third-party dependencies.

## Install

**Extension Manager.** Download `cocos-git-desk-<version>.zip` from the Releases page, then in Creator open *Extension → Extension Manager → Project* (or *Global*) and import the zip.

**Release zip by hand.** Unzip into the project so the folder is `<project>/extensions/cocos-git-desk/`, then enable it in the Extension Manager. Verify the checksum first:

```sh
shasum -a 256 -c cocos-git-desk-<version>.zip.sha256
```

**From source.**

```sh
cd <project>/extensions
git clone https://github.com/jiaqihuu/cocos-git-desk.git
cd cocos-git-desk
npm ci --ignore-scripts
npm run build
```

Then enable the extension in the Extension Manager (or reload it if it was already enabled). Open the panel with *Git Desk → Open Git Desk* or `Cmd+Alt+G` / `Ctrl+Alt+G`.

Keep only one copy enabled: if a project copy and a global copy both exist, disable one.

## Connect an AI client

The extension starts a loopback RPC server when it loads and writes `extensions/cocos-git-desk/.cache/agent-connection.json` (mode `0600`, rotated on every load). AI clients run the bundled stdio adapter, which reads that file and forwards MCP `tools/call` to the editor. Creator must be running with the project open; otherwise tools return an offline error.

**Claude Code** — copy [`templates/mcp.json`](templates/mcp.json) to `<project>/.mcp.json`. It locates the adapter through `CLAUDE_PROJECT_DIR`, so the file can be committed and shared:

```json
{
  "mcpServers": {
    "cocos-git-desk": {
      "type": "stdio",
      "command": "python3",
      "args": [
        "-c",
        "import os,runpy,sys; from pathlib import Path; root=Path(os.environ.get('CLAUDE_PROJECT_DIR') or os.getcwd()).resolve(); script=root/'extensions/cocos-git-desk/scripts/git-desk-mcp.py'; sys.argv=[str(script),'--project',str(root)]; runpy.run_path(str(script),run_name='__main__')"
      ]
    }
  }
}
```

**Codex** — add the block from [`templates/codex-config.toml`](templates/codex-config.toml) to `<project>/.codex/config.toml`, replacing `<project>` with the absolute path:

```toml
[mcp_servers.cocos-git-desk]
command = "python3"
args = ["<project>/extensions/cocos-git-desk/scripts/git-desk-mcp.py", "--project", "<project>"]
cwd = "<project>"
startup_timeout_sec = 30
tool_timeout_sec = 150
```

**Any other stdio MCP client** — run:

```sh
python3 <project>/extensions/cocos-git-desk/scripts/git-desk-mcp.py --project <project>
```

The adapter implements `initialize`, `ping`, `tools/list` and `tools/call` for MCP protocol versions 2025-11-25, 2025-06-18 and 2025-03-26. It does not implement HTTP transport, resources, prompts or cancellation. On Windows replace `python3` with the path to your Python 3 executable.

After connecting, read `git_desk_query` with `op: "capabilities"` first; the protocol, task flow and review policy are described in [docs/AGENT_API.md](docs/AGENT_API.md).

## Configure

Two files, both optional:

- `<project>/git-desk.config.json` — committed with the project: preview URL and allowed engine versions, bridge object names, revision scan roots, language key audit settings, which AI client configs the panel may write.
- `<project>/extensions/cocos-git-desk/.cache/agent-settings.json` — local only: `requireHumanReview` and the debug state/export directories.

Every key, default and meaning is in [docs/CONFIG.md](docs/CONFIG.md).

## Security model

- The RPC server binds `127.0.0.1` on a random port; requests need the per-launch token and are rejected when they carry `Origin` or `Sec-Fetch-Site` headers or a wrong `Host`.
- Requests are capped at 128 KiB and responses at 256 KiB; 8 connections, 4 in-flight calls.
- No tool runs arbitrary code. `creator_message` accepts a fixed list of read-only editor messages. Inspector scripts are bundled with the extension and expose a fixed method set.
- Git writes require a task scope recorded before editing, a reviewed plan, and a one-time token + digest that expires after two minutes. The MCP cannot approve human reviews, cannot amend commits, and always checks the whole index before a commit.
- This is a collaboration gate, not a sandbox: any program running under the same OS account that can read the token file can call the RPC.

Details and the reporting channel are in [SECURITY.md](SECURITY.md).

## Limits and tested scope

- The test suite runs on macOS, Linux and Windows in CI. Inside the editor the extension has been used with Cocos Creator 3.8.8 on macOS only; other 3.8.x versions and editors on Windows or Linux still need hands-on verification. Editor message signatures were checked against 3.8.8.
- On Windows, file names containing `* ? : " < > |` or control characters cannot exist, so the literal-path protections for such names only matter on macOS and Linux.
- On Windows the token file's protection depends on the user profile ACL; use a dedicated OS account.
- The runtime inspector injects into the embedded Debug Preview only, and only for engine versions listed in `preview.engineVersions`.
- Single-file preview limit 5 MiB; diff rendering 15,000 lines; Git command output 8 MiB; MCP response 256 KiB. Use `offset`/`limit`/`contains` to page.
- The extension uses your local Git credentials, hooks, filters and signing configuration and never stores passwords.
- Do not reload the extension or close Creator while a Git task is running.

## Development

```sh
npm ci --ignore-scripts
npm run typecheck
npm run build
npm test          # full suite, ~5 minutes, uses temporary repositories under .test-work/
npm run test:en   # every message id has an English text
npm run package   # releases/cocos-git-desk-<version>.zip + .sha256
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the i18n conventions, commit messages and test layout. Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE).
