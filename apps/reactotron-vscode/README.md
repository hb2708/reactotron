# Sidecar for Reactotron

> **Unofficial Extension:** This is an independent community extension built on the MIT-licensed [Reactotron](https://github.com/infinitered/reactotron) codebase. It is not affiliated with, endorsed by, or maintained by Infinite Red LLC.

Unofficial Reactotron inspector embedded directly inside VS Code and Cursor, reusing `reactotron-core-ui` and `apps/reactotron-app` renderer components with zero extra Electron/Chromium processes.

## Features

- **Isolated Worker Server**: Runs the Reactotron WebSocket server in a dedicated Node `worker_threads` worker (`0.0.0.0` + `::1` loopback) with 3s auto-retry if port `9090` is transiently busy.
- **Flat Memory Under Load**: Batches UI IPC updates every 32 ms, truncates oversized payloads (`maxPayloadMB`), virtualizes the timeline with `@tanstack/react-virtual`, and offloads payloads over 16 KB to a temp file (hydrated lazily on click and searchable).
- **Native Jump-to-Source**: Click stack frames in error logs to open the file and line directly in VS Code via `vscode.workspace.openTextDocument`.
- **Live MCP Server**: Built-in Streamable HTTP `reactotron-mcp` endpoint (`http://127.0.0.1:4567/mcp`) for inspecting timeline, state, network logs, and triggering custom commands from AI coding tools.
- **Android ADB Support**: Built-in device discovery and one-click `adb reverse tcp:9090 tcp:9090` port forwarding.

## Installation

### From VSIX

```bash
code --install-extension sidecar-for-reactotron-0.1.5.vsix
# or in Cursor:
cursor --install-extension sidecar-for-reactotron-0.1.5.vsix
```

Or in the Extensions sidebar, click `...` -> **Install from VSIX...** and select the `.vsix` file.

## Quick Start

1. Quit any standalone Reactotron Electron/Tauri app so port `9090` is free.
2. Click **Reactotron :9090** in the bottom status bar (or open the Command Palette with `Cmd+Shift+P` / `Ctrl+Shift+P` -> **Reactotron: Open Inspector**).
3. Run your React Native, Expo, or React app configured with Reactotron on port `9090`.
   - **iOS Simulator / Web**: connects to `localhost:9090` automatically.
   - **Android Emulator / USB**: run `adb reverse tcp:9090 tcp:9090` (or use the **Help** tab reverse button).
   - **Physical Device on LAN**: keep the default `0.0.0.0` bind host and point your app's Reactotron `host` config to your computer's LAN IP.

## Commands

| Command | Description |
| --- | --- |
| `Reactotron: Open Inspector` | Opens or focuses the Reactotron Webview panel beside your editor |
| `Reactotron: Restart Server` | Restarts the background WebSocket server on the configured host and port |
| `Reactotron: Toggle LAN / Loopback Bind Mode` | Switches between `0.0.0.0` (LAN/Expo devices) and `127.0.0.1` (loopback only) |

## Extension Settings

| Setting | Default | Description |
| --- | --- | --- |
| `reactotron.port` | `9090` | WebSocket port for incoming Reactotron client connections |
| `reactotron.bindHost` | `"0.0.0.0"` | Bind interface (`"0.0.0.0"` for LAN/Expo devices, `"127.0.0.1"` for loopback only) |
| `reactotron.maxPayloadMB` | `5` | Maximum single WebSocket message size (MB) before truncation |
| `reactotron.autoStart` | `true` | Automatically start the Reactotron WebSocket worker on VS Code startup |

## MCP Server

1. Click **MCP** in the Reactotron panel footer to start the local Streamable HTTP server (`http://127.0.0.1:4567/mcp`). A green indicator confirms it is listening.
2. Configure redaction rules and client permissions directly in the panel's MCP settings dialog.

> **Lifecycle Note:** The `:9090` WebSocket inspector server stays running in the background when you close the Reactotron tab (so logs and connections keep flowing when `reactotron.autoStart` is enabled), whereas the MCP HTTP server stops when the Reactotron inspector tab is closed and starts again when toggled back on.

## License

MIT License. Based on [Reactotron](https://github.com/infinitered/reactotron) (Copyright Infinite Red LLC). See [LICENSE](./LICENSE) and [THIRD_PARTY_LICENSES.txt](./THIRD_PARTY_LICENSES.txt).
