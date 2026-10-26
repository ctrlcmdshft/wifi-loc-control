#!/usr/bin/env bash
# Switch the macOS network location to match the associated Wi-Fi network.
# bootstrap.sh installs this script and loads it as a per-user LaunchAgent.

LOGS_PATH="${HOME}/Library/Logs/WiFiLocControl.log"
CONFIG_DIR="${HOME}/.wifi-loc-control"
ALIAS_CONFIG_PATH="${CONFIG_DIR}/alias.conf"
CONFIG_PATH="${CONFIG_DIR}/config"
SETTLE_SECONDS=3
LOG_MAX_BYTES=1048576
IPCONFIG_BIN=/usr/sbin/ipconfig

IPCONFIG_VERBOSE_RAISED=0
LOCK_DIR=""
LOCK_HELD=0
WIFI_NAME_SOURCE=""
SSID_VALUE=""
SSID_CANDIDATE=""
TARGET_LOCATION=""
ALIAS_MATCH_KIND=""
ALIAS_MATCH_VALUE=""
CHOSEN_ALIAS_LOCATION=""
LOCATION_LIST=""
CURRENT_LOCATION=""
LOCATION_SOURCE=""

log() {
  if [[ "${WIFI_LOC_QUIET:-}" == "1" ]]; then
    return 0
  fi
  printf '%s %s\n' "$(date +"[%Y-%m-%d %H:%M:%S]")" "$*" >&2
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s\n' "$value"
}

normalize_mac() {
  printf '%s\n' "$1" | tr '[:upper:]' '[:lower:]'
}

is_mac_address() {
  local mac extra
  mac=$(normalize_mac "$1")
  case "$mac" in
    ??:??:??:??:??:??) ;;
    *) return 1 ;;
  esac
  extra=$(printf '%s' "$mac" | tr -d '0-9a-f:')
  [[ -z "$extra" ]]
}

is_usable_ssid() {
  local value compact
  value=$(trim "$1")
  [[ -n "$value" ]] || return 1
  case "$value" in
    *$'\n'*) return 1 ;;
  esac
  compact=$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
  case "$compact" in
    "<redacted>"|"0x00") return 1 ;;
  esac
  return 0
}

# First matching key wins. Blank lines and full-line comments are ignored.
# Spaces around "=" are ignored. MAC address keys are compared case-insensitively.
lookup_alias() {
  local file="$1"
  local key="$2"
  local line raw_key raw_value parsed_key parsed_value

  [[ -n "$key" && -f "$file" ]] || return 1

  while IFS= read -r line || [[ -n "$line" ]]; do
    line=${line%$'\r'}
    line=$(trim "$line")
    [[ -z "$line" ]] && continue
    case "$line" in
      \#*) continue ;;
    esac
    case "$line" in
      *=*) ;;
      *) continue ;;
    esac

    raw_key=${line%%=*}
    raw_value=${line#*=}
    parsed_key=$(trim "$raw_key")
    parsed_value=$(trim "$raw_value")
    [[ -n "$parsed_key" && -n "$parsed_value" ]] || continue

    if [[ "$parsed_key" == "$key" ]]; then
      printf '%s\n' "$parsed_value"
      return 0
    fi

    if is_mac_address "$parsed_key" && is_mac_address "$key"; then
      if [[ "$(normalize_mac "$parsed_key")" == "$(normalize_mac "$key")" ]]; then
        printf '%s\n' "$parsed_value"
        return 0
      fi
    fi
  done < "$file"

  return 1
}

load_default_location() {
  local file="$1"
  local value=""

  if [[ -f "$file" ]]; then
    value=$(lookup_alias "$file" "default_location") || value=""
  fi

  if [[ -n "$value" ]]; then
    printf '%s\n' "$value"
  else
    printf '%s\n' "Automatic"
  fi
}

location_in_list() {
  local candidate="$1"
  local locations="$2"
  local loc

  while IFS= read -r loc || [[ -n "$loc" ]]; do
    loc=$(trim "$loc")
    [[ -n "$loc" ]] || continue
    [[ "$loc" == "$candidate" ]] && return 0
  done <<< "$locations"

  return 1
}

