import path from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig, normalizePath, type Plugin } from "vite"
import react from "@vitejs/plugin-react"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = normalizePath(path.resolve(__dirname, "../.."))
const appRendererDir = normalizePath(path.resolve(__dirname, "../reactotron-app/src/renderer"))
const appImagesDir = normalizePath(path.join(appRendererDir, "images"))
const imagesShimPath = normalizePath(path.resolve(__dirname, "webview/shims/images.ts"))
const useStandaloneSourcePath = normalizePath(
  path.join(appRendererDir, "contexts/Standalone/useStandalone")
)
const useStandaloneShimPath = normalizePath(
  path.resolve(__dirname, "webview/shims/useStandalone.ts")
)
const timelinePageDir = normalizePath(path.join(appRendererDir, "pages/timeline"))
const timelineShimPath = normalizePath(path.resolve(__dirname, "webview/shims/Timeline.tsx"))
const helpPagePath = normalizePath(path.join(appRendererDir, "pages/help/index.tsx"))

function reactotronAppCompat(): Plugin {
  return {
    name: "reactotron-app-compat",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer || !source.startsWith(".")) return null
      const cleanImporter = normalizePath(importer.split("?")[0])
      if (!cleanImporter.startsWith(appRendererDir)) return null
      const resolved = normalizePath(path.resolve(path.dirname(cleanImporter), source))
      if (resolved === appImagesDir || resolved === `${appImagesDir}/index.ts`) {
        return imagesShimPath
      }
      if (
        resolved === useStandaloneSourcePath ||
        resolved === `${useStandaloneSourcePath}.ts`
      ) {
        return useStandaloneShimPath
      }
      if (resolved === timelinePageDir || resolved === `${timelinePageDir}/index.tsx`) {
        return timelineShimPath
      }
      return null
    },
    transform(code, id) {
      const cleanId = normalizePath(id.split("?")[0])
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
  base: "./",
  plugins: [reactotronAppCompat(), react()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1421,
    strictPort: true,
    fs: {
      allow: [repoRoot],
    },
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify(mode === "production" ? "production" : "development"),
  },
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
      "reactotron-core-server": path.resolve(__dirname, "webview/shims/reactotron-core-server.ts"),
      "reactotron-mcp": path.resolve(__dirname, "webview/shims/reactotron-mcp.ts"),
      "electron-store": path.resolve(__dirname, "webview/shims/electron-store.ts"),
      electron: path.resolve(__dirname, "webview/shims/electron.ts"),
      fs: path.resolve(__dirname, "webview/shims/fs.ts"),
      path: path.resolve(__dirname, "webview/shims/path.ts"),
      os: path.resolve(__dirname, "webview/shims/os.ts"),
      events: path.resolve(__dirname, "webview/shims/events.ts"),
    },
  },
  build: {
    outDir: "dist/webview",
    emptyOutDir: false,
    target: "chrome120",
    minify: "esbuild",
    sourcemap: false,
  },
}))
