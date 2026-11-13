// Which reporters a Jest run has, in which order: `TestScheduler._setupReporters` (jest-core
// 30.5.2 `TestScheduler.ts` L382-L431) step for step, as data. The composition root turns a step
// into a reporter (a built-in of `@provino/reporters`, or `loadJestReporters`' module).

/**
 * One reporter of the run.
 * @public
 */
export type JestReporterStep =
  | {
      readonly kind: 'builtin'
      readonly name: 'default' | 'verbose' | 'agent' | 'github-actions'
      readonly options: Readonly<Record<string, unknown>>
    }
  | {
      readonly kind: 'custom'
      /** The module path the config reader resolved. */
      readonly path: string
      readonly options: Readonly<Record<string, unknown>>
    }

/**
 * The reporters of a run, in the order they are added, and the options of the summary reporter
 * that comes last (`undefined`: none, because no `default`, `agent` or `summary` was named).
 * @public
 */
export interface JestReporterPlan {
  readonly steps: readonly JestReporterStep[]
  readonly summary: { readonly options: Readonly<Record<string, unknown>> } | undefined
}

/**
 * What the plan reads of the environment: Jest's `detectAgent()` and its `GITHUB_ACTIONS`.
 * @public
 */
export interface JestReporterEnvironment {
  readonly agent: boolean
  readonly githubActions: boolean
}

/**
 * The plan for a run. `globalConfig.reporters` is what the config reader produced (`undefined` when
 * the config and the command line name none). With none, Jest runs `agent` under an agent and
 * `default` otherwise; Provino also adds `github-actions` on GitHub Actions (D88, DV59), where Jest
 * adds it only when it is named. `default` is the verbose reporter when the global config or any
 * project is verbose.
 * @public
 */
export function jestReporterPlan(
  globalConfig: {
    readonly reporters:
      | readonly (readonly [string, Readonly<Record<string, unknown>>])[]
      | undefined
    readonly verbose?: boolean | undefined
  },
  projectConfigs: readonly { readonly verbose?: boolean | undefined }[],
  environment: JestReporterEnvironment,
): JestReporterPlan {
  const verbose =
    globalConfig.verbose === true || projectConfigs.some((config) => config.verbose === true)
  const implicit = globalConfig.reporters === undefined
  const named = globalConfig.reporters ?? [[environment.agent ? 'agent' : 'default', {}] as const]
  const steps: JestReporterStep[] = []
  let summary: JestReporterPlan['summary']
  for (const [name, options] of named) {
    switch (name) {
      case 'agent':
        summary = { options }
        steps.push({ kind: 'builtin', name: 'agent', options })
        break
      case 'default':
        summary = { options }
        steps.push({ kind: 'builtin', name: verbose ? 'verbose' : 'default', options })
        break
      case 'github-actions':
        // Jest adds it only on GitHub Actions.
        if (environment.githubActions) steps.push({ kind: 'builtin', name, options })
        break
      case 'summary':
        summary = { options }
        break
      default:
        steps.push({ kind: 'custom', path: name, options })
    }
  }
  if (implicit && environment.githubActions) {
    steps.push({ kind: 'builtin', name: 'github-actions', options: {} })
  }
  return { steps, summary }
}