# scselect prints "  * <id> (Name)" and a header that also contains parentheses.
# The name can contain spaces. Match it exactly; do not treat it as a pattern.
parse_scselect() {
  awk '
    function location_name(line,    name) {
      if (line ~ /^Defined sets/) {
        return ""
      }
      if (match(line, /\([^)]*\)[[:space:]]*$/)) {
        name = substr(line, RSTART + 1, RLENGTH - 2)
        sub(/\)[[:space:]]*$/, "", name)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
        if (name ~ /==/ || name == "") {
          return ""
        }
        return name
      }
      return ""
    }
    {
      line = $0
      sub(/\r$/, "", line)
      name = location_name(line)
      if (name == "") {
        next
      }
      if (line ~ /^[[:space:]]*\*/) {
        print "current\t" name
      }
      print "location\t" name
    }
  '
}

locations_from_scselect() {
  parse_scselect | awk -F '\t' '$1 == "location" { print $2 }'
}

current_location_from_scselect() {
  parse_scselect | awk -F '\t' '$1 == "current" { print $2; exit }'
}

extract_ssid_from_ipconfig_summary() {
  awk '
    {
      line = $0
      sub(/\r$/, "", line)
      if (line ~ /^[[:space:]]*SSID[[:space:]]*:[[:space:]]*/) {
        sub(/^[[:space:]]*SSID[[:space:]]*:[[:space:]]*/, "", line)
        sub(/[[:space:]]+$/, "", line)
        print line
        exit
      }
    }
  '
}

extract_ssid_from_airport_line() {
  local line
  line=$(trim "$1")
  case "$line" in
    "Current Wi-Fi Network: "*)
      trim "${line#Current Wi-Fi Network: }"
      ;;
    "Current WiFi Network: "*)
      trim "${line#Current WiFi Network: }"
      ;;
  esac
}

wifi_interface_from_hardware_ports() {
  awk '
    {
      sub(/\r$/, "")
    }
    $0 ~ /Hardware Port: (Wi-Fi|AirPort|WiFi)[[:space:]]*$/ {
      found = 1
      next
    }
    found && $1 == "Device:" {
      print $2
      exit
    }
    found {
      found = 0
    }
  '
}

wifi_interface_from_service_order() {
  awk '
    {
      sub(/\r$/, "")
      if (match($0, /Hardware Port: (Wi-Fi|AirPort|WiFi), Device: [^)]+/)) {
        line = substr($0, RSTART, RLENGTH)
        split(line, parts, "Device: ")
        gsub(/[[:space:]]/, "", parts[2])
        if (parts[2] != "") {
          print parts[2]
          exit
        }
      }
    }
  '
}

# Returns 0 and prints the location to select.
# Returns 1 when the fallback location is not defined.
# Returns 3 when the network cannot be identified; the caller should not switch.
choose_target_location() {
  local ssid="$1"
  local mac="$2"
  local alias_file="$3"
  local locations="$4"
  local default_location="$5"
  local mapped=""
  local alias_location=""
  local target=""

  ALIAS_MATCH_KIND=""
  ALIAS_MATCH_VALUE=""
  CHOSEN_ALIAS_LOCATION=""
  TARGET_LOCATION=""

  if is_usable_ssid "$ssid"; then
    mapped=$(lookup_alias "$alias_file" "$ssid") || mapped=""
    if [[ -n "$mapped" ]]; then
      alias_location=$mapped
      ALIAS_MATCH_KIND=wifi_name
      ALIAS_MATCH_VALUE=$mapped
    fi
  fi

  if [[ -z "$alias_location" && -n "$mac" ]]; then
    mapped=$(lookup_alias "$alias_file" "$mac") || mapped=""
    if [[ -n "$mapped" ]]; then
      alias_location=$mapped
      ALIAS_MATCH_KIND=wifi_mac_address
      ALIAS_MATCH_VALUE=$mapped
    fi
  fi

  if [[ -z "$alias_location" ]]; then
    if is_usable_ssid "$ssid"; then
      alias_location=$ssid
    else
      return 3
    fi
  fi

  CHOSEN_ALIAS_LOCATION=$alias_location
  target=$default_location
  if location_in_list "$alias_location" "$locations"; then
    target=$alias_location
  fi

  if ! location_in_list "$target" "$locations"; then
    return 1
  fi

  # Callers must not run this in a command substitution. Bash 3.2 has no
  # namerefs, and a subshell would drop these results.
  TARGET_LOCATION=$target
}

script_path_for_location() {
  local location="$1"
  local config_dir="$2"

  case "$location" in
    ""|.|..|.*|/*|*/*)
      return 1
      ;;
  esac

  printf '%s\n' "${config_dir}/${location}"
}

