// `orchestrator.globalSetup.reviveArgs` for Jest (T9.15): what Jest's global hooks are called with
// that JSON can't carry. In Jest 30 `globalConfig.testPathPatterns` is a `TestPathPatterns`
// (jest-pattern 30.5.2), not an array: a hook may call `isSet()`, `toPretty()` or `toExecutor()` on
// it. The reader gives the patterns as an array of strings (it has to be JSON), and this rebuilds the
// object, with the same public members, in the coordinator where the hook runs, so it needs no
// runtime dependency on jest-pattern. Recorded: `cli/global-setup-test-path-patterns` and
// `cli/global-setup-no-test-path-patterns` (class names, own keys, every member's answer).
import { isAbsolute, relative, sep } from 'node:path'
import type { ReviveGlobalSetupArgs } from '@provino/types'

/** jest-regex-util 30.5.2's `replacePathSepForRegex`: a regular expression's `/` as this platform's separator. */
function replacePathSepForRegex(text: string): string {
  if (sep === '\\') {
    return text.replaceAll(
      /(\/|(.)?\\(?![$()*+.?[\\\]^{|}]))/g,
      (_match, _group: unknown, before: string | undefined) =>
        before !== undefined && before !== '' && before !== '\\' ? `${before}\\\\` : '\\\\',
    )
  }
  return text
}

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

/** jest-pattern's `TestPathPatterns`: the command line's test path patterns. */
class TestPathPatterns {
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

/**
 * The configs Jest's global hooks get: the reader's JSON, with `globalConfig.testPathPatterns`
 * made the `TestPathPatterns` object Jest 30 passes.
 * @public
 */
export const reviveGlobalSetupArgs: ReviveGlobalSetupArgs = ({ globalConfig, projectConfig }) => {
  const patterns = globalConfig.testPathPatterns
  return {
    globalConfig: {
      ...globalConfig,
      testPathPatterns: new TestPathPatterns(
        Array.isArray(patterns) ? patterns.map((pattern) => String(pattern)) : [],
      ),
    },
    projectConfig,
  }
}
