type SchemaEntry = {
  type?: string
  default?: unknown
  items?: unknown
  [key: string]: unknown
}

const STORAGE_PREFIX = "reactotron_vscode_store:"

export default class Store<T extends Record<string, any> = Record<string, any>> {
  private defaults: Record<string, unknown> = {}

  constructor(options?: { schema?: Record<string, SchemaEntry> }) {
    if (options?.schema) {
      for (const [key, entry] of Object.entries(options.schema)) {
        if ("default" in entry) {
          this.defaults[key] = entry.default
        }
      }
    }
  }

  has(key: keyof T & string): boolean {
    try {
      return localStorage.getItem(`${STORAGE_PREFIX}${key}`) !== null || key in this.defaults
    } catch {
      return key in this.defaults
    }
  }

  get<K extends keyof T & string>(key: K): T[K] {
    try {
      const raw = localStorage.getItem(`${STORAGE_PREFIX}${key}`)
      if (raw !== null) {
        return JSON.parse(raw) as T[K]
      }
    } catch {
      // ignore storage errors in restricted webview contexts
    }
    return this.defaults[key] as T[K]
  }

  set<K extends keyof T & string>(key: K, value: T[K]): void {
    try {
      localStorage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify(value))
    } catch {
      // ignore storage quota errors
    }
  }
}
