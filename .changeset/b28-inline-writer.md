---
'provino': patch
---

A project with no dialect writes inline snapshots: `toMatchInlineSnapshot()` and `toThrowErrorMatchingInlineSnapshot()` with nothing in them (or with `-u`, a snapshot that differs) put the value into the test file as a template literal, escaped and at column 0 as Jest writes it without Prettier. Only the template changes; the rest of the call keeps its layout. Two snapshots for one call (a helper called twice) fail the test file, as in Jest.
