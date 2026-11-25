import path from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, "../..")
const appRendererDir = path.resolve(__dirname, "../reactotron-app/src/renderer")
const appImagesDir = path.resolve(appRendererDir, "images")
const imagesShimPath = path.resolve(__dirname, "src/shims/images.ts")
const useStandaloneSourcePath = path.resolve(
  appRendererDir,
  "contexts/Standalone/useStandalone"
)
const useStandaloneShimPath = path.resolve(__dirname, "src/shims/useStandalone.ts")
const timelinePageDir = path.resolve(appRendererDir, "pages/timeline")
const timelineShimPath = path.resolve(__dirname, "src/shims/Timeline.tsx")
const helpPagePath = path.resolve(appRendererDir, "pages/help/index.tsx")

function reactotronAppCompat(): Plugin {
  return {
    name: "reactotron-app-compat",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer || !source.startsWith(".")) return null
      const cleanImporter = importer.split("?")[0]
      if (!cleanImporter.startsWith(appRendererDir)) return null
      const resolved = path.resolve(path.dirname(cleanImporter), source)
      if (resolved === appImagesDir || resolved === path.join(appImagesDir, "index.ts")) {
        return imagesShimPath
      }
      if (
        resolved === useStandaloneSourcePath ||
        resolved === `${useStandaloneSourcePath}.ts`
      ) {
        return useStandaloneShimPath
      }
      if (resolved === timelinePageDir || resolved === path.join(timelinePageDir, "index.tsx")) {
        return timelineShimPath
      }
      return null
    },
    transform(code, id) {
      const cleanId = id.split("?")[0]
      if (cleanId === helpPagePath) {
        return code.replace(
          'const projectJson = require("../../../../package.json")',
          'import projectJson from "../../../../package.json"'
        )
      }
      return null
    },
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [reactotronAppCompat(), react()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    fs: {
      allow: [repoRoot],
    },
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify(mode === "production" ? "production" : "development"),
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  resolve: {
    dedupe: [
      "react",
      "react-dom",
      "styled-components",
      "react-router-dom",
      "react-modal",
      "react-tooltip",
      "react-hotkeys",
      "react-motion",
    ],
    alias: {
      "reactotron-core-server": path.resolve(__dirname, "src/shims/reactotron-core-server.ts"),
      "reactotron-mcp": path.resolve(__dirname, "src/shims/reactotron-mcp.ts"),
      "electron-store": path.resolve(__dirname, "src/shims/electron-store.ts"),
      electron: path.resolve(__dirname, "src/shims/electron.ts"),
      fs: path.resolve(__dirname, "src/shims/fs.ts"),
      path: path.resolve(__dirname, "src/shims/path.ts"),
      os: path.resolve(__dirname, "src/shims/os.ts"),
      events: path.resolve(__dirname, "src/shims/events.ts"),
    },
  },
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari14",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
}))
