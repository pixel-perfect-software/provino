// Parsing for the hoister. The input is the pipeline's stripped output, so it is JavaScript (JSX
// is accepted in case a `.jsx` file passed through untransformed). Raw transfer is about 3x
// faster than the JSON AST (Track 3 F4), so it is used wherever the platform has it.
import type { TransformDiagnostic } from '@provino/types'
import { type ParserOptions, parseSync, rawTransferSupported } from 'oxc-parser'
import { positionOf } from '../internal/position.ts'
import type { Program } from './ast.ts'
import { codeFrame } from './diagnostics.ts'

const RAW_TRANSFER = rawTransferSupported()

type Options = ParserOptions & { experimentalRawTransfer?: boolean }

const OPTIONS: Options = {
  lang: 'jsx',
  sourceType: 'unambiguous',
  preserveParens: false,
  ...(RAW_TRANSFER ? { experimentalRawTransfer: true } : {}),
}

export type ParseOutcome =
  | { readonly ok: true; readonly program: Program }
  | { readonly ok: false; readonly diagnostics: readonly TransformDiagnostic[] }

export function parseForHoist(filename: string, code: string): ParseOutcome {
  const result = parseSync(filename, code, OPTIONS)
  const errors = result.errors.filter((error) => String(error.severity) === 'Error')
  if (errors.length === 0) return { ok: true, program: result.program }
  return {
    ok: false,
    diagnostics: errors.map((error) => {
      const start = error.labels[0]?.start
      return {
        severity: 'error',
        code: 'PARSE_ERROR',
        message: error.message,
        ...(start === undefined
          ? {}
          : { loc: positionOf(code, start), codeFrame: error.codeframe ?? codeFrame(code, start) }),
      }
    }),
  }
}
