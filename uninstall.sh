#!/usr/bin/env bash
# uninstall.sh - Removes WiFiLocControl from your system

# Set text colors for better readability
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Print header
echo -e "${YELLOW}WiFiLocControl Uninstaller${NC}"
echo "This script will remove all components of WiFiLocControl from your system."
echo

# Confirm with user before proceeding
read -p "Do you want to continue with uninstallation? (y/n): " CONFIRM
if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
  echo -e "${YELLOW}Uninstallation cancelled.${NC}"
  exit 0
fi

echo
echo -e "${YELLOW}Starting uninstallation...${NC}"

# Define paths
SCRIPT_PATH="/usr/local/bin/wifi-loc-control.sh"
CONFIG_DIR="$HOME/.wifi-loc-control"
LAUNCH_AGENT_PATH="$HOME/Library/LaunchAgents/WiFiLocControl.plist"
LOG_PATH="$HOME/Library/Logs/WiFiLocControl.log"

# Ask for admin privileges upfront
sudo -v
# Keep-alive: update existing sudo time stamp until script has finished
while true; do sudo -n true; sleep 60; kill -0 "$$" || exit; done 2>/dev/null &

# Step 1: Unload the launch agent
echo "Unloading launch agent..."
if [ -f "$LAUNCH_AGENT_PATH" ]; then
  launchctl unload "$LAUNCH_AGENT_PATH" 2>/dev/null
  STATUS=$?
  if [ $STATUS -eq 0 ]; then
    echo -e "  ${GREEN}✓ Launch agent unloaded successfully${NC}"
  else
    echo -e "  ${YELLOW}⚠ Launch agent may not have been loaded${NC}"
  fi
else
  echo -e "  ${YELLOW}⚠ Launch agent file not found${NC}"
fi

# Step 2: Remove the launch agent file
echo "Removing launch agent file..."
if [ -f "$LAUNCH_AGENT_PATH" ]; then
  rm "$LAUNCH_AGENT_PATH"
  echo -e "  ${GREEN}✓ Launch agent file removed${NC}"
else
  echo -e "  ${YELLOW}⚠ Launch agent file not found${NC}"
fi

# Step 3: Remove the main script
echo "Removing main script..."
if [ -f "$SCRIPT_PATH" ]; then
  sudo rm "$SCRIPT_PATH"
  echo -e "  ${GREEN}✓ Main script removed${NC}"
else
  echo -e "  ${YELLOW}⚠ Main script not found${NC}"
fi

# Step 4: Remove the configuration directory
echo "Removing configuration directory..."
if [ -d "$CONFIG_DIR" ]; then
  BACKUP_DIR="$HOME/wifi-loc-control-backup-$(date +%Y%m%d%H%M%S)"
  
  # If there are custom scripts in the config dir, back them up
  CUSTOM_FILES=$(find "$CONFIG_DIR" -type f -not -name "alias.conf" | wc -l)
  if [ "$CUSTOM_FILES" -gt 0 ]; then
    mkdir -p "$BACKUP_DIR"
    cp -r "$CONFIG_DIR" "$BACKUP_DIR/"
    echo -e "  ${YELLOW}⚠ Custom files found and backed up to:${NC}"
    echo -e "  ${YELLOW}  $BACKUP_DIR${NC}"
  fi
  
  rm -rf "$CONFIG_DIR"
  echo -e "  ${GREEN}✓ Configuration directory removed${NC}"
else
  echo -e "  ${YELLOW}⚠ Configuration directory not found${NC}"
fi

# Step 5: Ask about log file
echo
echo "Do you want to delete the log file as well? ($LOG_PATH)"
read -p "(y/n): " DELETE_LOGS
if [[ "$DELETE_LOGS" == "y" || "$DELETE_LOGS" == "Y" ]]; then
  if [ -f "$LOG_PATH" ]; then
    rm "$LOG_PATH"
    echo -e "  ${GREEN}✓ Log file removed${NC}"
  else
    echo -e "  ${YELLOW}⚠ Log file not found${NC}"
  fi
else
  echo -e "  ${YELLOW}Log file preserved${NC}"
fi

echo
echo -e "${GREEN}WiFiLocControl has been uninstalled successfully!${NC}"
if [ "$CUSTOM_FILES" -gt 0 ]; then
  echo -e "${YELLOW}Note: Your custom configuration files were backed up to:${NC}"
  echo -e "${YELLOW}$BACKUP_DIR${NC}"
fi
echo

exit 0