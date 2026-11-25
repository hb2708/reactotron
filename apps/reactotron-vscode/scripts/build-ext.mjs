import { build } from "esbuild"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "..")

await Promise.all([
  build({
    entryPoints: [path.join(root, "src/extension.ts")],
    outfile: path.join(root, "dist/extension.js"),
    bundle: true,
    platform: "node",
    target: "node18",
    format: "cjs",
    external: ["vscode"],
    sourcemap: false,
    minify: true,
  }),
  build({
    entryPoints: [path.join(root, "src/serverWorker.ts")],
    outfile: path.join(root, "dist/serverWorker.js"),
    bundle: true,
    platform: "node",
    target: "node18",
    format: "cjs",
    sourcemap: false,
    minify: true,
  }),
])
