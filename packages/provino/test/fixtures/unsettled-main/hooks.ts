// A resolve hook: the bin's import of its own `main` (`./internal/cli.ts`, from `src/cli.ts`)
// resolves to `main.ts` here instead. Nothing else is touched.
import type { ResolveHook } from 'node:module'

export const resolve: ResolveHook = (specifier, context, nextResolve) => {
  if (specifier === './internal/cli.ts' && context.parentURL?.endsWith('/src/cli.ts') === true) {
    return {
      url: new URL('./main.ts', import.meta.url).href,
      format: 'module-typescript',
      shortCircuit: true,
    }
  }
  return nextResolve(specifier, context)
}
