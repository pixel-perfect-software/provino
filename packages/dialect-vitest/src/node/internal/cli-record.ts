// Records real Vitest's answer to every line of the CLI corpus (`cli-corpus.ts`) into
// `__goldens__/cli-corpus.json`: `pnpm --filter @provino/dialect-vitest record:cli`. With `--check`
// it writes nothing and exits 1 when the committed recording differs from a fresh one.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import {
  CLI_GOLDEN_PATH,
  cliCorpus,
  corpusHash,
  installedVitestVersion,
  loadVitestNode,
  realOutcome,
  serializeCliGolden,
} from './cli-corpus.ts'

const check = process.argv.slice(2).includes('--check')
const vitestNode = await loadVitestNode()
const corpus = cliCorpus()
const text = serializeCliGolden({
  vitest: installedVitestVersion(),
  corpus: corpusHash(corpus),
  outcomes: corpus.map((args) => realOutcome(vitestNode, args)),
})
if (check) {
  if (!existsSync(CLI_GOLDEN_PATH) || readFileSync(CLI_GOLDEN_PATH, 'utf8') !== text) {
    console.error(
      `${CLI_GOLDEN_PATH} is stale: run \`pnpm --filter @provino/dialect-vitest record:cli\``,
    )
    process.exit(1)
  }
  console.log(`${corpus.length} lines agree with the recording`)
} else {
  writeFileSync(CLI_GOLDEN_PATH, text)
  console.log(`recorded ${corpus.length} lines`)
}
