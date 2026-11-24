export function homedir(): string {
  return ""
}

export function platform(): string {
  if (typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)) {
    return "darwin"
  }
  return "darwin"
}

export default { homedir, platform }
