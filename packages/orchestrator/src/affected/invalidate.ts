// T9.12: the project's own inputs. A change to the config file, a setup file, a global setup or
// teardown, the environment module, the root `package.json`, a lockfile or the tsconfig can change
// what every file does. The policy's `affected.invalidateAll` says whether that selects the whole
// project (`project-inputs`) or nothing the graph doesn't reach (`none`, Jest's).
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ResolvedProject } from '@provino/config'

const LOCKFILES: readonly string[] = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
]

/** An environment's `module` is an absolute path or a `file:` URL. */
function pathOf(location: string): string {
  return location.startsWith('file:') ? fileURLToPath(location) : location
}

/**
 * The absolute paths whose change affects every file of the project. `extra` adds what the
 * caller knows (the config file's own path).
 * @internal
 */
export function projectInputs(
  project: Pick<ResolvedProject, 'rootDir' | 'globalSetup' | 'config'>,
  extra: readonly string[] = [],
): ReadonlySet<string> {
  const { rootDir, config } = project
  const inputs = new Set<string>(extra.map((path) => resolve(path)))
  for (const path of [
    ...config.setupFiles,
    ...config.setupFilesAfterEnv,
    ...(project.globalSetup?.setup ?? []),
    ...(project.globalSetup?.teardown ?? []),
  ]) {
    inputs.add(path)
  }
  inputs.add(pathOf(config.environment.module))
  inputs.add(join(rootDir, 'package.json'))
  for (const name of LOCKFILES) inputs.add(join(rootDir, name))
  inputs.add(join(rootDir, 'tsconfig.json'))
  const tsconfig = config.loader.tsconfig
  if (typeof tsconfig === 'string') inputs.add(resolve(rootDir, tsconfig))
  return inputs
}

/** Whether any of `changed` is one of the project's inputs. */
export function touchesInputs(changed: Iterable<string>, inputs: ReadonlySet<string>): boolean {
  for (const path of changed) if (inputs.has(path)) return true
  return false
}
