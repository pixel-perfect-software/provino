// Vitest's sidecar reporter (Track 12 T12.4). Loaded by absolute path (`--reporter=<path>`), so it
// imports Node builtins and harness files that do the same, never a package: see
// `internal/sidecar-format.ts`.
import type { UserConsoleLog } from 'vitest'
import type { Reporter } from 'vitest/node'
import { pathText } from '../internal/keys.ts'
import { openSidecar, type SidecarEntry, type SidecarOptions } from '../internal/sidecar-format.ts'

// The parts of Vitest's reported tasks (`TestCase`, `TestSuite`, `TestModule`) the reporter reads,
// written out so a test can hand it plain objects and Vitest's own classes still fit.
interface ReportedModule {
  readonly type: 'module'
  readonly id: string
  readonly moduleId: string
  readonly children: { allTests(): Iterable<ReportedTest> }
}
interface ReportedSuite {
  readonly type: 'suite'
  readonly name: string
  readonly module: ReportedModule
  readonly parent: ReportedSuite | ReportedModule
}
interface ReportedTest {
  readonly type: 'test'
  readonly id: string
  readonly name: string
  readonly module: ReportedModule
  readonly parent: ReportedSuite | ReportedModule
}

/**
 * What the reporter needs of the `Vitest` instance `onInit` receives: the lookup from a log's
 * `taskId` to the test, suite or module it ran in.
 * @public
 */
export interface ReportedEntities {
  readonly state: {
    getReportedEntityById(id: string): ReportedTest | ReportedSuite | ReportedModule | undefined
  }
}

/** A test's title path: its suites' names from the outside in, then its own. */
function titlePath(test: ReportedTest): string[] {
  const path = [test.name]
  for (let parent = test.parent; parent.type === 'suite'; parent = parent.parent) {
    path.unshift(parent.name)
  }
  return path
}

/**
 * Writes Vitest's captured console output to the sidecar file, one entry per write Vitest reports.
 * A write during a test (its each-hooks included) names the test: its title path and its index
 * among tests with the same path in its file, counted in declaration order as the converters
 * count. A write in a `beforeAll`, an `afterAll` or a module's top level names only the file.
 * Vitest merges adjacent writes to one stream into one report, keeps each stream's order but not
 * the order across streams, and gives no console method, so an entry has no `level` and may hold
 * several lines.
 * @public
 */
export default class VitestSidecarReporter implements Reporter {
  readonly #write: (entries: readonly SidecarEntry[]) => void
  #entities: ReportedEntities | undefined
  /** Each test's identity, filled once per module the first time one of its tests writes. */
  readonly #identities = new Map<string, { path: string[]; dupIndex: number }>()
  readonly #indexedModules = new Set<string>()

  /** Vitest passes the options of a `['<path>', options]` entry. */
  constructor(options?: SidecarOptions) {
    this.#write = openSidecar(options)
  }

  onInit(vitest: ReportedEntities): void {
    this.#entities = vitest
  }

  onUserConsoleLog(log: UserConsoleLog): void {
    const entity =
      log.taskId === undefined ? undefined : this.#entities?.state.getReportedEntityById(log.taskId)
    this.#write([{ ...this.#placeOf(entity), stream: log.type, text: log.content }])
  }

  #placeOf(
    entity: ReportedTest | ReportedSuite | ReportedModule | undefined,
  ): Pick<SidecarEntry, 'file' | 'test'> {
    if (entity === undefined) return {}
    if (entity.type === 'module') return { file: entity.moduleId }
    if (entity.type === 'suite') return { file: entity.module.moduleId }
    return { file: entity.module.moduleId, test: this.#identityOf(entity) }
  }

  #identityOf(test: ReportedTest): { path: string[]; dupIndex: number } {
    const { module } = test
    if (!this.#indexedModules.has(module.id)) {
      this.#indexedModules.add(module.id)
      const seen = new Map<string, number>()
      for (const each of module.children.allTests()) {
        const path = titlePath(each)
        // The converters' own key, so the reporter and the converter count alike by construction.
        const key = pathText(path)
        const dupIndex = seen.get(key) ?? 0
        seen.set(key, dupIndex + 1)
        this.#identities.set(each.id, { path, dupIndex })
      }
    }
    return this.#identities.get(test.id) ?? { path: titlePath(test), dupIndex: 0 }
  }
}
