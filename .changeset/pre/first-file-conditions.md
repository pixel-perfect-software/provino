---
'@provino/loader': patch
'provino': patch
---

The first test file to load a package with a `browser` build (Emotion under jsdom, through MUI) now gets the environment's build from that first load, as later files and Jest do, rather than Node's build alongside it.
