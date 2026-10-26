# WiFiLocControl

WiFiLocControl changes your macOS [network location](https://support.apple.com/en-us/105129) to match the Wi-Fi network you are associated with. It is useful when work and home need different settings, such as a VPN or a custom DNS configuration, and you do not want to switch locations by hand.

The script runs as a LaunchAgent for the user who installed it. It runs at login and whenever macOS changes the system network configuration. It waits a few seconds so Wi-Fi can finish associating, then selects a location.

## Features

- Selects a network location from the current Wi-Fi name.
- Maps several Wi-Fi networks, or their private Wi-Fi addresses, onto one location.
- Runs a script after a location change.
- Leaves the current location alone when Wi-Fi is off or the network name cannot be read.

## Installation

1. Clone the repository and enter it.

   ```bash
   git clone https://github.com/vborodulin/wifi-loc-control.git
   cd wifi-loc-control
   ```

2. Install it as your own user. Do not prefix the command with `sudo`. The script asks for an administrator password when it needs one.

   ```bash
   chmod +x bootstrap.sh
   ./bootstrap.sh
   ```

   This copies `wifi-loc-control.sh` to `/usr/local/bin`, loads `~/Library/LaunchAgents/WiFiLocControl.plist`, and makes `~/.wifi-loc-control` private to your user. Running it again updates an existing install.

   On macOS 15.6 and later, the network name is often reported as `<redacted>` unless `ipconfig` verbose mode is turned on. The installer writes `/etc/sudoers.d/wifi-loc-control` so the agent can run only these two commands without a password:

   ```text
   /usr/sbin/ipconfig setverbose 1
   /usr/sbin/ipconfig setverbose 0
   ```

   The agent turns verbose mode on for the read and turns it off again afterward. It does not grant any other root access.

3. Watch the log.

   ```bash
   tail -f ~/Library/Logs/WiFiLocControl.log
   ```

4. To uninstall:

   ```bash
   ./bootstrap.sh --uninstall
   ```

   This unloads the LaunchAgent and removes the installed script, the plist, and the ipconfig sudoers rule. Aliases, location scripts, and the log are left in place. Remove them yourself when you want to:

   ```bash
   rm -rf ~/.wifi-loc-control
   rm -f ~/Library/Logs/WiFiLocControl.log ~/Library/Logs/WiFiLocControl.log.1
   ```

   If the repository is already gone, the same uninstall can be done by hand:

   ```bash
   launchctl bootout "gui/$(id -u)/application.com.wifi-loc-control"
   rm -f ~/Library/LaunchAgents/WiFiLocControl.plist
   sudo rm -f /usr/local/bin/wifi-loc-control.sh
   sudo rm -f /etc/sudoers.d/wifi-loc-control
   ```

## Usage

Name a network location after the Wi-Fi network when one location is enough. A network named `My_Home_Wi-Fi_5GHz` selects a location named `My_Home_Wi-Fi_5GHz`.

A network with no matching location selects the default location, which is `Automatic` unless you change it. The agent does that only when it could read a real network name. A redacted or empty name is not treated as an unknown café, because switching on a guess would drop a known network onto the default location.

Wi-Fi that is powered off or not associated does not change the location.

## Configuration

Configuration lives in `~/.wifi-loc-control`.

### Default location

Create `~/.wifi-loc-control/config` when the fallback location is not `Automatic`:

```text
# Used when the current network has no matching location
default_location=Automatic
```

The same file format as `alias.conf` is used. Blank lines and lines that start with `#` are ignored, and spaces around `=` are ignored.

### Aliasing

Use `~/.wifi-loc-control/alias.conf` when several wireless networks should share one location, or when you would rather match the private Wi-Fi address than the network name.

```bash
mkdir -p ~/.wifi-loc-control
nano ~/.wifi-loc-control/alias.conf
```

```text
# Two bands of the same router
My_Home_Wi-Fi_5GHz=Home
My_Home_Wi-Fi_2.4GHz=Home

My_Work_Wi-Fi_5GHz=Work
My_Work_Guest=Work
```

The key is the Wi-Fi name and the value is the location name. The first match wins. A `#` starts a comment only when it is the first character on the line, so do not put a comment after a value.

macOS can use a stable private address for each Wi-Fi network. That address still shows up when the network name is redacted. Match it in lowercase or uppercase:

```text
# My_Home_Wi-Fi_5GHz
d2:1a:f8:5d:bb:ac=Home

# My_Home_Wi-Fi_2.4GHz
cf:0a:4e:8a:4b:fe=Home
```

A Wi-Fi name alias wins over a MAC address alias for the same network. The log prints the address when the name cannot be read, which is the value to paste here.

### Location scripts

After a location change, the agent runs `~/.wifi-loc-control/<location>` when that file exists. The file name is the location that was selected:

- without an alias, that is the Wi-Fi name
- with an alias, that is the value from `alias.conf`, such as `Home`

```bash
#!/usr/bin/env bash
# Output is appended to ~/Library/Logs/WiFiLocControl.log
exec 2>&1

sudo -n /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate on
```

Save that as `~/.wifi-loc-control/Home` when the selected location is `Home`. A reset script for the default location can live at `~/.wifi-loc-control/Automatic` and turn the same setting off.

The agent runs the script as your user. A command that needs root will fail until you allow that exact command. Keep the rule narrow and check it with `visudo`:

```bash
sudo visudo -f /etc/sudoers.d/wifi-loc-control-firewall
```

```text
your-user-name ALL=(root) NOPASSWD: /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate on, /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate off
```

Make the script executable. The agent will also mark it executable if it can.

```bash
chmod +x ~/.wifi-loc-control/Home
chmod +x ~/.wifi-loc-control/Automatic
```

Scripts run only when the location actually changes. Location names that contain `/`, or that start with `.`, are not used as script paths.

## Troubleshooting

Logs are written to `~/Library/Logs/WiFiLocControl.log`. The file is private to your user. When it grows past 1 MB it is renamed to `WiFiLocControl.log.1` and a new log is started.

```bash
tail -f ~/Library/Logs/WiFiLocControl.log
```

```text
[2023-11-26 13:44:49] using Wi-Fi interface 'en0'
[2023-11-26 13:44:49] current wifi_name 'My_Home_Wi-Fi_5GHz' via ipconfig and wifi_mac_address 'd2:1a:f8:5d:bb:ac'
[2023-11-26 13:44:49] network locations: Automatic, Home
[2023-11-26 13:44:49] current network location 'Automatic'
[2023-11-26 13:44:49] reading alias config '/Users/example/.wifi-loc-control/alias.conf'
[2023-11-26 13:44:49] for wifi_name 'My_Home_Wi-Fi_5GHz' found alias 'Home'
[2023-11-26 13:44:49] location switched to 'Home'
[2023-11-26 13:44:49] finding script for location 'Home'
[2023-11-26 13:44:49] running script '/Users/example/.wifi-loc-control/Home'
[2023-11-26 13:44:49] script exited with status 0
```

The `via` field says which probe read the name: `ipconfig`, `networksetup`, `ipconfig-verbose`, or `system_profiler`.

If the log says the Wi-Fi name is unavailable:

- Re-run `./bootstrap.sh` so the ipconfig sudoers rule is installed, then join the network again.
- Copy `wifi_mac_address` from the log into `alias.conf` when the name stays redacted. That is the reliable mapping on macOS versions that hide the SSID from scripts.
- Confirm the Wi-Fi service is the interface named in the log. It is not assumed to be `en0`.

`switch location is not required` means the selected location is already active. `Wi-Fi interface '…' is inactive` means the radio is off or not associated, so the location was left as it is.

The LaunchAgent does not start more than once every 10 seconds. A second change that arrives while a run is already waiting is handled by that run.

## Contributing

Contributions are welcome. Shell scripts in this repository are checked with [shellcheck](https://www.shellcheck.net/). The helper tests do not install the agent or read the live Wi-Fi network:

```bash
bash tests/test_wifi_loc_control.sh
```

Switching a location still has to be tried on a Mac.

## License

This project is licensed under the MIT License.
