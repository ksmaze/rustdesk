---
name: web-dev-build
description: How to build and test the Flutter web client (JS bridge + Flutter web)
---

# Flutter Web Client Development Build

## Prerequisites
- Docker dev container running (`rustdesk-web-dev`)
- Source files are bind-mounted at `/app/rustdesk/`

## Tech Stack
- **Flutter 3.24.5** (web target)
- **Vite 6.x** (JS bundler)
- **TypeScript 5.x**
- **Node.js 22.x LTS**
- **Dart-JS interop** via `dart:js` (`context.callMethod`)

## Architecture
The Flutter web app has two layers:
1. **JS bridge** (`flutter/web/js/`) — TypeScript/JS code compiled by Vite into `js/dist/index.js`. Exposes `window.getByName`, `window.setByName`, `window.init`, `window.isMobile`, etc.
2. **Flutter app** (`flutter/lib/`) — Dart code compiled to `main.dart.js`. Calls JS bridge via `context.callMethod('getByName', ...)` etc. in `flutter/lib/models/web_model.dart`.

### Key Dart-JS interop flow
- `web_model.dart:init()` sets `window.onInitFinished` callback, then calls `window.init()`
- `globals.js:window.init()` must call `window.onInitFinished()` after async init completes
- If `onInitFinished` is never called, the Dart init hangs and the app stays on the spinner

### JS Bridge source layout
- `flutter/web/js/src/globals.js` — Core bridge: `window.getByName`, `window.setByName`, `window.init`, `msgbox`, `draw`
- `flutter/web/js/src/connection.ts` — WebSocket connection to rendezvous/relay servers
- `flutter/web/js/src/websock.ts` — WebSocket wrapper with encryption
- `flutter/web/js/src/ui.js` — Standalone demo UI (not used by Flutter, but bundled)
- `flutter/web/js/src/codec.js` — VP9 decoder loading via OGVLoader
- `flutter/web/js/src/common.ts` — Utilities (zstd decompression, key mapping)

## Build Steps

### 1. Build JS Bridge
```bash
cd /app/rustdesk/flutter/web/js
yarn install
# Create use_ws shim if missing
[ -f src/shim.ts ] || echo 'export function use_ws(): boolean { return true; }' > src/shim.ts
# Generate TS from Dart/proto definitions
python ./gen_js_from_hbb.py > src/gen_js_from_hbb.ts
echo 'import { use_ws } from "./shim";' | cat - src/gen_js_from_hbb.ts > src/gen_js_from_hbb.tmp
mv src/gen_js_from_hbb.tmp src/gen_js_from_hbb.ts
python ./ts_proto.py
npx tsc
npx vite build
```

### 2. Build Flutter Web
```bash
cd /app/rustdesk/flutter
flutter build web --release
```

### 3. Serve and Test
```bash
cd /app/rustdesk/flutter/build/web
python3 -m http.server 5000 --bind 0.0.0.0
```
Open browser at `http://localhost:5000`

## Known Gotchas

### Duplicate identifiers in Vite bundle
When Vite bundles all modules into one scope, local function names can collide with exported ones. Example: `msgbox` in `ui.js` vs `globals.js`. Fix by renaming the local one.

### tsconfig.json: useDefineForClassFields
**Must keep `useDefineForClassFields: true`**. Removing it changes how TypeScript compiles class field declarations, causing `Connection` class fields (`_ws`, `_msgs`, `_interval`) to be `undefined` at runtime instead of properly initialized.

### vendor.js modulepreload
The `index.html` has `<link rel="modulepreload" href="js/dist/vendor.js">`. Vite 6 does NOT produce a `vendor.js` chunk by default (everything goes into `index.js`). The modulepreload is harmless (404 is ignored) but could be removed if Vite config doesn't split chunks.

### Script load order race condition
`<script type="module">` (JS bridge) is always deferred. `<script async>` (Flutter bootstrap) can execute earlier. If `main.dart.js` runs before the JS bridge module, `window.getByName` is undefined. The current setup works because `main.dart.js` is large enough to always load after the small bridge module, but adding a readiness check in `flutter_bootstrap.js` is a safer approach if issues arise.

### Apple mobile web app meta tag
`<meta name="apple-mobile-web-app-capable" content="yes">` is deprecated. Use `<meta name="mobile-web-app-capable" content="yes">` instead.

## Quick Rebuild (JS bridge only)
// turbo
```bash
docker exec rustdesk-web-dev bash -c "cd /app/rustdesk/flutter/web/js && npx tsc && npx vite build"
```

## Quick Rebuild (Flutter only, after JS bridge is built)
```bash
docker exec rustdesk-web-dev bash -c "cd /app/rustdesk/flutter && flutter build web --release"
```

## Full Rebuild + Serve
```bash
docker exec rustdesk-web-dev bash -c "cd /app/rustdesk/flutter/web/js && npx tsc && npx vite build && cd /app/rustdesk/flutter && flutter build web --release && pkill -f 'http.server' || true; cd /app/rustdesk/flutter/build/web && python3 -m http.server 5000 --bind 0.0.0.0 &"
```
