import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { clipboard, shell } from "electron"
import os from "os"
import path from "path"
import debounce from "lodash.debounce"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  Header,
  filterCommands,
  TimelineFilterModal,
  timelineCommandResolver,
  repairSerialization,
  EmptyState,
  ReactotronContext,
  TimelineContext,
  RandomJoke,
} from "reactotron-core-ui"
import StandaloneContext from "../../../reactotron-app/src/renderer/contexts/Standalone"
import {
  MdSearch,
  MdDeleteSweep,
  MdFilterList,
  MdSwapVert,
  MdReorder,
  MdDownload,
} from "react-icons/md"
import { FaTimes } from "react-icons/fa"
import styled from "styled-components"
import fs from "fs"
import {
  clearPayloadStore,
  exportTimelineLog,
  getCommandPayload,
  searchCommandPayloads,
} from "../bridge/vscodeBridge"

const Container = styled.div`
  display: flex;
  flex-direction: column;
  width: 100%;
`
const TimelineContainer = styled.div`
  flex: 1;
  min-height: 0;
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
`
const SearchContainer = styled.div`
  display: flex;
  align-items: center;
  padding-bottom: 10px;
  padding-top: 4px;
  padding-right: 10px;
`
const SearchLabel = styled.p`
  padding: 0 10px;
  font-size: 14px;
  color: ${(props) => props.theme.foregroundDark};
`
const SearchInput = styled.input`
  border-radius: 4px;
  padding: 10px;
  flex: 1;
  background-color: ${(props) => props.theme.backgroundSubtleDark};
  border: none;
  color: ${(props) => props.theme.foregroundDark};
  font-size: 14px;
`
const HelpMessage = styled.div`
  margin: 0 40px;
`
const QuickStartButtonContainer = styled.div`
  display: flex;
  padding: 4px 8px;
  margin: 30px 20px;
  border-radius: 4px;
  cursor: pointer;
  background-color: ${(props) => props.theme.backgroundLighter};
  color: ${(props) => props.theme.foreground};
  align-items: center;
  justify-content: center;
  text-align: center;
`
const Divider = styled.div`
  height: 1px;
  background-color: ${(props) => props.theme.foregroundDark};
  margin: 40px 10px;
`
export const ButtonContainer = styled.div`
  padding: 10px;
  cursor: pointer;
`
const ExportToast = styled.div<{ $isError?: boolean }>`
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 1000;
  padding: 10px 14px;
  border-radius: 6px;
  font-size: 13px;
  background-color: ${(props) =>
    props.$isError ? props.theme.tag : props.theme.backgroundLighter};
  color: ${(props) => (props.$isError ? props.theme.tagComplement : props.theme.foregroundLight)};
  border: 1px solid ${(props) => props.theme.line};
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
`

const MAX_HYDRATED_PAYLOADS = 25
const hydratedPayloadCache = new Map<string, { clientId?: string; payload: any }>()

function getCacheKey(command: any): string {
  return `${command.workerGeneration ?? 0}:${command.messageId}`
}

function cacheHydratedPayload(cacheKey: string, clientId: string | undefined, payload: any) {
  if (hydratedPayloadCache.has(cacheKey)) {
    hydratedPayloadCache.delete(cacheKey)
  }
  hydratedPayloadCache.set(cacheKey, { clientId, payload })
  if (hydratedPayloadCache.size > MAX_HYDRATED_PAYLOADS) {
    const oldestKey = hydratedPayloadCache.keys().next().value
    if (oldestKey !== undefined) hydratedPayloadCache.delete(oldestKey)
  }
}

