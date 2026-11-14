---
'provino': minor
'@provino/dialect-jest': minor
'@provino/types': minor
---

`provino jest` runs the third-party reporters real projects name (jest-junit, jest-silent-reporter, jest-html-reporters, vscode-jest's reporter, `testResultsProcessor: jest-sonar-reporter`) with Jest's text on 20 files. Jest's own `github-actions` reporter is the one `provino jest` runs, a console entry's call site renders through `jest-message-util` (a code frame for `warn` and `error`), `failureDetails[i]` has the `message`, `stack` and `name` a reporter reads, and a failing frame is named as Jest names it (`at Object.toBe`): `ModulePolicy.stackFrameNames`, and `jestConsoleTrace` in `@provino/dialect-jest/node`. The text reporters take a `consoleTrace` option.
