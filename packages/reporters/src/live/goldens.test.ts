// The `provino` reporter's frames, pinned (B26 Phase 2): the fixture run through the reporter with
// the manual scheduler (a frame after each file ends) and a clock that moves 37 ms per event, as a
// plain stream and as a colour terminal, with the emoji and the fallback glyph sets, at 40 and 120
// columns; one footer state; the two end cards. `PROVINO_UPDATE_GOLDENS=1` writes them.
import { describe, test } from 'node:test'
import type { ReporterBus, ReporterEvents } from '@provino/types'
import { createReporterBus } from '../bus.ts'
import { expectGolden } from '../internal/golden.ts'
import {
  buildFile,
  error,
  FIXTURE_FILES,
  FIXTURE_SNAPSHOTS,
  playRun,
} from '../internal/test-support.ts'
import { createStyle } from '../style.ts'
import { provinoReporter } from './reporter.ts'
import { GLYPHS } from './terminal/glyphs.ts'
import { fakeClock, manualScheduler, recordingSink } from './test-support.ts'
import { endCardLines } from './view/end-card.ts'

/** The sources the code frames come from, keyed by file name; the fixture's own files don't exist on disk. */
const SOURCES: Readonly<Record<string, string>> = {
  'fails.test.ts': [
    "import { expect, test } from 'provino'",
    "test('fails', () => {",
    '  expect(compute()).toBe(2)',
    '})',
    '',
  ].join('\n'),
  'discount.ts': [
    'export function discount(cart: Cart): number {',
    '  const rules = cart.rules',
    '  return rules.percent * cart.subtotal',
    '}',
    '',
  ].join('\n'),
  'snapshot.test.ts': [
    "test('matches a stored snapshot', () => {",
    '  expect({ value: makeValue() }).toMatchSnapshot()',
    '})',
    '',
  ].join('\n'),
}

const readSource = (path: string): Promise<string | undefined> =>
  Promise.resolve(SOURCES[path.slice(path.lastIndexOf('/') + 1)])

