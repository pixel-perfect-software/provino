# Troubleshooting

- **A flag is refused.** Provino names the flag, and the run doesn't start. Drop the flag, or use Jest for that run. [Compatibility](compatibility.md#not-in-place-yet) lists every refused flag.
- **A config key is "read but not applied".** Provino reads it but can't act on it yet (`collectCoverage`, `reporters`, `snapshotResolver`). The run continues without it.
- **`provino` exits naming `@oxc-…/binding-…` packages.** Your install is missing Oxc's native package for this platform, usually after `--no-optional` or `--omit=optional`. Reinstall with optional dependencies.
- **A result differs from Jest's.** Run both on that one file, then [open an issue](https://github.com/pixel-perfect-software/provino/issues) with the test (or a minimal copy of it), both outputs, and the output of `provino jest --showConfig`.
- **Something looks stale after a config change.** Run `provino jest --clearCache`, or pass `--no-cache` for one run. The cache is in `node_modules/.cache/provino`, or under the config's `cacheDirectory` if it sets one.
- **The output looks different under an AI agent.** With no reporter named, Provino chooses the compact `agent` reporter (failures and totals) when it detects an agent (`CLAUDECODE`, `AI_AGENT`, …). Pass `--verbose`, or run outside the agent, to see Jest's text.