get_wifi_interface() {
  local iface=""

  command -v networksetup >/dev/null 2>&1 || return 1
  iface=$(networksetup -listallhardwareports 2>/dev/null | wifi_interface_from_hardware_ports || true)
  if [[ -n "$iface" ]]; then
    printf '%s\n' "$iface"
    return 0
  fi
  networksetup -listnetworkserviceorder 2>/dev/null | wifi_interface_from_service_order
}

wifi_interface_state() {
  local iface="$1"
  local status=""

  if [[ -z "$iface" ]] || ! command -v ifconfig >/dev/null 2>&1; then
    printf 'unknown\n'
    return 0
  fi

  status=$(ifconfig "$iface" 2>/dev/null | awk '/status:/ { print $2; exit }' || true)
  case "$status" in
    active) printf 'active\n' ;;
    inactive) printf 'inactive\n' ;;
    *) printf 'unknown\n' ;;
  esac
}

get_wifi_mac_address() {
  local iface="$1"
  [[ -n "$iface" ]] || return 0
  command -v ifconfig >/dev/null 2>&1 || return 0
  ifconfig "$iface" 2>/dev/null | awk '/ether/ { print $2; exit }'
}

read_ipconfig_ssid() {
  local iface="$1"
  local bin=""

  [[ -n "$iface" ]] || return 0
  if [[ -x "$IPCONFIG_BIN" ]]; then
    bin=$IPCONFIG_BIN
  elif command -v ipconfig >/dev/null 2>&1; then
    bin=$(command -v ipconfig)
  else
    return 0
  fi

  "$bin" getsummary "$iface" 2>/dev/null | extract_ssid_from_ipconfig_summary || true
  return 0
}

restore_ipconfig_verbose() {
  if [[ "${IPCONFIG_VERBOSE_RAISED:-0}" -eq 1 ]]; then
    sudo -n "$IPCONFIG_BIN" setverbose 0 >/dev/null 2>&1 || true
    IPCONFIG_VERBOSE_RAISED=0
  fi
}

read_ipconfig_ssid_verbose() {
  local iface="$1"
  local summary=""

  # Must run in the current shell so a failure can turn verbose mode back off.
  SSID_CANDIDATE=""
  [[ -n "$iface" && -x "$IPCONFIG_BIN" ]] || return 0
  if ! sudo -n "$IPCONFIG_BIN" setverbose 1 >/dev/null 2>&1; then
    return 0
  fi

  IPCONFIG_VERBOSE_RAISED=1
  summary=$("$IPCONFIG_BIN" getsummary "$iface" 2>/dev/null || true)
  restore_ipconfig_verbose
  SSID_CANDIDATE=$(printf '%s\n' "$summary" | extract_ssid_from_ipconfig_summary)
}

read_airport_ssid() {
  local iface="$1"
  local line=""

  [[ -n "$iface" ]] || return 0
  command -v networksetup >/dev/null 2>&1 || return 0
  line=$(networksetup -getairportnetwork "$iface" 2>/dev/null || true)
  extract_ssid_from_airport_line "$line"
}

read_system_profiler_ssid() {
  local xml=""
  local name=""

  [[ -x /usr/libexec/PlistBuddy ]] || return 0
  command -v system_profiler >/dev/null 2>&1 || return 0

  xml=$(system_profiler SPAirPortDataType -xml 2>/dev/null || true)
  [[ -n "$xml" ]] || return 0
  name=$(
    /usr/libexec/PlistBuddy \
      -c 'Print :0:_items:0:spairport_airport_interfaces:0:spairport_current_network_information:_name' \
      /dev/stdin <<< "$xml" 2>/dev/null || true
  )
  printf '%s\n' "$name"
}

get_wifi_name() {
  local iface="$1"
  local candidate=""

  # Must run in the current shell. WIFI_NAME_SOURCE is reported by the caller,
  # and the verbose-mode probe has to share the caller's EXIT trap.
  SSID_VALUE=""
  WIFI_NAME_SOURCE=""

  candidate=$(read_ipconfig_ssid "$iface")
  if is_usable_ssid "$candidate"; then
    WIFI_NAME_SOURCE=ipconfig
    SSID_VALUE=$(trim "$candidate")
    return 0
  fi

  # Fast path on older macOS, and on machines whose terminal has already
  # been allowed to read the current network name.
  candidate=$(read_airport_ssid "$iface")
  if is_usable_ssid "$candidate"; then
    WIFI_NAME_SOURCE=networksetup
    SSID_VALUE=$(trim "$candidate")
    return 0
  fi

  # macOS 15.6 and later redact the SSID unless ipconfig verbose mode is on.
  # The mode is turned off again as soon as the summary has been read.
  # listpreferredwirelessnetworks is intentionally not used: it prints the
  # preferred-network list, not the network that is associated now.
  read_ipconfig_ssid_verbose "$iface"
  if is_usable_ssid "$SSID_CANDIDATE"; then
    WIFI_NAME_SOURCE=ipconfig-verbose
    SSID_VALUE=$(trim "$SSID_CANDIDATE")
    return 0
  fi

  candidate=$(read_system_profiler_ssid)
  if is_usable_ssid "$candidate"; then
    WIFI_NAME_SOURCE=system_profiler
    SSID_VALUE=$(trim "$candidate")
    return 0
  fi

  return 1
}

