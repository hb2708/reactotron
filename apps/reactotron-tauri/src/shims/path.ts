export function join(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .join("/")
    .replace(/\/+/g, "/")
}

export function resolve(...parts: string[]): string {
  return join(...parts)
}

export function basename(filePath: string): string {
  const parts = filePath.split(/[/\\]/)
  return parts[parts.length - 1] || ""
}

export function dirname(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"))
  return idx <= 0 ? "" : filePath.slice(0, idx)
}

export function extname(filePath: string): string {
  const base = basename(filePath)
  const idx = base.lastIndexOf(".")
  return idx <= 0 ? "" : base.slice(idx)
}

export default { join, resolve, basename, dirname, extname }
