#!/usr/bin/env bash
# WiFiLocControl - Automatically changes macOS network locations based on connected WiFi SSID
# This script detects the current WiFi network and switches to a corresponding network location

# ===== Configuration paths =====
LOGS_PATH=$HOME/Library/Logs/WiFiLocControl.log
DEFAULT_NETWORK_LOCATION=Automatic
CONFIG_DIR=$HOME/.wifi-loc-control
ALIAS_CONFIG_PATH=$CONFIG_DIR/alias.conf

# Create log directory if it doesn't exist
mkdir -p "$(dirname "$LOGS_PATH")"

# Redirect both standard output and standard error to the log file
# This ensures all messages and errors are captured for debugging
exec >> "$LOGS_PATH" 2>&1

# ===== Helper functions =====
# Function to log messages with a timestamp for better debugging
log() {
  echo "[$(date +"%Y-%m-%d %H:%M:%S")] $*"
}

# ===== Get current WiFi network name =====
# Try the airport command first (more reliable), then fall back to ipconfig if needed
AIRPORT="/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport"
if [ -f "$AIRPORT" ]; then
  # Airport command exists - use it to get SSID (more reliable method)
  wifi_name=$("$AIRPORT" -I | awk '/ SSID:/ {print substr($0, index($0, $2))}')
else
  # Fall back to ipconfig method if airport command is not available
  wifi_name=$(ipconfig getsummary en0 | awk -F ' SSID : ' '/ SSID : / {print $2}')
fi

log "current wifi_name '$wifi_name'"

# If we're not connected to WiFi, exit gracefully
if [ -z "$wifi_name" ]; then
  log "wifi_name is empty, possibly not connected to WiFi"
  exit 0
fi

# ===== Get network location information =====
# Get a list of all available network locations
network_locations=$(networksetup -listlocations | xargs)
log "network locations: $network_locations"

# Get the currently active network location
current_network_location=$(networksetup -getcurrentlocation)
log "current network location '$current_network_location'"

# ===== Check for WiFi network alias =====
# The alias.conf file maps WiFi SSIDs to location names
# This allows multiple WiFi networks to use the same location
alias_location=$wifi_name
if [ -f "$ALIAS_CONFIG_PATH" ]; then
  log "reading alias config '$ALIAS_CONFIG_PATH'"
  # Look for a line starting with the WiFi name and extract what's after the equals sign
  alias=$(grep "^$wifi_name=" "$ALIAS_CONFIG_PATH" | sed -nE 's/.*=(.*)/\1/p')

  if [ -n "$alias" ]; then
    alias_location=$alias
    log "for wifi name '$wifi_name' found alias '$alias_location'"
  else
    log "for wifi name '$wifi_name' alias not found"
  fi
fi

# ===== Function to execute location-specific scripts =====
# This allows custom actions when switching to a specific location
exec_location_script() {
  local location=$1
  local script_file="$CONFIG_DIR/$location"

  log "finding script for location '$location'"

  if [ -f "$script_file" ]; then
    log "running script '$script_file'"
    if [ -x "$script_file" ]; then
      # Execute the script if it's already executable
      "$script_file"
    else
      # Make the script executable if needed
      log "script is not executable, setting permissions"
      chmod +x "$script_file"
      "$script_file"
    fi
  else
    log "script for location '$location' not found"
  fi
}

# ===== Determine if location switch is needed =====
# Check if the alias corresponds to a valid network location
has_related_network_location=$(echo "$network_locations" | grep -q "\b$alias_location\b" && echo "true" || echo "false")

# If we're already in the default location and there's no matching location for this network, do nothing
if [[ "$has_related_network_location" == "false" && "$current_network_location" == "$DEFAULT_NETWORK_LOCATION" ]]; then
  log "switch location is not required"
  exit 0
fi

# ===== Switch to default location if needed =====
# If no matching location exists for this WiFi, switch to the default location
if [ "$has_related_network_location" == "false" ]; then
  new_location=$DEFAULT_NETWORK_LOCATION
  log "switching to default location '$new_location'"
  networksetup -switchtolocation "$new_location" > /dev/null 2>&1
  if [ $? -eq 0 ]; then
    log "location switched to '$new_location'"
    # Run location-specific script after switching
    exec_location_script "$new_location"
  else
    log "failed to switch to location '$new_location'"
  fi
  exit 0
fi

# ===== Switch to matching location if needed =====
# If we have a matching location and we're not already in it, make the switch
if [ "$alias_location" != "$current_network_location" ]; then
  new_location=$alias_location
  log "switching to location '$new_location'"
  networksetup -switchtolocation "$new_location" > /dev/null 2>&1
  if [ $? -eq 0 ]; then
    log "location switched to '$new_location'"
    # Run location-specific script after switching
    exec_location_script "$new_location"
  else
    log "failed to switch to location '$new_location'"
  fi
  exit 0
fi

# If none of the conditions are met, no location switch is required
log "switch location is not required"
