import type { Environment, SetupDeps } from './types.ts'

// provino: a factory over the deps the module imported upstream (patch 2); `setupVM` left out (patch 3).
export function edgeRuntimeEnvironment({ populateGlobal, KEYS, load }: SetupDeps): Environment {
  return {
    name: 'edge-runtime',
    viteEnvironment: 'ssr',
    async setup(global) {
      const { EdgeVM } = await load('@edge-runtime/vm') // provino: the project's copy
      const vm = new EdgeVM({
        extend: (context: any) => {
          context.global = context
          context.Buffer = Buffer
          KEYS.forEach((key) => {
            if (key in global) {
              context[key] = global[key]
            }
          })
          return context
        },
      })
      const populated = populateGlobal(global, vm.context, {
        bindFunctions: true,
      })
      const { keys, originals } = populated
      return {
        populated, // provino: patch 4
        teardown(global) {
          keys.forEach((key) => delete global[key])
          originals.forEach((d, k) => Object.defineProperty(global, k, d))
        },
      }
    },
  }
}
