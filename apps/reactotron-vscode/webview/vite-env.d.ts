/// <reference types="vite/client" />

interface File {
  path?: string
}

declare function acquireVsCodeApi(): {
  postMessage: (msg: unknown) => void
  getState: () => unknown
  setState: (state: unknown) => void
}

declare module "../../reactotron-app/src/renderer/App" {
  import type { ComponentType } from "react"
  const App: ComponentType
  export default App
}

declare module "../../reactotron-app/src/renderer/global.css" {}
