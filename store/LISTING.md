# Cocos Store listing draft

Fields of the Cocos developer center form (Store → New resource). The resource name cannot be changed after it is confirmed.

| Field | Value |
| --- | --- |
| Name (permanent) | Git Desk for Cocos Creator |
| Category | Creator Extension → Plugins |
| Supported Creator versions | 3.8.x (tested on 3.8.8) |
| Price | 0 (free, MIT) |
| Package | `releases/cocos-git-desk-0.2.2.zip` built by `npm run package`, under 100 MB |
| Source | https://github.com/jiaqihuu/cocos-git-desk |
| Keywords | git, mcp, ai, claude code, codex, prefab diff, meta check, runtime inspector, submodule, lfs |

## Short description

**中文**：在编辑器里管理项目与子模块的 Git，并通过受限的 MCP 让 AI 客户端安全地使用 Git、编辑器和运行中的预览。

**English**: Git for your project and its submodules inside Cocos Creator, plus a scoped MCP that lets AI clients use Git, the editor and the running preview safely.

## Long description

### 中文

Git Desk 是 Cocos Creator 3.8 的编辑器扩展，包含三部分：

- **Git 面板**：主仓库与递归子模块的改动、逐行暂存、历史、Blame、分支、标签、Stash、远端、合并与冲突处理、LFS。提交前检查资源与 .meta 是否成对、uuid 是否重复。
- **AI 用的 MCP**：77 个工具，分为 Git、编辑器、运行时检查器、项目桥四组。所有写操作都要先建任务范围，再用一次性令牌执行；没有任意代码执行，编辑器消息只开放只读白名单。支持 Claude Code、Codex 和其他 stdio MCP 客户端。
- **调试预览与运行时检查器**：内嵌预览里查看运行中游戏的节点树和组件属性，停靠在原生层级管理器与属性检查器旁；点击画面选中节点、改属性可撤销、DrawCall 分析、布局与设计稿逐元素对照。

另外提供 .prefab／.scene 的语义差异（节点、组件、属性、资源引用），以及多语言 key 审计与 CSV 草稿。

运行需要本机 Git 与 Python 3；不需要 Node.js 或 npm。界面支持中文和英文。

### English

Git Desk is a Cocos Creator 3.8 editor extension in three parts:

- **Git panel**: changes across the main repository and recursive submodules, line staging, history, blame, branches, tags, stashes, remotes, merge and conflict resolution, LFS. Commits are checked for asset/.meta pairs and duplicate uuids.
- **MCP for AI clients**: 77 tools in four groups (Git, editor, runtime inspector, project bridge). Every write needs a task scope and a one-time token; there is no arbitrary code execution and editor messages are limited to a read-only allowlist. Works with Claude Code, Codex and any stdio MCP client.
- **Debug preview and runtime inspector**: the live node tree and component properties of the running game in an embedded preview, docked next to Creator's own hierarchy and inspector; click to select, undoable property edits, draw call analysis, per-element layout comparison with design measurements.

It also gives a semantic diff of .prefab/.scene files (nodes, components, properties, asset references) and a language key audit with CSV drafts.

Requires Git and Python 3 on the machine; no Node.js or npm. English and Chinese UI.

## Screenshots to capture (in a real project, Creator 3.8.8)

1. Git Desk panel: working tree changes with a diff open.
2. Debug Preview with Runtime Hierarchy and Runtime Properties docked.
3. The "Configure AI client" snippet area.
4. A `creator_prefab_diff` or `git_desk_commit_check` result in an AI client (optional).
