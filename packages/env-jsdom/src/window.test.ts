// The `userAgent` option across the peer range: jsdom 26 (the bottom, `jsdom-26`) and 30. It must
// set `navigator.userAgent` and must not turn subresource loading on (a page would fetch scripts).
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, test } from 'node:test'
import * as jsdom30 from 'jsdom'
import * as jsdom26 from 'jsdom-26'
import { createDom, type JsdomModule } from './window.ts'

const versions: readonly (readonly [string, JsdomModule])[] = [
  ['jsdom 26.1.0', jsdom26 as unknown as JsdomModule],
  ['jsdom 30.x', jsdom30 as unknown as JsdomModule],
]

/** A server that counts the requests it gets. */
async function counting(): Promise<{ url: string; hits: () => number; close(): Promise<void> }> {
  let count = 0
  const server = createServer((_request, response) => {
    count++
    response.setHeader('content-type', 'text/javascript')
    response.end('window.loadedScript = true')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/script.js`,
    hits: () => count,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** Resolves when the window's `load` event has fired. */
function loaded(win: {
  addEventListener(type: 'load', listener: () => void): void
}): Promise<void> {
  return new Promise((resolve) => win.addEventListener('load', () => resolve()))
}

for (const [name, jsdom] of versions) {
  describe(name, () => {
    test('userAgent is set on navigator', () => {
      const dom = createDom(jsdom, { userAgent: 'provino-test' }, console)
      assert.equal(dom.window.navigator.userAgent, 'provino-test')
      dom.window.close()
    })

    test('the default user agent is jsdom`s own when none is given', () => {
      const dom = createDom(jsdom, {}, console)
      assert.match(dom.window.navigator.userAgent, /jsdom/)
      dom.window.close()
    })

    test('setting userAgent does not load subresources', async () => {
      const server = await counting()
      try {
        const html = `<!DOCTYPE html><script src="${server.url}"></script>`
        const dom = createDom(jsdom, { userAgent: 'provino-test', html }, console)
        await loaded(dom.window)
        assert.equal(server.hits(), 0, 'a page must not fetch its scripts')
        assert.equal((dom.window as unknown as { loadedScript?: boolean }).loadedScript, undefined)
        dom.window.close()
      } finally {
        await server.close()
      }
    })

    test('the control: jsdom with resources "usable" does load them', async () => {
      const server = await counting()
      try {
        const html = `<!DOCTYPE html><script src="${server.url}"></script>`
        const dom = new jsdom.JSDOM(html, { runScripts: 'dangerously', resources: 'usable' })
        await loaded(dom.window)
        assert.equal(server.hits(), 1)
        dom.window.close()
      } finally {
        await server.close()
      }
    })
  })
}