read_location_state() {
  local listed=""
  local current=""
  local status=1
  local parsed=""

  LOCATION_LIST=""
  CURRENT_LOCATION=""
  LOCATION_SOURCE=""

  if command -v networksetup >/dev/null 2>&1; then
    status=0
    listed=$(networksetup -listlocations 2>/dev/null) || status=$?
    if [[ "$status" -eq 0 ]]; then
      current=$(networksetup -getcurrentlocation 2>/dev/null) || status=$?
    fi
  fi

  if [[ "$status" -eq 0 ]] && [[ -n "$(trim "$listed")" ]] && [[ -n "$(trim "$current")" ]]; then
    LOCATION_LIST=$listed
    CURRENT_LOCATION=$(trim "$current")
    LOCATION_SOURCE=networksetup
    return 0
  fi

  if command -v scselect >/dev/null 2>&1; then
    parsed=$(scselect 2>&1 || true)
    LOCATION_LIST=$(printf '%s\n' "$parsed" | locations_from_scselect)
    CURRENT_LOCATION=$(printf '%s\n' "$parsed" | current_location_from_scselect)
    LOCATION_SOURCE=scselect
  fi
}

single_line_locations() {
  local locations="$1"
  local line joined=""

  while IFS= read -r line || [[ -n "$line" ]]; do
    line=$(trim "$line")
    [[ -n "$line" ]] || continue
    if [[ -z "$joined" ]]; then
      joined=$line
    else
      joined="${joined}, ${line}"
    fi
  done <<< "$locations"

  printf '%s\n' "$joined"
}

prepare_log() {
  local size=""

  mkdir -p "$(dirname "$LOGS_PATH")"
  if [[ -f "$LOGS_PATH" ]]; then
    size=$(wc -c < "$LOGS_PATH" | tr -d '[:space:]')
    if [[ "$size" -gt "$LOG_MAX_BYTES" ]]; then
      mv "$LOGS_PATH" "${LOGS_PATH}.1"
    fi
  fi
  touch "$LOGS_PATH"
  chmod 600 "$LOGS_PATH" || true
}

acquire_lock() {
  local now mtime age

  mkdir -p "$CONFIG_DIR"
  LOCK_DIR="${CONFIG_DIR}/.lock"
  if [[ -L "$LOCK_DIR" ]]; then
    log "lock path '${LOCK_DIR}' is a symlink; not using it"
    return 1
  fi

  if mkdir "$LOCK_DIR" 2>/dev/null; then
    LOCK_HELD=1
    return 0
  fi

  now=$(date +%s)
  mtime=$(stat -f %m "$LOCK_DIR" 2>/dev/null || stat -c %Y "$LOCK_DIR" 2>/dev/null || printf '%s\n' "$now")
  age=$((now - mtime))
  if [[ "$age" -gt 120 ]]; then
    rmdir "$LOCK_DIR" 2>/dev/null || true
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      LOCK_HELD=1
      return 0
    fi
  fi

  return 1
}

cleanup() {
  restore_ipconfig_verbose
  if [[ "${LOCK_HELD:-0}" -eq 1 && -n "${LOCK_DIR:-}" && ! -L "$LOCK_DIR" ]]; then
    rmdir "$LOCK_DIR" 2>/dev/null || true
    LOCK_HELD=0
  fi
}

switch_to_location() {
  local new_location="$1"
  local output=""
  local status=0

  output=$(scselect "$new_location" 2>&1) || status=$?
  if [[ "$status" -ne 0 ]]; then
    log "failed to switch to '${new_location}' (scselect status ${status}): ${output}"
    return 1
  fi

  log "location switched to '${new_location}'"
  if [[ -n "$output" ]]; then
    log "scselect: ${output}"
  fi
}

