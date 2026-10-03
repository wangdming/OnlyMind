#!/usr/bin/env bash
# Remove the OnlyMind macOS LaunchAgent.
set -euo pipefail
PLIST="$HOME/Library/LaunchAgents/com.onlymind.plist"
if [[ -f "$PLIST" ]]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "✓ Uninstalled OnlyMind LaunchAgent."
else
  echo "Nothing to do: $PLIST not found."
fi
