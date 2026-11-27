---
'provino': patch
'@provino/expect': patch
'@provino/policy': patch
'@provino/types': patch
---

A native project takes `expect(value, message)` and `expect.soft(value, message)`: the message is the first line of a failure, then a blank line, then the matcher's text with the measured values. A third argument is refused as "expect() takes a value and an optional message".
