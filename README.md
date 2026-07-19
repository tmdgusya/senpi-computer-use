# Senpi computer use

A source-only Senpi extension that exposes a conservative `computer_use` tool backed by `cua-driver`.

## Available actions

- `status`: runs `cua-driver doctor --json` in a credential-free child environment.
- `windows`: lists real X11/XWayland windows through `cua-driver`.
- `capture`: requests `get_window_state` for a selected `{ pid, windowId }`, returning the driver’s structured state.
- `click`: requests explicit interactive confirmation, then sends one background click for a selected accessibility `elementIndex` in `{ pid, windowId }`.

The extension disables telemetry and update checks for its child process. It never installs `cua-driver` and does not silently perform a mutation when no confirmation UI is available.

## Run locally

```bash
senpi --extension /home/roach/senpi-computer-use/src/index.ts
```

## Linux scope

The implemented loop was exercised against an XWayland GTK dialog. Native Wayland desktop capture remains outside this initial baseline and depends on the CUA platform helper/readiness path.
