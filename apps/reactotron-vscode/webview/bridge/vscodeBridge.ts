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
  bindHost: string
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

const vscodeApi =
  typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null

let reqId = 0
const pending = new Map<
  number,
  { resolve: (val: any) => void; reject: (err: Error) => void }
>()
const eventListeners = new Map<string, Set<(payload: any) => void>>()

if (typeof window !== "undefined") {
  window.addEventListener("message", (event) => {
    const msg = event.data
    if (!msg || typeof msg !== "object") return
    if (msg.type === "response" && msg.requestId !== undefined) {
      const entry = pending.get(msg.requestId)
      if (entry) {
        pending.delete(msg.requestId)
        if (msg.ok) entry.resolve(msg.result)
        else entry.reject(new Error(msg.error || "Extension host error"))
      }
      return
    }
    if (msg.type === "event" && typeof msg.event === "string") {
      eventListeners.get(msg.event)?.forEach((fn) => fn(msg.payload))
    }
  })
}

export function requestHost<T = any>(action: string, data: Record<string, any> = {}): Promise<T> {
  if (!vscodeApi) {
    return Promise.reject(new Error("VS Code Webview API unavailable"))
  }
  const requestId = ++reqId
  return new Promise<T>((resolve, reject) => {
    pending.set(requestId, { resolve, reject })
    vscodeApi.postMessage({ requestId, action, ...data })
  })
}

export function addHostEventListener(
  eventName: string,
  handler: (payload: any) => void
): () => void {
  if (!eventListeners.has(eventName)) {
    eventListeners.set(eventName, new Set())
  }
  eventListeners.get(eventName)!.add(handler)
  return () => {
    eventListeners.get(eventName)?.delete(handler)
  }
}

export function isVscodeRuntime(): boolean {
  return vscodeApi !== null
}

export async function getServerState(): Promise<ServerStateSnapshot> {
  if (!isVscodeRuntime()) {
    return {
      status: "stopped",
      port: 9090,
      bindHost: "0.0.0.0",
      connections: [],
      maxPayloadBytes: 5 * 1024 * 1024,
    }
  }
  return requestHost<ServerStateSnapshot>("getServerState")
}

export async function sendServerCommand(
  commandType: string,
  payload: any,
  clientId?: string
): Promise<void> {
  if (!isVscodeRuntime()) return
  await requestHost("sendCommand", { commandType, payload, clientId: clientId || null })
}

export async function openInEditor(file: string, lineNumber?: number): Promise<void> {
  if (!isVscodeRuntime()) return
  await requestHost("openInEditor", { file, lineNumber: lineNumber ?? null })
}

export async function readLocalFile(path: string): Promise<string> {
  return requestHost<string>("readLocalFile", { path })
}

export async function exportTimelineLog(contents: string, filePath?: string): Promise<string | null> {
  if (!isVscodeRuntime()) return null
  return requestHost<string>("exportTimelineLog", { contents, filePath: filePath ?? null })
}

export async function getCommandPayload(messageId: number): Promise<any | null> {
  if (!isVscodeRuntime()) return null
  return requestHost<any | null>("getCommandPayload", { messageId })
}

export async function clearPayloadStore(clientId?: string): Promise<void> {
  if (!isVscodeRuntime()) return
  await requestHost("clearPayloadStore", { clientId: clientId ?? null })
}

export async function searchCommandPayloads(
  query: string,
  clientId?: string
): Promise<number[]> {
  if (!isVscodeRuntime()) return []
  return requestHost<number[]>("searchCommandPayloads", { query, clientId: clientId ?? null })
}

export function copyText(text: string): void {
  if (isVscodeRuntime()) {
    void requestHost("copyText", { text }).catch(() => {
      if (navigator.clipboard) void navigator.clipboard.writeText(text)
    })
    return
  }
  if (navigator.clipboard) {
    void navigator.clipboard.writeText(text)
  }
}

export function openExternalUrl(url: string): void {
  if (isVscodeRuntime()) {
    void requestHost("openExternal", { url }).catch(() => {})
    return
  }
  window.open(url, "_blank", "noopener,noreferrer")
}

export function subscribeServerEvents(handlers: {
  onServerStarted: () => void
  onPortUnavailable: () => void
  onConnectionEstablished: (conn: ReactotronConnection) => void
  onDisconnect: (conn: ReactotronConnection) => void
  onCommand: (cmd: IncomingCommandPayload) => void
  onCommandsBatch?: (cmds: IncomingCommandPayload[]) => void
}): () => void {
  if (!isVscodeRuntime()) return () => {}

  const unlisteners = [
    addHostEventListener("reactotron://server-started", () => handlers.onServerStarted()),
    addHostEventListener("reactotron://port-unavailable", () => handlers.onPortUnavailable()),
    addHostEventListener("reactotron://connection-established", (conn) =>
      handlers.onConnectionEstablished(conn)
    ),
    addHostEventListener("reactotron://disconnect", (conn) => handlers.onDisconnect(conn)),
    addHostEventListener("reactotron://command", (cmd) => handlers.onCommand(cmd)),
    addHostEventListener("reactotron://commands-batch", (batch: IncomingCommandPayload[]) => {
      if (handlers.onCommandsBatch) {
        handlers.onCommandsBatch(batch)
      } else {
        batch.forEach((c) => handlers.onCommand(c))
      }
    }),
  ]

  return () => {
    unlisteners.forEach((fn) => fn())
  }
}
