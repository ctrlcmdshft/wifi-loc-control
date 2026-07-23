#!/usr/bin/env bash

LOGS_PATH=${LOGS_PATH:-"$HOME/Library/Logs/WiFiLocControl.log"}
DEFAULT_NETWORK_LOCATION=${DEFAULT_NETWORK_LOCATION:-Automatic}
CONFIG_DIR=${CONFIG_DIR:-"$HOME/.wifi-loc-control"}
ALIAS_CONFIG_PATH=${ALIAS_CONFIG_PATH:-"$CONFIG_DIR/alias.conf"}
STATE_PATH=${STATE_PATH:-"$CONFIG_DIR/state"}
LOCK_DIR=${LOCK_DIR:-"$CONFIG_DIR/run.lock"}
SCRIPT_TIMEOUT_SECONDS=${SCRIPT_TIMEOUT_SECONDS:-60}
LAUNCH_AGENT_LABEL=${LAUNCH_AGENT_LABEL:-application.com.wifi-loc-control}
LAUNCH_AGENT_PATH=${LAUNCH_AGENT_PATH:-"$HOME/Library/LaunchAgents/WiFiLocControl.plist"}
INSTALL_PATH=${INSTALL_PATH:-/usr/local/bin/wifi-loc-control.sh}

MODE=run
SHOULD_LOG_TO_FILE=true

usage() {
  cat <<'EOF'
Usage:
  wifi-loc-control.sh                   Switch to the detected network location.
  wifi-loc-control.sh --preview         Show what would happen without switching.
  wifi-loc-control.sh --doctor          Check install/config health.
  wifi-loc-control.sh --validate-config Validate alias and script configuration.
  wifi-loc-control.sh --help            Show this help.
EOF
}

case "${1:-}" in
  "")
    ;;
  --preview|preview)
    MODE=preview
    SHOULD_LOG_TO_FILE=false
    ;;
  --doctor|doctor)
    MODE=doctor
    SHOULD_LOG_TO_FILE=false
    ;;
  --validate-config|validate-config)
    MODE=validate
    SHOULD_LOG_TO_FILE=false
    ;;
  --help|-h|help)
    SHOULD_LOG_TO_FILE=false
    usage
    exit 0
    ;;
  *)
    SHOULD_LOG_TO_FILE=false
    usage >&2
    exit 2
    ;;
esac

if [ "$SHOULD_LOG_TO_FILE" = true ]; then
  mkdir -p "$(dirname "$LOGS_PATH")"
  exec >> "$LOGS_PATH" 2>&1
  sleep 3
fi

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2
}

print_kv() {
  printf '%-24s %s\n' "$1:" "$2"
}

is_empty_or_redacted() {
  [ -z "$1" ] || [ "$1" = "<redacted>" ] || [ "$1" = "< redacted >" ]
}

wifi_device() {
  networksetup -listallhardwareports 2>/dev/null | awk '
    $0 == "Hardware Port: Wi-Fi" { found = 1; next }
    found && /^Device: / { print $2; exit }
  '
}

get_wifi_name() {
  local device="${1:-}"
  local wifi_name_new=""
  local wifi_name_verbose=""
  local wifi_name_plist=""
  local wifi_name_fallback=""

  [ -z "$device" ] && device="en0"

  if command -v ipconfig >/dev/null 2>&1; then
    wifi_name_new=$(ipconfig getsummary "$device" 2>/dev/null | awk -F ' SSID : ' '/ SSID : / {print $2}' | tr -d '\n')
    if ! is_empty_or_redacted "$wifi_name_new"; then
      echo "$wifi_name_new"
      return 0
    fi

    if sudo -n ipconfig setverbose 1 >/dev/null 2>&1; then
      sudo ipconfig setverbose 1 >/dev/null 2>&1
      wifi_name_verbose=$(ipconfig getsummary "$device" 2>/dev/null | awk -F ' SSID : ' '/ SSID : / {print $2}' | tr -d '\n')
      sudo ipconfig setverbose 0 >/dev/null 2>&1

      if ! is_empty_or_redacted "$wifi_name_verbose"; then
        echo "$wifi_name_verbose"
        return 0
      fi
    fi
  fi

  wifi_name_plist=$(/usr/libexec/PlistBuddy -c 'Print :0:_items:0:spairport_airport_interfaces:0:spairport_current_network_information:_name' /dev/stdin <<< "$(system_profiler SPAirPortDataType -xml)" 2>/dev/null)
  if ! is_empty_or_redacted "$wifi_name_plist"; then
    echo "$wifi_name_plist"
    return 0
  fi

  wifi_name_fallback=$(networksetup -listpreferredwirelessnetworks "$device" 2>/dev/null | sed -n '2 p' | tr -d '\t')
  if ! is_empty_or_redacted "$wifi_name_fallback"; then
    echo "$wifi_name_fallback"
    return 0
  fi

  echo ""
}

