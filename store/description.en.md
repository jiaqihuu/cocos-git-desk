Git Desk is a Cocos Creator 3.8 editor extension: Git for your project and its submodules inside the editor, plus a scoped MCP that lets AI clients (Claude Code, Codex or any stdio MCP client) use Git, the editor and the running preview safely. Free and open source under the MIT license.

## Features

- **Git panel**: changes across the main repository and recursive submodules, line staging, history, blame, branches, tags, stashes, remotes, merge and conflict resolution, LFS. Commits are checked for asset/`.meta` pairs and duplicate uuids.
- **MCP for AI clients (77 tools)**: Git, editor, runtime inspector and project bridge groups. Every write needs a task scope and a one-time token; there is no arbitrary code execution and editor messages are limited to a read-only allowlist.
- **Semantic prefab/scene diff**: nodes, components, properties and asset references that changed between two versions, instead of JSON line diffs.
- **Debug preview and runtime inspector**: the live node tree and component properties of the running game in an embedded preview, docked next to Creator's own hierarchy and inspector; click to select, undoable property edits, draw call analysis, per-element layout comparison with design measurements.
- **Language key audit**: keys added by a change, fallback file and placeholder checks, and a CSV draft for the back end.

## Install

1. Unzip into your project's `extensions/cocos-git-desk`.
2. Enable Git Desk in Creator under Extension → Extension Manager → Project, then open it with `⌘⌥G` (`Ctrl+Alt+G` on Windows).
3. AI client configuration is in the repository's `templates/` and README.

Requires Git and Python 3.9+ on the machine; Git LFS only for LFS projects. No Node.js or npm. English and Chinese UI.

## Notes

- The test suite runs on macOS, Linux and Windows; inside the editor it has been used with Creator 3.8.8 on macOS.
- Source, documentation and issues: https://github.com/jiaqihuu/cocos-git-desk
