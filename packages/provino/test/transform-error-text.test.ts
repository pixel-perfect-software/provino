// A project transformer that throws, through `provino jest`, held to the runs Jest 30.5.2 recorded
// (`cli/transform-throws-*`): the file fails at transform with the thrown value as it is, an
// Error's class and message with no path added, a thrown string as the string.
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { assertMatchesGolden, linkEnvironments, provinoOn, WORK } from './recorded-run.ts'

const PARENT = join(WORK, 'transform-error-text')

after(async () => {
  await rm(PARENT, { recursive: true, force: true })
})

describe('a transformer that throws, against Jest 30.5.2', () => {
  for (const fixture of ['cli/transform-throws-error', 'cli/transform-throws-string']) {
    it(`${fixture}: the file fails with the thrown value as it is, exit 1`, async () => {
      await linkEnvironments(PARENT)
      assertMatchesGolden(fixture, await provinoOn(fixture, { parent: PARENT }))
    })
  }
})
