import { execFile, spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { Worker } from "node:worker_threads"
import * as vscode from "vscode"

const execFileAsync = promisify(execFile)
const MAX_READ_FILE_BYTES = 1024 * 1024

const ALLOWED_SOURCE_EXTENSIONS = new Set([
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "json",
  "swift",
  "m",
  "mm",
  "h",
  "kt",
  "java",
  "dart",
  "rs",
  "css",
  "scss",
  "html",
  "md",
  "txt",
  "yaml",
  "yml",
  "xml",
  "gradle",
  "podspec",
])

const BLOCKED_PATH_PARTS = [
  ".ssh",
  ".aws",
  ".gnupg",
  "keychains",
  ".env",
  "id_rsa",
  "id_ed25519",
  "credentials",
  ".npmrc",
  ".netrc",
]

function validateReadableSourcePath(resolvedPath: string): void {
  const parts = resolvedPath.split(path.sep)
  for (const part of parts) {
    const lower = part.toLowerCase()
    if (BLOCKED_PATH_PARTS.some((b) => lower === b || lower.startsWith(".env."))) {
      throw new Error("Access to sensitive path blocked")
    }
  }
  const ext = path.extname(resolvedPath).slice(1).toLowerCase()
  if (!ext || !ALLOWED_SOURCE_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported source file extension: .${ext || "none"}`)
  }
  const folders = vscode.workspace.workspaceFolders
  if (!folders || folders.length === 0) {
    throw new Error("No open workspace folder to read source files from")
  }
  const insideWorkspace = folders.some((folder) => {
    let root = folder.uri.fsPath
    try {
      root = fs.realpathSync(root)
    } catch {
      // fall back to fsPath when folder symlink cannot be resolved
    }
    return resolvedPath === root || resolvedPath.startsWith(root + path.sep)
  })
  if (!insideWorkspace) {
    throw new Error("Source file is outside open workspace folders")
  }
}

function validateDeviceId(deviceId: string): string {
  const trimmed = deviceId.trim()
  if (!trimmed || trimmed.length > 128 || trimmed.startsWith("-")) {
    throw new Error("Invalid Android device id")
  }
  if (!/^[A-Za-z0-9.:_-]+$/.test(trimmed)) {
    throw new Error("Android device id contains disallowed characters")
  }
  return trimmed
}

let worker: Worker | null = null
let panel: vscode.WebviewPanel | null = null
let statusBar: vscode.StatusBarItem | null = null
let adbTracker: ChildProcess | null = null
const activeClientIds = new Set<string>()
let currentStatus: "stopped" | "started" | "portUnavailable" = "stopped"
let currentPort = 9090
let currentBindHost = "0.0.0.0"
let failedPort = 9090
let failedBindHost = "0.0.0.0"
let requestedPort = 9090
let requestedBindHost = "0.0.0.0"
let workerGeneration = 0

let reqCounter = 0
const pendingRequests = new Map<
  number,
  { resolve: (val: any) => void; reject: (err: Error) => void }
>()

function callWorker(action: string, payload: Record<string, any> = {}): Promise<any> {
  if (!worker) {
    return Promise.reject(new Error("Reactotron worker is not running"))
  }
  const requestId = ++reqCounter
  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject })
    worker!.postMessage({ requestId, action, ...payload })
  })
}

function updateStatusBar() {
  if (!statusBar) return
  if (currentStatus === "portUnavailable") {
    statusBar.text = `$(warning) Reactotron :${failedPort} busy`
    statusBar.tooltip = `Port ${failedPort} (${failedBindHost}) is already in use — Click to inspect or run Restart Server`
  } else if (currentStatus === "started") {
    statusBar.text = `$(radio-tower) Reactotron :${currentPort} (${activeClientIds.size})`
    statusBar.tooltip = `Listening on ${currentBindHost}:${currentPort} — Click to open inspector`
  } else {
    statusBar.text = "$(circle-slash) Reactotron (stopped)"
    statusBar.tooltip = "Click to open Reactotron inspector"
  }
}

function postToWebview(message: unknown) {
  panel?.webview.postMessage(message)
}

function startWorker(context: vscode.ExtensionContext) {
  if (worker) return

  const cfg = vscode.workspace.getConfiguration("reactotron")
  requestedPort = cfg.get<number>("port", 9090)
  requestedBindHost = cfg.get<string>("bindHost", "0.0.0.0")
  currentPort = requestedPort
  currentBindHost = requestedBindHost
  failedPort = requestedPort
  failedBindHost = requestedBindHost
  const maxPayloadMB = cfg.get<number>("maxPayloadMB", 5)
  const generation = ++workerGeneration

  const workerPath = path.join(context.extensionPath, "dist", "serverWorker.js")
  worker = new Worker(workerPath, {
    workerData: {
      port: requestedPort,
      bindHost: requestedBindHost,
      maxPayloadBytes: Math.max(1, maxPayloadMB) * 1024 * 1024,
      workerGeneration: generation,
    },
  })

  worker.on("message", (msg: any) => {
    if (msg?.requestId !== undefined) {
      const pending = pendingRequests.get(msg.requestId)
      if (pending) {
        pendingRequests.delete(msg.requestId)
        if (msg.ok) pending.resolve(msg.result)
        else pending.reject(new Error(msg.error || "Worker error"))
      }
      return
    }

    switch (msg?.event) {
      case "serverStarted":
        currentStatus = "started"
        currentPort = msg.port ?? currentPort
        currentBindHost = msg.bindHost ?? currentBindHost
        updateStatusBar()
        postToWebview({ type: "event", event: "reactotron://server-started" })
        break
      case "portUnavailable":
        currentStatus = "portUnavailable"
        failedPort = msg.port ?? requestedPort
        failedBindHost = msg.bindHost ?? requestedBindHost
        updateStatusBar()
        postToWebview({
          type: "event",
          event: "reactotron://port-unavailable",
          payload: { port: failedPort, bindHost: failedBindHost },
        })
        break
      case "connectionEstablished": {
        const cid = msg.connection?.clientId
        if (typeof cid === "string" && cid) activeClientIds.add(cid)
        updateStatusBar()
        postToWebview({
          type: "event",
          event: "reactotron://connection-established",
          payload: msg.connection,
        })
        break
      }
      case "disconnect": {
        const cid = msg.connection?.clientId
        if (typeof cid === "string" && cid) activeClientIds.delete(cid)
        updateStatusBar()
        postToWebview({
          type: "event",
          event: "reactotron://disconnect",
          payload: msg.connection,
        })
        break
      }
      case "commandsBatch":
        postToWebview({
          type: "event",
          event: "reactotron://commands-batch",
          payload: msg.batch,
        })
        break
    }
  })

  worker.on("error", (err) => {
    currentStatus = "stopped"
    activeClientIds.clear()
    updateStatusBar()
    void vscode.window.showWarningMessage(`Reactotron server worker error: ${err.message}`)
  })

  worker.on("exit", () => {
    for (const pending of pendingRequests.values()) {
      pending.reject(new Error("Reactotron worker exited"))
    }
    pendingRequests.clear()
    worker = null
    currentStatus = "stopped"
    activeClientIds.clear()
    updateStatusBar()
  })
}

async function openFileInVscode(filePath: string, lineNumber?: number) {
  const trimmed = filePath.trim()
  if (!trimmed) return

  let targetUri: vscode.Uri | null = null
  if (fs.existsSync(trimmed)) {
    targetUri = vscode.Uri.file(trimmed)
  } else {
    const folders = vscode.workspace.workspaceFolders || []
    for (const folder of folders) {
      const candidate = path.join(folder.uri.fsPath, trimmed.replace(/^\/+/, ""))
      if (fs.existsSync(candidate)) {
        targetUri = vscode.Uri.file(candidate)
        break
      }
    }
  }

  if (!targetUri) {
    vscode.window.showWarningMessage(`Reactotron: Could not find file ${trimmed}`)
    return
  }

  const doc = await vscode.workspace.openTextDocument(targetUri)
  const line = Math.max(0, (lineNumber ?? 1) - 1)
  const pos = new vscode.Position(line, 0)
  await vscode.window.showTextDocument(doc, {
    selection: new vscode.Range(pos, pos),
    viewColumn: vscode.ViewColumn.One,
  })
}

async function listAdbDevices(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("adb", ["devices"])
    return stdout
  } catch {
    return "List of devices attached\n"
  }
}

function startAdbTracker() {
  if (adbTracker) return
  try {
    const proc = spawn("adb", ["track-devices"], { stdio: ["ignore", "pipe", "ignore"] })
    proc.on("error", () => {
      adbTracker = null
    })
    proc.stdout?.on("data", () => {
      void listAdbDevices().then((out) => {
        postToWebview({
          type: "event",
          event: "reactotron://adb-device-list",
          payload: out,
        })
      })
    })
    proc.on("close", () => {
      adbTracker = null
    })
    adbTracker = proc
  } catch {
    adbTracker = null
  }
}

function getWebviewHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  const webviewDir = vscode.Uri.joinPath(context.extensionUri, "dist", "webview")
  const indexPath = path.join(webviewDir.fsPath, "index.html")
  let html = fs.readFileSync(indexPath, "utf8")

  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data: blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    // Required by upstream reactotron-core-ui DispatchActionModal eval() when parsing actions
    `script-src ${webview.cspSource} 'unsafe-eval'`,
    `font-src ${webview.cspSource} data:`,
  ].join("; ")

  html = html.replace(
    "<head>",
    `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`
  )

  html = html.replace(/(src|href)="(\.?\/)([^"]+)"/g, (_m, attr, _prefix, relPath) => {
    const assetUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, relPath))
    return `${attr}="${assetUri.toString()}"`
  })

  return html
}

function openInspectorPanel(context: vscode.ExtensionContext) {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside)
    return
  }

  const webviewRoot = vscode.Uri.joinPath(context.extensionUri, "dist", "webview")
  panel = vscode.window.createWebviewPanel(
    "reactotronInspector",
    "Reactotron",
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [webviewRoot],
    }
  )

  const iconPath = vscode.Uri.joinPath(context.extensionUri, "icon.png")
  if (fs.existsSync(iconPath.fsPath)) {
    panel.iconPath = iconPath
  }

  const currentPanel = panel
  const targetWebview = currentPanel.webview

  targetWebview.html = getWebviewHtml(context, targetWebview)

  targetWebview.onDidReceiveMessage(async (msg: any) => {
    const { requestId, action } = msg || {}
    const respond = (ok: boolean, result?: unknown, error?: string) => {
      if (requestId !== undefined) {
        void targetWebview.postMessage({ type: "response", requestId, ok, result, error })
      }
    }

    try {
      switch (action) {
        case "getServerState": {
          const state = await callWorker("getServerState")
          respond(true, state)
          break
        }
        case "sendCommand": {
          const sent = await callWorker("sendCommand", {
            commandType: msg.commandType,
            payload: msg.payload,
            clientId: msg.clientId,
          })
          respond(true, sent)
          break
        }
        case "getCommandPayload": {
          const payload = await callWorker("getCommandPayload", {
            messageId: msg.messageId,
            workerGeneration: msg.workerGeneration,
          })
          respond(true, payload)
          break
        }
        case "searchCommandPayloads": {
          const ids = await callWorker("searchCommandPayloads", {
            query: msg.query,
            clientId: msg.clientId,
          })
          respond(true, ids)
          break
        }
        case "clearPayloadStore": {
          await callWorker("clearPayloadStore", { clientId: msg.clientId })
          respond(true, true)
          break
        }
        case "openInEditor": {
          await openFileInVscode(String(msg.file || ""), msg.lineNumber)
          respond(true, true)
          break
        }
        case "copyText": {
          await vscode.env.clipboard.writeText(String(msg.text ?? ""))
          respond(true, true)
          break
        }
        case "openExternal": {
          const url = String(msg.url ?? "")
          if (/^https?:\/\//i.test(url)) {
            await vscode.env.openExternal(vscode.Uri.parse(url))
          }
          respond(true, true)
          break
        }
        case "readLocalFile": {
          const targetPath = String(msg.path || "")
          const canonical = await fs.promises.realpath(targetPath)
          validateReadableSourcePath(canonical)
          const stat = await fs.promises.stat(canonical)
          if (!stat.isFile()) throw new Error("Target path is not a regular file")
          if (stat.size > MAX_READ_FILE_BYTES) throw new Error("Source file exceeds 1 MB limit")
          const data = await fs.promises.readFile(canonical, "utf8")
          respond(true, data)
          break
        }
        case "exportTimelineLog": {
          const downloadsDir = path.join(os.homedir(), "Downloads")
          await fs.promises.mkdir(downloadsDir, { recursive: true })
          const rawName = msg.filePath ? path.basename(String(msg.filePath)) : ""
          const filename = rawName || `timeline-log-${Date.now()}.json`
          const targetFile = path.join(downloadsDir, filename)

          let output = String(msg.contents ?? "[]")
          let parsedArray: any[] | null = null
          try {
            const parsed = JSON.parse(output)
            if (Array.isArray(parsed)) {
              parsedArray = parsed
            }
          } catch {
            // write raw contents if not JSON array
          }

          if (parsedArray !== null) {
            const hydrated = await callWorker("hydrateExport", { commands: parsedArray })
            output = JSON.stringify(hydrated)
          }

          await fs.promises.writeFile(targetFile, output, "utf8")
          void vscode.window.showInformationMessage(`Exported timeline log to ${targetFile}`)
          respond(true, targetFile)
          break
        }
        case "adbListDevices": {
          startAdbTracker()
          const out = await listAdbDevices()
          respond(true, out)
          break
        }
        case "adbReverseTunnel": {
          const id = validateDeviceId(String(msg.deviceId || ""))
          const tronPort = Number(msg.reactotronPort || 9090)
          const metroPort = Number(msg.metroPort || 8081)
          await execFileAsync("adb", ["-s", id, "reverse", `tcp:${tronPort}`, `tcp:${tronPort}`])
          await execFileAsync("adb", ["-s", id, "reverse", `tcp:${metroPort}`, `tcp:${metroPort}`])
          respond(true, true)
          break
        }
        case "adbReloadApp": {
          const id = validateDeviceId(String(msg.deviceId || ""))
          await execFileAsync("adb", ["-s", id, "shell", "input", "text", "RR"])
          respond(true, true)
          break
        }
        case "adbShakeDevice": {
          const id = validateDeviceId(String(msg.deviceId || ""))
          await execFileAsync("adb", ["-s", id, "shell", "input", "keyevent", "82"])
          respond(true, true)
          break
        }
        case "startMcp": {
          const res = await callWorker("startMcp", {
            port: msg.port,
            redactionConfig: msg.redactionConfig,
          })
          respond(true, res)
          break
        }
        case "stopMcp": {
          const res = await callWorker("stopMcp")
          respond(true, res)
          break
        }
        case "updateMcpRedactionConfig": {
          await callWorker("updateMcpRedactionConfig", { redactionConfig: msg.redactionConfig })
          respond(true, true)
          break
        }
        case "getMcpState": {
          const res = await callWorker("getMcpState")
          respond(true, res)
          break
        }
        default:
          respond(false, undefined, `Unknown action: ${String(action)}`)
      }
    } catch (err: any) {
      respond(false, undefined, err?.message || String(err))
    }
  })

  currentPanel.onDidDispose(() => {
    if (panel === currentPanel) {
      panel = null
    }
    if (worker) {
      void callWorker("stopMcp").catch(() => {})
    }
  })
}

export function activate(context: vscode.ExtensionContext) {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusBar.command = "reactotron.open"
  updateStatusBar()
  statusBar.show()
  context.subscriptions.push(statusBar)

  const autoStart = vscode.workspace.getConfiguration("reactotron").get<boolean>("autoStart", true)
  if (autoStart) {
    startWorker(context)
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("reactotron.open", () => {
      if (!worker) startWorker(context)
      else if (currentStatus === "portUnavailable") {
        void callWorker("restart", { port: requestedPort, bindHost: requestedBindHost }).catch(
          () => {}
        )
      }
      openInspectorPanel(context)
    }),
    vscode.commands.registerCommand("reactotron.restart", async () => {
      if (!worker) {
        startWorker(context)
        return
      }
      activeClientIds.clear()
      try {
        const res = await callWorker("restart", { port: requestedPort, bindHost: requestedBindHost })
        currentStatus = res.status
        if (currentStatus === "started") {
          currentPort = res.port ?? requestedPort
          currentBindHost = res.bindHost ?? requestedBindHost
        } else if (currentStatus === "portUnavailable") {
          failedPort = res.port ?? requestedPort
          failedBindHost = res.bindHost ?? requestedBindHost
        }
        updateStatusBar()
        if (currentStatus === "started") {
          void vscode.window.showInformationMessage(
            `Reactotron restarted on ${currentBindHost}:${currentPort}`
          )
        } else {
          void vscode.window.showWarningMessage(
            `Reactotron port ${failedPort} is still unavailable`
          )
        }
      } catch (err: any) {
        void vscode.window.showErrorMessage(
          `Reactotron restart failed: ${err?.message || String(err)}`
        )
      }
    }),
    vscode.commands.registerCommand("reactotron.toggleBindMode", async () => {
      const nextHost = requestedBindHost === "0.0.0.0" ? "127.0.0.1" : "0.0.0.0"
      requestedBindHost = nextHost
      if (!worker) {
        void vscode.workspace
          .getConfiguration("reactotron")
          .update("bindHost", nextHost, vscode.ConfigurationTarget.Global)
        startWorker(context)
        return
      }
      activeClientIds.clear()
      try {
        const res = await callWorker("restart", { bindHost: nextHost, port: requestedPort })
        currentStatus = res.status
        if (currentStatus === "started") {
          currentPort = res.port ?? requestedPort
          currentBindHost = res.bindHost ?? nextHost
        } else if (currentStatus === "portUnavailable") {
          failedPort = res.port ?? requestedPort
          failedBindHost = res.bindHost ?? nextHost
        }
        updateStatusBar()
        if (currentStatus === "started") {
          void vscode.window.showInformationMessage(
            `Reactotron listening on ${currentBindHost}:${currentPort}`
          )
        } else {
          void vscode.window.showWarningMessage(
            `Reactotron port ${failedPort} (${failedBindHost}) is unavailable`
          )
        }
      } catch (err: any) {
        void vscode.window.showErrorMessage(
          `Reactotron bind switch failed: ${err?.message || String(err)}`
        )
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("reactotron.port") ||
        e.affectsConfiguration("reactotron.bindHost") ||
        e.affectsConfiguration("reactotron.maxPayloadMB")
      ) {
        const cfg = vscode.workspace.getConfiguration("reactotron")
        requestedPort = cfg.get<number>("port", 9090)
        requestedBindHost = cfg.get<string>("bindHost", "0.0.0.0")
        const maxBytes = Math.max(1, cfg.get<number>("maxPayloadMB", 5)) * 1024 * 1024
        if (!worker) {
          updateStatusBar()
          return
        }
        void callWorker("setMaxPayloadBytes", { maxBytes }).catch(() => {})
        activeClientIds.clear()
        void callWorker("restart", {
          port: requestedPort,
          bindHost: requestedBindHost,
        })
          .then((res) => {
            currentStatus = res.status
            if (currentStatus === "started") {
              currentPort = res.port ?? requestedPort
              currentBindHost = res.bindHost ?? requestedBindHost
            } else if (currentStatus === "portUnavailable") {
              failedPort = res.port ?? requestedPort
              failedBindHost = res.bindHost ?? requestedBindHost
            }
            updateStatusBar()
          })
          .catch(() => {})
      }
    })
  )
}

export async function deactivate() {
  if (adbTracker) {
    adbTracker.kill()
    adbTracker = null
  }
  if (worker) {
    try {
      await callWorker("shutdown")
    } catch {
      await worker.terminate()
    }
    worker = null
  }
}
