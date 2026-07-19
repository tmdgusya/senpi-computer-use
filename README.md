# Senpi computer use

A source-only Senpi extension that exposes one conservative `computer_use` tool
backed by a persistent MCP connection to [`cua-driver`](https://github.com/trycua).

## Architecture

The extension owns **one lazy, persistent MCP stdio proxy** to `cua-driver mcp`
(not a per-call CLI process). On first driver-backed action it:

1. spawns `cua-driver mcp` with a credential-free child environment,
2. performs the MCP `initialize` + `tools/list` handshake and **validates the
   tool contract** (required tools, `get_window_state` schema keys, minimum
   driver version) — failing closed on any mismatch,
3. declares one logical CUA session that every subsequent action carries,
4. serializes all tool calls FIFO and shuts the child down deterministically
   (graceful close → terminate → kill) on `session_shutdown`.

## Actions

`computer_use(action: ...)` is a single action-discriminated tool:

- **Read-only (no approval):** `status` (capability doctor), `windows`,
  `capture` (accessibility elements + a screenshot when the model accepts
  images), `wait`.
- **State-changing (per-call approval):** `click`, `double_click`,
  `right_click`, `drag`, `scroll`, `type`, `key`, `hotkey`, `set_value`,
  `launch`, `focus`.

### Safety

- Every mutating action requires **explicit allow-once approval** and is
  **denied in non-interactive modes** (`ctx.mode !== "tui"`) with reason
  `interactive_approval_required`.
- Catastrophic key/hotkey/text combinations are **hard-blocked before approval**.
- Element indexes are only valid for the capture generation they came from; a
  reconnect invalidates them (`stale_reference`).
- Mutating calls with an unknown outcome (timeout / transport loss / in-flight
  abort) are reported and **never replayed**.

## Run locally

```bash
senpi --extension /home/roach/senpi-computer-use/src/index.ts
```

The extension never installs `cua-driver` and never runs it at import time;
install and grant its host permissions separately. Telemetry and update checks
are disabled for the extension-launched child process.

## Tests

- `npm test` — fast unit + contract suite (fake MCP transport, no driver needed).
- `SENPI_CUA_LIVE=1 npm test` — additionally runs the live integration suite
  against a real installed `cua-driver` (read-only probes only).

## Linux scope

The implemented loop targets XWayland application windows. Native Wayland
desktop capture depends on the CUA platform helper/readiness path and is
capability-gated, not asserted here. macOS and Windows are unverified.
