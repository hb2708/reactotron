import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { openUrl } from "@tauri-apps/plugin-opener"
import { writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager"
import type { DecodedDropImage } from "./fs"

function hasTauriInternals(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

export const clipboard = {
  writeText(text: string): void {
    if (hasTauriInternals()) {
      void writeClipboardText(text).catch(() => {
        if (typeof navigator !== "undefined" && navigator.clipboard) {
          void navigator.clipboard.writeText(text)
        }
      })
      return
    }
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(text)
    }
  },
}

export const shell = {
  openExternal(url: string): void {
    if (hasTauriInternals()) {
      void openUrl(url).catch(() => {
        if (typeof window !== "undefined") {
          window.open(url, "_blank", "noopener,noreferrer")
        }
      })
      return
    }
    if (typeof window !== "undefined") {
      window.open(url, "_blank", "noopener,noreferrer")
    }
  },
}

type Listener = (...args: any[]) => void
const listeners = new Map<string, Set<Listener>>()
let adbUnlisten: UnlistenFn | null = null
let adbListenStarted = false

function emitLocal(channel: string, ...args: any[]) {
  listeners.get(channel)?.forEach((fn) => fn({}, ...args))
}

function ensureAdbEventSubscription() {
  if (adbListenStarted || !hasTauriInternals()) return
  adbListenStarted = true
  void listen<string>("reactotron://adb-device-list", (event) => {
    emitLocal("device-list", event.payload)
  })
    .then((unlisten) => {
      adbUnlisten = unlisten
    })
    .catch(() => {
      adbListenStarted = false
    })
}

export const ipcRenderer = {
  on(channel: string, listener: Listener) {
    if (!listeners.has(channel)) listeners.set(channel, new Set())
    listeners.get(channel)!.add(listener)
    if (channel === "device-list") {
      ensureAdbEventSubscription()
    }
    return ipcRenderer
  },
  removeAllListeners(channel: string) {
    listeners.delete(channel)
    if (channel === "device-list" && adbUnlisten) {
      adbUnlisten()
      adbUnlisten = null
      adbListenStarted = false
    }
    return ipcRenderer
  },
  send(channel: string, ...args: any[]) {
    if (!hasTauriInternals()) return

    switch (channel) {
      case "get-device-list":
        void invoke<string>("adb_list_devices")
          .then((out) => emitLocal("device-list", out))
          .catch(() => {})
        break
      case "reverse-tunnel-device": {
        const [deviceId, reactotronPort, metroPort] = args
        void invoke("adb_reverse_tunnel", {
          deviceId: String(deviceId ?? ""),
          reactotronPort: Number(reactotronPort ?? 9090),
          metroPort: Number(metroPort ?? 8081),
        }).catch((err) => console.error("adb_reverse_tunnel failed:", err))
        break
      }
      case "reload-app":
        void invoke("adb_reload_app", { deviceId: String(args[0] ?? "") }).catch((err) =>
          console.error("adb_reload_app failed:", err)
        )
        break
      case "shake-device":
        void invoke("adb_shake_device", { deviceId: String(args[0] ?? "") }).catch((err) =>
          console.error("adb_shake_device failed:", err)
        )
        break
      default:
        void invoke("ipc_noop", { channel, args }).catch(() => {})
        break
    }
  },
}

function isDecodedDropImage(value: unknown): value is DecodedDropImage {
  return (
    typeof value === "object" &&
    value !== null &&
    "dataUrl" in value &&
    typeof (value as DecodedDropImage).dataUrl === "string"
  )
}

export const nativeImage = {
  createFromBuffer: (buffer?: unknown) => {
    if (isDecodedDropImage(buffer)) {
      return {
        toDataURL: () => buffer.dataUrl,
        getSize: () => ({ width: buffer.width, height: buffer.height }),
      }
    }
    return {
      toDataURL: () => "",
      getSize: () => ({ width: 0, height: 0 }),
    }
  },
}

export default { clipboard, shell, ipcRenderer, nativeImage }
