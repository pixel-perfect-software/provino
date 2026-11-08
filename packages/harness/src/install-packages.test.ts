// `installPackages` writes a fixture's `packages` into a work directory. The manifest parser
// already refuses a file that leaves its package; this is the second check, for a manifest built
// by hand, and it must agree with the first about what "leaves" means.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { HarnessError } from './errors.ts'
import type { Fixture } from './fixture.ts'
import { installPackages } from './record.ts'

function fixtureWith(files: Record<string, string>): Fixture {
  return {
    dir: '/not/used',
    id: 'area/packages',
    files: [],
    manifest: { description: 'x', runners: ['jest'], packages: { pkg: files } },
  }
}

async function withWorkDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'provino-install-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('a file whose name merely starts with .. is installed', async () => {
  await withWorkDir(async (dir) => {
    await installPackages(fixtureWith({ '..foo.js': 'exports.x = 1\n' }), dir)
    assert.equal(
      await readFile(path.join(dir, 'node_modules', 'pkg', '..foo.js'), 'utf8'),
      'exports.x = 1\n',
    )
  })
})

test('a file that leaves its package is refused, however it is spelled', async () => {
  for (const file of ['../x.js', 'a/../../x.js', '..']) {
    await withWorkDir(async (dir) => {
      await assert.rejects(
        installPackages(fixtureWith({ [file]: '' }), dir),
        (error) => error instanceof HarnessError && error.code === 'HARNESS_FIXTURE_BAD_PACKAGES',
        file,
      )
    })
  }
})
