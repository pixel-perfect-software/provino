// T2.11: tier selection and escalation. Raise, refuse to lower, unknown values; the docblock reader.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { IsolationTier, Pragmas } from '@provino/types'
import { ISOLATE_PRAGMA, isolatePragmaOf, readIsolatePragma, tierFor } from './tier.ts'

const FILE = 'a.test.ts'
const pragma = (value: string | readonly string[]): Pragmas => ({ [ISOLATE_PRAGMA]: value })
const TIERS: readonly IsolationTier[] = ['none', 'registry', 'realm', 'process']

describe('tierFor', () => {
  it('keeps the configured tier when nothing else names one', () => {
    for (const configured of TIERS) {
      assert.deepEqual(tierFor(FILE, { configured }), {
        tier: configured,
        source: 'config',
        warnings: [],
      })
    }
  })

  it('raises the tier to a higher one named by the docblock', () => {
    assert.deepEqual(tierFor(FILE, { configured: 'registry', docblock: pragma('realm') }), {
      tier: 'realm',
      source: 'docblock',
      warnings: [],
    })
    assert.equal(
      tierFor(FILE, { configured: 'none', docblock: pragma('registry') }).tier,
      'registry',
    )
    assert.equal(
      tierFor(FILE, { configured: 'registry', docblock: pragma('process') }).tier,
      'process',
    )
  })

  it('never lowers it, and says nothing about a request below the project’s tier', () => {
    for (const [configured, asked] of [
      ['realm', 'registry'],
      ['realm', 'none'],
      ['registry', 'none'],
      ['process', 'realm'],
    ] as const) {
      assert.deepEqual(
        tierFor(FILE, { configured, docblock: pragma(asked) }),
        { tier: configured, source: 'config', warnings: [] },
        `${asked} in a ${configured} project`,
      )
    }
    // A learned tier is no way down either.
    assert.equal(tierFor(FILE, { configured: 'realm', learned: 'none' }).tier, 'realm')
  })

  it('warns about a value that is not a tier and keeps the configured tier', () => {
    for (const value of ['', 'Registry', 'jail', 'realm please', 'process,realm']) {
      const choice = tierFor(FILE, { configured: 'registry', docblock: pragma(value) })
      assert.equal(choice.tier, 'registry', JSON.stringify(value))
      assert.equal(choice.source, 'config')
      assert.equal(choice.warnings.length, 1)
      assert.match(
        choice.warnings[0] as string,
        /a\.test\.ts: @provino-isolate .* is not an isolation tier/,
      )
      assert.match(choice.warnings[0] as string, /none, registry, realm, process/)
    }
  })

  it('counts every value of a repeated pragma: the highest valid one wins, each bad one warns', () => {
    const choice = tierFor(FILE, {
      configured: 'none',
      docblock: pragma(['registry', 'nonsense', 'realm']),
    })
    assert.equal(choice.tier, 'realm')
    assert.equal(choice.warnings.length, 1)
  })

  it('takes a learned tier the same way: it raises, and the docblock is named first when both agree', () => {
    assert.deepEqual(tierFor(FILE, { configured: 'registry', learned: 'realm' }), {
      tier: 'realm',
      source: 'learned',
      warnings: [],
    })
    assert.equal(
      tierFor(FILE, { configured: 'registry', docblock: pragma('realm'), learned: 'realm' }).source,
      'docblock',
    )
    assert.deepEqual(
      tierFor(FILE, { configured: 'registry', docblock: pragma('realm'), learned: 'process' }),
      { tier: 'process', source: 'learned', warnings: [] },
    )
  })

  it('returns process as a tier: the coordinator turns it into a fresh worker', () => {
    assert.equal(tierFor(FILE, { configured: 'none', docblock: pragma('process') }).tier, 'process')
  })
})

describe('isolatePragmaOf', () => {
  it('reads the pragma of the leading docblock', () => {
    assert.deepEqual(
      isolatePragmaOf('/**\n * @provino-isolate realm\n */\ntest("x", () => {})'),
      pragma('realm'),
    )
    assert.deepEqual(isolatePragmaOf('/* @provino-isolate registry */'), pragma('registry'))
    assert.deepEqual(
      isolatePragmaOf('\n\n  /**\n   * @provino-isolate process\n   */'),
      pragma('process'),
    )
    assert.deepEqual(isolatePragmaOf('/**\r\n * @provino-isolate realm\r\n */'), pragma('realm'))
  })

  it('reads it among other pragmas, drops a // comment from its value, and trims', () => {
    assert.deepEqual(
      isolatePragmaOf(
        '/**\n * @jest-environment jsdom\n * @provino-isolate   realm   // leaks timers\n * @other x\n */',
      ),
      pragma('realm'),
    )
  })

  it('lists a pragma given twice', () => {
    assert.deepEqual(
      isolatePragmaOf('/**\n * @provino-isolate registry\n * @provino-isolate realm\n */'),
      pragma(['registry', 'realm']),
    )
  })

  it('reads an empty value as an empty string, which `tierFor` then warns about', () => {
    assert.deepEqual(isolatePragmaOf('/**\n * @provino-isolate\n */'), pragma(''))
  })

  it('finds nothing in a comment that is not the first thing in the file, or not closed, or about another pragma', () => {
    assert.equal(isolatePragmaOf('import x from "y"\n/** @provino-isolate realm */'), undefined)
    assert.equal(isolatePragmaOf('// @provino-isolate realm\n'), undefined)
    assert.equal(isolatePragmaOf('/** @provino-isolate realm'), undefined)
    assert.equal(
      isolatePragmaOf('/**\n * @provino-isolated realm\n * @provino-isolate-x realm\n */'),
      undefined,
    )
    assert.equal(isolatePragmaOf('/** @jest-environment node */'), undefined)
    assert.equal(isolatePragmaOf(''), undefined)
  })
})

describe('readIsolatePragma', () => {
  async function withFile<T>(text: string, use: (path: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'provino-tier-'))
    try {
      const path = join(dir, 'a.test.ts')
      await writeFile(path, text)
      return await use(path)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  it('reads the pragma of a file', async () => {
    await withFile('/** @provino-isolate realm */\ntest("x", () => {})\n', async (path) => {
      assert.deepEqual(await readIsolatePragma(path), pragma('realm'))
    })
  })

  it('reads on past the first 4 KiB when the leading comment is not closed there', async () => {
    const padding = ` * ${'x'.repeat(100)}\n`.repeat(60)
    await withFile(`/**\n${padding} * @provino-isolate process\n */\n`, async (path) => {
      assert.deepEqual(await readIsolatePragma(path), pragma('process'))
    })
  })

  it('finds nothing in a long file with no docblock, and nothing in a file that is not there', async () => {
    await withFile(`${'const a = 1\n'.repeat(1000)}`, async (path) => {
      assert.equal(await readIsolatePragma(path), undefined)
    })
    assert.equal(await readIsolatePragma(join(tmpdir(), 'provino-no-such-dir', 'x.ts')), undefined)
  })
})
