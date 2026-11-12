// The window `setup` builds, from the jsdom the project installed. Kept apart from the environment
// so a test can build it with each jsdom of the peer range (`>=26 <31`).
import type { ConstructorOptions, JSDOM } from 'jsdom'
import type { JsdomEnvironmentOptions } from './environment.ts'

/** The classes of the project's jsdom that `prepare` keeps. */
export interface JsdomModule {
  readonly JSDOM: typeof import('jsdom').JSDOM
  readonly VirtualConsole: typeof import('jsdom').VirtualConsole
  /** jsdom 26 to 29 export it; 30 has no such class. */
  readonly ResourceLoader?: new (options?: {
    userAgent?: string
  }) => object
}

/** jsdom 26 to 29 name it `sendTo`; 30 names it `forwardTo`. */
type Forwarding = { forwardTo?: (to: Console) => unknown; sendTo?: (to: Console) => unknown }

function forwardConsole(virtualConsole: object, to: Console): void {
  const forwarding = virtualConsole as Forwarding
  if (typeof forwarding.forwardTo === 'function') forwarding.forwardTo(to)
  else forwarding.sendTo?.(to)
}

/**
 * Where a user agent goes, so it is set without turning subresource loading on (a page would fetch
 * its scripts and images):
 * - jsdom 26 to 29 take `resources`: a `ResourceLoader` carries the user agent, and a subclass whose
 *   `fetch` returns `null` loads nothing. (A plain object is refused there, and `'usable'` loads.)
 * - jsdom 30 has no `ResourceLoader`, and any `resources` value turns loading on
 *   (`loadSubresources: resources !== undefined`), so the user agent is defined on `navigator`
 *   after construction instead. XHR keeps jsdom's own user agent header.
 */
function userAgentOptions(
  jsdom: JsdomModule,
  userAgent: string,
): { constructor: ConstructorOptions; after?: (dom: JSDOM) => void } {
  const { ResourceLoader } = jsdom
  if (typeof ResourceLoader === 'function') {
    class NoFetch extends ResourceLoader {
      fetch(): null {
        return null
      }
    }
    return { constructor: { resources: new NoFetch({ userAgent }) as never } }
  }
  return {
    constructor: {},
    after(dom) {
      Object.defineProperty(dom.window.navigator, 'userAgent', {
        get: () => userAgent,
        configurable: true,
        enumerable: true,
      })
    },
  }
}

export function createDom(
  jsdom: JsdomModule,
  options: JsdomEnvironmentOptions,
  console: Console,
): JSDOM {
  const virtualConsole = new jsdom.VirtualConsole()
  forwardConsole(virtualConsole, console)
  const agent =
    options.userAgent === undefined ? undefined : userAgentOptions(jsdom, options.userAgent)
  const dom = new jsdom.JSDOM(options.html ?? '<!DOCTYPE html>', {
    pretendToBeVisual: options.pretendToBeVisual ?? true,
    runScripts: 'dangerously',
    url: options.url ?? 'http://localhost:3000',
    virtualConsole,
    ...agent?.constructor,
    // The user's own bag of `JSDOM` constructor options, free-form by design, goes last.
    ...(options.jsdom as ConstructorOptions | undefined),
  })
  agent?.after?.(dom)
  return dom
}
