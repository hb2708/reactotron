import assert from "node:assert/strict"
import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import WebSocket from "ws"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const workerPath = path.resolve(__dirname, "../dist/serverWorker.js")

function createWorkerHarness(workerData) {
  const worker = new Worker(workerPath, { workerData })
  const events = []
  const pending = new Map()
  let reqId = 0

  worker.on("message", (msg) => {
    if (msg?.requestId !== undefined) {
      const p = pending.get(msg.requestId)
      if (p) {
        pending.delete(msg.requestId)
        clearTimeout(p.timer)
        if (msg.ok) p.resolve(msg.result)
        else p.reject(new Error(msg.error))
      }
      return
    }
    events.push(msg)
  })

  worker.on("error", (err) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    pending.clear()
  })

  function callWorker(action, payload = {}, timeoutMs = 5000) {
    const requestId = ++reqId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error(`Worker request "${action}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      pending.set(requestId, { resolve, reject, timer })
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

  async function shutdown() {
    try {
      await callWorker("shutdown", {}, 3000)
    } catch {
      await worker.terminate()
    }
  }

  return { worker, events, callWorker, waitForEvent, shutdown }
}

function waitForCondition(predicate, timeoutMs = 3000, label = "condition") {
  const existing = predicate()
  if (existing) return Promise.resolve(existing)
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      const val = predicate()
      if (val) {
        clearInterval(timer)
        resolve(val)
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`Timed out waiting for ${label}`))
      }
    }, 10)
  })
}

async function getFreePort() {
  const probe = net.createServer()
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve))
  const addr = probe.address()
  assert.ok(addr && typeof addr === "object")
  const port = addr.port
  await new Promise((resolve) => probe.close(resolve))
  return port
}

// Primary end-to-end worker test
const main = createWorkerHarness({
  port: 0,
  bindHost: "127.0.0.1",
  maxPayloadBytes: 5 * 1024 * 1024,
  workerGeneration: 1,
})

let ws = null
let mcpBlocker = null
try {
  const startedEv = await main.waitForEvent((e) => e.event === "serverStarted")
  assert.ok(startedEv.port > 0, "Expected ephemeral port > 0")

  ws = new WebSocket(`ws://127.0.0.1:${startedEv.port}`)
  const received = []
  ws.onmessage = (ev) => received.push(JSON.parse(String(ev.data)))

  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })

  // Expect initial state.values.subscribe via deadline wait
  const subMsg = await waitForCondition(
    () => received.find((m) => m?.type === "state.values.subscribe"),
    3000,
    "state.values.subscribe"
  )
  assert.equal(subMsg.type, "state.values.subscribe")

  // 1. Handshake client.intro -> setClientId
  ws.send(
    JSON.stringify({
      type: "client.intro",
      payload: { name: "VSCodeMockApp", platform: "ios", platformVersion: "18.2" },
    })
  )

  const established = await main.waitForEvent((e) => e.event === "connectionEstablished")
  const clientId = established.connection.clientId
  assert.ok(clientId)
  const setIdMsg = await waitForCondition(
    () => received.find((m) => m?.type === "setClientId"),
    3000,
    "setClientId"
  )
  assert.equal(setIdMsg.payload, clientId)

  // 2. Large (>16 KB) payload offload + hydration + search + generation check
  const bigBody = { marker: "NEEDLE_IN_HAYSTACK", blob: "x".repeat(24 * 1024) }
  ws.send(
    JSON.stringify({
      type: "api.response",
      payload: {
        request: { url: "https://example.com/big", method: "GET", params: { huge: "p".repeat(1024) } },
        response: { status: 200, body: bigBody },
        duration: 25,
      },
    })
  )

  const batchEv = await main.waitForEvent(
    (e) => e.event === "commandsBatch" && e.batch.some((c) => c.type === "api.response")
  )
  const apiCmd = batchEv.batch.find((c) => c.type === "api.response")
  assert.equal(apiCmd.payloadOffloaded, true)
  assert.equal(apiCmd.workerGeneration, 1)
  assert.ok(typeof apiCmd.payload.request.params === "string")

  const hydrated = await main.callWorker("getCommandPayload", {
    messageId: apiCmd.messageId,
    workerGeneration: 1,
  })
  assert.equal(hydrated.response.body.marker, "NEEDLE_IN_HAYSTACK")

  const staleGenHydrated = await main.callWorker("getCommandPayload", {
    messageId: apiCmd.messageId,
    workerGeneration: 99,
  })
  assert.equal(staleGenHydrated, null)

  const searchHits = await main.callWorker("searchCommandPayloads", { query: "needle_in_haystack" })
  assert.ok(searchHits.includes(apiCmd.messageId))

  // Scoped clear reclaims index entries
  await main.callWorker("clearPayloadStore", { clientId })
  const clearedLookup = await main.callWorker("getCommandPayload", {
    messageId: apiCmd.messageId,
    workerGeneration: 1,
  })
  assert.equal(clearedLookup, null)

  // 3. Outbound command round-trip
  const sentCount = await main.callWorker("sendCommand", {
    commandType: "state.values.request",
    payload: { path: "auth.user" },
    clientId,
  })
  assert.equal(sentCount, 1)
  const reqMsg = await waitForCondition(
    () => received.find((m) => m?.type === "state.values.request"),
    3000,
    "state.values.request"
  )
  assert.equal(reqMsg.payload?.path, "auth.user")

  // 4. Prototype-key safety in repairItem ("constructor", "toString")
  ws.send(
    JSON.stringify({
      type: "log",
      payload: { level: "info", message: { key: "constructor", extra: "toString" } },
    })
  )
  const protoBatch = await main.waitForEvent(
    (e) =>
      e.event === "commandsBatch" &&
      e.batch.some((c) => c.type === "log" && c.payload?.message?.key === "constructor")
  )
  assert.equal(
    protoBatch.batch.find((c) => c.type === "log" && c.payload?.message?.key === "constructor")
      ?.payload?.message?.extra,
    "toString"
  )

  // 5. Max payload guard
  await main.callWorker("setMaxPayloadBytes", { maxBytes: 1024 })
  ws.send(JSON.stringify({ type: "log", payload: { level: "debug", message: "y".repeat(2048) } }))
  const warnBatch = await main.waitForEvent(
    (e) =>
      e.event === "commandsBatch" &&
      e.batch.some((c) => c.type === "log" && c.payload?.level === "warn")
  )
  assert.ok(warnBatch)

  // 6. MCP failed startup rollback + clean start / initialize / stop
  mcpBlocker = net.createServer()
  await new Promise((resolve) => mcpBlocker.listen(0, "127.0.0.1", resolve))
  const busyMcpAddr = mcpBlocker.address()
  assert.ok(busyMcpAddr && typeof busyMcpAddr === "object")
  await assert.rejects(() => main.callWorker("startMcp", { port: busyMcpAddr.port }))
  await new Promise((resolve) => mcpBlocker.close(resolve))
  mcpBlocker = null

  const mcpPort = await getFreePort()
  const mcpStartRes = await main.callWorker("startMcp", { port: mcpPort })
  assert.equal(mcpStartRes.started, true)
  assert.equal(mcpStartRes.port, mcpPort)

  const mcpInitRes = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    signal: AbortSignal.timeout(5000),
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

  const mcpStopRes = await main.callWorker("stopMcp")
  assert.equal(mcpStopRes.started, false)
} finally {
  if (mcpBlocker) {
    await new Promise((resolve) => mcpBlocker.close(() => resolve()))
  }
  try {
    ws?.close()
  } catch {
    // ignore
  }
  await main.shutdown()
}

// 7. Auto-recovery when port is transiently busy at startup
const blocker = net.createServer()
await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve))
const blockerAddr = blocker.address()
assert.ok(blockerAddr && typeof blockerAddr === "object")
const busyPort = blockerAddr.port

const retryHarness = createWorkerHarness({
  port: busyPort,
  bindHost: "127.0.0.1",
  maxPayloadBytes: 5 * 1024 * 1024,
  retryIntervalMs: 100,
})

try {
  await retryHarness.waitForEvent((e) => e.event === "portUnavailable" && e.port === busyPort, 2000)
  await new Promise((resolve) => blocker.close(resolve))
  const recovered = await retryHarness.waitForEvent(
    (e) => e.event === "serverStarted" && e.port === busyPort,
    2000
  )
  assert.equal(recovered.port, busyPort)
} finally {
  try {
    blocker.close()
  } catch {
    // ignore
  }
  await retryHarness.shutdown()
}

console.log("reactotron-vscode worker test passed")
