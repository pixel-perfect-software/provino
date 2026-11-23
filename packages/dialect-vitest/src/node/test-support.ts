// Test helpers for the reader's tests: a temp tree written from data. Three of the files that import
// this run on node:test (`tooling/provino/bootstrap.json`) and two on Provino, so it imports neither
// runner: each test file registers `removeTrees` itself (`after` or `afterAll`).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const roots: string[] = []

/** Removes every tree `writeTree` made; a test file runs it when its tests are done. */
export function removeTrees(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}

/** Writes `files` (path to text) into a fresh temp directory and returns its real path. */
export function writeTree(files: Readonly<Record<string, string>>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'provino-vitest-config-')))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}
