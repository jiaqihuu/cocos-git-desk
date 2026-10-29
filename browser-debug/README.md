# Browser debugging: embedded preview, runtime inspector and AI clients

Everything in this directory runs inside the Cocos Creator main process; no second MCP server, Node process or relay is needed. It ships with the extension, so a team member only has to open the project in Creator.

## For people

Open "Debug preview" from the Creator toolbar or from Git Desk. The dockable panel offers reload, zoom/fit, canvas picking, click linking, draw-call capture, evidence export, an external browser and connection state; the runtime hierarchy and runtime properties dock next to Creator's own hierarchy and inspector. "Open in external browser" gives the full browser DevTools on the same preview.

## For AI clients

There is one MCP, `cocos-git-desk`: the Python adapter in `scripts/git-desk-mcp.py` connects to the running Creator. Claude Code reads `.mcp.json` at the project root, Codex reads `.codex/config.toml`; `templates/` holds both files, and the "Configure AI clients" action in the debug preview panel writes them for the clients listed under `clients` in `git-desk.config.json` (a managed block between `# BEGIN COCOS GIT DESK (managed by Creator)` and `# END COCOS GIT DESK`; a hand-written entry is kept, the previous file is backed up under `~/.cocos-git-desk/<projectId>/backups`). Git tools, runtime inspector tools (`runtime_inspector_*`) and preview debug tools (`browser_debug_*`) are all served by the Creator main process.

AI tools observe only the embedded debug preview; the external browser offers no AI tools. The observer switch (`browser_debug_enable/disable`) is saved per machine under `~/.cocos-git-desk/<projectId>/state/` (override with `debug.stateDir` in `.cache/agent-settings.json`) and pushed to the page after every connection and reload; a newer choice made inside the page wins. Event capture (`browser_debug_start/events/summary/mark/compare/wait_for_reload`) reads the page debugging session directly. Evidence packages (`browser_debug_export`) are written under `~/.cocos-git-desk/<projectId>/exports/` (`debug.outputDir`) and never uploaded.

Preview-time commands (`browser_debug_ui_open/ui_close/language/mock_set/mock_list/mock_clear`, `hierarchy`, `inspect_node`, `state`, `timeline`, `stats`, `capture_bodies`) are executed by a page bridge the project installs in its preview build: `window.<bridge.debugName>` (default `__COCOS_GIT_DESK_DEBUG__`) with api version `bridge.apiVersion`, plus `window.<bridge.controlName>` (default `__COCOS_GIT_DESK_PREVIEW_CONTROL__`) for the observer switch. The bridge must report the project id Creator has open (`identity().projectId`, the `uuid` of the project's `package.json`). Without a bridge those tools fail with a clear message; the runtime inspector and the CDP-based capture tools still work.

## Configuration

`git-desk.config.json` at the project root: `preview.url` (default: the URL Creator serves its preview on, else `http://localhost:7456/`), `preview.engineVersions` (default `["3.8.x"]`, which engines the inspector may be injected into), `bridge.controlName` / `bridge.debugName` / `bridge.apiVersion`, `revision.roots` (default `assets` and `extensions/*/assets`, the fingerprint scope of `browser_debug_identity {compareDisk:true}`), `i18n.*` (enables `creator_language_keys`) and `clients`. Per-machine settings live in `extensions/cocos-git-desk/.cache/agent-settings.json` (`requireHumanReview`, `debug.stateDir`, `debug.outputDir`).

## Security model

The embedded page is isolated from the editor and runs without Node.js integration; the page debugging connection exists only in the Creator main process and is released when the panel closes. The embedded browser uses an in-memory session, so logins do not survive a Creator restart. Page evaluation is limited to fixed expressions built by the extension; no tool evaluates arbitrary scripts from an AI client.

## Maintenance

Host side: `src/preview-debug.ts` (switch, bridge queries, evidence export, tool dispatch), `src/preview-capture.ts` (event capture), `src/preview-sanitize.ts`, `src/preview-revision.ts` (disk fingerprint) and `src/config.ts` (configuration). The tool catalogues are `static/mcp-tools.{core,inspector,bridge,i18n}.json`. This directory keeps the embedded page connection (`embedded.cjs`), the inspector injection (`inspector-*.js/.cjs`), the external browser and client configuration (`actions.cjs`, `setup.cjs`) and the optional `skills/cocos-git-desk-debug` skill installed for Codex.

Tests: `node --test browser-debug/tests/*.test.cjs` and, after `npm run build`, `node --test tests/preview-*.test.cjs tests/mcp-bridge.test.cjs tests/config.test.cjs`. They never connect to a real browser or server and never modify a real client configuration.
