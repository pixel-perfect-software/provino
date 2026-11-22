import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  ADD_ONS,
  INTERNAL_ENTRIES,
  inPackage,
  internalTarget,
  isAddOn,
  isInternalEntry,
  rewriteResolveCalls,
} from './internal-entries.ts'
import { readManifest } from './package-json.ts'
import { ROOT } from './workspace.ts'

describe("an add-on's build reaches the engine through provino/internal/* (D187)", () => {
  test("the add-ons are the table's keys, each names provino as a peer, and provino is none", () => {
    assert.deepEqual(ADD_ONS, Object.keys(INTERNAL_ENTRIES))
    for (const name of ['dialect-jest', 'dialect-vitest'])
      assert.ok(isAddOn(readManifest(join(ROOT, 'packages', name))), name)
    assert.ok(!isAddOn(readManifest(join(ROOT, 'packages', 'provino'))))
  })

  test('inPackage and isInternalEntry', () => {
    assert.ok(inPackage('@provino/dialect-jest', '@provino/dialect-jest'))
    assert.ok(inPackage('@provino/dialect-jest/node', '@provino/dialect-jest'))
    assert.ok(!inPackage('@provino/dialect-jester', '@provino/dialect-jest'))
    assert.ok(isInternalEntry('./internal/jest-runtime') && isInternalEntry('internal/types'))
    assert.ok(!isInternalEntry('./node') && !isInternalEntry('worker/internal'))
  })

  test('an engine specifier maps to its internal subpath; its own and a third party stay', () => {
    assert.equal(
      internalTarget('@provino/mock', '@provino/dialect-jest'),
      'provino/internal/jest-runtime',
    )
    assert.equal(
      internalTarget('@provino/resolver', '@provino/dialect-jest'),
      'provino/internal/resolver',
    )
    assert.equal(
      internalTarget('@provino/dialect-jest/results', '@provino/dialect-jest'),
      undefined,
    )
    assert.equal(internalTarget('pretty-format', '@provino/dialect-jest'), undefined)
    // The Vitest add-on's table is its own.
    assert.equal(
      internalTarget('@provino/config', '@provino/dialect-vitest'),
      'provino/internal/config',
    )
    assert.throws(
      () => internalTarget('@provino/config', '@provino/dialect-jest'),
      /does not export to it/,
    )
    assert.throws(
      () => internalTarget('@provino/loader', '@provino/dialect-jest'),
      /@provino\/loader/,
    )
  })

  test('rewriteResolveCalls rewrites every literal form, a wrapped call included, and fails on one it cannot read', () => {
    const rewrite = (specifier: string) =>
      specifier === '@provino/expect'
        ? 'import.meta.resolve("provino/internal/jest-runtime")'
        : undefined
    for (const call of [
      "import.meta.resolve('@provino/expect')",
      'import.meta.resolve("@provino/expect")',
      'import.meta.resolve(`@provino/expect`)',
      // Biome's wrapped form: one argument per line, a trailing comma.
      'import.meta.resolve(\n  "@provino/expect",\n)',
    ]) {
      assert.equal(
        rewriteResolveCalls(`const a = ${call}`, 'a.ts', rewrite),
        'const a = import.meta.resolve("provino/internal/jest-runtime")',
        call,
      )
    }
    assert.equal(rewriteResolveCalls("import.meta.resolve('vitest')", 'a.ts', rewrite), undefined)
    for (const call of [
      'import.meta.resolve(name)',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the text of a call, not a template
      'import.meta.resolve(`@provino/${name}`)',
      "import.meta.resolve('@provino/' + name)",
    ]) {
      assert.throws(
        () => rewriteResolveCalls(call, 'a.ts', rewrite),
        /needs a string literal/,
        call,
      )
    }
    // A comment that mentions a call, and a message's empty call, are not calls.
    assert.equal(
      rewriteResolveCalls('// import.meta.resolve(name)\nimport.meta.resolve()', 'a.ts', rewrite),
      undefined,
    )
  })
})
