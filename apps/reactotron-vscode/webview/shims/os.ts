export function homedir(): string {
  return ""
}

export function platform(): string {
  if (typeof navigator !== "undefined") {
    if (/Mac|Darwin/i.test(navigator.platform)) return "darwin"
    if (/Win/i.test(navigator.platform)) return "win32"
  }
  return "linux"
}

export default { homedir, platform }
