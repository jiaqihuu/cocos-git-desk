Git Desk 是 Cocos Creator 3.8 的编辑器扩展：在编辑器里管理项目与子模块的 Git，并通过受限的 MCP 让 AI 客户端（Claude Code、Codex 或任意 stdio MCP 客户端）安全地使用 Git、编辑器和运行中的预览。免费开源，MIT 许可。

## 主要功能

- **Git 面板**：主仓库与递归子模块的改动、逐行暂存、历史、Blame、分支、标签、Stash、远端、合并与冲突处理、LFS；提交前检查资源与 `.meta` 是否成对、uuid 是否重复。
- **AI 用的 MCP（77 个工具）**：Git、编辑器、运行时检查器、项目桥四组。所有写操作都要先建任务范围，再用一次性令牌执行；没有任意代码执行，编辑器消息只开放只读白名单。
- **Prefab／场景语义差异**：按节点、组件、属性和资源引用列出两版之间的变化，而不是 JSON 行差异。
- **调试预览与运行时检查器**：在内嵌预览里查看运行中游戏的节点树和组件属性，停靠在原生层级管理器与属性检查器旁；点击画面选中节点，修改属性可撤销，DrawCall 分析，布局与设计稿逐元素对照。
- **多语言 key 审计**：找出改动新增的 key，检查各语言兜底文件和占位符，生成上传后台用的 CSV。

## 安装

1. 下载后解压到项目的 `extensions/cocos-git-desk`。
2. 在 Creator「扩展 → 扩展管理器 → 项目」启用 Git Desk，按 `⌘⌥G`（Windows `Ctrl+Alt+G`）打开面板。
3. AI 客户端的配置见仓库里的 `templates/` 与 README。

运行需要本机 Git 与 Python 3.9+；LFS 项目另需 Git LFS。不需要 Node.js 或 npm。界面支持中文和英文。

## 说明

- 测试套件在 macOS、Linux、Windows 上运行；编辑器内在 macOS 的 Creator 3.8.8 上实际使用过。
- 源码、文档与问题反馈：https://github.com/jiaqihuu/cocos-git-desk
