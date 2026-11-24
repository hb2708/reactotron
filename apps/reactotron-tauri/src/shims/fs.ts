import { invoke } from "@tauri-apps/api/core"

function hasTauriInternals(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

export function readFile(
  filePath: string,
  encodingOrCallback: string | ((err: Error | null, data?: string) => void),
  maybeCallback?: (err: Error | null, data?: string) => void
): void {
  const callback = typeof encodingOrCallback === "function" ? encodingOrCallback : maybeCallback
  if (!callback) return

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