function LazyTimelineRow({
  command,
  sendCommand,
  dispatchAction,
  openDispatchModal,
}: {
  command: any
  sendCommand: any
  dispatchAction: (action: any) => void
  openDispatchModal: any
}) {
  const cacheKey = getCacheKey(command)
  const [hydratedPayload, setHydratedPayload] = useState<any>(() =>
    command.payloadOffloaded ? hydratedPayloadCache.get(cacheKey)?.payload : undefined
  )

  useEffect(() => {
    setHydratedPayload(
      command.payloadOffloaded ? hydratedPayloadCache.get(cacheKey)?.payload : undefined
    )
  }, [cacheKey, command.payloadOffloaded])

  const handleClickCapture = useCallback(() => {
    if (!command.payloadOffloaded || hydratedPayload !== undefined) return
    void getCommandPayload(command.messageId, command.workerGeneration).then((raw) => {
      if (raw != null) {
        const repaired = typeof raw === "object" ? repairSerialization(raw) : raw
        cacheHydratedPayload(cacheKey, command.clientId, repaired)
        setHydratedPayload(repaired)
      }
    })
  }, [
    cacheKey,
    command.clientId,
    command.messageId,
    command.payloadOffloaded,
    command.workerGeneration,
    hydratedPayload,
  ])

  const effectiveCommand = useMemo(
    () => (hydratedPayload !== undefined ? { ...command, payload: hydratedPayload } : command),
    [command, hydratedPayload]
  )

  const CommandComponent = timelineCommandResolver(command.type)
  if (!CommandComponent) return null

  return (
    <div onClickCapture={handleClickCapture}>
      <CommandComponent
        command={effectiveCommand}
        copyToClipboard={clipboard.writeText}
        readFile={(filePath) => {
          return new Promise((resolve, reject) => {
            fs.readFile(filePath, "utf-8", (err, data) => {
              if (err || !data) reject(new Error("Something failed"))
              else resolve(data)
            })
          })
        }}
        sendCommand={sendCommand}
        dispatchAction={dispatchAction}
        openDispatchDialog={openDispatchModal}
      />
    </div>
  )
}

