import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { internalImports, internalTarget, isAddOn } from './internal-entries.ts'
import { readManifest } from './package-json.ts'
import { ROOT } from './workspace.ts'

describe("an add-on's build reaches the engine through provino/internal/* (D187)", () => {
  const hooks = (internalImports('@provino/dialect-jest') as readonly unknown[])[0] as {
    resolveId: { order: string; handler: (source: string) => unknown }
    transform: { handler: (code: string) => { code: string } | null }
  }

  test('the two dialects are add-ons, and provino is not', () => {
    for (const name of ['dialect-jest', 'dialect-vitest'])
      assert.ok(isAddOn(readManifest(join(ROOT, 'packages', name))), name)
    assert.ok(!isAddOn(readManifest(join(ROOT, 'packages', 'provino'))))
  })

  test('an engine import resolves to its internal subpath, external; its own and a third party stay', () => {
    assert.equal(hooks.resolveId.order, 'pre')
    assert.deepEqual(hooks.resolveId.handler('@provino/mock'), {
      id: 'provino/internal/jest-runtime',
      external: true,
    })
    assert.deepEqual(hooks.resolveId.handler('@provino/resolver'), {
      id: 'provino/internal/resolver',
      external: true,
    })
    assert.equal(hooks.resolveId.handler('@provino/dialect-jest/results'), null)
    assert.equal(hooks.resolveId.handler('pretty-format'), null)
  })

  test('an engine package the table lacks for this add-on fails the build', () => {
    assert.throws(() => hooks.resolveId.handler('@provino/loader'), /does not export to it/)
    // The Vitest add-on's engine entry is not the Jest one's.
    assert.throws(
      () => internalTarget('@provino/config', '@provino/dialect-jest'),
      /@provino\/config/,
    )
    assert.equal(
      internalTarget('@provino/config', '@provino/dialect-vitest'),
      'provino/internal/config',
    )
  })

  test('import.meta.resolve of the engine is rewritten; its own subpaths are left', () => {
    const out = hooks.transform.handler(
      [
        "const a = import.meta.resolve('@provino/expect')",
        'const b = import.meta.resolve("@provino/dialect-jest/runtime")',
      ].join('\n'),
    )
    assert.ok(out !== null)
    assert.match(out.code, /import\.meta\.resolve\('provino\/internal\/jest-runtime'\)/)
    assert.match(out.code, /import\.meta\.resolve\("@provino\/dialect-jest\/runtime"\)/)
    assert.equal(hooks.transform.handler("import.meta.resolve('vitest')"), null)
    assert.throws(() => hooks.transform.handler("import.meta.resolve('@provino/loader')"))
  })
})
