// B25c, T11.15: `import.meta.env` for a Vitest project, from `mode` and the `.env*` files, as
// Vite's `loadEnv` reads them (`dotenv` 16's parser and `dotenv-expand`'s substitution, rebuilt
// here: the config reader runs without Vite). Held to Vite's own `loadEnv` by `env.test.ts`.
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const LINE =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm

/**
 * dotenv 16's `parse`: `KEY=value` lines, quotes (`"` also expands `\n` and `\r`), comments.
 * @public
 */
export function parseDotenv(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  const lines = text.replace(/\r\n?/gm, '\n')
  const regex = new RegExp(LINE.source, LINE.flags)
  for (let match = regex.exec(lines); match !== null; match = regex.exec(lines)) {
    const key = match[1]
    if (key === undefined) continue
    let value = (match[2] ?? '').trim()
    const quote = value[0]
    value = value.replace(/^(['"`])([\s\S]*)\1$/gm, '$2')
    if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r')
    result[key] = value
  }
  return result
}

const SUBSTITUTION = /(\\)?\$(?:\{([\w.]+)(?::?-([^}]*))?\}|([\w.]+))/g

function interpolate(
  value: string,
  key: string,
  processEnv: Readonly<Record<string, string | undefined>>,
  parsed: Readonly<Record<string, string>>,
  seen: ReadonlySet<string>,
): string {
  return value
    .replace(SUBSTITUTION, (whole, escaped: string | undefined, braced, fallback, bare) => {
      if (escaped !== undefined) return whole.slice(1)
      const name: string = braced ?? bare
      const own = Object.hasOwn(processEnv, name) ? processEnv[name] : undefined
      let found = own ?? parsed[name] ?? fallback ?? ''
      if (own === undefined && name !== key && !seen.has(name) && found.includes('$')) {
        found = interpolate(found, name, processEnv, parsed, new Set([...seen, key]))
      }
      return found
    })
    .replace(/\\\$/g, '$')
}

/**
 * dotenv-expand's substitution (`$VAR`, `${VAR}`, `${VAR:-default}`, `\$` kept literal): a value
 * the process environment already holds wins over the file's, as there.
 * @public
 */
export function expandDotenv(
  parsed: Readonly<Record<string, string>>,
  processEnv: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const expanded: Record<string, string> = { ...parsed }
  for (const key of Object.keys(parsed)) {
    const base = Object.hasOwn(processEnv, key) ? processEnv[key] : parsed[key]
    expanded[key] = interpolate(base ?? '', key, processEnv, expanded, new Set())
  }
  return expanded
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** What `loadVitestEnv` reads. */
export interface LoadEnvOptions {
  readonly mode: string
  readonly envDir: string
  readonly prefixes: readonly string[]
  readonly processEnv: Readonly<Record<string, string | undefined>>
}

/**
 * Vite's `loadEnv(mode, envDir, prefixes)`: `.env`, `.env.local`, `.env.[mode]` and
 * `.env.[mode].local` (a later file wins), expanded, keeping the keys that start with a prefix,
 * then the process environment's keys that do (those win).
 * @public
 */
export function loadVitestEnv(options: LoadEnvOptions): Record<string, string> {
  const { mode, envDir, prefixes, processEnv } = options
  const files = ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]
  const parsed: Record<string, string> = {}
  for (const file of files) {
    const path = join(envDir, file)
    if (!isFile(path)) continue
    Object.assign(parsed, parseDotenv(readFileSync(path, 'utf8')))
  }
  const expanded = expandDotenv(parsed, processEnv)
  const env: Record<string, string> = {}
  const wanted = (key: string): boolean => prefixes.some((prefix) => key.startsWith(prefix))
  for (const [key, value] of Object.entries(expanded)) if (wanted(key)) env[key] = value
  for (const [key, value] of Object.entries(processEnv)) {
    if (value !== undefined && wanted(key)) env[key] = value
  }
  return env
}
