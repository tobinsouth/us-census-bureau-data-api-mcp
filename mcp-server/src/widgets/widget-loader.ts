import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolve paths relative to the compiled JS location so this works from dist/
// at runtime and from src/ under tsx (both point back to node_modules at the
// mcp-server root).
const here = dirname(fileURLToPath(import.meta.url))
const mcpServerRoot = resolve(here, '..', '..')

function read(relative: string): string {
  return readFileSync(resolve(mcpServerRoot, relative), 'utf8')
}

// ext-apps ships as an ES module; its tail is `export{A as App,B as App2,...};`
// The iframe runtime treats it as a classic <script> bundle that attaches to
// `globalThis.ExtApps`, so rewrite the tail to an assignment. Use the function
// form of replace() so `$` characters inside the bundle body are literal.
function rewriteExtAppsBundle(): string {
  const src = read(
    'node_modules/@modelcontextprotocol/ext-apps/dist/src/app-with-deps.js',
  )
  return src.replace(/export\{([^}]+)\};?\s*$/, (_match, body: string) => {
    const fields = body
      .split(',')
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const [local, exported] = pair.split(/\s+as\s+/).map((s) => s.trim())
        const name = exported ?? local
        return `${name}:${local}`
      })
    return `globalThis.ExtApps={${fields.join(',')}};`
  })
}

// vega's package.json `exports` blocks subpath resolution (and blocks
// `require.resolve("vega/build/vega.min.js")`). Read the UMD directly by
// filesystem path. Same applies for vega-lite and vega-embed.
function readVegaBundles() {
  return {
    vega: read('node_modules/vega/build/vega.min.js'),
    vegaLite: read('node_modules/vega-lite/build/vega-lite.min.js'),
    vegaEmbed: read('node_modules/vega-embed/build/vega-embed.min.js'),
  }
}

function replaceAllWithFunction(
  haystack: string,
  needle: string,
  replacement: string,
): string {
  // String.prototype.replaceAll handles literal string needles without running
  // regex substitution on `$` in the replacement — but only when the
  // replacement is a function, so use that form explicitly.
  return haystack.replaceAll(needle, () => replacement)
}

export interface LoadedWidget {
  html: string
  bytes: number
}

export function loadVisualizeWidget(): LoadedWidget {
  const template = read('src/widgets/visualize.html')
  const { vega, vegaLite, vegaEmbed } = readVegaBundles()
  const extApps = rewriteExtAppsBundle()

  let html = template
  html = replaceAllWithFunction(html, '/*__VEGA_BUNDLE__*/', vega)
  html = replaceAllWithFunction(html, '/*__VEGA_LITE_BUNDLE__*/', vegaLite)
  html = replaceAllWithFunction(html, '/*__VEGA_EMBED_BUNDLE__*/', vegaEmbed)
  html = replaceAllWithFunction(html, '/*__EXT_APPS_BUNDLE__*/', extApps)

  return { html, bytes: Buffer.byteLength(html, 'utf8') }
}
