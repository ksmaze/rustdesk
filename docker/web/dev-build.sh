#!/bin/bash
set -e

echo "==> RustDesk Web Client - Dev Build"

cd /app/rustdesk

# Apply Flutter patch if not already applied
cd /usr/local/flutter && \
    git apply /app/rustdesk/.github/patches/flutter_3.24.4_dropdown_menu_enableFilter.diff 2>/dev/null || true
cd /app/rustdesk

# Init submodules if needed
git submodule update --init --recursive 2>/dev/null || true

# --- Build JS bridge ---
echo "==> Building JS/TypeScript bridge..."
cd /app/rustdesk/flutter/web/js

# Install deps
yarn install

# Generate and build
python ./gen_js_from_hbb.py > src/gen_js_from_hbb.ts
echo 'import { use_ws } from "./shim";' | cat - src/gen_js_from_hbb.ts > src/gen_js_from_hbb.tmp
mv src/gen_js_from_hbb.tmp src/gen_js_from_hbb.ts
python ./ts_proto.py
npx tsc
npx vite build

echo "==> JS bridge built."

# --- Download web deps if needed ---
cd /app/rustdesk/flutter/web
if [ ! -d ogvjs-1.8.6 ] || [ ! -f yuv-canvas-1.2.6.js ]; then
    echo "==> Downloading web dependencies..."
    wget -q https://github.com/rustdesk/doc.rustdesk.com/releases/download/console/web_deps.tar.gz
    tar xzf web_deps.tar.gz
    rm web_deps.tar.gz
fi

# --- Flutter build ---
echo "==> Building Flutter web..."
cd /app/rustdesk/flutter
flutter pub get
flutter build web --release

echo "==> Build complete! Output in flutter/build/web/"
echo ""
echo "To serve: cd /app/rustdesk/flutter/build/web && python3 -m http.server 5000 --bind 0.0.0.0"
