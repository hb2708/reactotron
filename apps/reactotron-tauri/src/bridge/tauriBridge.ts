import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager"
import { openUrl } from "@tauri-apps/plugin-opener"

export type ServerStatus = "stopped" | "portUnavailable" | "started"

export interface ReactotronConnection {
  id: number
  clientId: string
  platform: "ios" | "android" | "browser" | string
  name?: string
  platformVersion?: string
  osRelease?: string
  userAgent?: string
  address?: string
  windowWidth?: number
  windowHeight?: number
  screenScale?: number
  reactotronVersion?: string
}

export interface ServerStateSnapshot {
  status: ServerStatus
  port: number
  connections: ReactotronConnection[]
  maxPayloadBytes: number
}

export interface IncomingCommandPayload {
  type: string
  connectionId: number
  clientId?: string
  date: string
  deltaTime: number
  important: boolean
  messageId: number
  payload: any
  payloadOffloaded?: boolean
  diff?: any
}

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

export async function getServerState(): Promise<ServerStateSnapshot> {
  if (!isTauriRuntime()) {
    return { status: "stopped", port: 9090, connections: [], maxPayloadBytes: 5 * 1024 * 1024 }
  }
  return invoke<ServerStateSnapshot>("get_server_state")
}

export async function sendServerCommand(
  commandType: string,
  payload: any,
  clientId?: string
): Promise<void> {
  if (!isTauriRuntime()) return
  await invoke("send_command", { commandType, payload, clientId: clientId || null })
}

export async function openInEditor(file: string, lineNumber?: number): Promise<void> {
  if (!isTauriRuntime()) return
  await invoke("open_in_editor", { file, lineNumber: lineNumber ?? null })
}

export async function readLocalFile(path: string): Promise<string> {
  if (!isTauriRuntime()) {
    throw new Error("Local file reading requires Tauri runtime")
  }
  return invoke<string>("read_local_file", { path })
}

export async function exportTimelineLog(contents: string): Promise<string | null> {
  if (!isTauriRuntime()) return null
  return invoke<string>("export_timeline_log", { contents, filePath: null })
}

export async function setMaxPayloadBytes(maxBytes: number): Promise<void> {
  if (!isTauriRuntime()) return
  await invoke("set_max_payload_bytes", { maxBytes })
}

export async function getCommandPayload(messageId: number): Promise<any | null> {
  if (!isTauriRuntime()) return null
  return invoke<any | null>("get_command_payload", { messageId })
}

export async function clearPayloadStore(clientId?: string): Promise<void> {
  if (!isTauriRuntime()) return
  await invoke("clear_payload_store", { clientId: clientId ?? null })
}

export async function searchCommandPayloads(query: string, clientId?: string): Promise<number[]> {
  if (!isTauriRuntime() || !query.trim()) return []
  return invoke<number[]>("search_command_payloads", { query, clientId: clientId ?? null })
}

if (typeof window !== "undefined") {
  ;(window as any).__REACTOTRON_TAURI_BRIDGE__ = {
    getCommandPayload,
    clearPayloadStore,
    searchCommandPayloads,
  }
}

export function copyText(text: string): void {
  if (isTauriRuntime()) {
    void writeClipboardText(text).catch(() => {
      if (navigator.clipboard) void navigator.clipboard.writeText(text)
    })
    return
  }
  if (navigator.clipboard) {
    void navigator.clipboard.writeText(text)
  }
}

export function openExternalUrl(url: string): void {
  if (isTauriRuntime()) {
    void openUrl(url).catch(() => {
      window.open(url, "_blank", "noopener,noreferrer")
    })
    return
  }
  window.open(url, "_blank", "noopener,noreferrer")
}

export async function subscribeServerEvents(handlers: {
  onServerStarted: () => void
  onPortUnavailable: () => void
  onConnectionEstablished: (conn: ReactotronConnection) => void
  onDisconnect: (conn: ReactotronConnection) => void
  onCommand: (cmd: IncomingCommandPayload) => void
  onCommandsBatch?: (cmds: IncomingCommandPayload[]) => void
}): Promise<() => void> {
  if (!isTauriRuntime()) return () => {}

  const unlisteners: UnlistenFn[] = await Promise.all([
    listen("reactotron://server-started", () => handlers.onServerStarted()),
    listen("reactotron://port-unavailable", () => handlers.onPortUnavailable()),
    listen<ReactotronConnection>("reactotron://connection-established", (e) =>
      handlers.onConnectionEstablished(e.payload)
    ),
    listen<ReactotronConnection>("reactotron://disconnect", (e) =>
      handlers.onDisconnect(e.payload)
    ),
    listen<IncomingCommandPayload>("reactotron://command", (e) => handlers.onCommand(e.payload)),
    listen<IncomingCommandPayload[]>("reactotron://commands-batch", (e) => {
      if (handlers.onCommandsBatch) {
        handlers.onCommandsBatch(e.payload)
      } else {
        e.payload.forEach((cmd) => handlers.onCommand(cmd))
      }
    }),
  ])

  return () => {
    unlisteners.forEach((unlisten) => unlisten())
  }
}
