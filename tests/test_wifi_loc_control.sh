#!/usr/bin/env bash
# Checks parsing and location selection. Safe on a Mac: it does not install
# the agent, and it does not read the live Wi-Fi network.
set -euo pipefail

ROOT=$(cd "$(dirname -- "$0")/.." && pwd)
export WIFI_LOC_QUIET=1

# shellcheck disable=SC1091
source "${ROOT}/wifi-loc-control.sh"

passed=0
failures=0

assert_eq() {
  local name="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    passed=$((passed + 1))
  else
    failures=$((failures + 1))
    printf 'FAIL %s\n  expected: [%s]\n  actual:   [%s]\n' "$name" "$expected" "$actual" >&2
  fi
}

assert_status() {
  local name="$1"
  local expected="$2"
  shift 2
  local status=0
  "$@" >/dev/null 2>&1 || status=$?
  if [[ "$status" -eq "$expected" ]]; then
    passed=$((passed + 1))
  else
    failures=$((failures + 1))
    printf 'FAIL %s\n  expected status %s, got %s\n' "$name" "$expected" "$status" >&2
  fi
}

run_choose() {
  CHOOSE_STATUS=0
  TARGET_LOCATION=""
  choose_target_location "$@" || CHOOSE_STATUS=$?
  CHOOSE_OUT=$TARGET_LOCATION
}

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

ALIAS_FILE="${TMP_DIR}/alias.conf"
cat > "$ALIAS_FILE" <<'EOF'
# comment
  My Home = Home Office

My Home=Work

aa:bb:cc:dd:ee:ff=Office
AA:BB:CC:DD:EE:01=Lab
not a pair
SSID=Loc=Extra
guest=
EOF
printf 'Cafe\tNet=Cafe\r\n' >> "$ALIAS_FILE"

assert_eq "trim spaces" "hello" "$(trim "  hello  ")"
assert_eq "alias trims and uses the first match" "Home Office" "$(lookup_alias "$ALIAS_FILE" "My Home")"
assert_eq "alias keeps equals in the value" "Loc=Extra" "$(lookup_alias "$ALIAS_FILE" "SSID")"
assert_eq "mac alias is case-insensitive" "Office" "$(lookup_alias "$ALIAS_FILE" "AA:BB:CC:DD:EE:FF")"
assert_eq "mac alias keeps distinct addresses apart" "Lab" "$(lookup_alias "$ALIAS_FILE" "aa:bb:cc:dd:ee:01")"
assert_eq "crlf alias value" "Cafe" "$(lookup_alias "$ALIAS_FILE" $'Cafe\tNet')"
assert_status "missing alias" 1 lookup_alias "$ALIAS_FILE" "Nope"
assert_status "empty alias value is ignored" 1 lookup_alias "$ALIAS_FILE" "guest"
assert_status "comment is not a key" 1 lookup_alias "$ALIAS_FILE" "comment"

CONFIG_FILE="${TMP_DIR}/config"
cat > "$CONFIG_FILE" <<'EOF'
# default_location=Work
default_location = Home Office
EOF
assert_eq "default location config" "Home Office" "$(load_default_location "$CONFIG_FILE")"
assert_eq "missing config falls back to Automatic" "Automatic" "$(load_default_location "${TMP_DIR}/missing")"

SUMMARY=$(cat <<'EOF'
InterfaceType : WiFi
LinkStatusActive : TRUE
NetworkID : abc
SSID : My Home
BSSID : aa:bb:cc:dd:ee:ff
Security : WPA2
EOF
)
assert_eq "ssid ignores bssid" "My Home" "$(printf '%s\n' "$SUMMARY" | extract_ssid_from_ipconfig_summary)"
assert_eq "ssid with colon" "Foo:Bar" "$(printf '%s\n' "  SSID : Foo:Bar" | extract_ssid_from_ipconfig_summary)"
assert_eq "bssid alone is not an ssid" "" "$(printf '%s\n' "BSSID : aa:bb:cc:dd:ee:ff" | extract_ssid_from_ipconfig_summary)"
assert_eq "redacted summary" "<redacted>" "$(printf '%s\n' "SSID : <redacted>" | extract_ssid_from_ipconfig_summary)"

