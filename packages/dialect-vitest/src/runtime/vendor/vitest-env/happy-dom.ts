import type { Environment, SetupDeps } from './types.ts'

async function teardownWindow(win: {
  happyDOM: { abort?: () => Promise<void>; cancelAsync: () => void }
  close?: () => void
}) {
  if (win.close && win.happyDOM.abort) {
    await win.happyDOM.abort()
    win.close()
  } else {
    win.happyDOM.cancelAsync()
  }
}

// provino: a factory over the deps the module imported upstream (patch 2); `setupVM` left out (patch 3).
export function happyDomEnvironment({ populateGlobal, load }: SetupDeps): Environment {
  return {
    name: 'happy-dom',
    viteEnvironment: 'client',
    async setup(global, { happyDOM = {} }) {
      // happy-dom v3 introduced a breaking change to Window, but
      // provides GlobalWindow as a way to use previous behaviour
      const { Window, GlobalWindow } = await load('happy-dom') // provino: the project's copy
      const win = new (GlobalWindow || Window)({
        ...happyDOM,
        console: console && global.console ? global.console : undefined,
        url: happyDOM.url || 'http://localhost:3000',
        settings: {
          ...happyDOM.settings,
          disableErrorCapturing: true,
        },
      })

      const populated = populateGlobal(global, win, {
        bindFunctions: true,
        // jsdom doesn't support fetch API, but happy-dom does
        additionalKeys: [
          'Request',
          'Response',
          'MessagePort',
          'fetch',
          'Headers',
          'AbortController',
          'AbortSignal',
          'URL',
          'URLSearchParams',
          'FormData',
        ],
      })
      const { keys, originals } = populated

      return {
        populated, // provino: patch 4
        async teardown(global) {
          await teardownWindow(win)
          keys.forEach((key) => delete global[key])
          originals.forEach((d, k) => Object.defineProperty(global, k, d))
        },
      }
    },
  }
}
