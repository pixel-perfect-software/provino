import { isAbsolute, relative, sep } from 'node:path'

// The assets and styles a native project imports as modules (`ModulePolicy.assetImports`).
//
// The asset list is Vite 8.3.5's `KNOWN_ASSET_TYPES` (`dist/node/chunks/node.js` L765-797), the
// style one its `CSS_LANGS_RE` (L747). The URL is the dev server's `fileToDevUrl` form (L32668-32683):
// the path from the root, or `/@fs/` and the absolute path outside it. Vite also inlines a small
// `.svg` as a `data:` URL; this does not.

const ASSET_EXTENSIONS =
  /\.(?:apng|bmp|png|jpe?g|jfif|pjpeg|pjp|gif|svg|ico|webp|avif|cur|jxl|mp4|webm|ogg|mp3|wav|flac|aac|opus|mov|m4a|vtt|woff2?|eot|ttf|otf|webmanifest|pdf|txt)$/i
const STYLE_EXTENSIONS = /\.(?:css|less|sass|scss|styl|stylus|pcss|postcss|sss)$/i
const CSS_MODULE = /\.module\.(?:css|less|sass|scss|styl|stylus|pcss|postcss|sss)$/i

/** What a file imports as, or `null` when it is no asset or style file. */
export type AssetKind = 'asset' | 'style' | 'style-module'

/** The kind of the file at `path` (a plain path, no query), or `null`. */
export function assetKindOf(path: string): AssetKind | null {
  if (STYLE_EXTENSIONS.test(path)) return CSS_MODULE.test(path) ? 'style-module' : 'style'
  return ASSET_EXTENSIONS.test(path) ? 'asset' : null
}

/** The URL an asset at absolute `path` has: `/src/logo.svg` inside `root`, `/@fs/<path>` outside. */
export function assetUrl(root: string, path: string): string {
  const inside = relative(root, path)
  if (inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)) {
    return `/${inside.split(sep).join('/')}`
  }
  return `/@fs/${path.split(sep).join('/').replace(/^\//, '')}`
}

/**
 * The module-runner form of the module of `kind` (`export default <value>`, as the runner writes
 * it), so the loader evaluates it like any ES module: a mock, `require` and `import` all see it
 * through the same path.
 */
export function assetRunnerSource(kind: AssetKind, root: string, path: string): string {
  const value =
    kind === 'asset'
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
