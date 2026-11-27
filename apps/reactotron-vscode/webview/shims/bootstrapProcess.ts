const platform =
  typeof navigator !== "undefined" && /Mac|Darwin/i.test(navigator.platform)
    ? "darwin"
    : typeof navigator !== "undefined" && /Win/i.test(navigator.platform)
      ? "win32"
      : "linux"

const g = globalThis as any
if (!g.process) {
  g.process = { platform, env: { NODE_ENV: import.meta.env.MODE } }
} else {
  if (!g.process.platform) g.process.platform = platform
  if (!g.process.env) g.process.env = { NODE_ENV: import.meta.env.MODE }
}

if (typeof window !== "undefined") {
  const w = window as any
  if (!w.process) {
    w.process = g.process
  } else if (!w.process.platform) {
    w.process.platform = platform
  }
}
