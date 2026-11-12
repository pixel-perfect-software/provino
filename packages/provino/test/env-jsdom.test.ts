// `@provino/env-jsdom` through `run()`: a `provino.config` project with `environment: 'jsdom'`
// (D44: a Jest-dialect project read by `provino jest` gets its own `jest-environment-jsdom`
// instead; this is the Provino-config path). Real forked workers, under the `registry` tier (the
// default for jsdom is `realm`, which waits for T2.8).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { run } from 'provino/node'
import { Collect, trackedProjects } from './support.ts'

const makeProject = trackedProjects()

const CONFIG = `export default {
  dialect: 'jest',
  environment: 'jsdom',
  isolation: 'registry',
  include: ['tests/**/*.test.js'],
}
`

describe('the jsdom environment through run()', () => {
  it('gives each file a fresh window and removes it afterwards', async () => {
    const project = await makeProject(
      {
        'tests/a.test.js': `test('a window is the global, and the file writes to it', () => {
  expect(window).toBe(globalThis)
  expect(document.defaultView).toBe(globalThis)
  expect(location.href).toBe('http://localhost:3000/')
  document.body.innerHTML = '<p id="mark">a</p>'
  globalThis.leakedByA = 1
  expect(document.getElementById('mark')?.textContent).toBe('a')
})
`,
        'tests/b.test.js': `test('the next file starts from a new document', () => {
  expect(document.getElementById('mark')).toBeNull()
  expect(document.body.innerHTML).toBe('')
  expect(typeof requestAnimationFrame).toBe('function')
})
`,
        'tests/c.test.js': `test('an error event nobody listens for fails the file', async () => {
  window.dispatchEvent(new ErrorEvent('error', { error: new Error('from the window'), cancelable: true }))
  await new Promise((resolve) => setTimeout(resolve, 10))
})
`,
      },
      CONFIG,
    )
    const stdout = new Collect()
    const stderr = new Collect()
    const ran = await run({ config: project.config, stdout, stderr, pool: 'forks' })

    const states = new Map(ran.summary?.files.map((file) => [file.file.path, file.state]))
    assert.equal(states.get('tests/a.test.js'), 'pass', stderr.text)
    assert.equal(states.get('tests/b.test.js'), 'pass', stderr.text)
    // The window's uncaught error is charged, so the run does not pass.
    assert.notEqual(ran.exitCode, 0)
    assert.match(stderr.text, /from the window/)
  })
})
