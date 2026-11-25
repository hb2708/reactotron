import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parentPort, workerData } from "node:worker_threads"
import { WebSocketServer, WebSocket, type RawData } from "ws"

const PAYLOAD_OFFLOAD_BYTES = 16 * 1024
const BATCH_WINDOW_MS = 32
const MAX_BATCH_SIZE = 200

interface WorkerConfig {
  port: number
  bindHost: string
  maxPayloadBytes: number
  retryIntervalMs: number
}

interface PayloadEntry {
  offset: number
  length: number
  clientId?: string
}

interface SessionRecord {
  connectionId: number
  metadata: Record<string, any>
  socket: WebSocket
}

const config: WorkerConfig = {
  port: Number(workerData?.port ?? 9090),
  bindHost: String(workerData?.bindHost || "0.0.0.0"),
  maxPayloadBytes: Number(workerData?.maxPayloadBytes ?? 5 * 1024 * 1024),
  retryIntervalMs: Math.max(50, Number(workerData?.retryIntervalMs ?? 3000)),
}

let serverStatus: "stopped" | "started" | "portUnavailable" = "stopped"
let activePort = config.port
let nextConnectionId = 0
let nextMessageId = 0
let subscriptions: string[] = []
const sessions = new Map<string, SessionRecord>()
const socketMeta = new WeakMap<WebSocket, { connectionId: number; clientId?: string }>()

let wssV4: WebSocketServer | null = null
let wssV6: WebSocketServer | null = null
let keepAliveTimer: ReturnType<typeof setInterval> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let isStarting = false

// Temp-file append-only payload offload store
const payloadDbPath = path.join(
  os.tmpdir(),
  `reactotron-vscode-payloads-${process.pid}-${crypto.randomUUID()}.dat`
)
let payloadFd: number | null = fs.openSync(payloadDbPath, "w+")
let writeCursor = 0
const payloadIndex = new Map<number, PayloadEntry>()

function cleanupPayloadFile() {
  if (payloadFd !== null) {
    try {
      fs.closeSync(payloadFd)
    } catch {
      // ignore
    }
    payloadFd = null
  }
  try {
    fs.unlinkSync(payloadDbPath)
  } catch {
    // ignore
  }
}

function storeOffloadedPayload(messageId: number, clientId: string | undefined, payload: unknown) {
  if (payloadFd === null) return
  const json = JSON.stringify(payload)
  const buf = Buffer.from(json, "utf8")
  fs.writeSync(payloadFd, buf, 0, buf.length, writeCursor)
  payloadIndex.set(messageId, { offset: writeCursor, length: buf.length, clientId })
  writeCursor += buf.length
}

function readOffloadedPayloadRaw(entry: PayloadEntry): string | null {
  if (payloadFd === null) return null
  const buf = Buffer.allocUnsafe(entry.length)
  const read = fs.readSync(payloadFd, buf, 0, entry.length, entry.offset)
  return buf.subarray(0, read).toString("utf8")
}

