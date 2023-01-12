---
"@soundxyz/fine-grained-cache": patch
---

Fix Redis get timeout re-uses promise for calls within the same event cycle
