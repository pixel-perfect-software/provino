// Jest's global setup: describes `globalConfig.testPathPatterns` as the hook sees it.
module.exports = async function globalSetup(globalConfig: {
  testPathPatterns: {
    patterns: string[]
    isSet(): boolean
    isValid(): boolean
    toPretty(): string
    toJSON(): unknown
    toExecutor(options: { rootDir: string }): {
      isSet(): boolean
      isValid(): boolean
      isMatch(path: string): boolean
      toPretty(): string
      patterns: unknown
    }
  }
}): Promise<void> {
  const fs = process.getBuiltinModule('node:fs')
  const patterns = globalConfig.testPathPatterns
  const executor = patterns.toExecutor({ rootDir: '/proj' })
  const seen = {
    isArray: Array.isArray(patterns),
    className: patterns.constructor.name,
    ownKeys: Object.keys(patterns),
    patterns: patterns.patterns,
    isSet: patterns.isSet(),
    isValid: patterns.isValid(),
    pretty: patterns.toPretty(),
    json: patterns.toJSON(),
    executor: {
      className: executor.constructor.name,
      isSet: executor.isSet(),
      isValid: executor.isValid(),
      pretty: executor.toPretty(),
      matchesA: executor.isMatch('/proj/a.test.ts'),
      matchesB: executor.isMatch('/proj/b.test.ts'),
      matchesNested: executor.isMatch('/proj/src/b.test.ts'),
      matchesOther: executor.isMatch('/proj/c.test.ts'),
      samePatterns: executor.patterns === patterns,
    },
  }
  fs.writeFileSync('seen.txt', `${JSON.stringify(seen)}\n`)
}