normalize_bssid() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]'
}

get_wifi_bssid() {
  local device="${1:-}"
  local bssid=""

  [ -z "$device" ] && device="en0"

  if command -v ipconfig >/dev/null 2>&1; then
    bssid=$(ipconfig getsummary "$device" 2>/dev/null | awk -F ' : ' '/ BSSID : / {print $2; exit}' | tr -d '\n')
    if ! is_empty_or_redacted "$bssid"; then
      normalize_bssid "$bssid"
      return 0
    fi

    if sudo -n ipconfig setverbose 1 >/dev/null 2>&1; then
      sudo ipconfig setverbose 1 >/dev/null 2>&1
      bssid=$(ipconfig getsummary "$device" 2>/dev/null | awk -F ' : ' '/ BSSID : / {print $2; exit}' | tr -d '\n')
      sudo ipconfig setverbose 0 >/dev/null 2>&1

      if ! is_empty_or_redacted "$bssid"; then
        normalize_bssid "$bssid"
        return 0
      fi
    fi
  fi

  echo ""
}

network_locations() {
  scselect 2>/dev/null | sed -n 's/^ .*(\(.*\))/\1/p'
}

current_network_location() {
  scselect 2>/dev/null | sed -n 's/ \* .*(\(.*\))/\1/p'
}

has_network_location() {
  local wanted="$1"
  network_locations | grep -Fxq "$wanted"
}

alias_for_bssid() {
  local bssid
  local line=""
  local key=""
  local value=""

  bssid=$(normalize_bssid "$1")

  [ -n "$bssid" ] || return 1
  [ -f "$ALIAS_CONFIG_PATH" ] || return 1

  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ""|\#*) continue ;;
    esac

    key=${line%%=*}
    value=${line#*=}

    [ "$line" = "$key" ] && continue
    [ -n "$value" ] || continue

    case "$key" in
      bssid:*|BSSID:*)
        key=${key#*:}
        ;;
      bssid\ *|BSSID\ *)
        key=${key#* }
        ;;
      *)
        continue
        ;;
    esac

    [ "$(normalize_bssid "$key")" = "$bssid" ] || continue
    echo "$value"
    return 0
  done < "$ALIAS_CONFIG_PATH"

  return 1
}

