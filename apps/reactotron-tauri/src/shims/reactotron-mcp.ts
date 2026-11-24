import type { McpRedactionRules } from "reactotron-core-contract"

export const REDACTED = "[REDACTED]"

export const DEFAULT_REDACTION_RULES: McpRedactionRules = {
  sensitiveKeys: [
    "password",
    "passwd",
    "pwd",
    "secret",
    "client_secret",
    "clientsecret",
    "credentials",
    "ssn",
    "creditcard",
    "privatekey",
    "private_key",
    "apikey",
    "api_key",
    "x-api-key",
    "accesstoken",
    "access_token",
    "refreshtoken",
    "refresh_token",
    "idtoken",
    "id_token",
    "token",
    "bearer",
    "jwt",
    "session",
    "sessionid",
    "session_id",
    "csrf",
    "xsrf",
    "csrf_token",
    "xsrf_token",
    "authorization",
    "cookie",
    "set-cookie",
    "proxy-authorization",
    "x-auth-token",
    "x-csrf-token",
    "x-xsrf-token",
    "csrf-token",
    "x-forwarded-for",
    "x-real-ip",
  ],
  statePathPatterns: [],
  valuePatterns: [],
}

export interface McpRedactionServerConfig {
  defaults: McpRedactionRules
  allowClientDisable: boolean
  allowClientRemoveRules: boolean
}

export const DEFAULT_SERVER_CONFIG: McpRedactionServerConfig = {
  defaults: DEFAULT_REDACTION_RULES,
  allowClientDisable: false,
  allowClientRemoveRules: false,
}

export interface ReactotronMcpServer {
  start: (port?: number) => Promise<void>
  stop: () => void
  updateRedactionConfig: (cfg: McpRedactionServerConfig) => void
}

export function createMcpServer(
  _server?: unknown,
  _config?: McpRedactionServerConfig
): ReactotronMcpServer {
  return {
    start: () => Promise.reject(new Error("MCP server is disabled in Tauri runtime")),
    stop: () => {},
    updateRedactionConfig: () => {},
  }
}
