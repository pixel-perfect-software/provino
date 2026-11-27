---
"provino": patch
"@provino/config": patch
"@provino/orchestrator": patch
---

Projects of a `provino.config.*` may share a root when their `include` globs select different files, so some files of one `src/` can run in node and others in jsdom. A run is refused (exit 2) only when a file would run in more than one project, and the message names the projects and the files.
