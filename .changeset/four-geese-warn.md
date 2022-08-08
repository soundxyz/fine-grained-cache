---
"@soundxyz/fine-grained-cache": minor
---

New "awaitRedisSet" option to allow skipping awaiting the Redis set on getCached logic execution

Default value is `process.env.NODE_ENV === "test"`
