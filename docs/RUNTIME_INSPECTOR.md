# Runtime inspector

Inspect and edit the running game inside Creator's embedded Debug Preview: hierarchy, properties, selection, printing, flat UI layout and DrawCall capture. The feature set is modelled on the cc-inspector Chrome extension but is an independent implementation; no third-party extension code is included. It runs on Cocos Creator 3.8.x (tested on 3.8.8); the engine versions it may attach to are configured by `preview.engineVersions` (see [CONFIG.md](CONFIG.md)).

## How it attaches

The inspector is a script bundled with the extension (`browser-debug/inspector-frames.cjs`, `inspector-runtime.js`, `inspector-render.js`) that the main process injects into the main frame of the Debug Preview's web contents. It bootstraps from `System.import('cc')`, so it needs no change to the project: no Chrome extension, no code in `Main.ts`, nothing in release builds. If the frame has no engine, the engine is not initialised, or the version is not allowed, the panels show the reason instead of a tree.

A single collection hub in the main process polls the page and feeds three views that share one snapshot:

- **Runtime Hierarchy** and **Runtime Properties** dock panels. When you switch to the Debug Preview tab or click in the game they dock next to Creator's Hierarchy and Inspector and come to the front; switching away, opening a prefab or closing the preview closes them and restores the native panels.
- A floating **Runtime Inspector** window, opened from the preview toolbar.

New panel declarations need an extension reload; if Creator reports a missing panel or message, save your work and restart Creator.

## Using the panels

- **Search** by node name, path or non-contiguous characters. Click to select; double-click or Alt+click to collapse; arrow keys to navigate. Prefab instances are marked in blue, inactive nodes are dimmed. Nodes with a project script show a `TS` badge.
- **Click to select** (on by default): clicking in the game selects the node under the cursor and brings the runtime panels to the front; the click still reaches the game and nothing is drawn over it.
- **Pick mode** (off by default): intercepts UI clicks, highlights on hover, draws a selection box and lets you cycle through overlapping nodes. Press again or `Esc` to leave. Picking uses `UITransform` in reverse hierarchy order, not the final render order; 3D nodes and nodes without `UITransform` are selected in the tree.
- **Edit** node name, active state, position, rotation, scale; component enabled state and writable public fields. Number, boolean, string, enum, `Vec2`/`Vec3` and `Color` get matching controls; Alt-drag a number field to scrub, Shift for fine steps. Edits apply to the running instance only and are never written back to scenes, prefabs or assets. A field setter or enable toggle may run the component's normal logic.
- **Accessors** are read only when you click "Read accessors" and shown as a snapshot; "Re-read" refreshes. Private fields are read-only; complex objects can be printed to the console.
- **Undo** on the node title row reverts property edits made in this inspector session (up to 50). If the game changed the value in between, the panel reports a conflict instead of overwriting.
- **Destroy** asks for confirmation, cannot target the scene root and cannot be undone; a reload restores the normal startup state.
- **Print** writes `[Git Desk] print node <name> (<path>)` plus an indented JSON snapshot to the Creator console at Info level and brings the console forward. In the preview DevTools the printed object is available as `$gd0` in the frame's context until the inspector closes or the frame changes.
- **Related assets**: component scripts and assets referenced directly by component fields (up to 40, accessors not read) resolved through the Creator asset database; scripts can be opened or revealed, assets revealed. "Containing view" lists the nearest ancestor with a project script (up to 64 levels, 8 scripts). Prefab locate selects the file in Assets, then finds the editor node by the source `fileId` and switches to the scene editor. When a node has no source information the panel says so rather than guessing by name.
- Shortcuts while the tree has focus: `P` pick, `C` print, `Space` toggle active, `Delete` destroy.
- Styling follows Creator's native panels and reads the editor theme variables (`--color-default-fill` and friends), with fixed 3.8 dark-theme values as fallback.

## DrawCall capture

Click **DrawCall** to capture the next complete frame; all hooks are removed when the capture finishes or times out, and when the inspector is collapsed or the panel closed. The report contains:

- engine-reported GPU draw calls and triangle totals;
- the actual WebGL draw calls with parameters, shader program, FBO, active texture unit and its 2D texture, blend/stencil/depth state;
- the UI batches the engine produced, linked to the `commitComp` nodes they came from;
- UI commit order with texture, sampler, material, vertex buffer, data hash and mask differences between neighbours, as hints for batching problems.

