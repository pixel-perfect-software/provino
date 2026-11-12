// `--selectProjects` and `--ignoreProjects` (D69), as `jest-core` 30.5.2 does them: a multi-project
// run's projects are kept or dropped by `displayName` (`getConfigsOfProjectsToRun`), a project with
// no name is never selected and never ignored, and Jest says so before it runs
// (`getProjectNamesMissingWarning`, `getSelectProjectsMessage`). The texts are Jest's, without the
// colours (`chalk` is off when the output isn't a terminal, and `provino jest` doesn't colour yet).
import type { FileFilter, NeutralProject } from '@provino/types'

/** The two flags' values, each absent when the flag wasn't given. */
export interface ProjectSelection {
  readonly select: readonly string[] | undefined
  readonly ignore: readonly string[] | undefined
}

/** `argv.selectProjects` and `argv.ignoreProjects` as a selection; `undefined` when neither was given. */
export function selectionFromArgv(
  argv: Readonly<Record<string, unknown>>,
): ProjectSelection | undefined {
  const names = (value: unknown): readonly string[] | undefined => {
    if (value === undefined || value === false) return undefined
    return (Array.isArray(value) ? value : [value]).map(String)
  }
  const select = names(argv.selectProjects)
  const ignore = names(argv.ignoreProjects)
  return select === undefined && ignore === undefined ? undefined : { select, ignore }
}

/** A project's `displayName`, or `undefined` when it has none (an empty name is none). */
function nameOf(project: NeutralProject): string | undefined {
  return project.name === '' ? undefined : project.name
}

/**
 * The projects the selection keeps: with `select`, only those whose name is listed; with `ignore`,
 * none whose name is listed. A project without a name fails `select` and passes `ignore`.
 */
export function chooseProjects(
  projects: readonly NeutralProject[],
  selection: ProjectSelection,
): readonly NeutralProject[] {
  return projects.filter((project) => {
    const name = nameOf(project)
    const selected =
      selection.select === undefined || (name !== undefined && selection.select.includes(name))
    const kept =
      selection.ignore === undefined || !(name !== undefined && selection.ignore.includes(name))
    return selected && kept
  })
}

function flagsOf(selection: ProjectSelection): string[] {
  return [
    ...(selection.select === undefined ? [] : ['--selectProjects']),
    ...(selection.ignore === undefined ? [] : ['--ignoreProjects']),
  ]
}

/**
 * What Jest prints about a selection, before the run: the missing-names warning (about every
 * project of the config), then the list of the projects that will run, or why none will.
 */
export function selectionMessage(
  all: readonly NeutralProject[],
  chosen: readonly NeutralProject[],
  selection: ProjectSelection,
): string {
  let text = ''
  const unnamed = all.filter((project) => nameOf(project) === undefined).length
  if (unnamed > 0) {
    const subject =
      unnamed === 1 ? 'a project does not have a name' : `${unnamed} projects do not have a name`
    text += `You provided values for ${flagsOf(selection).join(' and ')} but ${subject}.\nSet displayName in the config of all projects in order to disable this warning.\n`
  }
  if (chosen.length === 0) {
    if (selection.select !== undefined && selection.ignore !== undefined) {
      return `${text}You provided values for --selectProjects and --ignoreProjects, but no projects were found matching the selection.\nAre you ignoring all the selected projects?\n`
    }
    if (selection.ignore !== undefined) {
      return `${text}You provided values for --ignoreProjects, but no projects were found matching the selection.\nAre you ignoring all projects?\n`
    }
    return `${text}You provided values for --selectProjects but no projects were found matching the selection.\n`
  }
  if (chosen.length === 1) {
    const [only] = chosen
    return `${text}Running one project: ${(only === undefined ? undefined : nameOf(only)) ?? '<unnamed project>'}\n`
  }
  const list = chosen
    .map((project) => `- ${nameOf(project) ?? '<unnamed project>'}`)
    .sort()
    .join('\n')
  return `${text}Running ${chosen.length} projects:\n${list}\n`
}

/**
 * `getNoTestFound` for a run with no project at all (`0 files checked across 0 projects`): what
 * Jest prints, to the run's output stream, when a selection leaves nothing to run.
 */
export function noProjectsMessage(options: {
  readonly rootDir: string
  readonly passWithNoTests: boolean
  readonly byPath: boolean
  readonly filters: readonly FileFilter[]
}): string {
  const { rootDir, passWithNoTests, byPath, filters } = options
  // `getNoTestFoundPassWithNoTests`: with `--passWithNoTests` it is the one line.
  if (passWithNoTests) return 'No tests found, exiting with code 0\n'
  const data = byPath
    ? `Files: ${filters.map((filter) => `"${filter.value}"`).join(', ')}`
    : `Pattern: ${filters.map((filter) => filter.value).join('|')} - 0 matches`
  const where = `In ${rootDir}\n  0 files checked across 0 projects. Run with \`--verbose\` for more details.\n${data}\n`
  return `No tests found, exiting with code 1\nRun with \`--passWithNoTests\` to exit with code 0\n${where}`
}
