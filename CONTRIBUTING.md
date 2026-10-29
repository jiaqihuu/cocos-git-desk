# Contributing

## Setup

Requirements: Node.js 20+, Git 2.26+ (2.54+ to run every test), Git LFS, Python 3.9+. The runtime has no third-party dependencies; the only dev dependencies are TypeScript and `@types/node`.

```sh
npm ci --ignore-scripts
npm run typecheck      # tsc --noEmit
npm run build          # tsc → dist/ (CommonJS; the tests load dist/, so build before testing)
npm test               # full suite, about 5 minutes
npm run test:en        # English-default check (no Chinese preload)
npm run package        # releases/cocos-git-desk-<version>.zip and .sha256
node scripts/tools-doc.cjs   # regenerate docs/TOOLS.md after changing static/mcp-tools*.json
```

While iterating, run a single file instead of the suite:

```sh
node --require ./tests/zh.cjs --test tests/git.test.cjs
```

Tests create temporary repositories and bare remotes under `.test-work/` inside the extension directory and clean up afterwards; they never touch a real project or remote. Tests that need `git lfs` or `python3` skip when the executable is missing. `tests/fork-tools.test.cjs` is known to time out occasionally under heavy load; rerun it before assuming a regression.

To try a change in the editor, build, then reload the extension from Creator's Extension Manager (or call `creator_reload_extension` over MCP). Reloading rotates the MCP token; the adapter picks up the new connection file on the next call.

## Layout

- `src/` TypeScript sources (`main.ts` entry, `git.ts` Git service, `agent.ts` IPC protocol v1, `mcp-bridge.ts` loopback RPC, `task-scope.ts`/`scope-reviews.ts` task baselines and human review, `creator-tools.ts`/`scene-tools.ts` editor tools, `runtime-inspector-*.ts` and `preview-*.ts` inspector and capture, `panel*.ts` UI).
- `src/i18n/` message tables, `i18n/` Creator extension i18n for `package.json` titles.
- `static/` panel HTML/CSS and the MCP tool catalogue (`mcp-tools.core.json`, `mcp-tools.inspector.json`, `mcp-tools.bridge.json`, `mcp-tools.i18n.json`).
- `browser-debug/` embedded preview binding, inspector injection scripts and their tests.
- `scripts/` the Python stdio adapter, project update scripts, packaging and doc generation.
- `tests/` `node:test` files (`*.test.cjs`).
- `docs/` user and protocol documentation.

## i18n conventions

- User-facing strings in `src/` go through `t(id, params)` from `src/i18n` (`import { t, MessageError } from './i18n'`). Domain tables live in `src/i18n/zh/<domain>.ts` and `src/i18n/en/<domain>.ts`; ids look like `git.lfsNotDownloaded`, placeholders like `{name}`.
- Add every new id to both languages in the same change. `tests/i18n.test.cjs` fails when the zh and en key sets differ; `npm run test:en` fails when an id has no English text.
- Throw `new MessageError('domain.id', params)` for user-visible errors (`.message` is localised, `.id` is stable for tests). Decide behaviour by error id, code or structured field, never by matching translated text.
- Do not translate Git command arguments, paths, protocol or JSON field names. Console log prefixes written to the Creator console use `[Git Desk]`.
- Language selection: `GIT_DESK_LANG` (`en`/`zh`) overrides, then the Creator editor language, then English. `npm test` preloads `tests/zh.cjs` so the existing Chinese assertions keep passing; new tests should prefer asserting on error ids.
- Page injection scripts under `browser-debug/` have no i18n infrastructure and are English only.

## Pull requests

- Keep `dist/` out of commits (it is ignored); CI builds it.
- Run `npm run typecheck`, `npm run build`, the tests for the files you touched, and `npm run test:en` before opening a PR. CI runs the full suite on macOS, Ubuntu and Windows.
- When you change a tool schema in `static/mcp-tools*.json`, regenerate `docs/TOOLS.md` and mention the change under "Unreleased" in `CHANGELOG.md`. Bump the protocol version in `src/agent.ts` only for incompatible changes to the IPC protocol.
- Framework-level changes (the Git service invariants, the token/digest flow, the review policy) need a sentence in the PR explaining why the existing guard was insufficient.
- Security issues: see [SECURITY.md](SECURITY.md) and do not file them as public issues.

## Commit messages

Imperative subject line under 72 characters, body explaining what changed and why. English or Chinese are both fine; keep one language per commit. Reference issues with `#123`.

## Release

Tag `vX.Y.Z` on `main`. The release workflow runs typecheck, build and packaging and attaches `cocos-git-desk-X.Y.Z.zip` plus its `.sha256` to the GitHub release. Update `version` in `package.json` and move the "Unreleased" section of `CHANGELOG.md` to the new version before tagging.
