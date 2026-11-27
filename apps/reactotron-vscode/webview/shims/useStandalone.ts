import { useCallback, useEffect, useReducer, useRef } from "react"

export enum ActionTypes {
  ServerStarted = "SERVER_STARTED",
  ServerStopped = "SERVER_STOPPED",
  AddConnection = "ADD_CONNECTION",
  RemoveConnection = "REMOVE_CONNECTION",
  ClearConnectionCommands = "CLEAR_CONNECTION_COMMANDS",
  CommandReceived = "COMMAND_RECEIVED",
  CommandsBatchReceived = "COMMANDS_BATCH_RECEIVED",
  ChangeSelectedClientId = "CHANGE_SELECTED_CLIENT_ID",
  AddCommandHandler = "ADD_COMMAND_HANDLER",
  PortUnavailable = "PORT_UNAVAILABLE",
}

export type ServerStatus = "stopped" | "portUnavailable" | "started"

export interface ReactotronConnection {
  id: number
  clientId: string
  platform: "ios" | "android" | "browser"
  name?: string
  platformVersion?: string
  osRelease?: string
  userAgent?: string
}

export interface Connection extends ReactotronConnection {
  commands: any[]
  connected: boolean
}

interface State {
  serverStatus: ServerStatus
  connections: Connection[]
  selectedClientId: string | null
  orphanedCommands: any[]
  commandListeners: ((command: any) => void)[]
}

type Action =
  | { type: ActionTypes.ServerStarted; payload: undefined }
  | { type: ActionTypes.ServerStopped; payload: undefined }
  | {
      type: ActionTypes.AddConnection | ActionTypes.RemoveConnection
      payload: ReactotronConnection
    }
  | { type: ActionTypes.ChangeSelectedClientId; payload: string }
  | { type: ActionTypes.CommandReceived; payload: any }
  | { type: ActionTypes.CommandsBatchReceived; payload: any[] }
  | { type: ActionTypes.ClearConnectionCommands }
  | { type: ActionTypes.AddCommandHandler; payload: (command: any) => void }
  | { type: ActionTypes.PortUnavailable; payload: undefined }

function applyCommandsBatch(state: State, batch: any[]): State {
  if (batch.length === 0) return state

  const nextOrphans = [...state.orphanedCommands]
  const grouped = new Map<string, any[]>()

  for (let i = 0; i < batch.length; i++) {
    const cmd = batch[i]
    if (!cmd.clientId) {
      nextOrphans.push(cmd)
      continue
    }
    let list = grouped.get(cmd.clientId)
    if (!list) {
      list = []
      grouped.set(cmd.clientId, list)
    }
    list.push(cmd)
  }

  let nextConnections = state.connections
  if (grouped.size > 0) {
    nextConnections = state.connections.map((conn) => {
      const incoming = grouped.get(conn.clientId)
      if (!incoming) return conn
      const newestFirst = incoming.length === 1 ? incoming : incoming.slice().reverse()
      return {
        ...conn,
        commands: newestFirst.concat(conn.commands),
      }
    })
  }

  return {
    ...state,
    connections: nextConnections,
    orphanedCommands: nextOrphans,
  }
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case ActionTypes.ServerStarted:
      return { ...state, serverStatus: "started" }

    case ActionTypes.ServerStopped:
      return { ...state, serverStatus: "stopped" }

    case ActionTypes.AddConnection: {
      const existingIndex = state.connections.findIndex(
        (c) => c.clientId === action.payload.clientId
      )
      const matchingOrphans = state.orphanedCommands.filter(
        (oc) => oc.connectionId === action.payload.id
      )
      const remainingOrphans =
        matchingOrphans.length > 0
          ? state.orphanedCommands.filter((oc) => oc.connectionId !== action.payload.id)
          : state.orphanedCommands

      const nextConnections =
        existingIndex >= 0
          ? state.connections.map((c, idx) =>
              idx === existingIndex
                ? {
                    ...c,
                    connected: true,
                    commands:
                      matchingOrphans.length > 0
                        ? c.commands.concat(matchingOrphans)
                        : c.commands,
                  }
                : c
            )
          : [
              ...state.connections,
              {
                ...action.payload,
                commands: matchingOrphans,
                connected: true,
              },
            ]

      const connected = nextConnections.filter((c) => c.connected)
      const selectedClientId =
        connected.length === 1 ? connected[0].clientId : state.selectedClientId

      return {
        ...state,
        connections: nextConnections,
        orphanedCommands: remainingOrphans,
        selectedClientId,
        serverStatus: "started",
      }
    }

    case ActionTypes.RemoveConnection: {
      const existing = state.connections.find((c) => c.clientId === action.payload.clientId)
      if (!existing) return state

      const nextConnections = state.connections.map((c) =>
        c.clientId === action.payload.clientId ? { ...c, connected: false } : c
      )

      let selectedClientId = state.selectedClientId
      if (selectedClientId === action.payload.clientId) {
        const nextActive = nextConnections.find((c) => c.connected)
        selectedClientId = nextActive ? nextActive.clientId : null
      }

      return {
        ...state,
        connections: nextConnections,
        selectedClientId,
      }
    }

    case ActionTypes.CommandReceived:
      return applyCommandsBatch(state, [action.payload])

    case ActionTypes.CommandsBatchReceived:
      return applyCommandsBatch(state, action.payload)

    case ActionTypes.ClearConnectionCommands: {
      if (!state.selectedClientId) return state
      return {
        ...state,
        connections: state.connections.map((c) =>
          c.clientId === state.selectedClientId ? { ...c, commands: [] } : c
        ),
      }
    }

    case ActionTypes.ChangeSelectedClientId: {
      const exists = state.connections.some((c) => c.clientId === action.payload)
      return exists ? { ...state, selectedClientId: action.payload } : state
    }

    case ActionTypes.AddCommandHandler:
      return {
        ...state,
        commandListeners: [...state.commandListeners, action.payload],
      }

    case ActionTypes.PortUnavailable:
      console.error("Port unavailable!")
      return { ...state, serverStatus: "portUnavailable" }

    default:
      return state
  }
}

