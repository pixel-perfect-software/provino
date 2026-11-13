// Where a failure's frames point, through the bin: a TypeScript test file shaped like the real
// project this was found in (`jest.mock` on line 1, 16 lines of imports, then the tests). Real
// Jest 30.5.2 reports each frame at its place in the file as written
// (`cli/stack-frames-after-imports`); `provino jest` must give the same line and column for every
// failure, whichever transform made the code it ran: its own (Oxc, the hoister and the import
// rewrite), @swc/jest (the project's) and the recorder's babel-jest transformer. Before the loader
// mapped frames through each module's map, every frame below the imports was in the transformed
// code: about one line up per import line, and a column off by the reprint's indentation.
//
// Provino prints no code frame; the one Jest prints is built from the first of these frames, so
// the frame is what holds its place.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadFixture, materialize } from './recorded.ts'
import { spawnCli } from './support.ts'

const ID = 'cli/stack-frames-after-imports'

/** @swc/jest, from the package that installs it for its own tests. */
const SWC_JEST: string = createRequire(
  fileURLToPath(new URL('../../transform/package.json', import.meta.url)),
).resolve('@swc/jest')

/** The recorder's transformer: types stripped, `import` turned into `require` (`jestEsm`). */
const RECORDER_TRANSFORMER: string = fileURLToPath(
  new URL('../../harness/src/jest-transform.ts', import.meta.url),
)

/**
 * Each failure's title and the first frame under it that names the test file, as `line:column`.
 * The path in front differs (Jest prints it from the root, Provino in full), the position may not.
 */
function framesOf(stderr: string): [string, string][] {
  const frames: [string, string][] = []
  let title: string | undefined
  for (const line of stderr.split('\n')) {
    const bullet = /^ {2}● (.+)$/.exec(line)
    if (bullet !== null) {
      title = bullet[1]
      continue
    }
    const frame = /^ +at .*\bframes\.test\.ts:(\d+):(\d+)\)?$/.exec(line)
    if (frame !== null && title !== undefined) {
      frames.push([title, `${frame[1]}:${frame[2]}`])
      title = undefined
    }
  }
  return frames
}

/** The transform each run names, over the fixture's own Jest config. */
const TRANSFORMS: readonly [string, Readonly<Record<string, unknown>>][] = [
  ['Provino’s own transform', {}],
  [
    '@swc/jest, as the project the bug came from configures it',
    { transform: { '^.+\\.(t|j)sx?$': SWC_JEST }, extensionsToTreatAsEsm: ['.ts'] },
  ],
  [
    'the recorder’s babel-jest transformer',
    { transform: { '\\.ts$': [RECORDER_TRANSFORMER, { jestEsm: true }] } },
  ],
]

describe('provino jest reports each failure’s frame where Jest 30.5.2 does', () => {
  for (const [name, overlay] of TRANSFORMS) {
    it(name, async () => {
      const fixture = await loadFixture(ID)
      const expected = framesOf(fixture.golden.observed?.stderr ?? '')
      assert.equal(expected.length, 5, 'the recording has a frame for each of the 5 failures')
      const project = await materialize(fixture)
      try {
        const configPath = join(project.root, 'jest.config.json')
        const config = JSON.parse(await readFile(configPath, 'utf8')) as object
        await writeFile(configPath, JSON.stringify({ ...config, ...overlay }, null, 2))
        const ended = await spawnCli(['jest', `--config=${configPath}`, '--ci', '--no-cache'], {
          cwd: project.root,
        })
        assert.equal(ended.code, fixture.golden.observed?.exitCode, ended.stderr)
        assert.deepEqual(framesOf(ended.stderr), expected, ended.stderr)
      } finally {
        await project.dispose()
      }
    })
  }
})
