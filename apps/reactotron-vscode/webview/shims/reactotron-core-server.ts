import type { CommandEvent, ServerEventKey } from "reactotron-core-contract"
import { repairSerialization } from "reactotron-core-ui"
import {
  getServerState,
  openInEditor,
  sendServerCommand,
  subscribeServerEvents,
  type IncomingCommandPayload,
} from "../bridge/vscodeBridge"

type Handler = (...args: any[]) => void
type ServerListener = CommandEvent | ((socket: { readyState: number }) => void)

function normalizeCommand(raw: IncomingCommandPayload) {
  const parsedDate = raw.date ? new Date(raw.date) : new Date()
  const isOffloaded = Boolean(raw.payloadOffloaded)
  const repairedPayload =
    !isOffloaded && raw.payload && typeof raw.payload === "object"
      ? repairSerialization(raw.payload)
      : raw.payload

  return {
    type: raw.type,
    connectionId: raw.connectionId,
    clientId: raw.clientId,
    date: Number.isNaN(parsedDate.getTime()) ? new Date() : parsedDate,
    deltaTime: raw.deltaTime ?? 0,
    important: Boolean(raw.important),
    messageId: raw.messageId,
    workerGeneration: raw.workerGeneration,
    payload: repairedPayload,
    payloadOffloaded: isOffloaded,
    diff: raw.diff,
  }
}

export default class Server {
  private listeners = new Map<string, Set<Handler>>()
  private unlisten: (() => void) | null = null
  private stopped = false
  started = false
  options: { port?: number } = { port: 9090 }

  configure(options: { port?: number } = { port: 9090 }) {
    this.options = { ...this.options, ...options }
    return this
  }

  on(event: ServerEventKey, handler: ServerListener) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)!.add(handler as Handler)
  }

  off(event: ServerEventKey, handler: ServerListener) {
    this.listeners.get(event)?.delete(handler as Handler)
  }

  private emit(event: string, ...args: any[]) {
    this.listeners.get(event)?.forEach((fn) => fn(...args))
  }

  start = () => {
    this.stopped = false
    this.started = true

    void (async () => {
      const unlistenFn = subscribeServerEvents({
        onServerStarted: () => this.emit("start"),
        onPortUnavailable: () => this.emit("portUnavailable", this.options.port ?? 9090),
        onConnectionEstablished: (conn) => this.emit("connectionEstablished", conn),
        onDisconnect: (conn) => this.emit("disconnect", conn),
        onCommand: (raw) => this.emit("command", normalizeCommand(raw)),
        onCommandsBatch: (batch) => {
          for (let i = 0; i < batch.length; i++) {
            this.emit("command", normalizeCommand(batch[i]))
          }
        },
      })

      if (this.stopped) {
        unlistenFn()
        return
      }
      this.unlisten = unlistenFn

      const snapshot = await getServerState()
      if (this.stopped) return

      if (snapshot.status === "started") {
        this.emit("start")
      } else if (snapshot.status === "portUnavailable") {
        this.emit("portUnavailable", snapshot.port)
      }

      for (const conn of snapshot.connections) {
        this.emit("connectionEstablished", conn)
      }
    })()

    return this
  }

  stop() {
    this.stopped = true
    this.started = false
    if (this.unlisten) {
      this.unlisten()
      this.unlisten = null
    }
    this.emit("stop")
    return this
  }

  send = (type: string, payload: any, clientId?: string) => {
    if (type === "editor.open" && payload?.file) {
      const lineNum = Number(payload.lineNumber)
      void openInEditor(payload.file, Number.isFinite(lineNum) ? lineNum : undefined)
    }
    return sendServerCommand(type, payload, clientId)
  }
}

export const createServer = (options?: { port?: number }) => {
  const server = new Server()
  server.configure(options)
  return server
}