run_location_script() {
  local location="$1"
  local script_file=""
  local status=0

  if ! script_file=$(script_path_for_location "$location" "$CONFIG_DIR"); then
    log "skipping script for location '${location}'"
    return 0
  fi

  log "finding script for location '${location}'"
  if [[ ! -f "$script_file" ]]; then
    log "script for location '${location}' not found"
    return 0
  fi

  if [[ ! -x "$script_file" ]]; then
    if chmod +x "$script_file"; then
      log "marked '${script_file}' executable"
    else
      log "could not make '${script_file}' executable"
      return 0
    fi
  fi

  log "running script '${script_file}'"
  "$script_file" || status=$?
  log "script exited with status ${status}"
}

main() {
  local version=""
  local iface=""
  local state=""
  local ssid=""
  local mac=""
  local default_location=""
  local target=""
  local status=0

  set -euo pipefail
  prepare_log
  exec >> "$LOGS_PATH" 2>&1
  trap cleanup EXIT

  if ! acquire_lock; then
    log "another instance is running"
    exit 0
  fi

  log "waiting ${SETTLE_SECONDS}s for the network change to settle"
  sleep "$SETTLE_SECONDS"

  version=$(sw_vers -productVersion 2>/dev/null || true)
  if [[ -n "$version" ]]; then
    log "macOS ${version}"
  fi

  iface=$(get_wifi_interface || true)
  if [[ -z "$iface" ]]; then
    iface=en0
    log "could not find a Wi-Fi port; trying en0"
  else
    log "using Wi-Fi interface '${iface}'"
  fi

  state=$(wifi_interface_state "$iface")
  if [[ "$state" == "inactive" ]]; then
    log "Wi-Fi interface '${iface}' is inactive; leaving the current location unchanged"
    exit 0
  fi

  get_wifi_name "$iface" || true
  ssid=$SSID_VALUE
  mac=$(get_wifi_mac_address "$iface" || true)

  if [[ -n "$ssid" ]]; then
    log "current wifi_name '${ssid}' via ${WIFI_NAME_SOURCE} and wifi_mac_address '${mac}'"
  else
    log "current wifi_name unavailable and wifi_mac_address '${mac}'"
  fi

  default_location=$(load_default_location "$CONFIG_PATH")
  read_location_state
  log "network locations: $(single_line_locations "$LOCATION_LIST")"
  log "current network location '${CURRENT_LOCATION}'"
  log "default location '${default_location}'"
  if [[ -n "$LOCATION_SOURCE" ]]; then
    log "read locations with ${LOCATION_SOURCE}"
  fi
  if [[ -f "$ALIAS_CONFIG_PATH" ]]; then
    log "reading alias config '${ALIAS_CONFIG_PATH}'"
  fi

  choose_target_location "$ssid" "$mac" "$ALIAS_CONFIG_PATH" "$LOCATION_LIST" "$default_location" || status=$?
  target=$TARGET_LOCATION

  if [[ "$ALIAS_MATCH_KIND" == "wifi_name" ]]; then
    log "for wifi_name '${ssid}' found alias '${ALIAS_MATCH_VALUE}'"
  elif [[ "$ALIAS_MATCH_KIND" == "wifi_mac_address" ]]; then
    log "for wifi_mac_address '${mac}' found alias '${ALIAS_MATCH_VALUE}'"
  elif [[ -f "$ALIAS_CONFIG_PATH" ]]; then
    log "for wifi_name '${ssid}' and wifi_mac_address '${mac}' alias not found"
  fi

  case "$status" in
    0) ;;
    3)
      log "could not identify the Wi-Fi network; leaving the current location unchanged"
      if [[ -n "$mac" ]]; then
        log "wifi_mac_address '${mac}' has no alias. Add it to '${ALIAS_CONFIG_PATH}' if this network should select a location."
      fi
      exit 0
      ;;
    *)
      log "location '${default_location}' is not defined; leaving the current location unchanged"
      exit 0
      ;;
  esac

  if [[ -n "$CHOSEN_ALIAS_LOCATION" && "$target" != "$CHOSEN_ALIAS_LOCATION" ]]; then
    log "location '${CHOSEN_ALIAS_LOCATION}' is not defined; using '${target}'"
  fi

  if [[ "$target" == "$CURRENT_LOCATION" ]]; then
    log "switch location is not required"
    exit 0
  fi

  if ! command -v scselect >/dev/null 2>&1; then
    log "scselect is not available; cannot change location"
    exit 0
  fi

  if switch_to_location "$target"; then
    run_location_script "$target"
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
