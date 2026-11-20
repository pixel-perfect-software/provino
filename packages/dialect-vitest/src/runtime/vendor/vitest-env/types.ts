// Provino's stand-ins for what the two vendored setups import (see UPSTREAM.md, patch 2).

/** Vitest's `Environment` (`packages/vitest/src/types/environment.ts`), the members the setups use. */
export interface Environment {
  name: string
  viteEnvironment?: string
  transformMode?: string
  setupVM?(options: Record<string, any>): unknown
  setup?(global: any, options: Record<string, any>): Promise<EnvironmentReturn> | EnvironmentReturn
}

/** What `setup` returns, plus the populated keys' read watch (patch 4). */
export interface EnvironmentReturn {
  teardown(global: any): Promise<void> | void
  /** The populated globals, for the worker's read watch (D127). Not upstream's. */
  populated?: unknown
}

/** `populateGlobal`'s result, as `@provino/env-shared` gives it. */
export interface Populated {
  readonly keys: ReadonlySet<string>
  readonly originals: ReadonlyMap<string | symbol, PropertyDescriptor>
}

/** What the setups are given in place of their imports (patch 2). */
export interface SetupDeps {
  /** `@provino/env-shared`'s `populateGlobal` (Vitest 5.0.5's semantics). */
  readonly populateGlobal: (
    global: any,
    win: any,
    options?: { bindFunctions?: boolean; additionalKeys?: readonly string[] },
  ) => Populated
  /** `jsdom-keys.ts`'s `KEYS`, `@provino/env-shared`'s copy. */
  readonly KEYS: readonly string[]
  /** Imports the project's own copy of the environment's library. */
  readonly load: (name: string) => Promise<any>
}
