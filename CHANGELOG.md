# @soundxyz/fine-grained-cache

## 2.3.1

### Patch Changes

- c4904ea: Fix Redis get timeout re-uses promise for calls within the same event cycle

## 2.3.0

### Minor Changes

- 9741c97: New "setCache" function returned alongside "getCached"

## 2.2.1

### Patch Changes

- a617e8b: Improve JSON parse error handling

## 2.2.0

### Minor Changes

- c4d22cc: logEvents.events accepts custom log functions for specific events

### Patch Changes

- fb9397b: Fix "pipelineRedisSET: false"
- c4d22cc: logEvents.log is now optional (console.log default fallback)

## 2.1.1

### Patch Changes

- 662d8d1: Fix pipelined set

## 2.1.0

### Minor Changes

- 4f7b2b9: New "awaitRedisSet" option to allow skipping awaiting the Redis set on getCached logic execution

  Default value is `process.env.NODE_ENV === "test"`

- 4f7b2b9: New "pipelineRedisSET" option to pipeline redis SETs

## 2.0.1

### Patch Changes

- 82887cf: Never log empty param string, fallback to "null"

## 2.0.0

### Major Changes

- 2171c16: Minimum Node.js version is v16

### Minor Changes

- 2171c16: New "pipelineRedisGET" option to enable the usage of Redis pipelines to batch Redis GETs
- 2171c16: New "GETRedisTimeout" option to set a maximum amount of milliseconds for getCached to wait for the GET redis response
- 2171c16: New "logEvents" option to enable observability of events
- 2171c16: New "defaultUseMemoryCache" option to be able to customize default memory-cache usage in "getCached"

## 1.1.0

### Minor Changes

- 44af92c: setTTL and getTTL to manage ttl dynamically

## 1.0.1

### Patch Changes

- d6e4cda: Add "redlock"."useByDefault" option to `FineGrainedCache`

## 1.0.0

### Major Changes

- 622bf89: Release v1
