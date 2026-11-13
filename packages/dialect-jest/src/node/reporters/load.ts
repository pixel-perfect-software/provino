// Loading the custom reporters of a plan: `requireOrImportModule(path)` per module, as
// `TestScheduler._addCustomReporter` does (jest-core 30.5.2 L433-L451). The module is loaded
// before the run, so a missing or broken one ends the run before any file starts.
import { requireOrImportModule } from '../load.ts'
import { jestGitHubActionsReporter } from './github-actions.ts'
import type { JestLoadedReporter, JestReporterClass } from './host.ts'
import type { JestReporterPlan } from './plan.ts'

/**
 * The custom reporters of `plan` as loaded entries, in order, and Jest's `github-actions` reporter
 * where the plan has it (its class is `jestGitHubActionsReporter`). A module that can't be loaded throws
 * Jest's wrapped message: `An error occurred while adding the reporter at path "<path>".` and the
 * error's own text.
 * @public
 */
export async function loadJestReporters(plan: JestReporterPlan): Promise<JestLoadedReporter[]> {
  const entries: JestLoadedReporter[] = []
  for (const step of plan.steps) {
    if (step.kind === 'builtin') {
      // The one built-in Jest builds from a class of its own that Provino runs as one.
      if (step.name === 'github-actions') {
        // `silent: false` adds the result tree to the log (GitHubActionsReporter's `#getResultTree`
        // and `#printFullResult`); Provino does not build it, so say so instead of printing less.
        if (step.options.silent === false) {
          throw new Error(
            "The github-actions reporter option 'silent: false' is not supported yet: Provino does not print the result tree. Remove the option, or set 'silent: true'.",
          )
        }
        entries.push({
          path: 'github-actions',
          options: step.options,
          Class: jestGitHubActionsReporter,
        })
      }
      continue
    }
    try {
      const Class = (await requireOrImportModule(step.path)) as JestReporterClass
      entries.push({ path: step.path, options: step.options, Class })
    } catch (error) {
      // The module loader wraps what the module threw; Jest's `requireOrImportModule` doesn't.
      let cause: unknown = error
      while (cause instanceof Error && cause.cause instanceof Error) cause = cause.cause
      const message = cause instanceof Error ? cause.message : ''
      const wrapped = new Error(
        `An error occurred while adding the reporter at path "${step.path}".\n${message}`,
        { cause: error },
      )
      throw wrapped
    }
  }
  return entries
}
