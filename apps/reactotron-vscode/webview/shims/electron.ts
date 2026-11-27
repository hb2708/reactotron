import {
  addHostEventListener,
  copyText,
  isVscodeRuntime,
  openExternalUrl,
  requestHost,
} from "../bridge/vscodeBridge"
import type { DecodedDropImage } from "./fs"

export const clipboard = {
  writeText(text: string): void {
    copyText(text)
  },
}

export const shell = {
  openExternal(url: string): void {
    openExternalUrl(url)
  },
}

type Listener = (...args: any[]) => void
const listeners = new Map<string, Set<Listener>>()
let adbUnlisten: (() => void) | null = null

function emitLocal(channel: string, ...args: any[]) {
  listeners.get(channel)?.forEach((fn) => fn({}, ...args))
}

function ensureAdbSubscription() {
  if (adbUnlisten || !isVscodeRuntime()) return
  adbUnlisten = addHostEventListener("reactotron://adb-device-list", (out: string) => {
    emitLocal("device-list", out)
  })
}

export const ipcRenderer = {
  on(channel: string, listener: Listener) {
    if (!listeners.has(channel)) listeners.set(channel, new Set())
    listeners.get(channel)!.add(listener)
    if (channel === "device-list") {
      ensureAdbSubscription()
    }
    return ipcRenderer
  },
  removeAllListeners(channel: string) {
    listeners.delete(channel)
    if (channel === "device-list" && adbUnlisten) {
      adbUnlisten()
      adbUnlisten = null
    }
    return ipcRenderer
  },
  send(channel: string, ...args: any[]) {
    if (!isVscodeRuntime()) return

    switch (channel) {
      case "get-device-list":
        void requestHost<string>("adbListDevices")
          .then((out) => emitLocal("device-list", out))
          .catch(() => {})
        break
      case "reverse-tunnel-device": {
        const [deviceId, reactotronPort, metroPort] = args
        void requestHost("adbReverseTunnel", {
          deviceId: String(deviceId ?? ""),
          reactotronPort: Number(reactotronPort ?? 9090),
          metroPort: Number(metroPort ?? 8081),
        }).catch((err) => console.error("adbReverseTunnel failed:", err))
        break
      }
      case "reload-app":
        void requestHost("adbReloadApp", { deviceId: String(args[0] ?? "") }).catch((err) =>
          console.error("adbReloadApp failed:", err)
        )
        break
      case "shake-device":
        void requestHost("adbShakeDevice", { deviceId: String(args[0] ?? "") }).catch((err) =>
          console.error("adbShakeDevice failed:", err)
        )
        break
      default:
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
