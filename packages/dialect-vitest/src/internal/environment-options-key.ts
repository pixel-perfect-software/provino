// The one rule for which key of `environmentOptions` an environment reads, shared by the config
// reader (`/node`) and the environments (`/runtime`).

/**
 * The key of `environmentOptions` the environment `name` reads: `happyDOM` for `happy-dom`, else
 * the name itself (`jsdom`, `edge-runtime`, a custom one). Vitest 5.0.5's
 * `getSpecificationDocblock` (`packages/vitest/src/utils/test-helpers.ts` L49).
 * @internal
 */
export function environmentOptionsKey(name: string): string {
  return name === 'happy-dom' ? 'happyDOM' : name
}
