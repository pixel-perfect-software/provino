---
"provino": minor
"@provino/dialect-jest": minor
---

`provino jest --watch` gains Jest 30.5.2's `u` key (a run that updates the failing snapshots), the `i` key's interactive failed-test and snapshot modes, and third-party `watchPlugins` (jest-watch-typeahead among them), which were refused: each plugin is loaded and built as Jest builds it, hears `onFileChange`, `shouldRunTestSuite` and `onTestRunComplete`, and a plugin that fails to load or takes a key another plugin or Jest holds ends watch mode before any run with Jest's text and exit 1.

`@provino/dialect-jest/node` gains the two interactive modes, the plugin host (`loadJestWatchPlugin`, `checkJestWatchPluginConflicts`, `JestWatchPluginError`), and `JestWatchHost.listTests` and `cwd`; `jestUpdateSnapshotsPlugin` takes no argument.
