// Helpers for this package's tests (not exported): a printer that needs no dialect, and a state in
// a temp directory. The dialects' real printers are checked in the harness's snapshot corpus.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after } from 'node:test'
import type { SnapshotPlugin, SnapshotPrinter } from '@provino/types'
import { SnapshotState, type SnapshotStateOptions } from './state.ts'

export const HEADER = '// Test Snapshot v1'

/** A printer: a serializer that matches first, else `JSON.stringify` with two spaces. */
export const jsonPrinter: SnapshotPrinter = {
  serialize(value, { plugins }) {
    for (const plugin of plugins) {
      if (plugin.test(value)) {
        return 'serialize' in plugin
          ? (plugin.serialize as (v: unknown) => string)(value)
          : (plugin.print as (v: unknown) => string)(value)
      }
    }
    return JSON.stringify(value, null, 2) ?? 'undefined'
  },
  messages: {
    mismatch: (info) => `mismatch ${info.key}`,
    notWritten: (info) => `not written ${info.key}`,
    propertiesMismatch: (info) => `properties ${info.key}`,
  },
}

export const policy: SnapshotStateOptions['policy'] = {
  header: HEADER,
  keyJoin: ' ',
  hintJoin: ': ',
  throwErrorBody: 'message',
  format: { escapeString: false, printBasicPrototype: false, maxOutputLength: null, extra: {} },
}

/** A temp directory, removed when the test file ends. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'provino-snapshot-'))
  after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Writes a file (and its directory) under `dir`; returns its path. */
export function put(dir: string, relative: string, text: string): string {
  const path = join(dir, relative)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

/** A `.snap` file's text. */
export function snapText(
  entries: Readonly<Record<string, string>>,
  header: string = HEADER,
): string {
  const body = Object.entries(entries).map(([key, value]) => `exports[\`${key}\`] = \`${value}\`;`)
  return `${header}\n\n${body.join('\n\n')}\n`
}

/** A state over `<dir>/__snapshots__/a.test.ts.snap`. */
export function stateIn(dir: string, options: Partial<SnapshotStateOptions> = {}): SnapshotState {
  return new SnapshotState({
    testPath: join(dir, 'a.test.ts'),
    snapshotPath: join(dir, '__snapshots__', 'a.test.ts.snap'),
    update: 'new',
    expand: false,
    policy,
    key: (name, count) => `${name} ${count}`,
    printer: jsonPrinter,
    ...options,
  })
}

export type { SnapshotPlugin }
