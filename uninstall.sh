#!/usr/bin/env bash

set -euo pipefail

SCRIPT_PATH=${SCRIPT_PATH:-/usr/local/bin/wifi-loc-control.sh}
LAUNCH_AGENT_PATH=${LAUNCH_AGENT_PATH:-"$HOME/Library/LaunchAgents/WiFiLocControl.plist"}
CONFIG_DIR=${CONFIG_DIR:-"$HOME/.wifi-loc-control"}
SUDOERS_PATH=${SUDOERS_PATH:-/etc/sudoers.d/wifi-loc-control}
REMOVE_CONFIG=false

usage() {
  cat <<'EOF'
Usage:
  ./uninstall.sh                 Unload LaunchAgent and remove installed files.
  ./uninstall.sh --remove-config Also remove ~/.wifi-loc-control.
EOF
}

case "${1:-}" in
  "")
    ;;
  --remove-config)
    REMOVE_CONFIG=true
    ;;
  --help|-h)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

if [ -f "$LAUNCH_AGENT_PATH" ]; then
  launchctl bootout "gui/$(id -u)" "$LAUNCH_AGENT_PATH" >/dev/null 2>&1 || true
  launchctl unload "$LAUNCH_AGENT_PATH" >/dev/null 2>&1 || true
  rm -f "$LAUNCH_AGENT_PATH"
  printf 'removed: %s\n' "$LAUNCH_AGENT_PATH"
else
  printf 'skip: %s not found\n' "$LAUNCH_AGENT_PATH"
fi

if [ -e "$SCRIPT_PATH" ]; then
  sudo rm -f "$SCRIPT_PATH"
  printf 'removed: %s\n' "$SCRIPT_PATH"
else
  printf 'skip: %s not found\n' "$SCRIPT_PATH"
fi

if [ -e "$SUDOERS_PATH" ]; then
  sudo rm -f "$SUDOERS_PATH"
  printf 'removed: %s\n' "$SUDOERS_PATH"
fi

if [ "$REMOVE_CONFIG" = true ]; then
  rm -rf "$CONFIG_DIR"
  printf 'removed: %s\n' "$CONFIG_DIR"
else
  printf 'kept: %s\n' "$CONFIG_DIR"
fi

printf 'WiFiLocControl has been uninstalled.\n'
