#!/usr/bin/env bash
# WiFiLocControl Installer
# This script installs the WiFiLocControl service to automatically switch
# network locations based on the connected WiFi network

# Exit immediately if a command exits with non-zero status (fail fast)
set -e

# ===== Configuration paths =====
SCRIPT_NAME=wifi-loc-control.sh
INSTALL_DIR=/usr/local/bin/

LAUNCH_AGENTS_DIR=$HOME/Library/LaunchAgents
LAUNCH_AGENT_CONFIG_NAME=WiFiLocControl.plist
LAUNCH_AGENT_CONFIG_PATH=$LAUNCH_AGENTS_DIR/$LAUNCH_AGENT_CONFIG_NAME

CONFIG_DIR=$HOME/.wifi-loc-control
LOG_DIR=$HOME/Library/Logs

echo "Installing WiFiLocControl..."

# ===== Request administrative privileges =====
# Ask for admin privileges upfront to avoid prompting later
sudo -v
# Keep-alive: update existing sudo time stamp until script finishes
# This prevents the sudo timeout from interrupting the installation
while true; do sudo -n true; sleep 60; kill -0 "$$" || exit; done 2>/dev/null &

# ===== Create necessary directories =====
echo "Creating necessary directories..."
mkdir -p "$INSTALL_DIR" 2>/dev/null || true  # May fail if already exists/needs sudo
mkdir -p "$CONFIG_DIR"    # For alias configurations and custom scripts
mkdir -p "$LAUNCH_AGENTS_DIR"  # For launchd service configuration
mkdir -p "$LOG_DIR"       # For log files

# ===== Install main script =====
echo "Installing script to $INSTALL_DIR$SCRIPT_NAME..."
sudo cp -f "$SCRIPT_NAME" "$INSTALL_DIR"  # Force copy to overwrite existing file

# Set executable permissions for script
echo "Setting executable permissions..."
sudo chmod +x "$INSTALL_DIR$SCRIPT_NAME"

# ===== Install and configure launch agent =====
echo "Installing launch agent configuration..."
cp -f "$LAUNCH_AGENT_CONFIG_NAME" "$LAUNCH_AGENTS_DIR"

# Unload any existing launch agent and load the new one
echo "Configuring automatic startup..."
# Unload may fail if the service wasn't loaded before, so we suppress errors
launchctl unload "$LAUNCH_AGENT_CONFIG_PATH" > /dev/null 2>&1 || true
launchctl load -w "$LAUNCH_AGENT_CONFIG_PATH"  # -w option enables the service

# ===== Create sample configuration =====
echo "Creating sample alias configuration file..."
if [ ! -f "$CONFIG_DIR/alias.conf" ]; then
    # Create example configuration only if it doesn't already exist
    cat > "$CONFIG_DIR/alias.conf" << 'EOF'
# Example configuration:
# WiFi_Name=Location_Name
# My_Home_Wi-Fi_5GHz=Home
# My_Home_Wi-Fi_2.4GHz=Home
EOF
    echo "Created sample alias configuration at $CONFIG_DIR/alias.conf"
else
    echo "Alias configuration already exists at $CONFIG_DIR/alias.conf"
fi

# ===== Installation complete =====
echo "✅ WiFiLocControl has been installed and configured successfully!"
echo "You can check logs at: $HOME/Library/Logs/WiFiLocControl.log"
