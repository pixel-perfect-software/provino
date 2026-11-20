// Vitest's sidecar reporter (Track 12 T12.4). Loaded by absolute path (`--reporter=<path>`), so it
// imports Node builtins and harness files that do the same, never a package: see
// `internal/sidecar-format.ts`.
import type { UserConsoleLog } from 'vitest'
import type { Reporter, TestCase, TestModule, TestSuite } from 'vitest/node'
import { openSidecar, type SidecarEntry, type SidecarOptions } from '../internal/sidecar-format.ts'
import { dupIndexer, titlePath } from '../internal/vitest-reported.ts'

/**
 * What the reporter needs of the `Vitest` instance `onInit` receives: the lookup from a log's
 * `taskId` to the test, suite or module it ran in.
 * @public
 */
export interface ReportedEntities {
  readonly state: {
    getReportedEntityById(id: string): TestCase | TestSuite | TestModule | undefined
  }
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
  readonly #dupIndexOf = dupIndexer()

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
    entity: TestCase | TestSuite | TestModule | undefined,
  ): Pick<SidecarEntry, 'file' | 'test'> {
    if (entity === undefined) return {}
    if (entity.type === 'module') return { file: entity.moduleId }
    if (entity.type === 'suite') return { file: entity.module.moduleId }
    return {
      file: entity.module.moduleId,
      test: { path: titlePath(entity), dupIndex: this.#dupIndexOf(entity) },
    }
  }
}
