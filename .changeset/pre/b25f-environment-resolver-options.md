---
"@provino/types": patch
---

`EnvironmentRef` and `NeutralProject.environment` take an optional `resolverOptions`: what a dialect's environment resolver reads of the project's environment config beside the environment's own options. The Vitest dialect puts the whole `environmentOptions` there, so a docblock environment with no options gets it, as in Vitest.
