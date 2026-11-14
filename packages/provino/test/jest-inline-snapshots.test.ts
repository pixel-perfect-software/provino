// B23d B1, T7.11's Jest half: `provino jest` writes inline snapshots as Jest 30.5.2 does, held to
// black-box goldens recorded from real Jest (`packages/harness/fixtures/snapshot/inline-*`): the
// bytes of the test file the run leaves, the exit code and the kept stderr lines. New snapshots in
// JavaScript and TSX, `-u` over what differs, two calls on one line, `.resolves`/`.rejects`, property
// matchers and calls over several lines (Babel's reprint, D122), thrown messages, one call reached
// twice (Jest's error), `--ci` (nothing written) and the project's Prettier 3 (D113). Each project
// sits under `packages/provino/.work`, so Prettier, babel-jest and the presets the TSX fixture's
// Babel config names resolve from it, as they do from the recorder's work directory.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { observedText } from './mask.ts'
import { loadFixture, materialize } from './recorded.ts'
import { spawnCli } from './support.ts'

const WORK = fileURLToPath(new URL('../.work/', import.meta.url))

const FIXTURES: readonly string[] = [
  'snapshot/inline-new-js',
  'snapshot/inline-update',
  'snapshot/inline-tsx',
  'snapshot/inline-two-on-one-line',
  'snapshot/inline-resolves',
  'snapshot/inline-property-matchers',
  'snapshot/inline-throw-error',
  'snapshot/inline-same-call-twice',
  'snapshot/inline-ci',
  'snapshot/inline-prettier',
  'snapshot/inline-no-frame',
  'snapshot/inline-written',
]

describe('provino jest writes inline snapshots as Jest 30.5.2 does', () => {
  for (const id of FIXTURES) {
    it(id, async () => {
      const fixture = await loadFixture(id)
      const expected = fixture.golden.observed
      assert.notEqual(expected?.exitCode, undefined, 'the golden records an exit code')
      const captured = Object.entries(expected?.files ?? {})
      assert.ok(captured.length > 0, 'the golden captures the test file')
      const argv = fixture.manifest.run?.argv?.jest ?? []
      const project = await materialize(fixture, { parent: WORK })
      try {
        const ended = await spawnCli(
          [
            'jest',
            `--config=${join(project.root, 'jest.config.json')}`,
            ...(argv.some((arg) => arg.startsWith('--ci')) ? [] : ['--ci']),
            ...argv,
          ],
          { cwd: project.root },
        )
        assert.equal(ended.signal, null, 'it exited, it was not killed')
        assert.equal(ended.code, expected?.exitCode, ended.stderr)
        for (const [file, bytes] of captured) {
          const left = await readFile(join(project.root, file), 'utf8').catch(() => null)
          assert.equal(left, bytes, file)
        }
        if (expected?.stderr !== undefined) {
          const kept = observedText(ended.stderr, {
            roots: [project.root],
            keepLines: fixture.manifest.run?.keepLines,
          })
          assert.equal(kept, expected.stderr, 'the kept stderr lines')
        }
      } finally {
        await project.dispose()
      }
    })
  }
})
