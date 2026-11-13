---
"provino": minor
"@provino/dialect-jest": minor
"@provino/dialect-vitest": minor
"@provino/types": minor
---

`provino jest` runs the project's `globalSetup` and `globalTeardown` in the coordinator, as Jest does: once per distinct path, project by project, with `(globalConfig, projectConfig)`, through the project's transform (a TypeScript file, or one babel-jest or ts-jest handles). A hook that throws ends the run with Jest's text and exit code. `OrchestratorPolicy.globalSetup` gains `teardownOrder` and `failureMessage`, `NeutralProject` gains `globalSetupArgs`, and each file now sends one `deps` event with the modules it loaded.
