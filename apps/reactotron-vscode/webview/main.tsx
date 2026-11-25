import "./shims/bootstrapProcess"
import React from "react"
import { createRoot } from "react-dom/client"
import { ReactotronAppProvider } from "reactotron-core-ui"

import "../../reactotron-app/src/renderer/global.css"
import App from "../../reactotron-app/src/renderer/App"

const rootEl = document.getElementById("app")!
createRoot(rootEl).render(
  <ReactotronAppProvider>
    <App />
  </ReactotronAppProvider>
)
