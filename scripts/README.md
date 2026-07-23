# WiFiLocControl Script Templates

WiFiLocControl runs one script per network location.

If WiFiLocControl switches to `Home`, it runs:

```bash
~/.wifi-loc-control/Home
```

If it switches to `Work`, it runs:

```bash
~/.wifi-loc-control/Work
```

These templates are optional examples. Copy the ones you want into
`~/.wifi-loc-control/`, rename them to match your macOS Network Location names,
and edit the settings at the top of each file.

## Install the examples

```bash
scripts/install-examples
```

To overwrite existing examples:

```bash
scripts/install-examples --force
```

## Entry Script Model

Scripts run after entering a location, not when leaving the previous location.

Each script should describe the desired final state for that location. For
example, if `Work` enables a proxy, `Home` or `Automatic` should disable that
proxy.

## Safety Tips

- Keep scripts idempotent: they should be safe to run more than once.
- Start with notifications enabled so you can see when scripts run.
- Avoid commands that require an interactive password.
- Put cleanup in the next location's entry script.
