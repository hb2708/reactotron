import { exportTimelineLog, isVscodeRuntime, readLocalFile } from "../bridge/vscodeBridge"

const DROP_PREFIX = "__vscode_drop__://"
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
          // ignore if locked
        }
      }
    },
    true
  )
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

  if (!isVscodeRuntime()) {
    callback(new Error("Local file reads require VS Code Webview runtime"))
    return
  }

  readLocalFile(filePath)
    .then((data) => callback(null, data))
    .catch((err) => callback(err instanceof Error ? err : new Error(String(err))))
}

export function writeFileSync(filePath: string, contents: string): void {
  if (!isVscodeRuntime()) return
  void exportTimelineLog(contents, filePath).catch((err) => {
    console.error("Failed to write file via VS Code host", err)
  })
}

export default { readFile, writeFileSync }
