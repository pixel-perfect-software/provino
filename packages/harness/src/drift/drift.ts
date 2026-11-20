// T7.15: what changed upstream between two tags in the files the vendor directories copied. Each
// `UPSTREAM.md`'s sources are looked up in the repository's tree at each tag (the tag's tarball,
// extracted, `tarball.ts`); a source is a file or a directory, and every file under it counts.
// The report names each file whose bytes differ, or that only one tag has, with the `UPSTREAM.md`
// that copied it. It changes nothing: reading the upstream diff and porting it is the person's.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'
import { walkFiles } from '../internal/walk.ts'
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
  /**
   * Sources of this repository (the nearest named in their `UPSTREAM.md`) found in neither tag: a
   * stale name, or a path spelled another way. A source in this tree counts here whichever
   * repository is nearest it, so one is unresolved only when it is in none of the trees asked for.
   */
  readonly unresolved: readonly { readonly upstream: string; readonly source: string }[]
}

/** Every file under `dir` (relative to `root`), or `dir` itself when it is a file. */
async function filesUnder(root: string, relative: string): Promise<string[]> {
  const full = join(root, relative)
  if (!existsSync(full)) return []
  if (!statSync(full).isDirectory()) return [relative]
  return (await walkFiles(full)).map((file) => posix.join(relative, file))
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
export async function driftBetween(
  repository: Repository,
  range: { readonly from: string; readonly to: string },
  trees: { readonly from: string; readonly to: string },
  upstreams: readonly UpstreamFile[],
): Promise<DriftReport> {
  const namedBy = new Map<string, Set<string>>()
  const unresolved: { upstream: string; source: string }[] = []
  for (const upstream of upstreams) {
    if (!upstream.repositories.includes(repository)) continue
    for (const source of upstream.sources) {
      const found = source.paths.find(
        (path) => existsSync(join(trees.from, path)) || existsSync(join(trees.to, path)),
      )
      if (found === undefined) {
        // A file that names two repositories lists the other's sources too: each is reported by the
        // repository nearest it.
        if (source.repository === repository) {
          unresolved.push({ upstream: upstream.path, source: source.paths[0] ?? '' })
        }
        continue
      }
      const files = new Set([
        ...(await filesUnder(trees.from, found)),
        ...(await filesUnder(trees.to, found)),
      ])
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

/** Whether a report fails the command: a source in neither tag, or no file checked at all. */
export function driftFails(report: DriftReport): boolean {
  return report.unresolved.length > 0 || report.checked === 0
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
