// The oracle both checks call: real jest-config 30.5.2's `readConfig`, and ours beside it. Each
// returns an encoded result or the error text, so the two sides compare the same way whether
// they ran in this process (`presets`) or in a child (`sample`).
import { stripVTControlCharacters } from 'node:util'
import { readJestConfig } from '@provino/dialect-jest/node'
import { type EncodedRead, encode } from './compare.ts'

/** One side's outcome: an encoded read, or the error it threw. */
export type ReadOutcome =
  | { readonly ok: true; readonly read: EncodedRead }
  | { readonly ok: false; readonly error: string; readonly code: string | null }

function failure(error: unknown): ReadOutcome {
  const message = error instanceof Error ? error.message : String(error)
  const code: unknown = error instanceof Error ? Reflect.get(error, 'code') : undefined
  return {
    ok: false,
    error: stripVTControlCharacters(message),
    code: typeof code === 'string' ? code : null,
  }
}

function encoded(value: { projectConfig: unknown; globalConfig: unknown }): ReadOutcome {
  return {
    ok: true,
    read: {
      projectConfig: encode(value.projectConfig) as Record<string, unknown>,
      globalConfig: encode(value.globalConfig) as Record<string, unknown>,
    },
  }
}

interface JestConfigModule {
  readConfig(
    argv: object,
    packageRootOrConfig: string,
  ): Promise<{ projectConfig: unknown; globalConfig: unknown }>
}

/** Real jest-config's `readConfig(argv, path)`, as `jest` run in the working directory calls it. */
export async function readWithJest(path: string): Promise<ReadOutcome> {
  try {
    const jestConfig = (await import('jest-config')) as unknown as JestConfigModule
    return encoded(await jestConfig.readConfig({ _: [], $0: 'jest' }, path))
  } catch (error) {
    return failure(error)
  }
}

/**
 * Ours, with its defaults: Jest's own packages come from the project's own Jest install, found
 * from its root, as they would for a user.
 */
export async function readWithProvino(path: string): Promise<ReadOutcome> {
  try {
    return encoded(await readJestConfig(path, { cwd: process.cwd() }))
  } catch (error) {
    return failure(error)
  }
}
