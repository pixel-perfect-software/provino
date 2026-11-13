/**
 * The text `provino --help` prints, and a usage error prints after its message.
 * @internal
 */
export const USAGE = `Usage: provino <command> [options]

Commands:
  jest     Run a Jest project with Jest's command line: provino jest [--config <file>] [patterns]
  vitest   Run a Vitest project (not available yet)
  run      Run a project from a provino config file: provino run --config <file> [options]

With no command, provino [options] runs provino.config.* if this directory has one, else the Jest
config found from it; --dialect jest|vitest names the runner and skips that search. provino jest
takes Jest's own flags; one Provino can't run yet is refused by name, with the task that builds it.

Options of provino run:
  -c, --config <file>               The config file (required)
      --maxWorkers <n>              Run at most n workers (default: the cores, less one)
      --pool <kind>                 forks, threads or inline (default: the dialect's); inline
                                    runs in this process, so a leaked handle keeps it alive
      --reporter <name>             default, verbose, dot, agent, json, junit, github-actions or
                                    normalized-json (the same as json); repeat for several. With none,
                                    default: agent under an AI agent (CLAUDECODE, AI_AGENT, ...), and
                                    github-actions is added on GitHub Actions
      --outputFile <path>           Write the json or junit reporter's document here (one of them)
  -t, --testNamePattern <pattern>   Run only the tests whose full name matches
  -u, --updateSnapshot              Rewrite the snapshots that differ (default: write new ones)
      --ci                          Treat this as a CI run (default: from the CI variable)
      --passWithNoTests             Pass when no test files are found
      --no-cache                    Neither read nor write the results cache or the transform cache
      --bail[=n]                    End the run once n tests have failed (default 1; 0 is off)
      --forceExit                   Exit the process when the run is over, whatever a test left open
      --detectOpenHandles           Report what is still open after the run, and where it was made;
                                    runs in this process, and slows every timer and socket
      --workerMemoryLimit <n>       Replace a worker that holds more than n bytes after a file (512MB
                                    is 512,000,000, 512MiB is 2^29); 0 replaces it after every file
      --maxFilesPerWorker <n>       Replace a worker after it has run n files
      --fileTimeout <ms>            Kill a worker that runs one file longer than this, and fail it
  -h, --help                        Print this text
      --version                     Print the version of provino

Colour follows the terminal, FORCE_COLOR and NO_COLOR; the default reporter redraws the files that
are running on a terminal that is not CI.

Ctrl+C (SIGINT) ends the run: no file starts, the running ones are killed, exit code 130. A second
Ctrl+C kills every worker at once. SIGTERM and SIGHUP do the same and exit 143 and 129.
`