assert_status "redacted ssid is not usable" 1 is_usable_ssid "<redacted>"
assert_status "spaced redacted ssid is not usable" 1 is_usable_ssid "< redacted >"
assert_status "zero ssid sentinel is not usable" 1 is_usable_ssid "0x00"
assert_eq "usable ssid" "0" "$(is_usable_ssid "Café WiFi" >/dev/null; printf '%s' "$?")"

assert_eq "airport ssid" "My Home" "$(extract_ssid_from_airport_line "Current Wi-Fi Network: My Home")"
assert_eq "airport not associated" "" "$(extract_ssid_from_airport_line "You are not associated with an AirPort network.")"

PORTS=$(cat <<'EOF'
Hardware Port: Ethernet
Device: en0

Hardware Port: Wi-Fi
Device: en1

Hardware Port: Thunderbolt Bridge
Device: bridge0
EOF
)
assert_eq "wifi device is not assumed to be en0" "en1" "$(printf '%s\n' "$PORTS" | wifi_interface_from_hardware_ports)"

AIRPORT_PORTS=$(printf '%s\n' "Hardware Port: AirPort" "Device: en2")
assert_eq "legacy airport port" "en2" "$(printf '%s\n' "$AIRPORT_PORTS" | wifi_interface_from_hardware_ports)"

SERVICE_ORDER=$(cat <<'EOF'
An asterisk (*) denotes that a network service is disabled.
(1) Ethernet
(Hardware Port: Ethernet, Device: en0)

(2) Wi-Fi
(Hardware Port: Wi-Fi, Device: en1)
EOF
)
assert_eq "service order wifi device" "en1" "$(printf '%s\n' "$SERVICE_ORDER" | wifi_interface_from_service_order)"

SCSELECT_TEXT=$(cat <<'EOF'
Defined sets include: (* == current set)
 * BDF51A74-6547-4747-BD21-30C51DA26CB1 (Automatic)
   70209F72-5BE9-44D1-979E-A8BA25A317B4 (Home Office)
   11111111-2222-3333-4444-555555555555 (Work)
EOF
)
assert_eq "scselect locations" "$(printf '%s\n' "Automatic" "Home Office" "Work")" "$(printf '%s\n' "$SCSELECT_TEXT" | locations_from_scselect)"
assert_eq "scselect current" "Automatic" "$(printf '%s\n' "$SCSELECT_TEXT" | current_location_from_scselect)"

SCSELECT_SPACED=$(cat <<'EOF'
Defined sets include: (* == current set)
   70209F72-5BE9-44D1-979E-A8BA25A317B4 (Automatic)
 * 11111111-2222-3333-4444-555555555555 (Home Office)
EOF
)
assert_eq "current location can contain spaces" "Home Office" "$(printf '%s\n' "$SCSELECT_SPACED" | current_location_from_scselect)"

LOCATIONS=$(printf '%s\n' "Automatic" "Home Office" "Work")

run_choose "My Home" "" "$ALIAS_FILE" "$LOCATIONS" "Automatic"
assert_eq "ssid alias selects location" "Home Office" "$CHOOSE_OUT"
assert_eq "ssid alias status" "0" "$CHOOSE_STATUS"
assert_eq "ssid alias kind" "wifi_name" "$ALIAS_MATCH_KIND"

run_choose "Coffee" "" "$ALIAS_FILE" "$LOCATIONS" "Automatic"
assert_eq "unknown ssid uses the default location" "Automatic" "$CHOOSE_OUT"

run_choose "Home" "" "$ALIAS_FILE" "$LOCATIONS" "Automatic"
assert_eq "location names are not substring matches" "Automatic" "$CHOOSE_OUT"

run_choose "Home Office" "" "${TMP_DIR}/no-alias" "$LOCATIONS" "Automatic"
assert_eq "ssid can be the location name" "Home Office" "$CHOOSE_OUT"

MAC_LOCATIONS=$(printf '%s\n' "Automatic" "Home Office" "Work" "Office")
run_choose "<redacted>" "aa:bb:cc:dd:ee:ff" "$ALIAS_FILE" "$MAC_LOCATIONS" "Automatic"
assert_eq "mac alias is used when the ssid is redacted" "Office" "$CHOOSE_OUT"
assert_eq "mac alias kind" "wifi_mac_address" "$ALIAS_MATCH_KIND"

