---
"@moonshot-ai/kimi-code": minor
---

Show cumulative token usage and the most recent step's TPS on the left side of the footer status line, e.g. `47.0 tok/s · ↓12k ↑2k · ↻9k +1k · hit 90%`. Cache hit percentage uses `cacheRead / (inputOther + cacheRead + cacheCreation)`. The display progressively drops the lowest-priority segments when the terminal is too narrow, and hides entirely when there is no data or no room.