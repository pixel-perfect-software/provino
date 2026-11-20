// T7.15: what changed upstream between two tags in the files the vendor directories copied. Each
// `UPSTREAM.md`'s sources are looked up in the repository's tree at each tag (the tag's tarball,
// extracted, `tarball.ts`); a source is a file or a directory, and every file under it counts.
// The report names each file whose bytes differ, or that only one tag has, with the `UPSTREAM.md`
// that copied it. It changes nothing: reading the upstream diff and porting it is the person's.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Repository, UpstreamFile } from './upstream.ts'

/** One upstream file that differs between the tags. */
export interface DriftedFile {
  readonly path: string
  readonly change: 'changed' | 'added' | 'removed'
  /** The `UPSTREAM.md` files that name it. */
  readonly upstreams: readonly string[]
}

/** The report for one repository and one range. */
export interface DriftReport {
  readonly repository: Repository
  readonly from: string
  readonly to: string
  /** The upstream files the `UPSTREAM.md` files name that either tag has. */
  readonly checked: number
  readonly drifted: readonly DriftedFile[]
  /** Sources found in neither tag, by `UPSTREAM.md`: a stale name, or a path spelled another way. */
  readonly unresolved: readonly { readonly upstream: string; readonly source: string }[]
}

/** Every file under `dir` (relative to `root`), or `dir` itself when it is a file. */
function filesUnder(root: string, relative: string): string[] {
  const full = join(root, relative)
  if (!existsSync(full)) return []
  if (!statSync(full).isDirectory()) return [relative]
  return readdirSync(full, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
}

/** The bytes of `relative` in `root`, or `undefined` when the tree has no such file. */
function read(root: string, relative: string): Buffer | undefined {
  const full = join(root, relative)
  return existsSync(full) && statSync(full).isFile() ? readFileSync(full) : undefined
}

/**
 * Compares the two extracted trees over the sources the `UPSTREAM.md` files that name
 * `repository` list.
 */
export function driftBetween(
  repository: Repository,
  range: { readonly from: string; readonly to: string },
  trees: { readonly from: string; readonly to: string },
  upstreams: readonly UpstreamFile[],
): DriftReport {
  const namedBy = new Map<string, Set<string>>()
  const unresolved: { upstream: string; source: string }[] = []
  for (const upstream of upstreams) {
    if (!upstream.repositories.includes(repository)) continue
    for (const options of upstream.sources) {
      const found = options.find(
        (path) => existsSync(join(trees.from, path)) || existsSync(join(trees.to, path)),
      )
      if (found === undefined) {
        // A file that names two repositories lists the other's sources too: not this one's to report.
        if (upstream.repositories.length === 1) {
          unresolved.push({ upstream: upstream.path, source: options[0] ?? '' })
        }
        continue
      }
      const files = new Set([...filesUnder(trees.from, found), ...filesUnder(trees.to, found)])
      for (const file of files) {
        const set = namedBy.get(file) ?? new Set<string>()
        set.add(upstream.path)
        namedBy.set(file, set)
      }
    }
  }
  const drifted: DriftedFile[] = []
  for (const file of [...namedBy.keys()].sort()) {
    const before = read(trees.from, file)
    const after = read(trees.to, file)
    const change =
      before === undefined
        ? 'added'
        : after === undefined
          ? 'removed'
          : before.equals(after)
            ? undefined
            : 'changed'
    if (change !== undefined) {
      drifted.push({ path: file, change, upstreams: [...(namedBy.get(file) ?? [])].sort() })
    }
  }
  return { repository, ...range, checked: namedBy.size, drifted, unresolved }
}

/** The report as the command prints it. */
export function formatDrift(report: DriftReport): string {
  const lines = [
    `${report.repository} ${report.from}..${report.to}: ${report.drifted.length} of ${report.checked} vendored files differ`,
  ]
  for (const file of report.drifted) {
    lines.push(`  ${file.change.padEnd(8)} ${file.path}`)
    for (const upstream of file.upstreams) lines.push(`           copied by ${upstream}`)
  }
  for (const { upstream, source } of report.unresolved) {
    lines.push(`  unresolved ${source} (${upstream}): in neither tag`)
  }
  return lines.join('\n')
}
