// Reading an `UPSTREAM.md` for T7.15's drift report: which upstream repositories it names and
// which upstream paths its tables list as sources. A vendor directory's `UPSTREAM.md` lists its
// files in a table whose header has a `Source` column, sometimes with a base path in that header
// (`Source (\`packages/expect/src/\`)`); each cell's backticked names are the sources. A name
// is resolved against the repository's tree later (`drift.ts`), as written, under the base and
// under `packages/`, since the files spell it each of those ways.

/** The upstream repositories the report knows, by the name its flags use. */
export const REPOSITORIES = {
  jest: 'jestjs/jest',
  vitest: 'vitest-dev/vitest',
} as const

/** A repository the report knows. */
export type Repository = keyof typeof REPOSITORIES

/** What one `UPSTREAM.md` says. */
export interface UpstreamFile {
  /** Its path, as the caller gave it. */
  readonly path: string
  /** The repositories it names (`github.com/jestjs/jest`, `github.com/vitest-dev/vitest`). */
  readonly repositories: readonly Repository[]
  /** Each source the tables list: the candidate upstream paths it may be, most specific first. */
  readonly sources: readonly (readonly string[])[]
}

const BACKTICKED = /`([^`]+)`/g

/** The cells of a markdown table row, without the outer pipes. */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

/** The candidate paths a backticked source name may be, under the column's base. */
function candidates(name: string, base: string | undefined): string[] {
  const out = new Set<string>()
  if (base !== undefined) out.add(`${base.replace(/\/?$/, '/')}${name}`)
  out.add(name)
  if (!name.startsWith('packages/')) out.add(`packages/${name}`)
  return [...out].map((path) => path.replace(/\/+$/, ''))
}

/** Whether a backticked name looks like a path: a file with an extension, or a directory. */
const looksLikePath = (name: string): boolean =>
  !name.includes(' ') && (/\.[cm]?[jt]sx?$/.test(name) || name.endsWith('/'))

/** Reads an `UPSTREAM.md`'s repositories and sources. */
export function parseUpstream(path: string, text: string): UpstreamFile {
  const repositories = (Object.keys(REPOSITORIES) as Repository[]).filter((name) =>
    text.includes(`github.com/${REPOSITORIES[name]}`),
  )
  const sources: string[][] = []
  let sourceColumn = -1
  let base: string | undefined
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('|')) {
      sourceColumn = -1
      continue
    }
    const row = cells(line)
    if (row.every((cell) => /^:?-+:?$/.test(cell))) continue
    if (sourceColumn === -1) {
      // A table's header row: find the source column and its base.
      sourceColumn = row.findIndex((cell) => /^source\b/i.test(cell))
      if (sourceColumn === -1) {
        sourceColumn = -2
        continue
      }
      base = [...(row[sourceColumn] ?? '').matchAll(BACKTICKED)].map((m) => m[1] ?? '')[0]
      continue
    }
    if (sourceColumn < 0) continue
    for (const match of (row[sourceColumn] ?? '').matchAll(BACKTICKED)) {
      const name = match[1] ?? ''
      if (looksLikePath(name)) sources.push(candidates(name, base))
    }
  }
  return { path, repositories, sources }
}
