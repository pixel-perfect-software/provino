---
'provino': patch
'@provino/config': patch
'@provino/env-jsdom': patch
'@provino/types': patch
---

A native project's jsdom has `matchMedia`, `scrollIntoView`, `animate`, `ResizeObserver` and a client rect for a displayed element, so a setup file no longer writes them. Turn them off with `environmentOptions: { standIns: false }`.