/** Lets the code frames' reads settle. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const MODES = { plain: false, tty: true } as const
const SETS = { emoji: GLYPHS.emoji, fallback: GLYPHS.ascii } as const

function setup(options: {
  live: boolean
  colour: boolean
  columns: number
  glyphs: 'emoji' | 'fallback'
}) {
  const clock = fakeClock()
  const scheduler = manualScheduler(clock)
  const sink = recordingSink()
  const reporter = provinoReporter({
    stream: sink,
    live: options.live,
    colour: options.colour,
    columns: options.columns,
    glyphs: SETS[options.glyphs],
    hyperlinks: false,
    cwd: '/project',
    readSource,
    scheduler,
  })
  return { clock, scheduler, sink, reporter }
}

describe('the provino reporter on the fixture run', () => {
  for (const [mode, terminal] of Object.entries(MODES)) {
    for (const glyphs of ['emoji', 'fallback'] as const) {
      for (const columns of [40, 120]) {
        test(`${mode}, ${glyphs}, ${columns} columns`, async () => {
          const { clock, scheduler, sink, reporter } = setup({
            live: terminal,
            colour: terminal,
            columns,
            glyphs,
          })
          const bus = createReporterBus([reporter])
          const stepped: ReporterBus = {
            add: (each) => bus.add(each),
            async emit<K extends keyof ReporterEvents>(event: K, ...args: ReporterEvents[K]) {
              clock.advance(37)
              await bus.emit(event, ...args)
              if (event === 'file:end') {
                await settle()
                scheduler.tick()
              }
            },
          }
          await playRun(stepped, FIXTURE_FILES, { snapshots: FIXTURE_SNAPSHOTS, durationMs: 1234 })
          await expectGolden(`provino.${mode}.${glyphs}.${columns}`, sink.text())
        })
      }
    }
  }
})

describe('the footer with 16 busy workers, 3 over their expected time', () => {
  for (const glyphs of ['emoji', 'fallback'] as const) {
    for (const columns of [40, 120]) {
      test(`${glyphs}, ${columns} columns`, async () => {
        const { clock, scheduler, sink, reporter } = setup({
          live: true,
          colour: false,
          columns,
          glyphs,
        })
        const files = Array.from({ length: 20 }, (_, index) => ({
          ...buildFile({ path: `src/feature-${index}/module-${index}.test.ts` }).info,
          expectedMs: index < 3 ? 400 : 5000,
        }))
        await reporter['run:start']?.(
          { root: '/project', projects: [''], startTime: 0, watch: false, workers: 16 },
          files,
        )
        files.slice(0, 16).forEach((file, id) => {
          reporter['file:start']?.(file, id)
          clock.advance(10)
        })
        clock.advance(1500)
        scheduler.tick()
        await expectGolden(`provino-footer.${glyphs}.${columns}`, sink.text())
      })
    }
  }
})

describe('the end card', () => {
  const base = {
    reason: 'passed',
    passed: 4000,
    failed: 0,
    skipped: 0,
    todo: 0,
    filesDone: 1980,
    filesFailed: 0,
    durationMs: 12_400,
    slowest: [
      { path: 'src/a.test.ts', durationMs: 4200 },
      { path: 'src/b.test.ts', durationMs: 3900 },
      { path: 'src/c.test.ts', durationMs: 3100 },
    ],
    snapshots: undefined,
    openHandles: undefined,
    lateConsole: 0,
    failures: [],
    failuresMore: 0,
  } as const
  const plain = createStyle(false)

  test('pass', async () => {
    const text = endCardLines({ ...base, ok: true }, 120, GLYPHS.emoji, plain).join('\n')
    await expectGolden('provino-end.pass', `${text}\n`)
  })

  test('fail', async () => {
    const lines = endCardLines(
      {
        ...base,
        ok: false,
        reason: 'failed',
        passed: 3985,
        failed: 3,
        skipped: 12,
        filesFailed: 2,
        snapshots: { added: 0, matched: 8, unmatched: 1, updated: 0, unchecked: 2 },
        failures: [
          '  ❌ cart › total › applies the discount  src/cart/total.test.ts:41:22',
          '  ❌ cart › total › rounds  src/cart/total.test.ts:58:9',
          '  ❌ src/broken.test.ts',
        ],
        failuresMore: 0,
      },
      120,
      GLYPHS.emoji,
      plain,
    )
    await expectGolden('provino-end.fail', `${lines.join('\n')}\n`)
  })
})

describe('a failure thrown deep in source: the call chain under the code frame', () => {
  const stack = [
    'Error: cannot read the discount',
    '    at discount (/project/src/cart/discount.ts:3:22)',
    '    at total (/project/src/cart/total.ts:12:20)',
    '    at node:internal/process/task_queues:105:5',
    '    at Object.<anonymous> (/project/src/cart/total.test.ts:8:19)',
    '    at lib (/project/node_modules/lib/index.js:1:1)',
    '    at step1 (/project/src/steps.ts:1:1)',
    '    at step2 (/project/src/steps.ts:2:1)',
    '    at step3 (/project/src/steps.ts:3:1)',
    '    at step4 (/project/src/steps.ts:4:1)',
  ].join('\n')
  const spec = {
    path: 'src/cart/total.test.ts',
    tests: [
      {
        path: ['cart', 'total', 'applies the discount'],
        state: 'fail' as const,
        errors: [error('cannot read the discount', { stack })],
      },
    ],
  }
  for (const [mode, terminal] of Object.entries(MODES)) {
    test(mode, async () => {
      const { clock, scheduler, sink, reporter } = setup({
        live: terminal,
        colour: terminal,
        columns: 100,
        glyphs: 'emoji',
      })
      const bus = createReporterBus([reporter])
      const stepped: ReporterBus = {
        add: (each) => bus.add(each),
        async emit<K extends keyof ReporterEvents>(event: K, ...args: ReporterEvents[K]) {
          clock.advance(37)
          await bus.emit(event, ...args)
          if (event === 'file:end') {
            await settle()
            scheduler.tick()
          }
        },
      }
      await playRun(stepped, [spec], { durationMs: 900 })
      await expectGolden(`provino-stack.${mode}`, sink.text())
    })
  }
})