alias_for_ssid() {
  local wifi_name="$1"
  local line=""
  local key=""
  local value=""

  [ -f "$ALIAS_CONFIG_PATH" ] || return 1

  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ""|\#*) continue ;;
    esac

    key=${line%%=*}
    value=${line#*=}

    [ "$line" = "$key" ] && continue
    [ -n "$value" ] || continue

    case "$key" in
      ssid:*|SSID:*)
        key=${key#*:}
        ;;
      ssid\ *|SSID\ *)
        key=${key#* }
        ;;
    esac

    [ "$key" = "$wifi_name" ] || continue
    echo "$value"
    return 0
  done < "$ALIAS_CONFIG_PATH"

  return 1
}

acquire_lock() {
  mkdir -p "$CONFIG_DIR"
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM
    return 0
  fi

  log "another WiFiLocControl run is already active; exiting"
  exit 0
}

write_state() {
  local wifi_name="$1"
  local location="$2"
  local bssid="${3:-}"

  mkdir -p "$CONFIG_DIR"
  {
    printf 'wifi_name=%s\n' "$wifi_name"
    printf 'bssid=%s\n' "$bssid"
    printf 'location=%s\n' "$location"
    printf 'updated_at=%s\n' "$(date '+%Y-%m-%d %H:%M:%S')"
  } > "$STATE_PATH"
}

run_with_timeout() {
  local timeout_seconds="$1"
  shift

  "$@" &
  local pid=$!
  local elapsed=0

  while kill -0 "$pid" 2>/dev/null; do
    if [ "$elapsed" -ge "$timeout_seconds" ]; then
      log "script timed out after ${timeout_seconds}s; terminating pid $pid"
      kill "$pid" 2>/dev/null || true
      sleep 2
      kill -9 "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  wait "$pid"
}

exec_location_script() {
  local location="$1"
  local wifi_name="$2"
  local bssid="${3:-}"
  local script_file="$CONFIG_DIR/$location"
  local exit_code=0

  log "finding script for location '$location'"

  if [ ! -f "$script_file" ]; then
    log "script for location '$location' not found"
    return 0
  fi

  chmod +x "$script_file"
  log "running script '$script_file' with ${SCRIPT_TIMEOUT_SECONDS}s timeout"

  set +e
  run_with_timeout "$SCRIPT_TIMEOUT_SECONDS" "$script_file"
  exit_code=$?
  set -e

  log "script '$script_file' exited with code $exit_code"

  if [ "$exit_code" -eq 0 ]; then
    write_state "$wifi_name" "$location" "$bssid"
  fi

  return "$exit_code"
}

detect_plan() {
  local device="$1"
  local wifi_name="$2"
  local bssid="$3"
  local current_location="$4"
  local alias_location="$wifi_name"
  local alias_source="none"
  local alias_match="ssid"
  local target_location=""
  local action="none"
  local script_file=""

  if [ -f "$ALIAS_CONFIG_PATH" ]; then
    log "reading alias config '$ALIAS_CONFIG_PATH'"
    if alias=$(alias_for_bssid "$bssid"); then
      alias_location="$alias"
      alias_source="$ALIAS_CONFIG_PATH"
      alias_match="bssid"
      log "for bssid '$bssid' found alias '$alias_location'"
    elif alias=$(alias_for_ssid "$wifi_name"); then
      alias_location="$alias"
      alias_source="$ALIAS_CONFIG_PATH"
      alias_match="ssid"
      log "for wifi name '$wifi_name' found alias '$alias_location'"
    else
      log "for wifi name '$wifi_name' / bssid '$bssid' alias not found"
    fi
  fi

  if has_network_location "$alias_location"; then
    target_location="$alias_location"
  else
    target_location="$DEFAULT_NETWORK_LOCATION"
  fi

  if [ "$target_location" = "$current_location" ]; then
    action="none"
  else
    action="switch"
  fi

  script_file="$CONFIG_DIR/$target_location"

  printf 'device=%s\n' "$device"
  printf 'wifi_name=%s\n' "$wifi_name"
  printf 'bssid=%s\n' "$bssid"
  printf 'current_location=%s\n' "$current_location"
  printf 'alias_location=%s\n' "$alias_location"
  printf 'alias_source=%s\n' "$alias_source"
  printf 'alias_match=%s\n' "$alias_match"
  printf 'target_location=%s\n' "$target_location"
  printf 'action=%s\n' "$action"
  printf 'script_file=%s\n' "$script_file"
}

plan_value() {
  local key="$1"
  sed -n "s/^${key}=//p" | tail -n 1
}

preview() {
  local device="$1"
  local wifi_name="$2"
  local current_location="$3"
  local plan="$4"
  local target_location=""
  local action=""
  local script_file=""
  local alias_location=""
  local alias_source=""
  local alias_match=""
  local bssid=""

  target_location=$(printf '%s\n' "$plan" | plan_value target_location)
  action=$(printf '%s\n' "$plan" | plan_value action)
  script_file=$(printf '%s\n' "$plan" | plan_value script_file)
  alias_location=$(printf '%s\n' "$plan" | plan_value alias_location)
  alias_source=$(printf '%s\n' "$plan" | plan_value alias_source)
  alias_match=$(printf '%s\n' "$plan" | plan_value alias_match)
  bssid=$(printf '%s\n' "$plan" | plan_value bssid)

  print_kv "Wi-Fi device" "$device"
  print_kv "Current SSID" "$wifi_name"
  print_kv "Current BSSID" "${bssid:-unknown/redacted}"
  print_kv "Current location" "$current_location"
  print_kv "Alias target" "$alias_location"
  print_kv "Alias source" "$alias_source"
  print_kv "Alias match" "$alias_match"
  print_kv "Target location" "$target_location"
  print_kv "Action" "$action"
  print_kv "Location script" "$script_file"

  if [ -f "$script_file" ]; then
    print_kv "Script exists" "yes"
  else
    print_kv "Script exists" "no"
  fi
}

doctor_check() {
  local label="$1"
  local status="$2"
  local details="${3:-}"

  if [ -n "$details" ]; then
    printf '[%s] %s - %s\n' "$status" "$label" "$details"
  else
    printf '[%s] %s\n' "$status" "$label"
  fi
}

validate_config() {
  local line=""
  local key=""
  local value=""
  local normalized_key=""
  local script_file=""
  local seen_file=""
  local issue_count=0
  local line_number=0

  seen_file=$(mktemp "${TMPDIR:-/tmp}/wifi-loc-control-seen.XXXXXX")
  trap 'rm -f "$seen_file"' RETURN

  if [ ! -f "$ALIAS_CONFIG_PATH" ]; then
    doctor_check "Alias config" "info" "not configured"
    return 0
  fi

  while IFS= read -r line || [ -n "$line" ]; do
    line_number=$((line_number + 1))

    case "$line" in
      ""|\#*) continue ;;
    esac

    key=${line%%=*}
    value=${line#*=}

    if [ "$line" = "$key" ]; then
      doctor_check "Alias line $line_number" "warn" "missing '='"
      issue_count=$((issue_count + 1))
      continue
    fi

    if [ -z "$key" ] || [ -z "$value" ]; then
      doctor_check "Alias line $line_number" "warn" "empty key or location"
      issue_count=$((issue_count + 1))
      continue
    fi

    case "$key" in
      bssid:*|BSSID:*)
        normalized_key="bssid:$(normalize_bssid "${key#*:}")"
        ;;
      bssid\ *|BSSID\ *)
        normalized_key="bssid:$(normalize_bssid "${key#* }")"
        ;;
      ssid:*|SSID:*)
        normalized_key="ssid:${key#*:}"
        ;;
      ssid\ *|SSID\ *)
        normalized_key="ssid:${key#* }"
        ;;
      *)
        normalized_key="ssid:$key"
        ;;
    esac

    if grep -Fxq "$normalized_key" "$seen_file"; then
      doctor_check "Alias line $line_number" "warn" "duplicate alias key '$key'"
      issue_count=$((issue_count + 1))
    else
      printf '%s\n' "$normalized_key" >> "$seen_file"
    fi

    if ! has_network_location "$value"; then
      doctor_check "Alias line $line_number" "warn" "location '$value' does not exist"
      issue_count=$((issue_count + 1))
    fi
  done < "$ALIAS_CONFIG_PATH"

  while IFS= read -r location; do
    script_file="$CONFIG_DIR/$location"
    [ -f "$script_file" ] || continue
    if [ ! -x "$script_file" ]; then
      doctor_check "Script '$location'" "warn" "$script_file exists but is not executable"
      issue_count=$((issue_count + 1))
    fi
  done < <(network_locations)

  if [ "$issue_count" -eq 0 ]; then
    doctor_check "Config validation" "ok" "no issues found"
  else
    doctor_check "Config validation" "warn" "$issue_count issue(s) found"
  fi

  return "$issue_count"
}

