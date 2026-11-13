# Vendored upstream: the Jenkins JUnit schema

| File here | Source | How |
|---|---|---|
| `junit-10.xsd` | the Jenkins xunit plugin (https://github.com/jenkinsci/xunit-plugin, MIT, © 2014 Gregory Boissinot), `src/main/resources/org/jenkinsci/plugins/xunit/types/model/xsd/junit-10.xsd` | copied unchanged, license header included; the schema `JUnitReporter`'s output is validated against |

- **Pinned** to commit `ae25da5089d4f94ac6c4669bf736e4d416cc4665` (2018-12-15, "[JENKINS-54228] xunit fails to validate XML surefire report of Maven Surefire Plugin since version 2.22.1": "Add version attribute to testsuite element"), the last commit that touched the file. The xunit plugin has no tags that name it; the file is the same on `master` today. The URL the copy came from: `https://raw.githubusercontent.com/jenkinsci/xunit-plugin/ae25da5089d4f94ac6c4669bf736e4d416cc4665/src/main/resources/org/jenkinsci/plugins/xunit/types/model/xsd/junit-10.xsd`. SHA-256 of the file: `a1a816f58d1bf95ebabf371994df0b9246dee66ea9572fbec4f9296f1b2c0ff6`.
- **Copied** on 2026-11-13 (B21c, T9.7), by download, not from a clone in `.refs/`: the repository is not one of Provino's upstreams (DECISIONS S3).
- **License:** the file's own header is the MIT license with the copyright line `Copyright (c) 2014, Gregory Boissinot`, and the plugin's `pom.xml` says "MIT license: All source code is under the MIT license" (the repository has no LICENSE file; GitHub reports none). The notice is in `THIRD_PARTY_NOTICES.md`.
- **Use:** only the reporter's test reads it: `xmllint --noout --schema junit-10.xsd <file>` (`/usr/bin/xmllint`, a system tool; no dependency). It is not part of the published package (`files` is `dist`).

## Local patches

None.
