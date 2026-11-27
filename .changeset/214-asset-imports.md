---
'provino': patch
'@provino/types': patch
'@provino/policy': patch
'@provino/config': patch
'@provino/loader': patch
'@provino/dialect-vitest': patch
---

A native project can import an asset or a style file. `import logo from './logo.svg'` is the file's URL as a Vite dev server writes it (`/src/logo.svg`, or `/@fs/<path>` outside the project root), a `.css` or `.scss` import is an empty module, and a `*.module.css` import is an object that answers each name with itself. A `mock()` of the file still wins. Projects on the Jest or Vitest dialect are unchanged.
