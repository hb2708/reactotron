/// <reference types="vite/client" />

interface File {
  path?: string
}

declare module "../../reactotron-app/src/renderer/App" {
  import type { ComponentType } from "react"
  const App: ComponentType
  export default App
}

declare module "../../reactotron-app/src/renderer/global.css" {}
