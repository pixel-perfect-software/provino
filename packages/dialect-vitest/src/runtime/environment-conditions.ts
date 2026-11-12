import type { EnvironmentConditions } from '@provino/types'

/**
 * The resolver export conditions of a Vitest environment (`orchestrator.environmentConditions`).
 * Vitest resolves a test file's imports on the server side whatever the environment, so under
 * `environment: 'jsdom'` a package's `browser` variant is not picked and its `node` one is
 * (recorded: `env/conditions-vitest-jsdom`, Vitest 5.0.5). An environment's own list wins.
 * @public
 */
export const vitestEnvironmentConditions: EnvironmentConditions = (env) =>
  env.conditions ?? ['node']
