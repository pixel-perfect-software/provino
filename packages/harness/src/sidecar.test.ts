import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HarnessError } from './errors.ts'
import { attachConsole, consoleLines, startConversion } from './internal/convert.ts'
import { parseSidecar, type SidecarEntry } from './sidecar.ts'
import { convertOptions, makeFile, makeTest, ROOT } from './test-support.ts'

function invalid(line: number): (error: unknown) => boolean {
  return (error) =>
    error instanceof HarnessError &&
    error.code === 'HARNESS_SIDECAR_INVALID' &&
    error.message.startsWith(`side.jsonl:${line}:`)
}

test('parseSidecar reads one entry per line and skips blank lines', () => {
  const text = [
    '{"file":"/w/a.test.ts","stream":"stdout","level":"log","text":"hi"}',
    '',
    '{"file":"/w/a.test.ts","test":{"path":["d","t"],"dupIndex":1},"stream":"stderr","text":"x\\n"}',
    '{"stream":"stdout","text":"nowhere"}',
    '',
  ].join('\n')
  assert.deepEqual(parseSidecar(text, 'side.jsonl'), [
    { file: '/w/a.test.ts', stream: 'stdout', level: 'log', text: 'hi' },
    {
      file: '/w/a.test.ts',
      test: { path: ['d', 't'], dupIndex: 1 },
      stream: 'stderr',
      text: 'x\n',
    },
    { stream: 'stdout', text: 'nowhere' },
  ])
  assert.deepEqual(parseSidecar('', 'side.jsonl'), [])
})

test('parseSidecar names the line of the first bad entry', () => {
  const good = '{"stream":"stdout","text":"ok"}'
  for (const [bad, what] of [
    ['not json', 'not JSON'],
    ['[1]', 'an object'],
    ['{"stream":"stdin","text":"x"}', 'stream'],
    ['{"stream":"stdout"}', 'text'],
    ['{"stream":"stdout","text":"x","file":3}', 'file'],
    ['{"stream":"stdout","text":"x","level":false}', 'level'],
    ['{"stream":"stdout","text":"x","test":{"path":"a","dupIndex":0}}', 'test'],
    ['{"stream":"stdout","text":"x","test":{"path":["a"],"dupIndex":-1}}', 'test'],
    ['{"stream":"stdout","text":"x","test":{"path":["a"],"dupIndex":0.5}}', 'test'],
  ] as const) {
    assert.throws(() => parseSidecar(`${good}\n${bad}`, 'side.jsonl'), invalid(2), what)
  }
})

test('consoleLines splits on newlines; a trailing newline ends the last line', () => {
  assert.deepEqual(consoleLines('a'), ['a'])
  assert.deepEqual(consoleLines('a\n'), ['a'])
  assert.deepEqual(consoleLines('a\nb\n'), ['a', 'b'])
  assert.deepEqual(consoleLines('a\n\n'), ['a', ''])
  assert.deepEqual(consoleLines(''), [''])
  assert.deepEqual(consoleLines('\n'), [''])
})

function attach(entries: readonly SidecarEntry[], fired?: Set<string>) {
  const files = [
    makeFile('a.test.ts', [
      makeTest('a.test.ts', ['d', 'same']),
      makeTest('a.test.ts', ['d', 'same'], { dupIndex: 1 }),
    ]),
    makeFile('b.test.ts', [makeTest('b.test.ts', ['solo'])]),
  ]
  return attachConsole(
    files,
    startConversion(
      convertOptions({ console: entries, ...(fired === undefined ? {} : { fired }) }),
    ),
  )
}

test('attachConsole puts lines on the named test, else on the file, in sidecar order', () => {
  const [a, b] = attach([
    { file: `${ROOT}/a.test.ts`, stream: 'stdout', level: 'log', text: 'file one' },
    {
      file: `${ROOT}/a.test.ts`,
      test: { path: ['d', 'same'], dupIndex: 1 },
      stream: 'stderr',
      text: 'x\ny\n',
    },
    {
      file: `${ROOT}/a.test.ts`,
      test: { path: ['d', 'same'], dupIndex: 0 },
      stream: 'stdout',
      text: 'z\n',
    },
    { file: `${ROOT}/a.test.ts`, stream: 'stdout', level: 'log', text: 'file two' },
    // A test the JSON doesn't list goes to its file.
    {
      file: `${ROOT}/a.test.ts`,
      test: { path: ['d', 'gone'], dupIndex: 0 },
      stream: 'stdout',
      text: 'w\n',
    },
  ])
  assert.deepEqual(a?.console, [
    { stream: 'stdout', text: 'file one', level: 'log' },
    { stream: 'stdout', text: 'file two', level: 'log' },
    { stream: 'stdout', text: 'w' },
  ])
  assert.deepEqual(a?.tests[0]?.console, [{ stream: 'stdout', text: 'z' }])
  assert.deepEqual(a?.tests[1]?.console, [
    { stream: 'stderr', text: 'x' },
    { stream: 'stderr', text: 'y' },
  ])
  assert.equal(
    b !== undefined && 'console' in b,
    false,
    'a file that printed nothing has no console',
  )
  assert.equal(b?.tests[0] !== undefined && 'console' in b.tests[0], false)
})

test('attachConsole normalizes each line and drops what has nowhere to go', () => {
  const fired = new Set<string>()
  const [a] = attach(
    [
      { file: `${ROOT}/a.test.ts`, stream: 'stdout', text: `wrote ${ROOT}/out.txt (12 ms)\n` },
      { file: `${ROOT}/elsewhere.test.ts`, stream: 'stdout', text: 'not in the run' },
      { stream: 'stdout', text: 'no file at all' },
    ],
    fired,
  )
  assert.deepEqual(a?.console, [{ stream: 'stdout', text: 'wrote <root>/out.txt (<dur>)' }])
  assert.deepEqual([...fired].toSorted(), ['durations', 'root'])
})

test('without ConvertOptions.console the files are unchanged', () => {
  const files = [makeFile('a.test.ts', [makeTest('a.test.ts', ['t'])])]
  assert.deepEqual(attachConsole(files, startConversion(convertOptions())), files)
})
