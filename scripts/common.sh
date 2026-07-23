#!/usr/bin/env bash

# Shared helper functions for WiFiLocControl location scripts.
# Copy this file to ~/.wifi-loc-control/common.sh when using the examples.

set -u

WLC_SERVICE="${WLC_SERVICE:-Wi-Fi}"
WLC_LOG_PREFIX="${WLC_LOG_PREFIX:-WiFiLocControl script}"

wlc_log() {
  printf '[%s] %s: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$WLC_LOG_PREFIX" "$*"
}

wlc_notify() {
  local message="$1"
  osascript -e "display notification \"${message//\"/\\\"}\" with title \"WiFiLocControl\"" >/dev/null 2>&1 || true
}

wlc_run() {
  wlc_log "$*"
  "$@"
}

wlc_set_dns() {
  if [ "$#" -eq 0 ]; then
    wlc_log "No DNS servers configured; leaving DNS unchanged"
    return 0
  fi

  wlc_run networksetup -setdnsservers "$WLC_SERVICE" "$@"
}

wlc_clear_dns() {
  wlc_run networksetup -setdnsservers "$WLC_SERVICE" Empty
}

wlc_disable_proxies() {
  wlc_run networksetup -setwebproxystate "$WLC_SERVICE" off
  wlc_run networksetup -setsecurewebproxystate "$WLC_SERVICE" off
  wlc_run networksetup -setsocksfirewallproxystate "$WLC_SERVICE" off
}

wlc_enable_http_proxy() {
  local host="$1"
  local port="$2"

  if [ -z "$host" ] || [ -z "$port" ]; then
    wlc_log "HTTP proxy host or port is not configured; skipping proxy setup"
    return 0
  fi

  wlc_run networksetup -setwebproxy "$WLC_SERVICE" "$host" "$port"
  wlc_run networksetup -setwebproxystate "$WLC_SERVICE" on
  wlc_run networksetup -setsecurewebproxy "$WLC_SERVICE" "$host" "$port"
  wlc_run networksetup -setsecurewebproxystate "$WLC_SERVICE" on
}

wlc_mount_smb_if_missing() {
  local volume_name="$1"
  local smb_url="$2"

  if [ -z "$volume_name" ] || [ -z "$smb_url" ]; then
    wlc_log "SMB volume name or URL is not configured; skipping mount"
    return 0
  fi

  if mount | grep -q "/Volumes/$volume_name"; then
    wlc_log "Volume already mounted: /Volumes/$volume_name"
    return 0
  fi

  wlc_log "Mounting $smb_url"
  open "$smb_url"
}

wlc_unmount_if_mounted() {
  local volume_name="$1"

  if [ -z "$volume_name" ]; then
    wlc_log "Volume name is not configured; skipping unmount"
    return 0
  fi

  if mount | grep -q "/Volumes/$volume_name"; then
    wlc_run diskutil unmount "/Volumes/$volume_name"
  else
    wlc_log "Volume not mounted: /Volumes/$volume_name"
  fi
}

wlc_open_apps() {
  local app
  for app in "$@"; do
    [ -z "$app" ] && continue
    wlc_log "Opening app: $app"
    open -a "$app" >/dev/null 2>&1 || wlc_log "Could not open app: $app"
  done
}

wlc_quit_apps() {
  local app
  for app in "$@"; do
    [ -z "$app" ] && continue
    wlc_log "Quitting app: $app"
    osascript -e "tell application \"${app//\"/\\\"}\" to quit" >/dev/null 2>&1 || wlc_log "Could not quit app: $app"
  done
}

wlc_flush_dns_cache() {
  wlc_log "Flushing DNS cache"
  dscacheutil -flushcache >/dev/null 2>&1 || true
  sudo -n killall -HUP mDNSResponder >/dev/null 2>&1 || wlc_log "Could not signal mDNSResponder without sudo"
}