run_choose "< redacted >" "de:ad:be:ef:00:01" "$ALIAS_FILE" "$LOCATIONS" "Automatic"
assert_eq "unidentified network status" "3" "$CHOOSE_STATUS"
assert_eq "unidentified network does not print a target" "" "$CHOOSE_OUT"

REDACTED_LOCATIONS=$(printf '%s\n' "Automatic" "<redacted>")
run_choose "<redacted>" "" "$ALIAS_FILE" "$REDACTED_LOCATIONS" "Automatic"
assert_eq "redacted text is not used as a location name" "3" "$CHOOSE_STATUS"

run_choose "Coffee" "" "${TMP_DIR}/no-alias" "$LOCATIONS" "Missing"
assert_eq "missing default location" "1" "$CHOOSE_STATUS"

run_choose "My Home" "aa:bb:cc:dd:ee:ff" "$ALIAS_FILE" "$LOCATIONS" "Automatic"
assert_eq "ssid alias wins over a mac alias" "Home Office" "$CHOOSE_OUT"

CUSTOM_DEFAULT=$(printf '%s\n' "Automatic" "Work")
run_choose "CoffeeShop" "" "${TMP_DIR}/no-alias" "$CUSTOM_DEFAULT" "Work"
assert_eq "configured default location" "Work" "$CHOOSE_OUT"

assert_eq "script path" "${TMP_DIR}/Home Office" "$(script_path_for_location "Home Office" "$TMP_DIR")"
assert_status "script path rejects traversal" 1 script_path_for_location "../passwd" "$TMP_DIR"
assert_status "script path rejects a slash" 1 script_path_for_location "Home/Office" "$TMP_DIR"

run_helper() {
  HELPER_STATUS=0
  HELPER_OUT=$(bash "${ROOT}/wifi-loc-control-run" "$@" 2>&1) || HELPER_STATUS=$?
}
run_helper "../passwd"
assert_eq "runner rejects traversal" "126" "$HELPER_STATUS"
case "$HELPER_OUT" in
  *refusing*) passed=$((passed + 1)) ;;
  *)
    failures=$((failures + 1))
    printf 'FAIL runner traversal message: %s\n' "$HELPER_OUT" >&2
    ;;
esac
run_helper "Home/Office"
assert_eq "runner rejects a slash" "126" "$HELPER_STATUS"
run_helper "Automatic"
assert_eq "runner refuses to start without sudo" "126" "$HELPER_STATUS"
case "$HELPER_OUT" in
  *sudo*) passed=$((passed + 1)) ;;
  *)
    failures=$((failures + 1))
    printf 'FAIL runner sudo message: %s\n' "$HELPER_OUT" >&2
    ;;
esac

bash -n "${ROOT}/wifi-loc-control.sh"
bash -n "${ROOT}/wifi-loc-control-run"
bash -n "${ROOT}/bootstrap.sh"
bash -n "${ROOT}/tests/test_wifi_loc_control.sh"
passed=$((passed + 1))

help_text=$(bash "${ROOT}/bootstrap.sh" --help)
case "$help_text" in
  *Usage:*) passed=$((passed + 1)) ;;
  *)
    failures=$((failures + 1))
    printf 'FAIL bootstrap help\n' >&2
    ;;
esac

# A fake uname keeps this from installing when the tests run on a Mac.
mkdir -p "${TMP_DIR}/bin"
cat > "${TMP_DIR}/bin/uname" <<'EOF'
#!/bin/bash
echo Linux
EOF
chmod +x "${TMP_DIR}/bin/uname"
set +e
linux_text=$(PATH="${TMP_DIR}/bin:${PATH}" bash "${ROOT}/bootstrap.sh" 2>&1)
linux_status=$?
set -e
assert_eq "bootstrap refuses a non-macOS install" "1" "$linux_status"
case "$linux_text" in
  *macOS*) passed=$((passed + 1)) ;;
  *)
    failures=$((failures + 1))
    printf 'FAIL bootstrap platform message: %s\n' "$linux_text" >&2
    ;;
esac

if command -v shellcheck >/dev/null 2>&1; then
  shellcheck "${ROOT}/wifi-loc-control.sh" "${ROOT}/wifi-loc-control-run" "${ROOT}/bootstrap.sh" "${ROOT}/tests/test_wifi_loc_control.sh"
  passed=$((passed + 1))
fi

printf '%s passed, %s failed\n' "$passed" "$failures"
[[ "$failures" -eq 0 ]]
