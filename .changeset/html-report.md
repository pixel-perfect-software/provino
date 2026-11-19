---
"provino": patch
"@provino/reporters": patch
---

`--reporter html` (and `reporters: ['html']`, or `['html', { outputFile }]`) writes a self-contained HTML report at the end of the run: a searchable test tree, a status map, time by folder and a per-worker timeline, in one file that loads and requests nothing. It goes to `--outputFile` when `html` is the only document reporter, else to `provino-report.html` in the project root, and never to stdout; `@provino/reporters/html` is its entry.
