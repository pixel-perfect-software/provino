---
"provino": patch
---

With Node's source maps on (`process.setSourceMapsEnabled(true)` or `--enable-source-maps`), a stack frame in a built file that names its own source map now points at the original source, as it does under plain Node.
