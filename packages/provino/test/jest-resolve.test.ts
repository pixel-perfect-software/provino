// T3.3 end to end: what Jest's resolver does with a `moduleNameMapper` rule that matches, held to
// what real Jest 30.5.2 recorded (`resolve/*`): the error a rule whose targets don't resolve throws,
// and the order of the Jest-owned names against the mappers.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { provinoRun, sorted } from './live-jest.ts'
import { FIXTURES, loadFixture, materialize } from './recorded.ts'

interface Trace {
  readonly id: string
  readonly value: unknown
}

/** The `observe` values a golden recorded, by id. */
async function observed(id: string): Promise<ReadonlyMap<string, unknown>> {
  const golden = JSON.parse(
    await readFile(join(FIXTURES, id, '__goldens__', 'jest.json'), 'utf8'),
  ) as { trace: string[] }
  return new Map(golden.trace.map((line) => JSON.parse(line) as Trace).map((t) => [t.id, t.value]))
}

describe('moduleNameMapper against Jest 30.5.2', () => {
  it('a rule that matches and does not resolve throws the error Jest throws', async () => {
    const id = 'resolve/mapper-miss'
    const seen = await observed(id)
    const fixture = await loadFixture(id)
    const project = await materialize(fixture)
    try {
      // The fixture's own test records through `observe`; this one asserts what it recorded.
      const checks = [...seen]
        .map(([name, value]) => {
          const recorded = value as { threw: false | { message: string } }
          const target = {
            single: '@app/missing',
            array: '@multi/missing',
            first: '@first/special',
            hit: '@app/real',
          }[name]
          return recorded.threw
            ? `test(${JSON.stringify(name)}, () => {
  let message = ''
  try { require(${JSON.stringify(target)}) } catch (error) { message = error.message.replaceAll(__dirname, '<root>') }
  expect(message).toBe(${JSON.stringify(recorded.threw.message)})
})`
            : `test(${JSON.stringify(name)}, () => { expect(() => require(${JSON.stringify(target)})).not.toThrow() })`
        })
        .join('\n')
      await writeFile(join(project.root, 'mapper-miss.jest.test.ts'), `${checks}\n`)
      const ended = await provinoRun(project.root)
      assert.deepEqual(
        [...ended.statuses.values()],
        [...seen.keys()].map(() => 'passed'),
        ended.stderr,
      )
    } finally {
      await project.dispose()
    }
  })
})

/** Names Jest answers itself, against `moduleNameMapper`, held to the verdicts Jest recorded. */
describe('the order of the served names and moduleNameMapper, against Jest 30.5.2', () => {
  for (const id of ['resolve/alias-order', 'resolve/alias-jest-mock'] as const) {
    it(`${id}: each test has Jest's status`, async () => {
      const fixture = await loadFixture(id)
      const project = await materialize(fixture)
      try {
        const recorded = new Map<string, string>()
        for (const file of fixture.golden.files) {
          for (const test of file.tests ?? []) {
            recorded.set(`${file.file}::${test.id.path.join(' ')}`, test.status)
          }
        }
        assert.ok(recorded.size > 0)
        const ended = await provinoRun(project.root)
        assert.deepEqual(sorted(ended.statuses), sorted(recorded), ended.stderr)
      } finally {
        await project.dispose()
      }
    })
  }

  // Jest's own runner takes a mapped `expect` as its own, so every file of the project crashes
  // before its tests run. Provino's runner keeps its `expect`, and only the project's requires see
  // the stub: a declared divergence.
  for (const id of ['resolve/alias-expect', 'resolve/alias-jest-expect'] as const) {
    it(`${id}: Jest crashes the file, Provino's mapped require gets the stub (declared)`, async () => {
      const fixture = await loadFixture(id)
      assert.equal(fixture.golden.files[0]?.status, 'crashed', 'Jest crashed the file')
      const project = await materialize(fixture)
      try {
        const ended = await provinoRun(project.root)
        assert.deepEqual([...ended.statuses.values()], ['passed'], ended.stderr)
      } finally {
        await project.dispose()
      }
    })
  }
})