function Timeline() {
  const { sendCommand, clearCommands, commands, openDispatchModal } = useContext(ReactotronContext)
  const { selectedConnection } = useContext(StandaloneContext)
  const selectedClientId = selectedConnection?.clientId
  const {
    isSearchOpen,
    toggleSearch,
    closeSearch,
    setSearch,
    search,
    isReversed,
    toggleReverse,
    openFilter,
    closeFilter,
    isFilterOpen,
    hiddenCommands,
    setHiddenCommands,
  } = useContext(TimelineContext)

  const [workerSearchHits, setWorkerSearchHits] = useState<{
    workerGeneration: number
    ids: Set<number>
  } | null>(null)

  useEffect(() => {
    const trimmed = search.trim()
    if (!trimmed) {
      setWorkerSearchHits(null)
      return
    }
    let cancelled = false
    void searchCommandPayloads(trimmed, selectedClientId).then((res) => {
      if (!cancelled) {
        setWorkerSearchHits({ workerGeneration: res.workerGeneration, ids: new Set(res.ids) })
      }
    })
    return () => {
      cancelled = true
    }
  }, [search, commands.length, selectedClientId])

  let filteredCommands: any[]
  try {
    const jsMatches = filterCommands(commands, search, hiddenCommands)
    if (workerSearchHits && workerSearchHits.ids.size > 0) {
      const jsMatchKeys = new Set(jsMatches.map((c: any) => getCacheKey(c)))
      const hiddenSet = new Set(hiddenCommands)
      filteredCommands = commands.filter(
        (c: any) =>
          !hiddenSet.has(c.type) &&
          (jsMatchKeys.has(getCacheKey(c)) ||
            (c.workerGeneration === workerSearchHits.workerGeneration &&
              workerSearchHits.ids.has(c.messageId)))
      )
    } else {
      filteredCommands = jsMatches
    }
  } catch (error) {
    console.error(error)
    filteredCommands = commands
  }

  if (isReversed) {
    filteredCommands = [...filteredCommands].reverse()
  }

  const dispatchAction = (action: any) => {
    sendCommand("state.action.dispatch", { action })
  }

  const [exportNotice, setExportNotice] = useState<{ text: string; isError?: boolean } | null>(null)
  const exportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function showExportNotice(text: string, isError = false) {
    setExportNotice({ text, isError })
    if (exportTimerRef.current) clearTimeout(exportTimerRef.current)
    exportTimerRef.current = setTimeout(() => setExportNotice(null), 3500)
  }

  async function downloadLog() {
    const filename = `timeline-log-${Date.now()}.json`
    try {
      const homeDir = os.homedir()
      const downloadDir = path.join(homeDir, "Downloads")
      const fullPath = path.resolve(downloadDir, filename)
      const savedPath = await exportTimelineLog(JSON.stringify(commands || []), fullPath)
      if (!savedPath) {
        throw new Error("VS Code export unavailable")
      }
      showExportNotice(`Saved ~/Downloads/${filename}`)
    } catch (err: any) {
      showExportNotice(`Export failed: ${err?.message || "unknown error"}`, true)
    }
  }

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const rowVirtualizer = useVirtualizer({
    count: filteredCommands.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) =>
      filteredCommands[index] ? getCacheKey(filteredCommands[index]) : index,
    estimateSize: () => 56,
    overscan: 8,
  })

  const { searchString, handleInputChange, resetSearch } = useDebouncedSearchInput(
    search,
    setSearch,
    300
  )

  return (
    <Container>
      <Header
        title="Timeline"
        isDraggable
        actions={[
          {
            tip: "Export Log",
            icon: MdDownload,
            onClick: () => {
              void downloadLog()
            },
          },
          { tip: "Search", icon: MdSearch, onClick: toggleSearch },
          { tip: "Filter", icon: MdFilterList, onClick: openFilter },
          { tip: "Reverse Order", icon: MdSwapVert, onClick: toggleReverse },
          {
            tip: "Clear",
            icon: MdDeleteSweep,
            onClick: () => {
              if (selectedClientId) {
                for (const [key, entry] of hydratedPayloadCache.entries()) {
                  if (entry.clientId === selectedClientId) hydratedPayloadCache.delete(key)
                }
                void clearPayloadStore(selectedClientId)
              }
              clearCommands()
            },
          },
        ]}
      >
        {isSearchOpen && (
          <SearchContainer>
            <SearchLabel>Search</SearchLabel>
            <SearchInput autoFocus value={searchString} onChange={handleInputChange} />
            <ButtonContainer
              onClick={() => {
                if (search === "" && searchString === "") closeSearch()
                else resetSearch()
              }}
            >
              <FaTimes size={24} />
            </ButtonContainer>
          </SearchContainer>
        )}
      </Header>
      <TimelineContainer ref={scrollRef}>
        {filteredCommands.length === 0 ? (
          <EmptyState icon={MdReorder} title="No Activity">
            <HelpMessage>
              Once your app connects and starts sending events, they will appear here.
            </HelpMessage>
            <QuickStartButtonContainer
              onClick={() =>
                shell.openExternal("https://docs.infinite.red/reactotron/quick-start/react-native/")
              }
            >
              Check out the quick start guide here!
            </QuickStartButtonContainer>
            <Divider />
            <RandomJoke />
          </EmptyState>
        ) : (
          <div
            style={{
              height: `${rowVirtualizer.getTotalSize()}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const command = filteredCommands[virtualRow.index]
              return (
                <div
                  key={getCacheKey(command)}
                  data-index={virtualRow.index}
                  ref={rowVirtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: `${virtualRow.start}px`,
                    left: 0,
                    width: "100%",
                  }}
                >
                  <LazyTimelineRow
                    command={command}
                    sendCommand={sendCommand}
                    dispatchAction={dispatchAction}
                    openDispatchModal={openDispatchModal}
                  />
                </div>
              )
            })}
          </div>
        )}
      </TimelineContainer>
      <TimelineFilterModal
        isOpen={isFilterOpen}
        onClose={closeFilter}
        hiddenCommands={hiddenCommands}
        setHiddenCommands={setHiddenCommands}
      />
      {exportNotice && (
        <ExportToast $isError={exportNotice.isError}>{exportNotice.text}</ExportToast>
      )}
    </Container>
  )
}

export default Timeline

const useDebouncedSearchInput = (
  initialValue: string,
  setSearch: (search: string) => void,
  delay: number = 300
) => {
  const [searchString, setSearchString] = React.useState<string>(initialValue)
  const debouncedOnChange = useMemo(() => debounce(setSearch, delay), [delay, setSearch])

  useEffect(() => {
    return () => {
      debouncedOnChange.cancel()
    }
  }, [debouncedOnChange])

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const { value } = e.target
      setSearchString(value)
      debouncedOnChange(value)
    },
    [debouncedOnChange]
  )

  const resetSearch = useCallback(() => {
    debouncedOnChange.cancel()
    setSearchString("")
    setSearch("")
  }, [debouncedOnChange, setSearch])

  return { searchString, handleInputChange, resetSearch }
}
