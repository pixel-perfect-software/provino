// The Jest inline snapshot writer on its own (B23d B1): edits handed to it as the coordinator hands
// them, the source it leaves. The recorded goldens hold it to Jest 30.5.2 end to end
// (`packages/provino/test/jest-inline-snapshots.test.ts`); here, what a golden can't isolate: the
// errors, the escaping, no write when nothing changed, and Prettier 2's warning.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import type { InlineSnapshotEdit } from '@provino/types'
import { jestInlineSnapshotWriter } from './index.ts'

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'provino-inline-writer-'))
  after(() => rmSync(root, { recursive: true, force: true }))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

/** The edit for the n-th (0-based) `name(` in `text`, at its line and 0-based column. */
function at(
  file: string,
  text: string,
  name: string,
  snapshot: string,
  nth = 0,
): InlineSnapshotEdit {
  const lines = text.split('\n')
  let seen = 0
  for (const [index, line] of lines.entries()) {
    let from = 0
    for (;;) {
      const column = line.indexOf(`${name}(`, from)
      if (column === -1) break
      if (seen++ === nth) return { file, line: index + 1, column, snapshot }
      from = column + 1
    }
  }
  throw new Error(`no ${name} #${nth}`)
}

const write = jestInlineSnapshotWriter()

describe('jestInlineSnapshotWriter', () => {
  test('a new snapshot goes in as a template literal, escaped as Jest escapes it', async () => {
    const text = "test('t', () => {\n  expect(x).toMatchInlineSnapshot()\n})\n"
    const root = project({ 'a.test.ts': text })
    const file = join(root, 'a.test.ts')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the snapshot holds a `${` to escape
    await write([at(file, text, 'toMatchInlineSnapshot', '"a `b` ${c} \\\\"')], {
      rootDir: root,
      prettierPath: null,
    })
    assert.equal(
      readFileSync(file, 'utf8'),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the escaped `${` Jest writes
      'test(\'t\', () => {\n  expect(x).toMatchInlineSnapshot(`"a \\`b\\` \\${c} \\\\\\\\"`)\n})\n',
    )
  })

  test('a string literal argument is replaced by the template', async () => {
    const text = 'expect(1).toMatchInlineSnapshot(\'"old"\')\n'
    const root = project({ 'a.test.js': text })
    const file = join(root, 'a.test.js')
    await write([at(file, text, 'toMatchInlineSnapshot', '1')], {
      rootDir: root,
      prettierPath: null,
    })
    assert.equal(readFileSync(file, 'utf8'), 'expect(1).toMatchInlineSnapshot(`1`)\n')
  })

  test('two edits for one call are Jest`s error, and the file is left as it was', async () => {
    const text = 'expect(1).toMatchInlineSnapshot()\n'
    const root = project({ 'a.test.js': text })
    const file = join(root, 'a.test.js')
    const edit = at(file, text, 'toMatchInlineSnapshot', '1')
    await assert.rejects(
      write([edit, { ...edit, snapshot: '2' }], { rootDir: root, prettierPath: null }),
      /^Error: Jest: Multiple inline snapshots for the same call are not supported\.$/,
    )
    assert.equal(readFileSync(file, 'utf8'), text)
  })

  test('edits recorded out of source order (a helper defined above its callers) all land', async () => {
    // The helper's call is above `second`'s, but a run records it last: Jest substitutes in the
    // order it was handed the edits, so the earlier one shifts the later one's offsets and the
    // slices corrupt the file. The edits are applied from the end of the source instead.
    const text = [
      'const check = (value) => expect(value).toMatchInlineSnapshot()',
      "test('second', () => { expect(2).toMatchInlineSnapshot() })",
      "test('first', () => { check(1) })",
      '',
    ].join('\n')
    const root = project({ 'a.test.js': text })
    const file = join(root, 'a.test.js')
    await write(
      [
        at(file, text, 'toMatchInlineSnapshot', '2', 1),
        at(file, text, 'toMatchInlineSnapshot', '1', 0),
      ],
      { rootDir: root, prettierPath: null },
    )
    assert.equal(
      readFileSync(file, 'utf8'),
      [
        'const check = (value) => expect(value).toMatchInlineSnapshot(`1`)',
        "test('second', () => { expect(2).toMatchInlineSnapshot(`2`) })",
        "test('first', () => { check(1) })",
        '',
      ].join('\n'),
    )
  })

  test('an edit no call is at is Jest`s error', async () => {
    const text = 'expect(1).toMatchInlineSnapshot()\n'
    const root = project({ 'a.test.js': text })
    const file = join(root, 'a.test.js')
    await assert.rejects(
      write([{ file, line: 1, column: 3, snapshot: '1' }], { rootDir: root, prettierPath: null }),
      /Jest: Couldn't locate all inline snapshots\./,
    )
  })

  test('a source the edits leave as it was is not written again', async () => {
    const text = 'expect(1).toMatchInlineSnapshot(`1`)\n'
    const root = project({ 'a.test.js': text })
    const file = join(root, 'a.test.js')
    const before = statSync(file).mtimeMs
    await new Promise((resolve) => setTimeout(resolve, 20))
    await write([at(file, text, 'toMatchInlineSnapshot', '1')], {
      rootDir: root,
      prettierPath: null,
    })
    assert.equal(statSync(file).mtimeMs, before)
  })

  test('a prettierPath that is not installed writes unformatted, as Jest does', async () => {
    const text = "expect('x').toMatchInlineSnapshot()\n"
    const root = project({ 'a.test.js': text })
    const file = join(root, 'a.test.js')
    const warnings = await write([at(file, text, 'toMatchInlineSnapshot', '"x"')], {
      rootDir: root,
      prettierPath: join(root, 'node_modules', 'prettier', 'index.cjs'),
    })
    assert.deepEqual(warnings, [])
    assert.equal(readFileSync(file, 'utf8'), 'expect(\'x\').toMatchInlineSnapshot(`"x"`)\n')
  })

  test('Prettier 2 writes unformatted and warns (D113)', async () => {
    const text = "expect('x').toMatchInlineSnapshot()\n"
    const root = project({
      'a.test.js': text,
      'node_modules/prettier/package.json':
        '{ "name": "prettier", "version": "2.8.8", "main": "index.cjs" }\n',
      'node_modules/prettier/index.cjs':
        "exports.version = '2.8.8'\nexports.format = () => { throw new Error('not called') }\n",
    })
    const file = join(root, 'a.test.js')
    const warnings = await write([at(file, text, 'toMatchInlineSnapshot', '"x"')], {
      rootDir: root,
      prettierPath: join(root, 'node_modules', 'prettier', 'index.cjs'),
    })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /Prettier 3 only, and the project's Prettier is 2\.8\.8/)
    assert.equal(readFileSync(file, 'utf8'), 'expect(\'x\').toMatchInlineSnapshot(`"x"`)\n')
  })
})
