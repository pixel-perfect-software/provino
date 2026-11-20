// T11.16: pathe 2's `normalize` (as Vitest 5.0.5 bundles it, `vitest/dist/chunks/pathe.*.js`), which
// Vitest's command line applies to `normalize: true` options and to every file filter. Rebuilt with no
// dependency; `cli.test.ts` holds it to the real one through `parseCLI`.

const DRIVE_LETTER_START_RE = /^[A-Za-z]:\//
const UNC_REGEX = /^[/\\]{2}/
const IS_ABSOLUTE_RE = /^[/\\](?![/\\])|^[/\\]{2}(?!\.)|^[A-Za-z]:[/\\]/
const DRIVE_LETTER_RE = /^[A-Za-z]:$/

function normalizeWindowsPath(input: string): string {
  if (!input) return input
  return input.replace(/\\/g, '/').replace(DRIVE_LETTER_START_RE, (r) => r.toUpperCase())
}

const isAbsolute = (p: string): boolean => IS_ABSOLUTE_RE.test(p)

function normalizeString(path: string, allowAboveRoot: boolean): string {
  let res = ''
  let lastSegmentLength = 0
  let lastSlash = -1
  let dots = 0
  let char: string | null = null
  for (let index = 0; index <= path.length; ++index) {
    if (index < path.length) char = path[index] ?? null
    else if (char === '/') break
    else char = '/'
    if (char === '/') {
      if (lastSlash === index - 1 || dots === 1) {
        // nothing
      } else if (dots === 2) {
        if (
          res.length < 2 ||
          lastSegmentLength !== 2 ||
          res[res.length - 1] !== '.' ||
          res[res.length - 2] !== '.'
        ) {
          if (res.length > 2) {
            const lastSlashIndex = res.lastIndexOf('/')
            if (lastSlashIndex === -1) {
              res = ''
              lastSegmentLength = 0
            } else {
              res = res.slice(0, lastSlashIndex)
              lastSegmentLength = res.length - 1 - res.lastIndexOf('/')
            }
            lastSlash = index
            dots = 0
            continue
          } else if (res.length > 0) {
            res = ''
            lastSegmentLength = 0
            lastSlash = index
            dots = 0
            continue
          }
        }
        if (allowAboveRoot) {
          res += res.length > 0 ? '/..' : '..'
          lastSegmentLength = 2
        }
      } else {
        if (res.length > 0) res += `/${path.slice(lastSlash + 1, index)}`
        else res = path.slice(lastSlash + 1, index)
        lastSegmentLength = index - lastSlash - 1
      }
      lastSlash = index
      dots = 0
    } else if (char === '.' && dots !== -1) {
      ++dots
    } else {
      dots = -1
    }
  }
  return res
}

/** pathe's `normalize`. */
export function patheNormalize(input: string): string {
  if (input.length === 0) return '.'
  let path = normalizeWindowsPath(input)
  const isUNCPath = UNC_REGEX.test(path)
  const isPathAbsolute = isAbsolute(path)
  const trailingSeparator = path[path.length - 1] === '/'
  path = normalizeString(path, !isPathAbsolute)
  if (path.length === 0) {
    if (isPathAbsolute) return '/'
    return trailingSeparator ? './' : '.'
  }
  if (trailingSeparator) path += '/'
  if (DRIVE_LETTER_RE.test(path)) path += '/'
  if (isUNCPath) {
    if (!isPathAbsolute) return `//./${path}`
    return `//${path}`
  }
  return isPathAbsolute && !isAbsolute(path) ? `/${path}` : path
}
