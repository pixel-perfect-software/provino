import assert from 'node:assert/strict'
import { link, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { InlineSnapshotEdit } from '@provino/types'
import { afterAll, beforeAll, describe, test } from 'provino'
import { SnapshotError } from '../errors.ts'
import { nativeInlineSnapshotWriter } from './index.ts'

let dir = ''
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'provino-inline-writer-'))
})
afterAll(() => rm(dir, { recursive: true, force: true }))

/** What the writer is told of the project: nothing it reads. */
const options = { rootDir: '/', prettierPath: null }
let count = 0

/** A source file written into the temp dir, and the edit of the matcher named `name`'s `nth` call. */
async function source(text: string, extension = '.ts') {
  const file = path.join(dir, `case-${count++}${extension}`)
  await writeFile(file, text)
  const at = (name: string, snapshot: string, nth = 0): InlineSnapshotEdit => {
    let offset = -1
    for (let i = 0; i <= nth; i++) offset = text.indexOf(`.${name}(`, offset + 1)
    assert.ok(offset >= 0, `${name} #${nth} is in the source`)
    const before = text.slice(0, offset + 1).split(/\r\n?|\n/)
    return {
      file,
      line: before.length,
      column: (before.at(-1) ?? '').length,
      snapshot,
    }
  }
  return { file, at, read: () => readFile(file, 'utf8') }
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error) => error instanceof SnapshotError && error.code === code)
}