background_items_check() {
  local btm_dump=""

  if ! command -v sfltool >/dev/null 2>&1; then
    doctor_check "Background items check" "info" "sfltool unavailable"
    return 0
  fi

  btm_dump=$(sfltool dumpbtm 2>/dev/null || true)

  if ! printf '%s\n' "$btm_dump" | grep -qi "wifi-loc-control"; then
    doctor_check "Background items entry" "info" "no wifi-loc-control entry found"
    return 0
  fi

  if printf '%s\n' "$btm_dump" | awk '
    /Disposition: \[disabled/ { previous_disabled = 1; next }
    /Identifier: Unknown Developer/ && previous_disabled { unknown_developer_disabled = 1 }
    /Name: wifi-loc-control/ { wifi_loc_control = 1 }
    END { exit !(wifi_loc_control && unknown_developer_disabled) }
  '; then
    doctor_check "Background items entry" "warn" "Unknown Developer parent appears disabled in Login Items & Extensions"
  else
    doctor_check "Background items entry" "ok" "found wifi-loc-control in Background Task Management"
  fi
}

doctor() {
  local device="$1"
  local wifi_name="$2"
  local current_location="$3"
  local plan="$4"
  local target_location=""
  local script_file=""
  local bssid=""

  target_location=$(printf '%s\n' "$plan" | plan_value target_location)
  script_file=$(printf '%s\n' "$plan" | plan_value script_file)
  bssid=$(printf '%s\n' "$plan" | plan_value bssid)

  [ -x "$INSTALL_PATH" ] && doctor_check "Installed script" "ok" "$INSTALL_PATH" || doctor_check "Installed script" "warn" "$INSTALL_PATH is missing or not executable"
  [ -f "$LAUNCH_AGENT_PATH" ] && doctor_check "LaunchAgent plist" "ok" "$LAUNCH_AGENT_PATH" || doctor_check "LaunchAgent plist" "warn" "$LAUNCH_AGENT_PATH is missing"

  if launchctl print "gui/$(id -u)/$LAUNCH_AGENT_LABEL" >/dev/null 2>&1; then
    doctor_check "LaunchAgent loaded" "ok" "$LAUNCH_AGENT_LABEL"
  else
    doctor_check "LaunchAgent loaded" "warn" "$LAUNCH_AGENT_LABEL is not loaded"
  fi

  [ -d "$CONFIG_DIR" ] && doctor_check "Config directory" "ok" "$CONFIG_DIR" || doctor_check "Config directory" "warn" "$CONFIG_DIR is missing"
  [ -f "$ALIAS_CONFIG_PATH" ] && doctor_check "Alias config" "ok" "$ALIAS_CONFIG_PATH" || doctor_check "Alias config" "info" "not configured"
  [ -n "$device" ] && doctor_check "Wi-Fi device" "ok" "$device" || doctor_check "Wi-Fi device" "warn" "not detected"

  if is_empty_or_redacted "$wifi_name"; then
    doctor_check "Current SSID" "warn" "empty or redacted"
  else
    doctor_check "Current SSID" "ok" "$wifi_name"
  fi

  if [ -n "$bssid" ]; then
    doctor_check "Current BSSID" "ok" "$bssid"
  else
    doctor_check "Current BSSID" "info" "empty or redacted"
  fi

  [ -n "$current_location" ] && doctor_check "Current location" "ok" "$current_location" || doctor_check "Current location" "warn" "not detected"

  if has_network_location "$target_location"; then
    doctor_check "Target location" "ok" "$target_location"
  else
    doctor_check "Target location" "warn" "$target_location does not exist"
  fi

  if [ -f "$script_file" ]; then
    if [ -x "$script_file" ]; then
      doctor_check "Location script" "ok" "$script_file"
    else
      doctor_check "Location script" "warn" "$script_file exists but is not executable"
    fi
  else
    doctor_check "Location script" "info" "none at $script_file"
  fi

  if [ -f "$LOGS_PATH" ]; then
    doctor_check "Log file" "ok" "$LOGS_PATH"
  else
    doctor_check "Log file" "info" "not created yet"
  fi

  validate_config || true
  background_items_check

  echo
  preview "$device" "$wifi_name" "$current_location" "$plan"
}

main() {
  local device=""
  local wifi_name=""
  local bssid=""
  local locations=""
  local current_location=""
  local plan=""
  local target_location=""
  local action=""

  if [ "$MODE" = validate ]; then
    validate_config
    return $?
  fi

  device=$(wifi_device)
  [ -z "$device" ] && device="en0"

  wifi_name="$(get_wifi_name "$device")"
  bssid="$(get_wifi_bssid "$device")"
  log "current wifi_name '$wifi_name'"
  log "current bssid '${bssid:-unknown/redacted}'"

  if is_empty_or_redacted "$wifi_name"; then
    log "wifi_name is empty or redacted - this may be due to macOS privacy restrictions"
    log "If you're on macOS 26+, ensure the bootstrap script was run to set up sudo permissions"
    [ "$MODE" = run ] && exit 0
  fi

  locations=$(network_locations | xargs)
  log "network locations: $locations"

  current_location=$(current_network_location)
  log "current network location '$current_location'"

  plan=$(detect_plan "$device" "$wifi_name" "$bssid" "$current_location")

  case "$MODE" in
    preview)
      preview "$device" "$wifi_name" "$current_location" "$plan"
      ;;
    doctor)
      doctor "$device" "$wifi_name" "$current_location" "$plan"
      ;;
    run)
      acquire_lock
      target_location=$(printf '%s\n' "$plan" | plan_value target_location)
      action=$(printf '%s\n' "$plan" | plan_value action)

      if [ "$action" = "none" ]; then
        log "switch location is not required"
        exit 0
      fi

      scselect "$target_location"
      log "location switched to '$target_location'"
      exec_location_script "$target_location" "$wifi_name" "$bssid"
      ;;
  esac
}

main
