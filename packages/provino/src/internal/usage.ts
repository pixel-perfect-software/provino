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
      --reporter <name>             default or normalized-json; repeat for several
      --outputFile <path>           Write the normalized-json reporter's JSON here
  -t, --testNamePattern <pattern>   Run only the tests whose full name matches
  -u, --updateSnapshot              Rewrite the snapshots that differ (default: write new ones)
      --ci                          Treat this as a CI run (default: from the CI variable)
      --passWithNoTests             Pass when no test files are found
      --no-cache                    Neither read nor write the results cache or the transform cache
  -h, --help                        Print this text
      --version                     Print the version of provino
`
