---
"provino": patch
"@provino/policy": patch
---

A native project evaluates a `node_modules` package again in each later file of a worker when its first load read the file's window or test globals, or added or replaced a key of the global, as Jest does with its per-file registry. Before, every package Node loaded itself was shared by all the files of a worker, so `@testing-library/dom`, which builds `screen` over `document.body` as it loads, searched the first jsdom file's body from the second file on: every `screen` query failed while `within(document.body)` passed, and a React suite went red on a CI runner with fewer cores than the developer's machine. The same holds for a package that adds a key to the global as it loads (the environment's restore took it away after the first file). The first run learns which packages these are and remembers them for the next run. A package that reads and writes nothing per file stays shared by the worker.
