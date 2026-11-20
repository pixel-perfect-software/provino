// Type tests for the Vitest command line (`@provino/dialect-vitest/node`) and the results entry
// (`@provino/dialect-vitest/results`), B25g.
import {
  parseVitestArgv,
  parseVitestCli,
  type VitestArgv,
  type VitestCliError,
  type VitestCliErrorCode,
  vitestArgvToRunRequest,
  vitestCli,
  vitestNodeDialect,
} from '@provino/dialect-vitest/node'
import {
  createVitestResults,
  type VitestJsonResults,
  type VitestResults,
} from '@provino/dialect-vitest/results'
import type { CliDialect, Diagnostic, Reporter, RunRequest } from '@provino/types'
import { expectTypeOf } from 'expect-type'

expectTypeOf(vitestCli).toEqualTypeOf<CliDialect<VitestArgv>>()
expectTypeOf(vitestNodeDialect.cli).toEqualTypeOf<CliDialect | undefined>()
expectTypeOf(parseVitestArgv(['run'])).toEqualTypeOf<VitestArgv>()
expectTypeOf(parseVitestCli([]).diagnostics).toEqualTypeOf<Diagnostic[]>()
expectTypeOf(vitestArgvToRunRequest(parseVitestArgv([]))).toEqualTypeOf<RunRequest>()
expectTypeOf<VitestCliError['code']>().toEqualTypeOf<VitestCliErrorCode>()
expectTypeOf<VitestArgv['command']>().toExtend<string>()

// @ts-expect-error: the arguments are a list, not one string
parseVitestArgv('run -t x')
// @ts-expect-error: the argv is read-only
parseVitestArgv([]).options = {}
// @ts-expect-error: not a command Vitest has
const command: VitestArgv['command'] = 'typecheck'
void command

const results = createVitestResults({
  roots: ['/'],
  passWithNoTests: false,
  includeTaskLocation: true,
})
expectTypeOf(results).toEqualTypeOf<VitestResults>()
expectTypeOf(results.reporter).toEqualTypeOf<Reporter>()
expectTypeOf(results.json()).toEqualTypeOf<VitestJsonResults>()
expectTypeOf(results.json().testResults[0]?.status).toEqualTypeOf<'failed' | 'passed' | undefined>()

// @ts-expect-error: roots is required
createVitestResults({ passWithNoTests: false, includeTaskLocation: false })
