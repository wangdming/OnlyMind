#!/usr/bin/env bash
# Install OnlyMind as a macOS LaunchAgent (auto-starts at login, restarts on crash).
#
# Usage:
#   ONLYMIND_TOKEN=your-strong-token ./scripts/autostart-install.sh
#   # or
#   ./scripts/autostart-install.sh your-strong-token
#
# A fixed token is REQUIRED here: a background service can't show you a
# randomly generated one.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.onlymind"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE_BIN="$(command -v node || true)"
TOKEN="${ONLYMIND_TOKEN:-${1:-}}"
PORT="${ONLYMIND_PORT:-8787}"

if [[ -z "$NODE_BIN" ]]; then
  echo "ERROR: node not found on PATH." >&2; exit 1
fi
if [[ -z "$TOKEN" ]]; then
  echo "ERROR: provide a token via ONLYMIND_TOKEN env or first argument." >&2; exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$PROJECT_DIR/data"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>              <string>$LABEL</string>
  <key>WorkingDirectory</key>   <string>$PROJECT_DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$PROJECT_DIR/src/index.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ONLYMIND_TOKEN</key> <string>$TOKEN</string>
    <key>ONLYMIND_PORT</key>  <string>$PORT</string>
    <key>PATH</key>           <string>$(dirname "$NODE_BIN"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>          <true/>
  <key>KeepAlive</key>         <true/>
  <key>StandardOutPath</key>   <string>$PROJECT_DIR/data/onlymind.log</string>
  <key>StandardErrorPath</key> <string>$PROJECT_DIR/data/onlymind.log</string>
</dict>
</plist>
PLIST_EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "✓ Installed LaunchAgent: $PLIST"
echo "  OnlyMind is running on port $PORT and will auto-start at login."
echo "  Logs: $PROJECT_DIR/data/onlymind.log"
echo "  Uninstall: ./scripts/autostart-uninstall.sh"
