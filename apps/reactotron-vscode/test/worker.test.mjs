import assert from "node:assert/strict"
import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const workerPath = path.resolve(__dirname, "../dist/serverWorker.js")

const worker = new Worker(workerPath, {
  workerData: { port: 0, bindHost: "127.0.0.1", maxPayloadBytes: 5 * 1024 * 1024 },
})

const events = []
const pending = new Map()
let reqId = 0

function callWorker(action, payload = {}) {
  const requestId = ++reqId
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject })
    worker.postMessage({ requestId, action, ...payload })
  })
}

function waitForEvent(predicate, timeoutMs = 3000) {
  const existing = events.find(predicate)
  if (existing) return Promise.resolve(existing)
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      const found = events.find(predicate)
      if (found) {
        clearInterval(timer)
        resolve(found)
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error("Timed out waiting for worker event"))
      }
    }, 10)
  })
}

worker.on("message", (msg) => {
  if (msg?.requestId !== undefined) {
    const p = pending.get(msg.requestId)
    if (p) {
      pending.delete(msg.requestId)
      if (msg.ok) p.resolve(msg.result)
      else p.reject(new Error(msg.error))
    }
    return
  }
  events.push(msg)
})

const startedEv = await waitForEvent((e) => e.event === "serverStarted")
assert.ok(startedEv.port > 0, "Expected ephemeral port > 0")

const ws = new WebSocket(`ws://127.0.0.1:${startedEv.port}`)
const received = []
ws.onmessage = (ev) => received.push(JSON.parse(String(ev.data)))

await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})

// Expect initial state.values.subscribe
await new Promise((r) => setTimeout(r, 30))
assert.equal(received[0]?.type, "state.values.subscribe")

// 1. Handshake client.intro -> setClientId
ws.send(
  JSON.stringify({
    type: "client.intro",
    payload: { name: "VSCodeMockApp", platform: "ios", platformVersion: "18.2" },
  })
)

const established = await waitForEvent((e) => e.event === "connectionEstablished")
const clientId = established.connection.clientId
assert.ok(clientId)
assert.equal(received[1]?.type, "setClientId")
assert.equal(received[1]?.payload, clientId)

// 2. Large (>16 KB) payload offload + hydration + search
const bigBody = { marker: "NEEDLE_IN_HAYSTACK", blob: "x".repeat(24 * 1024) }
ws.send(
  JSON.stringify({
    type: "api.response",
    payload: {
      request: { url: "https://example.com/big", method: "GET" },
      response: { status: 200, body: bigBody },
      duration: 25,
    },
  })
)

const batchEv = await waitForEvent(
  (e) => e.event === "commandsBatch" && e.batch.some((c) => c.type === "api.response")
)
const apiCmd = batchEv.batch.find((c) => c.type === "api.response")
assert.equal(apiCmd.payloadOffloaded, true)

const hydrated = await callWorker("getCommandPayload", { messageId: apiCmd.messageId })
assert.equal(hydrated.response.body.marker, "NEEDLE_IN_HAYSTACK")

const searchHits = await callWorker("searchCommandPayloads", { query: "needle_in_haystack" })
assert.ok(searchHits.includes(apiCmd.messageId))

// 3. Outbound command round-trip
const sentCount = await callWorker("sendCommand", {
  commandType: "state.values.request",
  payload: { path: "auth.user" },
  clientId,
})
assert.equal(sentCount, 1)
await new Promise((r) => setTimeout(r, 30))
assert.equal(received[2]?.type, "state.values.request")
assert.equal(received[2]?.payload?.path, "auth.user")

// 4. Max payload guard (> 5 MB)
await callWorker("setMaxPayloadBytes", { maxBytes: 1024 })
ws.send(JSON.stringify({ type: "log", payload: { level: "debug", message: "y".repeat(2048) } }))
const warnBatch = await waitForEvent(
  (e) =>
    e.event === "commandsBatch" &&
    e.batch.some((c) => c.type === "log" && c.payload?.level === "warn")
)
assert.ok(warnBatch)

// 5. MCP HTTP server start / initialize / stop
const mcpProbe = net.createServer()
await new Promise((resolve) => mcpProbe.listen(0, "127.0.0.1", resolve))
const mcpProbeAddr = mcpProbe.address()
assert.ok(mcpProbeAddr && typeof mcpProbeAddr === "object")
const mcpPort = mcpProbeAddr.port
await new Promise((resolve) => mcpProbe.close(resolve))

const mcpStartRes = await callWorker("startMcp", { port: mcpPort })
assert.equal(mcpStartRes.started, true)
assert.equal(mcpStartRes.port, mcpPort)

const mcpInitRes = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "worker-test", version: "0.1.0" },
    },
  }),
})
assert.equal(mcpInitRes.status, 200)
const mcpInitBody = await mcpInitRes.text()
assert.ok(mcpInitBody.includes("reactotron"), `Expected reactotron in MCP response: ${mcpInitBody}`)

const mcpStopRes = await callWorker("stopMcp")
assert.equal(mcpStopRes.started, false)

ws.close()
await callWorker("shutdown")

// 5. Auto-recovery when port is transiently busy at startup
const blocker = net.createServer()
await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve))
const blockerAddr = blocker.address()
assert.ok(blockerAddr && typeof blockerAddr === "object")
const busyPort = blockerAddr.port

const retryWorker = new Worker(workerPath, {
  workerData: {
    port: busyPort,
    bindHost: "127.0.0.1",
    maxPayloadBytes: 5 * 1024 * 1024,
    retryIntervalMs: 100,
  },
})

const retryEvents = []
let retryReqId = 0
const retryPending = new Map()
retryWorker.on("message", (msg) => {
  if (msg?.requestId !== undefined) {
    const p = retryPending.get(msg.requestId)
    if (p) {
      retryPending.delete(msg.requestId)
      if (msg.ok) p.resolve(msg.result)
      else p.reject(new Error(msg.error))
    }
    return
  }
  retryEvents.push(msg)
})

function waitForRetryEvent(predicate, timeoutMs = 2000) {
  const existing = retryEvents.find(predicate)
  if (existing) return Promise.resolve(existing)
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const timer = setInterval(() => {
      const found = retryEvents.find(predicate)
      if (found) {
        clearInterval(timer)
        resolve(found)
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer)
        reject(new Error("Timed out waiting for retry worker event"))
      }
    }, 10)
  })
}

await waitForRetryEvent((e) => e.event === "portUnavailable" && e.port === busyPort)
await new Promise((resolve) => blocker.close(resolve))
const recovered = await waitForRetryEvent((e) => e.event === "serverStarted" && e.port === busyPort)
assert.equal(recovered.port, busyPort)

await new Promise((resolve, reject) => {
  const requestId = ++retryReqId
  retryPending.set(requestId, { resolve, reject })
  retryWorker.postMessage({ requestId, action: "shutdown" })
})

console.log("reactotron-vscode worker test passed")