UI batches and GPU draw calls do not map one-to-one: multiple cameras, passes, 3D and special rendering all affect the counts. Batches without an attributable node are marked as such; a state difference between neighbours is a lead, not a proven cause. Frame timing during capture is not a performance baseline.

## MCP tools

The `runtime_inspector_*` tools use the same collection hub as the panels; the Debug Preview must be open. Queries never start polling or change selection; `select` brings the runtime panels forward; `print` produces the same console output as the panel. Parameters are listed in [TOOLS.md](TOOLS.md).

| Tool | What it returns |
| --- | --- |
| `runtime_inspector_hierarchy` | Paged node list (uuid, path, depth, active, kind, scripts) with `sessionId`, `truncated`, `scanLimitReached`. Filter with `contains`, `activeOnly`, `offset`, `limit` (≤ 500). |
| `runtime_inspector_layout` | Flat UI layout: for every node with `UITransform`, `x/y/width/height` in design pixels with a top-left origin, plus anchor, scale, layer, opacity, font size, colour and sprite name; design resolution and visible size attached. Compare against a design tool's measurements. |
| `runtime_inspector_layout_compare` | Per-element `dx/dy/dw/dh`, text/font/colour match flags, items over `tolerance` (default 2) and unmatched items on either side, given a `design` array of `{name,x,y,width,height,text?,fontSize?,color?}` (top-left origin). `scale`/`offsetX`/`offsetY` map artboard coordinates to the design resolution; matching is by name (exact → case-insensitive → unique substring), nearest wins on duplicates. |
| `runtime_inspector_inspect` | Transform, prefab source, referenced assets, containing view and component fields for one node (`uuid` + current `sessionId`; a stale session is rejected). |
| `runtime_inspector_select` | Selects the node in the runtime panels and brings them forward. |
| `runtime_inspector_print` | Prints to the Creator console and returns the same record. |
| `runtime_inspector_status` | Self-check without needing the preview: preview binding, observer preference, hub state (frame, session, node count, selection, pick and click-to-select toggles), which views are visible, which Git Desk panels exist, each open panel's render summary, and the extension's recent failures. Call it before asking a human to look at the editor. |

## Lifecycle and limits

- The hub requests a snapshot every 300 ms with the previous digest; unchanged results return only the digest and trigger no redraw. After 2 s without change or interaction the interval relaxes to about 1 s; interaction, picking and DrawCall capture restore 300 ms; with no visible inspector UI polling stops.
- Each frame call combines the readiness check and the call into one evaluation. Node lookups reuse the last scan's index and validate with `isValid`.
- The main process routes calls only to the current Debug Preview web contents' frame and offers no generic script IPC. Runtime operations verify the page session and node/component identity; references from before a reload are invalid.
- Closing or switching target removes the DOM pick layer, timers, listeners and render hooks.
- A password `EditBox` never shows its text: `string`/`_string` of the box and of the label it renders into report only the length in the panels, `inspect`, `print`, field reads and `layout` text, and its input type cannot be edited. A page keeps the inspector it was loaded with until it reloads. For a page that still runs an older inspector, the main process masks the `EditBox` component's own `string`/`_string` in the panels, `inspect`, `print` and field reads, but not the separate label node or `layout` text; reload the preview after upgrading.
- Reloading the extension (Extension Manager or `creator_reload_extension`) closes an open Debug Preview tab and reopens it on the new code. If the panel loses its binding otherwise, for example after the page's debugger was detached, it binds the same page again without reloading the game.
- Scan limits: 10,000 nodes, 200 per page, 40 components per node, 80 public fields per component; arrays show the first 16 items; nested objects are not walked. GPU calls and UI commits are capped at 10,000 entries each; the report says when it is incomplete. Truncation is shown in the UI; the full object is available in DevTools.

## Not covered

Creator 2.x and 3.x versions other than those allowed by `preview.engineVersions`; native or external-browser previews (the inspector attaches to the embedded preview only); writing changes back to assets. The optional `browser_debug_*` bridge tools (UI open/close, language switch, mocks) require a project-provided bridge script and are described in the tool catalogue.