function readOffloadedPayload(messageId: number): unknown | null {
  const entry = payloadIndex.get(messageId)
  if (!entry) return null
  const raw = readOffloadedPayloadRaw(entry)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function searchOffloadedPayloads(query: string, clientId?: string): number[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const hits: number[] = []
  for (const [messageId, entry] of payloadIndex.entries()) {
    if (clientId && entry.clientId !== clientId) continue
    const raw = readOffloadedPayloadRaw(entry)
    if (raw && raw.toLowerCase().includes(needle)) {
      hits.push(messageId)
      if (hits.length >= 500) break
    }
  }
  return hits
}

function clearOffloadedPayloads(clientId?: string) {
  if (!clientId) {
    payloadIndex.clear()
    writeCursor = 0
    if (payloadFd !== null) {
      try {
        fs.ftruncateSync(payloadFd, 0)
      } catch {
        // ignore
      }
    }
    return
  }
  for (const [id, entry] of payloadIndex.entries()) {
    if (entry.clientId === clientId) payloadIndex.delete(id)
  }
}

function buildSlimPreview(commandType: string, payload: any, originalBytes: number): any {
  const truncatedNote = `[Payload offloaded (${Math.round(originalBytes / 1024)} KB) — click row to load]`
  if (commandType === "api.response" && payload && typeof payload === "object") {
    return {
      request: {
        url: payload.request?.url,
        method: payload.request?.method,
        params: payload.request?.params,
      },
      response: {
        status: payload.response?.status,
        body: truncatedNote,
      },
      duration: payload.duration,
    }
  }
  if (commandType === "log" && payload && typeof payload === "object") {
    return {
      level: payload.level ?? "debug",
      message: truncatedNote,
    }
  }
  if (commandType === "state.action.complete" && payload && typeof payload === "object") {
    return {
      name: payload.name,
      ms: payload.ms,
      action: { type: payload.action?.type ?? payload.name, preview: truncatedNote },
    }
  }
  return { preview: truncatedNote, originalBytes }
}

const sentinelMap: Record<string, unknown> = {
  "~~~ null ~~~": null,
  "~~~ false ~~~": false,
  "~~~ zero ~~~": 0,
  "~~~ empty string ~~~": "",
  "~~~ anonymous function ~~~": "fn()",
}

function repairSerialization(value: unknown): unknown {
  if (!value || typeof value !== "object") return value
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = repairItem(value[i])
    }
    return value
  }
  const obj = value as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    obj[key] = repairItem(obj[key])
  }
  return obj
}

function repairItem(v: unknown): unknown {
  if (typeof v === "string") {
    const lower = v.toLowerCase()
    if (lower in sentinelMap) return sentinelMap[lower]
    if (
      lower === "~~~ undefined ~~~" ||
      lower === "~~~ nan ~~~" ||
      lower === "~~~ infinity ~~~" ||
      lower === "~~~ -infinity ~~~"
    ) {
      return v
    }
    if (v.length > 9 && v.startsWith("~~~ ") && v.endsWith(" ~~~")) {
      return v.replace(/~~~/g, "")
    }
    return v
  }
  if (v && typeof v === "object") {
    return repairSerialization(v)
  }
  return v
}

function post(msg: unknown) {
  parentPort?.postMessage(msg)
}

// 32 ms command batching queue
let pendingBatch: any[] = []
let batchTimer: ReturnType<typeof setTimeout> | null = null

function flushBatch() {
  if (batchTimer) {
    clearTimeout(batchTimer)
    batchTimer = null
  }
  if (pendingBatch.length === 0) return
  const batch = pendingBatch
  pendingBatch = []
  post({ event: "commandsBatch", batch })
}

function enqueueCommand(cmd: any) {
  pendingBatch.push(cmd)
  if (pendingBatch.length >= MAX_BATCH_SIZE) {
    flushBatch()
  } else if (!batchTimer) {
    batchTimer = setTimeout(flushBatch, BATCH_WINDOW_MS)
  }
}

