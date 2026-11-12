// T8.5's smoke, run in a child process (the adapter populates the process's own global, which a
// test runner's must not lose): set a Jest environment package up through the adapter, make the
// three observations the smoke test reads, tear it down, and print them as JSON.
//   node --conditions=provino-source environment-smoke.ts <entry path> [<testEnvironmentOptions JSON>]
import { jestEnvironment } from '../jest-environment.ts'

const [entry, optionsJson] = process.argv.slice(2)
if (entry === undefined) throw new Error('usage: environment-smoke.ts <entry> [options]')

const global = globalThis as Record<string, unknown>
const options = {
  module: entry,
  projectConfig: {
    rootDir: process.cwd(),
    cwd: process.cwd(),
    testEnvironment: entry,
    testEnvironmentOptions: optionsJson === undefined ? {} : JSON.parse(optionsJson),
    globals: { __SMOKE__: 1 },
    fakeTimers: {},
  },
}

const prepared = await jestEnvironment.prepare?.(options)
for (const key of Reflect.ownKeys(globalThis)) Object.getOwnPropertyDescriptor(globalThis, key)
const before = new Set(Reflect.ownKeys(globalThis))
const instance = await jestEnvironment.setup(
  {
    options,
    realm: 'worker',
    scope: 'file',
    testPath: `${process.cwd()}/smoke.test.js`,
    pragmas: {},
    console,
    signal: new AbortController().signal,
  },
  prepared,
)

const document = global.document as
  | {
      createElement(tag: string): { textContent: string; id: string }
      body: { appendChild(node: unknown): void }
      getElementById(id: string): { textContent: string } | null
    }
  | undefined
let dom: string | null = null
if (document !== undefined) {
  const node = document.createElement('div')
  node.id = 'smoke'
  node.textContent = 'hello'
  document.body.appendChild(node)
  dom = document.getElementById('smoke')?.textContent ?? null
}
const observed = {
  document: typeof global.document,
  dom,
  windowIsGlobal: global.window === globalThis,
  smokeGlobal: global.__SMOKE__ ?? null,
  edgeRuntime: typeof global.EdgeRuntime,
  instanceGlobalIsWorker: instance.global === globalThis,
}
const report = await instance.teardown()
const after = Reflect.ownKeys(globalThis)
const leaked = after.filter((key) => !before.has(key)).map(String)
const missing = [...before].filter((key) => !after.includes(key)).map(String)

process.stdout.write(
  `${JSON.stringify({ observed, report: report ?? null, leaked, missing, documentAfter: typeof global.document })}\n`,
)
