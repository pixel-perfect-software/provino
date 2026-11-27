// A native project's jsdom has the browser APIs jsdom lacks (matchMedia, scrollIntoView, animate,
// ResizeObserver, a client rect for a rendered element) unless `environmentOptions` turn them off.
// Through the source bin, on one pool.
import { describe, expect, test } from 'provino'
import { nativeProject, nativeRunArgs, outcomesByFile, spawnCli } from './support.ts'

const APIS = [
  "import { expect, it } from 'provino'",
  "it('has the APIs a component calls', () => {",
  "  const el = document.createElement('div')",
  '  document.body.append(el)',
  '  expect({',
  '    matchMedia: typeof window.matchMedia,',
  '    scrollIntoView: typeof el.scrollIntoView,',
  '    animate: typeof el.animate,',
  '    ResizeObserver: typeof globalThis.ResizeObserver,',
  '    clientRects: el.getClientRects().length,',
  "  }).toEqual({ matchMedia: 'function', scrollIntoView: 'function', animate: 'function', ResizeObserver: 'function', clientRects: 1 })",
  '})',
  "it('a hidden element has no box', () => {",
  "  const el = document.createElement('div')",
  '  el.hidden = true',
  '  document.body.append(el)',
  '  expect(el.getClientRects().length).toBe(0)',
  '})',
  '',
].join('\n')

const NONE = [
  "import { expect, it } from 'provino'",
  "it('has none of them', () => {",
  "  expect(typeof window.matchMedia).toBe('undefined')",
  "  expect(typeof globalThis.ResizeObserver).toBe('undefined')",
  '})',
  '',
].join('\n')

function config(options: string): string {
  return `export default { include: ['tests/**/*.test.ts'], environment: 'jsdom'${options} }\n`
}

describe('the native jsdom environment', () => {
  test('has the stand-ins by default', async () => {
    const dir = await nativeProject({ 'tests/apis.test.ts': APIS }, config(''))
    const ran = await spawnCli(nativeRunArgs('forks'), { cwd: dir })
    expect((await outcomesByFile(dir)).get('apis.test.ts')).toBe('passed,passed')
    expect(ran.code).toBe(0)
  })

  test('has none with environmentOptions: { standIns: false }', async () => {
    const dir = await nativeProject(
      { 'tests/none.test.ts': NONE },
      config(', environmentOptions: { standIns: false }'),
    )
    const ran = await spawnCli(nativeRunArgs('forks'), { cwd: dir })
    expect((await outcomesByFile(dir)).get('none.test.ts')).toBe('passed')
    expect(ran.code).toBe(0)
  })
})
