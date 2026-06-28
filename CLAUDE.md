# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Interactive physics modules (TypeScript + Canvas 2D, **no runtime dependencies**),
organized as tabs and bundled with Vite. UI text is in French; keep new
user-facing strings and comments in French to match. Each module is a
self-contained animated `<canvas>` visualization that draws everything by hand —
there is no graphics library. The Maxwell module ships its own tiny 3D engine
(perspective projection + mouse orbital camera).

## Commands

```bash
npm install         # dev deps only (Vite + TypeScript); nothing at runtime
npm run dev         # Vite dev server + HMR -> http://localhost:5173
npm run build       # static production build -> dist/
npm run preview     # serve dist/ locally
npm run typecheck   # tsc --noEmit
```

There is no test suite and no linter configured. `npm run typecheck` is the only
static check. **The build does not fail on type errors** — esbuild (via Vite)
strips types without checking them, so the site always compiles; run `typecheck`
separately for type rigor. `tsconfig.json` is intentionally loose (`strict: false`,
`noImplicitAny: false`).

## Architecture

A **shell** owns a module registry and a tab bar. Exactly one module is *mounted*
at a time; switching tabs unmounts the current one (stopping its `requestAnimationFrame`
loop) before mounting the next. The active tab is mirrored in the URL hash (`#id`),
and `hashchange` is honored for deep links.

Registration is **side-effect based**: importing a module file calls `register()`.

- `index.html` — minimal shell; loads `src/main.ts` as an ES module. The DOM
  anchors the shell writes into are fixed: `#tabs`, `#module-root`, `#subtitle`,
  `#footer`.
- `src/main.ts` — imports `style.css`, imports each module **for its side effect**
  (this is what registers it), then calls `boot()`.
- `src/registry.ts` — `register()` / `getModules()` over a shared array.
- `src/shell.ts` — `boot()`: builds tabs, manages mount/unmount lifecycle, syncs URL hash.
- `src/types.ts` — the `PhysicsModule` contract and `ModuleInstance` (`{ unmount? }`).
- `src/modules/*.ts` — one file per module (~550–770 lines each).

### Adding a module

1. Create `src/modules/my-module.ts` that calls `register({...})` at import time:

   ```ts
   import { register } from "../registry";

   function mount(root: HTMLElement) {
     // inject DOM into `root`, start the rAF loop…
     return { unmount() { /* cancel rAF, release refs */ } };
   }

   register({ id: "my-module", title: "…", subtitle: "…", help: "…", mount });
   ```

2. Add `import "./modules/my-module";` to `src/main.ts`. **Tab order = import
   order in `main.ts`.** The first registered module is the default tab.

`mount(root)` must return `{ unmount }` (or void) — `unmount` is mandatory in
practice to stop the animation loop and avoid leaks/overlapping rAF loops when
the user switches tabs. `help` is injected as raw HTML into `#footer`.

## Deployment

The built site is fully static. The multi-stage `Dockerfile` builds with Node then
serves `dist/` from `nginx:alpine` (`nginx.conf` handles gzip + long-cache for
Vite's hashed `/assets/`, no-cache for `index.html`). `docker compose up -d --build`
exposes it on port 8087 (intended for an Unraid NAS — see README for the Unraid paths).
`vite.config.ts` uses `base: "./"` (relative paths) so the site works under any
reverse-proxy sub-path without reconfiguration.

## Dev container

`.devcontainer/` provides Node 20 + TypeScript and runs `post-create.sh`, which
installs the Claude Code CLI and adds a hook that **auto-launches `claude
--dangerously-skip-permissions`** in interactive terminals (guarded by `[ -t 1 ]`
and `CLAUDE_AUTOSTARTED` so it doesn't recurse into subshells).
