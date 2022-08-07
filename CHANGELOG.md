# @soundxyz/fine-grained-cache

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
