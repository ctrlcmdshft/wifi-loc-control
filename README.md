# WiFiLocControl

WiFiLocControl allows you to change your
macOS [network location](https://support.apple.com/en-us/105129) automatically based on the Wi-Fi
network (SSID) you are connected to. It is particularly useful for users who use Wi-Fi at work and
at home, but the network settings (for example, custom DNS configurations) you use at work don't
allow your Mac to automatically connect to the same type of network at home.

## Features

- Automatically changes network locations based on current Wi-Fi name.
- Supports alias configurations for multiple Wi-Fi names.
- Executes location-specific scripts.
- Includes `--preview` and `--doctor` modes for safer setup and troubleshooting.
- Includes optional script templates for common per-location automations.

## Installation


1. Clone the repository to your local machine.
  ```bash
  git clone https://github.com/vborodulin/wifi-loc-control.git
  cd wifi-loc-control
  ```

2. Run the bootstrap script to set up the environment.
  ```bash
  chmod +x bootstrap.sh
  ./bootstrap.sh
  ```
   It will **ask you for a root password** to install WiFiLocControl to the `/usr/local/bin` directory and set up required permissions for macOS 26+.

3. To check logs for activity:
  ```bash
  tail -f ~/Library/Logs/WiFiLocControl.log
  ```

4. To verify the install:
  ```bash
  /usr/local/bin/wifi-loc-control.sh --doctor
  ```

5. To uninstall, run:
  ```bash
  ./uninstall.sh
  ```
  To also remove aliases, scripts, and state:
  ```bash
  ./uninstall.sh --remove-config
  ```

## Usage
To set up specific preferences for your Wi-Fi networks, keep it easy: just name your network locations after
your Wi-Fi names. For example, if you want special settings for `My_Home_Wi-Fi_5GHz`, make a
location called `My_Home_Wi-Fi_5GHz`. When you connect to that Wi-Fi, your location will switch
automatically. If you connect to a Wi-Fi without a special name, it defaults to `Automatic`.

## Configuration

### Aliasing


To share one network location between different wireless networks (for example, if you have a router broadcasting on multiple bands, or want to group several SSIDs under one profile), create a configuration file `~/.wifi-loc-control/alias.conf` (plain text file with simple key-value pairs):

```bash
mkdir -p ~/.wifi-loc-control
nano ~/.wifi-loc-control/alias.conf
```

Example contents:
```
My_Home_Wi-Fi_5GHz=Home
My_Home_Wi-Fi_2.4GHz=Home
My_Work_Wi-Fi_5GHz=Work
My_Home_Wi-Fi_2.4GHz=Work
```

Where the keys are the wireless network names and the values are the desired location names.

You can also use explicit `ssid:` entries, comments, and BSSID/router MAC
entries. BSSID rules win over SSID rules, which helps when different places use
the same Wi-Fi name:

```text
# SSID aliases
ssid:CompanyWiFi=Work
ssid:HomeWiFi=Home

# More specific BSSID aliases
bssid:aa:bb:cc:dd:ee:ff=Office
bssid:11:22:33:44:55:66=Home
```

Before letting WiFiLocControl switch locations, you can preview the decision:

```bash
/usr/local/bin/wifi-loc-control.sh --preview
```

Validate aliases and location scripts:

```bash
/usr/local/bin/wifi-loc-control.sh --validate-config
```

### Run Scripts on Wi-Fi Network Connection

Sometimes you want to execute a script every time you connect to a specific Wi-Fi network. For
example enable stealth or enable firewall mode. Follow these
steps:

- Place your scripts in `~/.wifi-loc-control/`.
- Name the scripts after the Wi-Fi network name, ensuring consistency with the corresponding
  network locations.

Example script (`~/.wifi-loc-control/My_Home_Wi-Fi_5GHz`):

```bash
#!/usr/bin/env bash
# Collect all output from this script to ~/Library/Logs/WiFiLocControl.log
exec 2>&1

# Enable stealth mode which makes your computer less visible to potential attackers
/usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate on
```

To reset changes made by specific location scripts, create corresponding reset script.
Example reset script (`~/.wifi-loc-control/Automatic`):

```bash
#!/usr/bin/env bash
exec 2>&1

# Disable stealth mode which makes your computer less visible to potential attackers
/usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate off
```

Make scripts executable

```bash
chmod +x ~/.wifi-loc-control/My_Home_Wi-Fi_5GHz
chmod +x ~/.wifi-loc-control/Automatic
```

User-friendly examples are available in [`scripts/`](scripts/). They include
editable `Home`, `Work`, and `Automatic` templates plus common helper functions
for DNS, proxies, notifications, app launching, and network shares.

```bash
scripts/install-examples
```

Scripts are entry scripts. They run after entering a location, not when leaving
the previous location. Each script should describe the final state you want for
that location. For example, if `Work` enables a proxy, `Home` or `Automatic`
should disable it.

## Troubleshooting

Rich logs available at ~/Library/Logs/WiFiLocControl.log.

```bash
tail -f ~/Library/Logs/WiFiLocControl.log
```

Run a full health check:

```bash
/usr/local/bin/wifi-loc-control.sh --doctor
```

Logs examples:

```text
[2023-11-26 13:44:49] current wifi_name 'My_Home_Wi-Fi_5GHz'
[2023-11-26 13:44:49] network locations: Automatic Home
[2023-11-26 13:44:49] current network location 'Automatic'
[2023-11-26 13:44:49] reading alias config '/Users/vborodulin/.wifi-loc-control/alias.conf'
[2023-11-26 13:44:49] for wifi name 'My_Home_Wi-Fi_5GHz' found alias 'Home'
[2023-11-26 13:44:49] location switched to 'Home'
[2023-11-26 13:44:49] finding script for location 'Home'
[2023-11-26 13:44:49] running script '/Users/vborodulin/.wifi-loc-control/Home'
```

## Contributing

Contributions are welcome! If you have suggestions, improvements, or encounter issues, feel free to
open an issue or submit a pull request.

## License

This project is licensed under the MIT License.
