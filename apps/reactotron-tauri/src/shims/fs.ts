import { invoke } from "@tauri-apps/api/core"

const DROP_PREFIX = "__tauri_drop__://"
const droppedFiles = new Map<string, File>()
let dropCounter = 0

if (typeof window !== "undefined") {
  window.addEventListener(
    "drop",
    (event) => {
      const files = event.dataTransfer?.files
      if (!files || files.length === 0) return
      for (let i = 0; i < files.length; i++) {
        const file = files[i] as File & { path?: string }
        if (file.path && !file.path.startsWith(DROP_PREFIX)) continue
        const id = `${DROP_PREFIX}${++dropCounter}`
        droppedFiles.set(id, file)
        try {
          Object.defineProperty(file, "path", {
            value: id,
            configurable: true,
          })
        } catch {
          // Ignore if browser locks File properties
        }
      }
    },
    true
  )
}

function hasTauriInternals(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

export interface DecodedDropImage {
  dataUrl: string
  width: number
  height: number
}

function readDroppedImage(file: File, callback: (err: Error | null, data?: any) => void) {
  const reader = new FileReader()
  reader.onerror = () => callback(new Error("Failed to read dropped file"))
  reader.onload = () => {
    const dataUrl = typeof reader.result === "string" ? reader.result : ""
    if (!dataUrl) {
      callback(new Error("Empty dropped file"))
      return
    }
    const img = new Image()
    img.onerror = () => callback(null, { dataUrl, width: 0, height: 0 } satisfies DecodedDropImage)
    img.onload = () =>
      callback(null, {
        dataUrl,
        width: img.naturalWidth,
        height: img.naturalHeight,
      } satisfies DecodedDropImage)
    img.src = dataUrl
  }
  reader.readAsDataURL(file)
}

export function readFile(
  filePath: string,
  encodingOrCallback: string | ((err: Error | null, data?: any) => void),
  maybeCallback?: (err: Error | null, data?: any) => void
): void {
  const callback = typeof encodingOrCallback === "function" ? encodingOrCallback : maybeCallback
  if (!callback) return

  if (typeof filePath === "string" && filePath.startsWith(DROP_PREFIX)) {
    const file = droppedFiles.get(filePath)
    droppedFiles.delete(filePath)
    if (!file) {
      callback(new Error("Dropped file reference expired"))
      return
    }
    readDroppedImage(file, callback)
    return
  }

  if (!hasTauriInternals()) {
    callback(new Error("Local file reads require Tauri desktop runtime"))
    return
  }

  invoke<string>("read_local_file", { path: filePath })
    .then((data) => callback(null, data))
    .catch((err) => callback(err instanceof Error ? err : new Error(String(err))))
}

export function writeFileSync(filePath: string, contents: string): void {
  if (!hasTauriInternals()) return
  void invoke("export_timeline_log", { contents, filePath }).catch((err) => {
    console.error("Failed to write file via Tauri", err)
  })
}

export default { readFile, writeFileSync }
