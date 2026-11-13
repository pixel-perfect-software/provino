// Which attempt a test context belongs to (`LazyHost.runOf`). The executor records one handle per
// attempt, on a context it has just built, and `runOf` reads it back for any object a user hands
// over. A `WeakMap` did this first; one entry per attempt cost about 0.2 µs a test in `bench:core`
// (T5.14), most of it in the GC's ephemeron work. A class's private field holds the handle instead:
// it lives and dies with the context, no reflection sees it (`Reflect.ownKeys`, `Object.keys`, a
// spread), and `#run in value` is the lookup. Each registry is a new class, so it has its own
// private name, and one runtime never reads another's handles, as with one `WeakMap` per runtime.
import type { TestRunHandle } from '@provino/types'

/** Associates attempts' handles with their test contexts. */
export interface RunRegistry {
  /** Records `run` as the attempt `ctx` belongs to. `ctx` must be extensible (the executor's are). */
  set(ctx: object, run: TestRunHandle): void
  /** The attempt `ctx` belongs to, or `undefined` for an object this registry never saw. */
  get(ctx: object): TestRunHandle | undefined
}

/** A constructor that returns the object it is given, so a subclass can add a field to it. */
class Returns {
  constructor(target: object) {
    // biome-ignore lint/correctness/noConstructorReturn: the subclass stamps its field on `target`
    return target
  }
}

/** A new registry, with a private name of its own. */
export function createRunRegistry(): RunRegistry {
  class Stamp extends Returns {
    readonly #run: TestRunHandle

    constructor(target: object, run: TestRunHandle) {
      super(target)
      this.#run = run
    }

    static read(target: object): TestRunHandle | undefined {
      // `in` throws on a primitive; `WeakMap.get` answered `undefined`, and so does this.
      if ((typeof target !== 'object' || target === null) && typeof target !== 'function') {
        return undefined
      }
      return #run in target ? (target as Stamp).#run : undefined
    }
  }
  return {
    set(ctx: object, run: TestRunHandle): void {
      new Stamp(ctx, run)
    },
    get(ctx: object): TestRunHandle | undefined {
      return Stamp.read(ctx)
    },
  }
}
