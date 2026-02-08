#!/bin/bash
set -e

PORT="${RUSTDESK_PORT:-5000}"

# Generate config.js from environment variables
cat > /app/web/config.js <<CONFIGEOF
// Auto-generated RustDesk web client configuration
(function() {
  var config = {
    "custom-rendezvous-server": "${RUSTDESK_SERVER:-}",
    "key": "${RUSTDESK_KEY:-}",
    "api-server": "${RUSTDESK_API_SERVER:-}",
    "relay-server": "${RUSTDESK_RELAY_SERVER:-}"
  };
  for (var k in config) {
    if (config[k]) {
      localStorage.setItem(k, config[k]);
      console.log("[RustDesk Config] " + k + " = " + config[k]);
    }
  }
})();
CONFIGEOF

echo "==> RustDesk Web Client"
echo "    Port:             ${PORT}"
[ -n "${RUSTDESK_SERVER}" ]       && echo "    Server:           ${RUSTDESK_SERVER}"
[ -n "${RUSTDESK_KEY}" ]          && echo "    Key:              ${RUSTDESK_KEY:0:8}..."
[ -n "${RUSTDESK_API_SERVER}" ]   && echo "    API Server:       ${RUSTDESK_API_SERVER}"
[ -n "${RUSTDESK_RELAY_SERVER}" ] && echo "    Relay Server:     ${RUSTDESK_RELAY_SERVER}"
echo "==> Serving from /app/web on port ${PORT}"

cd /app/web
exec python3 -m http.server "${PORT}" --bind 0.0.0.0
