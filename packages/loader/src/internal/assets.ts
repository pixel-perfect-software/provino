import { realpathSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'

// The assets and styles a native project imports as modules (`ModulePolicy.assetImports`).
//
// The asset list is Vite 8.3.5's `KNOWN_ASSET_TYPES` (`dist/node/chunks/node.js` L765-797), the
// style one its `CSS_LANGS_RE` (L747). The URL is the dev server's `fileToDevUrl` (L32668-32683) with
// `fileToModuleUrl` (L5403-5408): the path from the root, or `/@fs/` and the absolute path outside it,
// written as it is (no percent-encoding: `moduleUrlToBrowserUrl`, L515-518, and the `JSON.stringify`
// of `formatBuiltAsset`, L32594, add none). Vite also inlines a small `.svg` as a `data:` URL
// (L32672-32679); this does not. A query: `?raw` (`rawRE`, L2218; the load at L32569-32577) is the
// file's text as the default export, `?url` (`urlRE`, L2217; L32578-32583) the URL, and any other
// query is as none. Vite applies both to any file; here only to the asset and style files above.

const ASSET_EXTENSIONS =
  /\.(?:apng|bmp|png|jpe?g|jfif|pjpeg|pjp|gif|svg|ico|webp|avif|cur|jxl|mp4|webm|ogg|mp3|wav|flac|aac|opus|mov|m4a|vtt|woff2?|eot|ttf|otf|webmanifest|pdf|txt)$/i
const STYLE_LANGS = 'css|less|sass|scss|styl|stylus|pcss|postcss|sss'
const STYLE_EXTENSIONS = new RegExp(`\\.(?:${STYLE_LANGS})$`, 'i')
const CSS_MODULE = new RegExp(`\\.module\\.(?:${STYLE_LANGS})$`, 'i')

/** What a file imports as, or `null` when it is no asset or style file. */
export type AssetKind = 'asset' | 'style' | 'style-module'

/** The kind of the file at `path` (a plain path, no query), or `null`. */
export function assetKindOf(path: string): AssetKind | null {
  if (STYLE_EXTENSIONS.test(path)) return CSS_MODULE.test(path) ? 'style-module' : 'style'
  return ASSET_EXTENSIONS.test(path) ? 'asset' : null
}

/** The root as asset URLs are made from it: its real path, as the resolver's paths are. */
export function assetRootOf(root: string): string {
  try {
    return realpathSync(root)
  } catch {
    return root
  }
}

/** What a query turns an asset or style module into: its text, its URL, or nothing (as no query). */
export type AssetQuery = 'raw' | 'url' | null

/** The meaning of `query` (the id after its file: `?raw`, `?a=1&url`, `#frag`). */
export function assetQueryOf(query: string): AssetQuery {
  const hash = query.indexOf('#')
  const search = query.startsWith('?') ? (hash < 0 ? query : query.slice(0, hash)) : ''
  if (/[?&]raw(?:&|$)/.test(search)) return 'raw'
  return /[?&]url(?:&|$)/.test(search) ? 'url' : null
}

/**
 * The URL an asset at absolute `path` has: `/src/logo.svg` inside `root` (a real path, as the
 * resolver's are), `/@fs/<path>` outside.
 */
export function assetUrl(root: string, path: string): string {
  const inside = relative(root, path)
  if (inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)) {
    return `/${inside.split(sep).join('/')}`
  }
  return `/@fs/${path.split(sep).join('/').replace(/^\//, '')}`
}

/**
 * The module-runner form of the module of `kind` (`export default <value>`, as the runner writes
 * it), so the loader evaluates it like any ES module: a mock, `require` and `import` all see it
 * through the same path. `text` is the file's text, read by the caller only under `?raw`.
 */
export function assetRunnerSource(
  kind: AssetKind,
  root: string,
  path: string,
  query: AssetQuery = null,
  text = '',
): string {
  const value =
    query === 'raw'
      ? JSON.stringify(text)
      : query === 'url' || kind === 'asset'
        ? JSON.stringify(assetUrl(root, path))
        : kind === 'style'
          ? "''"
          : // Every string key reads as its own name; a symbol, `then` (so it is never thenable) and
            // `__esModule` read as undefined.
            `new Proxy(Object.create(null), { get(_target, key) { return typeof key === 'symbol' || key === 'then' || key === '__esModule' ? undefined : key } })`
  return [
    `const __vite_ssr_export_default__ = ${value}`,
    'Object.defineProperty(__vite_ssr_exports__, "default", { enumerable: true, configurable: true, get() { return __vite_ssr_export_default__ } })',
    '',
  ].join('\n')
}
