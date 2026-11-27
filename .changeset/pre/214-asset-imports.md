---
'provino': patch
'@provino/types': patch
'@provino/policy': patch
'@provino/config': patch
'@provino/loader': patch
'@provino/transform': patch
'@provino/dialect-vitest': patch
---

A native project can import an asset or a style file. `import logo from './logo.svg'` is the file's URL as a Vite dev server writes it (`/src/logo.svg`, or `/@fs/<path>` outside the project root), a `.css` or `.scss` import is an empty module, and a `*.module.css` import is an object that answers each name with itself. `?raw` imports the file's text and `?url` its URL. A `mock()` of the file still wins, so does a transform the project configures for it, and a dependency's own asset or stylesheet import works too. Projects on the Jest or Vitest dialect are unchanged.