describe('nativeInlineSnapshotWriter', () => {
  const write = nativeInlineSnapshotWriter()

  test("writes into empty calls as Jest does without a formatter (snapshot/inline-written's golden)", async () => {
    const s = await source(
      "describe('writes inline', () => {\n  test('into the call', () => {\n    expect({ a: 1, list: [1, 2] }).toMatchInlineSnapshot()\n    expect('x').toMatchInlineSnapshot()\n  })\n})\n",
    )
    const warnings = await write(
      [
        s.at('toMatchInlineSnapshot', '\n{\n  "a": 1,\n  "list": [\n    1,\n    2,\n  ],\n}\n'),
        s.at('toMatchInlineSnapshot', '"x"', 1),
      ],
      options,
    )
    assert.deepEqual(warnings, [])
    assert.equal(
      await s.read(),
      'describe(\'writes inline\', () => {\n  test(\'into the call\', () => {\n    expect({ a: 1, list: [1, 2] }).toMatchInlineSnapshot(`\n{\n  "a": 1,\n  "list": [\n    1,\n    2,\n  ],\n}\n`)\n    expect(\'x\').toMatchInlineSnapshot(`"x"`)\n  })\n})\n',
    )
  })

  test('replaces the first template or string argument, and appends after a property matcher', async () => {
    const s = await source(
      [
        "expect('new').toMatchInlineSnapshot('\"old\"')",
        'expect(() => f()).toThrowErrorMatchingInlineSnapshot(`"before"`)',
        'expect({ id: 7 }).toMatchInlineSnapshot({ id: expect.any(Number) })',
        '',
      ].join('\n'),
    )
    await write(
      [
        s.at('toMatchInlineSnapshot', '"new"'),
        s.at('toThrowErrorMatchingInlineSnapshot', '"now"'),
        s.at('toMatchInlineSnapshot', '\n{\n  "id": Any<Number>,\n}\n', 1),
      ],
      options,
    )
    assert.equal(
      await s.read(),
      [
        'expect(\'new\').toMatchInlineSnapshot(`"new"`)',
        'expect(() => f()).toThrowErrorMatchingInlineSnapshot(`"now"`)',
        'expect({ id: 7 }).toMatchInlineSnapshot({ id: expect.any(Number) }, `\n{\n  "id": Any<Number>,\n}\n`)',
        '',
      ].join('\n'),
    )
  })

  test("escapes backticks, ${ and backslashes with Jest's escapeBacktickString", async () => {
    const s = await source('expect(v).toMatchInlineSnapshot()\n')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the snapshot must escape it
    await write([s.at('toMatchInlineSnapshot', '"a `b`, ${c} \\ d"')], options)
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the escaped form of it
    assert.equal(await s.read(), 'expect(v).toMatchInlineSnapshot(`"a \\`b\\`, \\${c} \\\\ d"`)\n')
  })

  test('two calls on one line, each by its own column', async () => {
    const s = await source(
      "const calls = [expect(1).toMatchInlineSnapshot(), expect('b').toMatchInlineSnapshot()]\n",
    )
    await write(
      [s.at('toMatchInlineSnapshot', '1'), s.at('toMatchInlineSnapshot', '"b"', 1)],
      options,
    )
    assert.equal(
      await s.read(),
      'const calls = [expect(1).toMatchInlineSnapshot(`1`), expect(\'b\').toMatchInlineSnapshot(`"b"`)]\n',
    )
  })

  test('columns count UTF-16 units, and CR LF, CR and the line separators end lines', async () => {
    const text =
      "const é = '日本'; expect(1).toMatchInlineSnapshot()\r\nx\ry\u{2028}expect(2).toMatchInlineSnapshot()\n"
    const s = await source(text)
    const second = s.at('toMatchInlineSnapshot', '2', 1)
    assert.equal(second.line, 3, 'the helper reads CR LF and CR only')
    await write(
      [s.at('toMatchInlineSnapshot', '1'), { ...second, line: 4, column: 'expect(2)'.length + 1 }],
      options,
    )
    assert.equal(
      await s.read(),
      "const é = '日本'; expect(1).toMatchInlineSnapshot(`1`)\r\nx\ry\u{2028}expect(2).toMatchInlineSnapshot(`2`)\n",
    )
  })

  test('parses JSX in a .tsx and in a .js file', async () => {
    const tsx = await source(
      'type P = { readonly a?: string }\nexpect(<div className="g">hi</div>).toMatchInlineSnapshot()\n',
      '.tsx',
    )
    const js = await source('expect(<span />).toMatchInlineSnapshot()\n', '.js')
    await write(
      [tsx.at('toMatchInlineSnapshot', 'A'), js.at('toMatchInlineSnapshot', 'B')],
      options,
    )
    assert.equal(
      await tsx.read(),
      'type P = { readonly a?: string }\nexpect(<div className="g">hi</div>).toMatchInlineSnapshot(`A`)\n',
    )
    assert.equal(await js.read(), 'expect(<span />).toMatchInlineSnapshot(`B`)\n')
  })

  test('a stack read at .resolves or .rejects (the neutral at-read check) finds its matcher call', async () => {
    const text =
      'await expect(p).resolves.toMatchInlineSnapshot()\nawait expect(q).rejects.toThrowErrorMatchingInlineSnapshot()\n'
    const s = await source(text)
    const resolves = s.at('toMatchInlineSnapshot', 'A')
    const rejects = s.at('toThrowErrorMatchingInlineSnapshot', 'B')
    // Where V8 puts a property read: the dot, here; any offset up to the name counts.
    await write(
      [
        { ...resolves, column: 'await expect(p)'.length },
        { ...rejects, column: 'await expect(q).'.length },
      ],
      options,
    )
    assert.equal(
      await s.read(),
      'await expect(p).resolves.toMatchInlineSnapshot(`A`)\nawait expect(q).rejects.toThrowErrorMatchingInlineSnapshot(`B`)\n',
    )
  })

  test('a call over several lines keeps its layout: only the template goes in', async () => {
    const text = 'expect(\n  { a: 1 },\n).toMatchInlineSnapshot(\n  // here\n)\n'
    const s = await source(text)
    await write([s.at('toMatchInlineSnapshot', '1')], options)
    assert.equal(
      await s.read(),
      'expect(\n  { a: 1 },\n).toMatchInlineSnapshot(\n  // here\n`1`)\n',
    )
  })

  test('two snapshots for one call fail, and the file is left as it was', async () => {
    const text = 'const check = (v) => {\n  expect(v).toMatchInlineSnapshot()\n}\n'
    const s = await source(text, '.js')
    const edit = s.at('toMatchInlineSnapshot', '1')
    await rejectsWith(
      write([edit, { ...edit, snapshot: '2' }], options),
      'SNAPSHOT_INLINE_SAME_CALL',
    )
    await rejectsWith(write([edit, edit], options), 'SNAPSHOT_INLINE_SAME_CALL')
    assert.equal(await s.read(), text)
  })

  test('an edit with no matcher call at its place, or a file that does not parse, fails by code', async () => {
    const s = await source('expect(1).toMatchInlineSnapshot()\n')
    await rejectsWith(
      write([{ ...s.at('toMatchInlineSnapshot', '1'), column: 0 }], options),
      'SNAPSHOT_INLINE_NOT_FOUND',
    )
    await rejectsWith(
      write([{ ...s.at('toMatchInlineSnapshot', '1'), line: 9 }], options),
      'SNAPSHOT_INLINE_NOT_FOUND',
    )
    const broken = await source('expect(1).toMatchInlineSnapshot(\n')
    await rejectsWith(
      write([broken.at('toMatchInlineSnapshot', '1')], options),
      'SNAPSHOT_INLINE_PARSE',
    )
  })

  test('a file whose text would not change is not written', async () => {
    const s = await source('expect(1).toMatchInlineSnapshot(`1`)\n')
    const before = (await stat(s.file)).mtimeMs
    await new Promise((resolve) => setTimeout(resolve, 20))
    await write([s.at('toMatchInlineSnapshot', '1')], options)
    assert.equal((await stat(s.file)).mtimeMs, before)
  })

  test('edits of two files in one call are each written; no edits is no work', async () => {
    const a = await source('expect(1).toMatchInlineSnapshot()\n')
    const b = await source('expect(2).toMatchInlineSnapshot()\n')
    await write([a.at('toMatchInlineSnapshot', '1'), b.at('toMatchInlineSnapshot', '2')], options)
    assert.equal(await a.read(), 'expect(1).toMatchInlineSnapshot(`1`)\n')
    assert.equal(await b.read(), 'expect(2).toMatchInlineSnapshot(`2`)\n')
    assert.deepEqual(await write([], options), [])
  })

  test('writes the file through a temp file and a rename, never truncating it in place', async () => {
    const text = "expect('x').toMatchInlineSnapshot()\n"
    const s = await source(text)
    // A second name for the file's old contents: a rewrite in place changes them too.
    const old = `${s.file}.old`
    await link(s.file, old)
    await write([s.at('toMatchInlineSnapshot', '"x"')], options)
    assert.equal(await s.read(), 'expect(\'x\').toMatchInlineSnapshot(`"x"`)\n')
    assert.equal(await readFile(old, 'utf8'), text)
    assert.deepEqual(
      (await readdir(dir)).filter((name) => name.endsWith('.tmp')),
      [],
      'no temp file is left',
    )
  })
})
