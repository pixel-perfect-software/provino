// What Jest 30 hands a global hook as `globalConfig.testPathPatterns` (T9.15): a `TestPathPatterns`
// (jest-pattern 30.5.2), not an array. A hook may call `isSet()`, `toPretty()` or `toExecutor()` on
// it. The reader builds this one object, with the same public members, where the hook runs (the
// coordinator, so it never crosses to a worker) and with no runtime dependency on jest-pattern.
// Recorded: `cli/global-setup-test-path-patterns` and `cli/global-setup-no-test-path-patterns`
// (class names, own keys, every member's answer).
import { isAbsolute, relative, sep } from 'node:path'
import { replacePathSepForRegex } from '../paths.ts'

/** What a `TestPathPatterns` executor needs: the directory a pattern is read relative to. */
interface ExecutorOptions {
  readonly rootDir: string
}

/** jest-pattern's `TestPathPatternsExecutor`: the patterns run against paths. */
class TestPathPatternsExecutor {
  readonly patterns: TestPathPatterns
  readonly options: ExecutorOptions

  constructor(patterns: TestPathPatterns, options: ExecutorOptions) {
    this.patterns = patterns
    this.options = options
  }

  isSet(): boolean {
    return this.patterns.isSet()
  }

  isValid(): boolean {
    try {
      for (const pattern of this.patterns.patterns) new RegExp(pattern, 'i')
      return true
    } catch {
      return false
    }
  }

  /** Whether the ABSOLUTE `path` matches the patterns; none set matches everything. */
  isMatch(path: string): boolean {
    const relativePath = relative(this.options.rootDir || '/', path)
    if (this.patterns.patterns.length === 0) return true
    for (const pattern of this.patterns.patterns) {
      const pathToTest = isAbsolute(pattern) ? path : relativePath
      // `./foo.spec.js` (and `.\foo.spec.js` on Windows) is `^foo.spec.js` once the root is stripped.
      let source = pattern.replace(/^\.\//, '^')
      if (sep === '\\') source = source.replace(/^\.\\/, '^')
      source = replacePathSepForRegex(source)
      if (new RegExp(source, 'i').test(pathToTest)) return true
      if (new RegExp(source, 'i').test(path)) return true
    }
    return false
  }

  toPretty(): string {
    return this.patterns.toPretty()
  }
}

/**
 * jest-pattern's `TestPathPatterns`: the command line's test path patterns.
 * @internal
 */
export class TestPathPatterns {
  readonly patterns: string[]

  constructor(patterns: string[]) {
    this.patterns = patterns
  }

  isSet(): boolean {
    return this.patterns.length > 0
  }

  isValid(): boolean {
    return this.toExecutor({ rootDir: '/' }).isValid()
  }

  /** A human-friendly version of the pattern regular expression. */
  toPretty(): string {
    return this.patterns.join('|')
  }

  toExecutor(options: ExecutorOptions): TestPathPatternsExecutor {
    return new TestPathPatternsExecutor(this, options)
  }

  /** For Jest's serializers. */
  toJSON(): { readonly patterns: string[]; readonly type: 'TestPathPatterns' } {
    return { patterns: this.patterns, type: 'TestPathPatterns' }
  }
}
