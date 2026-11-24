import { invoke } from "@tauri-apps/api/core"
import { openUrl } from "@tauri-apps/plugin-opener"
import { writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager"

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

export const ipcRenderer = {
  on(channel: string, listener: Listener) {
    if (!listeners.has(channel)) listeners.set(channel, new Set())
    listeners.get(channel)!.add(listener)
    return ipcRenderer
  },
  removeAllListeners(channel: string) {
    listeners.delete(channel)
    return ipcRenderer
  },
  send(channel: string, ...args: any[]) {
    if (hasTauriInternals()) {
      void invoke("ipc_noop", { channel, args }).catch(() => {})
    }
  },
}

export const nativeImage = {
  createFromBuffer: (_buffer?: unknown) => ({
    toDataURL: () => "",
    getSize: () => ({ width: 0, height: 0 }),
  }),
}

export default { clipboard, shell, ipcRenderer, nativeImage }
