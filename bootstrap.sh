#!/usr/bin/env bash
# Install or remove the WiFiLocControl LaunchAgent for the current user.
set -euo pipefail

SCRIPT_NAME=wifi-loc-control.sh
INSTALL_PATH=/usr/local/bin/wifi-loc-control.sh
LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
PLIST_NAME=WiFiLocControl.plist
PLIST_PATH="${LAUNCH_AGENTS_DIR}/${PLIST_NAME}"
LABEL=application.com.wifi-loc-control
SUDOERS_PATH=/etc/sudoers.d/wifi-loc-control
CONFIG_DIR="${HOME}/.wifi-loc-control"
# This path and these arguments must match wifi-loc-control.sh.
IPCONFIG_BIN=/usr/sbin/ipconfig

usage() {
  cat <<'EOF'
Usage: ./bootstrap.sh [--uninstall]

Install WiFiLocControl for the current user. Run it again to update the
script, the LaunchAgent, and the ipconfig permission.

  ./bootstrap.sh --uninstall

Removes the LaunchAgent, the installed script, and the ipconfig permission.
Aliases and scripts in ~/.wifi-loc-control are left in place.
EOF
}

require_macos_user() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "WiFiLocControl only installs on macOS." >&2
    exit 1
  fi
  if [[ "$(id -u)" -eq 0 ]]; then
    echo "Run ./bootstrap.sh as your user, not as root. It will ask for an administrator password when it needs one." >&2
    exit 1
  fi
}

source_dir() {
  (
    cd "$(dirname -- "$0")" && pwd
  )
}

install_sudoers() {
  local user tmp
  user=$(id -un)
  case "$user" in
    ""|*[!A-Za-z0-9._-]*)
      echo "Cannot write a sudoers rule for user name '${user}'." >&2
      return 1
      ;;
  esac

  tmp=$(mktemp)
  cat > "$tmp" <<EOF
# Lets WiFiLocControl read the current Wi-Fi name on macOS versions that redact it.
# Verbose mode is enabled only for that read, then turned off again.
${user} ALL=(root) NOPASSWD: ${IPCONFIG_BIN} setverbose 0, ${IPCONFIG_BIN} setverbose 1
EOF

  if ! sudo visudo -cf "$tmp"; then
    rm -f "$tmp"
    echo "Refusing to install ${SUDOERS_PATH}; visudo rejected the rule." >&2
    return 1
  fi

  sudo cp "$tmp" "$SUDOERS_PATH"
  rm -f "$tmp"
  sudo chown root:wheel "$SUDOERS_PATH"
  sudo chmod 440 "$SUDOERS_PATH"
}

bootout_agent() {
  local uid
  uid=$(id -u)
  launchctl bootout "gui/${uid}/${LABEL}" >/dev/null 2>&1 || true
  launchctl bootout "gui/${uid}" "$PLIST_PATH" >/dev/null 2>&1 || true
  launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
}

bootstrap_agent() {
  local uid
  uid=$(id -u)
  launchctl enable "gui/${uid}/${LABEL}" >/dev/null 2>&1 || true
  if launchctl bootstrap "gui/${uid}" "$PLIST_PATH"; then
    return 0
  fi
  launchctl load -w "$PLIST_PATH"
}

install_tool() {
  local src
  src=$(source_dir)
  require_macos_user
  sudo -v

  if [[ ! -d /usr/local/bin ]]; then
    sudo mkdir -p /usr/local/bin
  fi
  sudo install -m 755 "${src}/${SCRIPT_NAME}" "$INSTALL_PATH"

  mkdir -p "$CONFIG_DIR"
  chmod 700 "$CONFIG_DIR"
  mkdir -p "$LAUNCH_AGENTS_DIR"
  cp -f "${src}/${PLIST_NAME}" "$PLIST_PATH"

  if ! install_sudoers; then
    echo "Warning: passwordless ipconfig was not configured. Wi-Fi names may stay redacted on newer macOS versions." >&2
  fi

  bootout_agent
  bootstrap_agent

  echo "WiFiLocControl is installed."
  echo "Logs: ${HOME}/Library/Logs/WiFiLocControl.log"
  echo "Aliases and scripts: ${CONFIG_DIR}"
}

uninstall_tool() {
  require_macos_user
  sudo -v
  bootout_agent
  rm -f "$PLIST_PATH"
  sudo rm -f "$INSTALL_PATH"
  sudo rm -f "$SUDOERS_PATH"

  echo "WiFiLocControl is uninstalled."
  echo "Left aliases and scripts in ${CONFIG_DIR}."
  echo "Left logs in ${HOME}/Library/Logs/WiFiLocControl.log."
  echo "Remove those yourself if you do not want them anymore."
}

main() {
  case "${1:-}" in
    ""|--install)
      install_tool
      ;;
    --uninstall|-u)
      uninstall_tool
      ;;
    --help|-h)
      usage
      ;;
    *)
      usage >&2
      exit 1
      ;;
  esac
}

main "$@"