function useStandalone() {
  const [state, dispatch] = useReducer(reducer, {
    serverStatus: "stopped",
    connections: [],
    selectedClientId: null,
    orphanedCommands: [],
    commandListeners: [],
  })

  const listenersRef = useRef<((command: any) => void)[]>([])
  const pendingBatchRef = useRef<any[]>([])
  const flushHandleRef = useRef<number | null>(null)
  const selectedClientIdRef = useRef<string | null>(null)
  selectedClientIdRef.current = state.selectedClientId

  const flushPending = useCallback(() => {
    flushHandleRef.current = null
    const batch = pendingBatchRef.current
    if (batch.length === 0) return
    pendingBatchRef.current = []

    dispatch({ type: ActionTypes.CommandsBatchReceived, payload: batch })

    const listeners = listenersRef.current
    for (let i = 0; i < batch.length; i++) {
      const cmd = batch[i]
      for (let j = 0; j < listeners.length; j++) {
        listeners[j](cmd)
      }
    }
  }, [])

  useEffect(() => {
    return () => {
      if (flushHandleRef.current !== null) {
        if (typeof cancelAnimationFrame === "function") {
          cancelAnimationFrame(flushHandleRef.current)
        } else {
          clearTimeout(flushHandleRef.current)
        }
        flushHandleRef.current = null
      }
    }
  }, [])

  const serverStarted = useCallback(() => {
    dispatch({ type: ActionTypes.ServerStarted, payload: undefined })
  }, [])

  const serverStopped = useCallback(() => {
    dispatch({ type: ActionTypes.ServerStopped, payload: undefined })
  }, [])

  const connectionEstablished = useCallback((connection: ReactotronConnection) => {
    dispatch({ type: ActionTypes.AddConnection, payload: connection })
  }, [])

  const commandReceived = useCallback(
    (command: any) => {
      pendingBatchRef.current.push(command)
      if (flushHandleRef.current === null) {
        if (typeof requestAnimationFrame === "function") {
          flushHandleRef.current = requestAnimationFrame(flushPending)
        } else {
          flushHandleRef.current = setTimeout(flushPending, 16) as unknown as number
        }
      }
    },
    [flushPending]
  )

  const connectionDisconnected = useCallback((connection: ReactotronConnection) => {
    dispatch({ type: ActionTypes.RemoveConnection, payload: connection })
  }, [])

  const clearSelectedConnectionCommands = useCallback(() => {
    const currentClientId = selectedClientIdRef.current
    if (currentClientId) {
      pendingBatchRef.current = pendingBatchRef.current.filter(
        (cmd) => cmd.clientId !== currentClientId
      )
    }
    dispatch({ type: ActionTypes.ClearConnectionCommands })
  }, [])

  const selectConnection = useCallback((clientId: string) => {
    dispatch({ type: ActionTypes.ChangeSelectedClientId, payload: clientId })
  }, [])

  const addCommandListener = useCallback((callback: (command: any) => void) => {
    listenersRef.current.push(callback)
  }, [])

  const portUnavailable = useCallback(() => {
    dispatch({ type: ActionTypes.PortUnavailable, payload: undefined })
  }, [])

  return {
    ...state,
    selectedConnection: state.connections.find((c) => c.clientId === state.selectedClientId),
    selectConnection,
    serverStarted,
    serverStopped,
    connectionEstablished,
    connectionDisconnected,
    commandReceived,
    clearSelectedConnectionCommands,
    addCommandListener,
    portUnavailable,
  }
}

export default useStandalone
