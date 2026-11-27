---
"provino": patch
"@provino/mock": patch
"@provino/types": patch
---

A mocked or spied overloaded function now takes one implementation, typed as its last overload, in `mockImplementation`, `mockImplementationOnce` and `withImplementation`. A `.each` table of several literal rows no longer rejects a callback that reads only the first columns.