function attachSocket(socket: WebSocket, remoteAddress: string) {
  const connectionId = nextConnectionId++
  socketMeta.set(socket, { connectionId })

  if (socket.readyState === WebSocket.OPEN) {
    socket.send(
      JSON.stringify({
        type: "state.values.subscribe",
        payload: { paths: subscriptions },
      })
    )
  }

  socket.on("message", (raw: RawData) => {
    const text = typeof raw === "string" ? raw : raw.toString("utf8")
    const meta = socketMeta.get(socket)!

    if (Buffer.byteLength(text, "utf8") > config.maxPayloadBytes) {
      const messageId = ++nextMessageId
      enqueueCommand({
        type: "log",
        connectionId,
        clientId: meta.clientId,
        date: new Date().toISOString(),
        deltaTime: 0,
        important: true,
        messageId,
        payload: {
          level: "warn",
          message: {
            warning: "Payload exceeded maxPayloadBytes limit and was truncated",
            originalBytes: Buffer.byteLength(text, "utf8"),
            maxBytes: config.maxPayloadBytes,
          },
        },
        payloadOffloaded: false,
      })
      return
    }

    let parsed: any
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    repairSerialization(parsed)

    const commandType = typeof parsed?.type === "string" ? parsed.type : ""
    if (!commandType) return

    const messageId = ++nextMessageId
    let payload = parsed.payload ?? {}
    const diff = parsed.diff ?? undefined
    const date = typeof parsed.date === "string" ? parsed.date : new Date().toISOString()
    const deltaTime = typeof parsed.deltaTime === "number" ? parsed.deltaTime : 0
    const important = Boolean(parsed.important)

    if (commandType === "client.intro") {
      if (payload && typeof payload === "object") {
        payload.address = remoteAddress
      }
      let assignedClientId =
        typeof payload?.clientId === "string" && payload.clientId.trim()
          ? payload.clientId.trim()
          : ""

      if (!assignedClientId) {
        assignedClientId = crypto.randomUUID()
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(
            JSON.stringify({
              type: "setClientId",
              payload: assignedClientId,
            })
          )
        }
      }

      const prev = sessions.get(assignedClientId)
      if (prev && prev.socket !== socket) {
        try {
          prev.socket.close()
        } catch {
          // ignore
        }
      }

      const connMeta = {
        ...payload,
        id: connectionId,
        address: remoteAddress,
        clientId: assignedClientId,
        ...(diff !== undefined ? { diff } : {}),
      }

      meta.clientId = assignedClientId
      sessions.set(assignedClientId, {
        connectionId,
        metadata: connMeta,
        socket,
      })

      post({ event: "connectionEstablished", connection: connMeta })
    } else if (commandType === "state.values.change") {
      if (Array.isArray(payload?.changes)) {
        subscriptions = payload.changes
          .map((item: any) => item?.path)
          .filter((p: unknown): p is string => typeof p === "string")
      }
    } else if (commandType === "state.backup.response") {
      if (payload && typeof payload === "object") {
        payload.name = null
      }
    }

    const encodedLen = Buffer.byteLength(text, "utf8")
    let payloadOffloaded = false
    let outboundPayload = payload
    if (
      encodedLen > PAYLOAD_OFFLOAD_BYTES &&
      commandType !== "client.intro" &&
      commandType !== "state.values.change"
    ) {
      storeOffloadedPayload(messageId, meta.clientId, payload)
      outboundPayload = buildSlimPreview(commandType, payload, encodedLen)
      payloadOffloaded = true
    }

    enqueueCommand({
      type: commandType,
      connectionId,
      clientId: meta.clientId,
      date,
      deltaTime,
      important,
      messageId,
      payload: outboundPayload,
      payloadOffloaded,
      ...(diff !== undefined ? { diff } : {}),
    })
  })

  socket.on("close", () => {
    const meta = socketMeta.get(socket)
    if (!meta?.clientId) return
    const existing = sessions.get(meta.clientId)
    if (existing && existing.connectionId === connectionId) {
      sessions.delete(meta.clientId)
      post({ event: "disconnect", connection: existing.metadata })
    }
  })

  socket.on("error", () => {
    // handled on close
  })
}

function clearRetryTimer() {
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
}

async function stopServers() {
  clearRetryTimer()
  flushBatch()
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer)
    keepAliveTimer = null
  }
  for (const session of sessions.values()) {
    try {
      session.socket.close()
    } catch {
      // ignore
    }
  }
  sessions.clear()

  const closeServer = (wss: WebSocketServer | null) =>
    new Promise<void>((resolve) => {
      if (!wss) return resolve()
      wss.close(() => resolve())
    })

  await Promise.all([closeServer(wssV4), closeServer(wssV6)])
  wssV4 = null
  wssV6 = null
  serverStatus = "stopped"
}

