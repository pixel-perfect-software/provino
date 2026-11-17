---
"provino": minor
"@provino/reporters": minor
---

`provino run` and `provino jest` gain `--tree` and `--map`, which print a folder tree of the run and a status map of every file in Provino's own output. With no reporter named they choose the `provino` reporter, and beside other named reporters they are a usage error.
