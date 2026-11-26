import { BUILT_IN_REPORTERS } from './reporter-names.ts'

/**
 * The text `provino --help` prints, and a usage error prints after its message.
 * @internal
 */
export const USAGE: string = `Usage: provino <command> [options]

Commands:
  jest     Run a Jest project with Jest's command line: provino jest [--config <file>] [patterns]
  vitest   Run a Vitest project (not available yet)
  run      Run a project from a provino config file: provino run [options] [pattern…]

A pattern is a regular expression, tried case-insensitively on each test file's path (from the
project root, and the absolute path): the files that match any pattern run, as Jest's path
patterns do. provino run math src/a.test.ts runs the files whose path holds either. A word that
is not a command is a pattern for the bare form below.

With no command, provino [options] [pattern…] walks up from this directory to the nearest one that holds a
config of any kind and runs it: a provino.config.* (which wins within one directory), else a Jest
config, else a Vitest config; the walk stops at a directory with .git or pnpm-workspace.yaml.
provino run takes a provino.config.* only, and says so when the nearest config is another kind.
--dialect jest|vitest names the runner and skips the search. A config that names no dialect runs
Provino's own policy and loads no Jest or Vitest code. provino jest takes Jest's own flags; one
Provino can't run yet is refused by name.

Options of provino run:
  -c, --config <file>               The config file (default: the provino.config.* found from the
                                    working directory upward)
      --maxWorkers <n>              Run at most n workers (default: the cores, less one)
      --pool <kind>                 forks, threads or inline (default: the dialect's); inline
                                    runs in this process, so a leaked handle keeps it alive
      --reporter <name>             One of the reporters below; repeat for several. With none,
                                    provino on an interactive terminal, else default: agent under
                                    an AI agent (CLAUDECODE, AI_AGENT, ...), and github-actions is
                                    added on GitHub Actions
      --outputFile <path>           Write the json or junit reporter's document here (one of them);
                                    with html alone, the page's path (else html writes
                                    provino-report.html in the project root, never to stdout)
  -t, --testNamePattern <pattern>   Run only the tests whose full name matches
  -u, --updateSnapshot              Rewrite the snapshots that differ (default: write new ones)
      --ci                          Treat this as a CI run (default: from the CI variable)
      --coverage                    Collect code coverage and write the reports the config's coverage
                                    key names (default: the text table and lcov.info in coverage/);
                                    the key also sets the provider, the files that count and the
                                    thresholds. Not with --watch
      --passWithNoTests             Pass when no test files are found, and for a file with no test
      --no-cache                    Neither read nor write the results cache or the transform cache
      --bail[=n]                    End the run once n tests have failed (default 1; 0 is off)
      --forceExit                   Exit the process when the run is over, whatever a test left open
      --detectOpenHandles           Report what is still open after the run, and where it was made;
                                    runs in this process, and slows every timer and socket
      --workerMemoryLimit <n>       Replace a worker that holds more than n bytes after a file (512MB
                                    is 512,000,000, 512MiB is 2^29); 0 replaces it after every file
      --maxFilesPerWorker <n>       Replace a worker after it has run n files
      --fileTimeout <ms>            Kill a worker that runs one file longer than this, and fail it
      --shard <i>/<n>               Run only shard i of n of the test files (1-based). With a timings
                                    file the shards are cut by predicted time; without one, by the
                                    dialect's split (Jest's under provino jest)
      --timings <file>              The timings file --shard cuts by (default: provino.timings.json
                                    in the project root)
      --update-timings              After the run, write each file that ran, with its time, into the
                                    timings file (provino jest takes this and --timings too). Not
                                    with --shard: refresh it on an unsharded run
      --no-emoji                    The provino reporter draws plain symbols, not emoji (also
                                    PROVINO_EMOJI=0; provino jest takes it too)
      --tree                        After the run, print the files folder by folder: a passing file
                                    is one row, a file with a failure opens to its failed tests.
                                    With no reporter named it chooses provino; beside others it is
                                    an error (provino jest takes it too)
      --map                         After the end card, print one cell per file, a row per folder
                                    (the same rules as --tree)
      --watch                       Run, then rerun the test files a change reaches (every file for
                                    a change to a package.json, provino.config.* or tsconfig).
                                    On a terminal: a runs all, f runs the failed, Enter reruns the
                                    last, q quits (Ctrl+C too); off a terminal it reruns on change
                                    with no keys. Not with --coverage, --shard,
                                    --detectOpenHandles, --timings, --update-timings or
                                    --forceExit
      --watchAll                    As --watch, and every file reruns on any change
  -h, --help                        Print this text
      --version                     Print the version of provino

Reporters: ${BUILT_IN_REPORTERS.join(', ')} (normalized-json is the same as json; html is a
static, self-contained page with the files, the status map, time by folder and a timeline).

Colour follows the terminal, FORCE_COLOR and NO_COLOR. On a terminal that is not CI, not an agent's
and not dumb, a run that names no reporter gets provino, Provino's own live output; anywhere else it
gets default, Jest's text.

Ctrl+C (SIGINT) ends the run: no file starts, the running ones are killed, exit code 130. A second
Ctrl+C kills every worker at once. SIGTERM and SIGHUP do the same and exit 143 and 129.
`