async function startServers() {
  if (isStarting) return
  isStarting = true
  try {
    await stopServers()

    await new Promise<void>((resolve) => {
      const server = new WebSocketServer({ host: config.bindHost, port: config.port })
      server.on("listening", () => {
        clearRetryTimer()
        const addr = server.address()
        if (addr && typeof addr === "object") {
          activePort = addr.port
        }
        wssV4 = server
        serverStatus = "started"
        post({ event: "serverStarted", port: activePort, bindHost: config.bindHost })
        resolve()
      })
      server.on("error", (err: NodeJS.ErrnoException) => {
        serverStatus = "portUnavailable"
        try {
          server.close()
        } catch {
          // ignore
        }
        post({
          event: "portUnavailable",
          port: config.port,
          error: err?.code || err?.message,
        })
        clearRetryTimer()
        retryTimer = setTimeout(() => {
          retryTimer = null
          if (serverStatus === "portUnavailable") {
            void startServers()
          }
        }, config.retryIntervalMs)
        resolve()
      })
      server.on("connection", (socket, req) => {
        attachSocket(socket, req.socket.remoteAddress || "127.0.0.1")
      })
    })

    if (serverStatus === "started" && activePort > 0) {
      try {
        const v6 = new WebSocketServer({ host: "::1", port: activePort })
        v6.on("error", () => {
          // Optional IPv6 loopback listener (0.0.0.0 or disabled IPv6 may conflict)
        })
        v6.on("connection", (socket, req) => {
          attachSocket(socket, req.socket.remoteAddress || "::1")
        })
        wssV6 = v6
      } catch {
        // ignore
      }

      keepAliveTimer = setInterval(() => {
        for (const session of sessions.values()) {
          if (session.socket.readyState === WebSocket.OPEN) {
            session.socket.ping()
          }
        }
      }, 30000)
    }
  } finally {
    isStarting = false
  }
}

function sendToClients(commandType: string, payload: unknown, clientId?: string): number {
  if (commandType === "state.values.subscribe" && payload && typeof payload === "object") {
    const paths = (payload as any).paths
    if (Array.isArray(paths)) {
      subscriptions = paths.filter((p): p is string => typeof p === "string")
    }
  }

  const encoded = JSON.stringify({ type: commandType, payload })
  let sent = 0
  if (clientId) {
    const target = sessions.get(clientId)
    if (target && target.socket.readyState === WebSocket.OPEN) {
      target.socket.send(encoded)
      sent = 1
    }
  } else {
    for (const session of sessions.values()) {
      if (session.socket.readyState === WebSocket.OPEN) {
        session.socket.send(encoded)
        sent++
      }
    }
  }
  return sent
}

parentPort?.on("message", async (msg: any) => {
  const { requestId, action } = msg || {}
  const reply = (ok: boolean, result?: unknown, error?: string) => {
    if (requestId !== undefined) {
      post({ requestId, ok, result, error })
    }
  }

  try {
    switch (action) {
      case "getServerState": {
        reply(true, {
          status: serverStatus,
          port: activePort,
          bindHost: config.bindHost,
          connections: Array.from(sessions.values()).map((s) => s.metadata),
          maxPayloadBytes: config.maxPayloadBytes,
        })
        break
      }
      case "sendCommand": {
        const sent = sendToClients(msg.commandType, msg.payload, msg.clientId || undefined)
        reply(true, sent)
        break
      }
      case "getCommandPayload": {
        reply(true, readOffloadedPayload(Number(msg.messageId)))
        break
      }
      case "searchCommandPayloads": {
        reply(true, searchOffloadedPayloads(String(msg.query || ""), msg.clientId || undefined))
        break
      }
      case "clearPayloadStore": {
        clearOffloadedPayloads(msg.clientId || undefined)
        reply(true, true)
        break
      }
      case "hydrateExport": {
        const items = Array.isArray(msg.commands) ? msg.commands : []
        const hydrated = items.map((item: any) => {
          if (item?.payloadOffloaded && typeof item.messageId === "number") {
            const full = readOffloadedPayload(item.messageId)
            if (full !== null) {
              const { payloadOffloaded: _drop, ...rest } = item
              return { ...rest, payload: full }
            }
          }
          return item
        })
        reply(true, hydrated)
        break
      }
      case "setMaxPayloadBytes": {
        config.maxPayloadBytes = Math.max(1024, Number(msg.maxBytes))
        reply(true, config.maxPayloadBytes)
        break
      }
      case "restart": {
        if (typeof msg.port === "number") config.port = msg.port
        if (typeof msg.bindHost === "string") config.bindHost = msg.bindHost
        await startServers()
        reply(true, { status: serverStatus, port: activePort, bindHost: config.bindHost })
        break
      }
      case "shutdown": {
        await stopServers()
        cleanupPayloadFile()
        reply(true, true)
        process.exit(0)
      }
      default:
        reply(false, undefined, `Unknown worker action: ${String(action)}`)
    }
  } catch (err: any) {
    reply(false, undefined, err?.message || String(err))
  }
})

process.on("exit", cleanupPayloadFile)
void startServers()
