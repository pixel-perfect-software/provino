import { fileURLToPath } from 'node:url'
import { HarnessError } from './errors.ts'
import type { FixtureRunner } from './fixture.ts'
import { isRecord } from './internal/guards.ts'
import { SIDECAR_ENV, type SidecarEntry } from './internal/sidecar-format.ts'

export type { SidecarEntry, SidecarOptions } from './internal/sidecar-format.ts'
export { SIDECAR_ENV }

const REPORTER_FILES: Readonly<Record<FixtureRunner, string>> = {
  jest: './reporters/jest.ts',
  vitest: './reporters/vitest.ts',
}

/**
 * The absolute path of a runner's sidecar reporter (`@provino/harness/reporters/jest` or
 * `/vitest`), for `--reporters=<path>` (Jest) or `--reporter=<path>` (Vitest), or a config's
 * reporter list. The reporters import Node builtins only, so they load from any repository's
 * config by path, with no `--conditions` flag and no `node_modules` link to this package. Each
 * writes the file named in `PROVINO_SIDECAR_OUT`.
 * @public
 */
export function sidecarReporterPath(runner: FixtureRunner): string {
  return fileURLToPath(new URL(REPORTER_FILES[runner], import.meta.url))
}

function invalid(source: string, line: number, what: string): HarnessError {
  return new HarnessError('HARNESS_SIDECAR_INVALID', `${source}:${line}: ${what}`, {
    path: source,
  })
}

function entryOf(value: unknown, source: string, line: number): SidecarEntry {
  if (!isRecord(value)) throw invalid(source, line, 'an entry must be a JSON object')
  const { file, test, stream, level, text } = value
  if (stream !== 'stdout' && stream !== 'stderr') {
    throw invalid(source, line, '"stream" must be "stdout" or "stderr"')
  }
  if (typeof text !== 'string') throw invalid(source, line, '"text" must be a string')
  if (file !== undefined && typeof file !== 'string') {
    throw invalid(source, line, '"file" must be a string')
  }
  if (level !== undefined && typeof level !== 'string') {
    throw invalid(source, line, '"level" must be a string')
  }
  let identity: SidecarEntry['test']
  if (test !== undefined) {
    const path = isRecord(test) ? test.path : undefined
    const dupIndex = isRecord(test) ? test.dupIndex : undefined
    if (
      !Array.isArray(path) ||
      !path.every((part): part is string => typeof part === 'string') ||
      typeof dupIndex !== 'number' ||
      !Number.isInteger(dupIndex) ||
      dupIndex < 0
    ) {
      throw invalid(source, line, '"test" must be { path: string[], dupIndex: whole number }')
    }
    identity = { path, dupIndex }
  }
  return {
    ...(file === undefined ? {} : { file }),
    ...(identity === undefined ? {} : { test: identity }),
    stream,
    ...(level === undefined ? {} : { level }),
    text,
  }
}

/**
 * Reads a sidecar file (one JSON entry per line, as the sidecar reporters write it). A blank line
 * is skipped; anything else that is not an entry is `HARNESS_SIDECAR_INVALID`, naming the line.
 * @public
 */
export function parseSidecar(text: string, source: string = 'sidecar'): SidecarEntry[] {
  const entries: SidecarEntry[] = []
  text.split('\n').forEach((raw, index) => {
    if (raw.trim() === '') return
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch (cause) {
      throw new HarnessError('HARNESS_SIDECAR_INVALID', `${source}:${index + 1}: not JSON`, {
        path: source,
        cause,
      })
    }
    entries.push(entryOf(value, source, index + 1))
  })
  return entries
}
