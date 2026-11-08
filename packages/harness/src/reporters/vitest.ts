// Vitest's sidecar reporter (Track 12 T12.4). Loaded by absolute path (`--reporter=<path>`), so it
// imports Node builtins and harness files that do the same, never a package: see
// `internal/sidecar-format.ts`.
import type { UserConsoleLog } from 'vitest'
import type { Reporter, TestCase, TestModule, TestSuite, Vitest } from 'vitest/node'
import { openSidecar, type SidecarEntry, type SidecarOptions } from '../internal/sidecar-format.ts'

type Entity = TestCase | TestSuite | TestModule

/** A test's title path: its suites' names from the outside in, then its own. */
function titlePath(test: TestCase): string[] {
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
 * Vitest merges adjacent writes to one stream into one report and gives no console method, so an
 * entry has no `level` and may hold several lines.
 * @public
 */
export default class VitestSidecarReporter implements Reporter {
  readonly #write: (entry: SidecarEntry) => void
  #vitest: Vitest | undefined
  /** Each test's identity, filled once per module the first time one of its tests writes. */
  readonly #identities = new Map<string, { path: string[]; dupIndex: number }>()
  readonly #indexedModules = new Set<string>()

  /** Vitest passes the options of a `['<path>', options]` entry. */
  constructor(options?: SidecarOptions) {
    this.#write = openSidecar(options)
  }

  onInit(vitest: Vitest): void {
    this.#vitest = vitest
  }

  onUserConsoleLog(log: UserConsoleLog): void {
    const entity: Entity | undefined =
      log.taskId === undefined ? undefined : this.#vitest?.state.getReportedEntityById(log.taskId)
    this.#write({ ...this.#placeOf(entity), stream: log.type, text: log.content })
  }

  #placeOf(entity: Entity | undefined): Pick<SidecarEntry, 'file' | 'test'> {
    if (entity === undefined) return {}
    if (entity.type === 'module') return { file: entity.moduleId }
    if (entity.type === 'suite') return { file: entity.module.moduleId }
    return { file: entity.module.moduleId, test: this.#identityOf(entity) }
  }

  #identityOf(test: TestCase): { path: string[]; dupIndex: number } {
    const module = test.module
    if (!this.#indexedModules.has(module.id)) {
      this.#indexedModules.add(module.id)
      const seen = new Map<string, number>()
      for (const each of module.children.allTests()) {
        const path = titlePath(each)
        // JSON keeps each title whole, so two different paths never share a key.
        const key = JSON.stringify(path)
        const dupIndex = seen.get(key) ?? 0
        seen.set(key, dupIndex + 1)
        this.#identities.set(each.id, { path, dupIndex })
      }
    }
    return this.#identities.get(test.id) ?? { path: titlePath(test), dupIndex: 0 }
  }
}
