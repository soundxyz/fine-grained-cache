# Fine-Grained Cache

This module provides a flexible caching utility designed to work with Redis and an in-memory cache (like LRUCache). It supports features like locking for preventing thundering herd problems, stale-while-revalidate patterns, timed invalidation, and fine-grained key invalidation.

## FineGrainedCache Factory

The `FineGrainedCache` function is a factory that creates a cache instance configured with your Redis client and other options.

**Parameters:**

- `options`: An object containing configuration options for the cache.
  - `redis`: (`Redis`) The Redis client instance to use for caching.
  - `redLock`: (`{ client: RedLock; maxExpectedTime?: StringValue; retryLockTime?: StringValue; useByDefault?: boolean; }`, optional) Configuration for RedLock for distributed locking.
    - `client`: (`RedLock`) The RedLock client instance.
    - `maxExpectedTime`: (`StringValue`, optional) Maximum time to wait for the lock.
    - `retryLockTime`: (`StringValue`, optional) Time to wait between lock retry attempts.
    - `useByDefault`: (`boolean`, optional) Whether to use RedLock by default for `getCached`. Defaults to `false`.
  - `keyPrefix`: (`KeyPrefix`, optional) A prefix to use for all Redis keys managed by this cache instance. Defaults to `"fine-cache-v1"`.
  - `memoryCache`: (`MemoryCache<unknown>`, optional) An instance of an in-memory cache (e.g., LRUCache) to use as a tier 1 cache.
  - `onError`: (`(err: unknown) => void`, optional) A callback function to handle errors that occur within the cache operations.
  - `logEvents`: (`{ events: LoggedEvents; log?: (args: LogEventArgs) => void; }`, optional) Configuration for logging cache events.
    - `events`: (`LoggedEvents`) An object specifying which events to log.
    - `log`: (`(args: LogEventArgs) => void`, optional) The logging function to use. Defaults to `console.log`.
  - `GETRedisTimeout`: (`number`, optional) The maximum amount of milliseconds for `getCached` to wait for a GET response from Redis.
  - `pipelineRedisGET`: (`boolean | number`, optional) Enables the use of Redis pipelines for GET operations. If a number is specified, it's the maximum number of operations per pipeline.
  - `pipelineRedisSET`: (`boolean | number`, optional) Enables the use of Redis pipelines for SET operations. If a number is specified, it's the maximum number of operations per pipeline.
  - `defaultUseMemoryCache`: (`boolean`, optional) Should `getCached` use the memory cache by default? Can be overridden per call. Defaults to `true`.
  - `awaitRedisSet`: (`boolean`, optional) Should `getCached` await the Redis SET operation? Defaults to `process.env.NODE_ENV === "test"`.

## Main Entry Points

These are the primary functions for interacting with the cache.

### `getCached`

Fetches a value from the cache or generates it using the provided callback if a cache miss occurs. Supports timed invalidation, locking, and stale-while-revalidate (implicitly via `ttl` and `timedInvalidation`).

```typescript
<T>(
  cb: CachedCallback<T>,
  options: {
    timedInvalidation?: Date | (() => Date | Promise<Date>);
    ttl: StringValue | "Infinity";
    keys: string | [string, ...(string | number)[]];
    maxExpectedTime?: StringValue;
    retryLockTime?: StringValue;
    checkShortMemoryCache?: boolean;
    useRedlock?: boolean;
    forceUpdate?: boolean;
  }
) => Awaited<T> | Promise<Awaited<T>>;
```

**Parameters:**

- `cb`: (`CachedCallback<T>`) An asynchronous function that generates the value to be cached.
- `options`: An object containing options for this specific cache retrieval.
  - `timedInvalidation`: (`Date | (() => Date | Promise<Date>)`, optional) Specifies a future date or a function that returns a future date when the cache entry should be considered invalid, even if the `ttl` has not expired.
  - `ttl`: (`StringValue | "Infinity"`) The time-to-live for the cache entry in Redis. Can be a string like "1m", "1h", "1d", or "Infinity".
  - `keys`: (`string | [string, ...(string | number)[]]`) A string or an array of strings and numbers used to generate the cache key.
  - `maxExpectedTime`: (`StringValue`, optional) Overrides the default RedLock `maxExpectedTime` for this operation.
  - `retryLockTime`: (`StringValue`, optional) Overrides the default RedLock `retryLockTime` for this operation.
  - `checkShortMemoryCache`: (`boolean`, optional) Should the memory cache be checked before hitting Redis? Overrides the default.
  - `useRedlock`: (`boolean`, optional) Should RedLock be used for this operation to prevent thundering herd? Overrides the default.
  - `forceUpdate`: (`boolean`, optional) Forces the cache to regenerate the value using the callback, ignoring any existing cache entry.

**Returns:**

(`Awaited<T> | Promise<Awaited<T>>`) The cached or newly generated value.

### `getStaleWhileRevalidate`

Fetches a value using the stale-while-revalidate pattern. It immediately returns a potentially stale value from the cache while asynchronously updating it in the background.

```typescript
<T>(
  cb: StaleWhileRevalidateCallback<T>,
  options: {
    revalidationTTL: StringValue;
    dataTTL?: StringValue | "Infinity";
    keys: string | [string, ...(string | number)[]];
    forceUpdate?: boolean;
  }
) => Promise<Awaited<T>>;
```

**Parameters:**

- `cb`: (`StaleWhileRevalidateCallback<T>`) An asynchronous function that generates the fresh value.
- `options`: An object containing options for this SWR operation.
  - `revalidationTTL`: (`StringValue`) The duration after which the cached data is considered stale and a background revalidation is triggered.
  - `dataTTL`: (`StringValue | "Infinity"`, optional) The maximum time the data is allowed to live in the cache, even if not revalidated. Defaults to `Infinity`.
  - `keys`: (`string | [string, ...(string | number)[]]`) A string or an array of strings and numbers used to generate the cache key.
  - `forceUpdate`: (`boolean`, optional) Forces the cache to regenerate the value using the callback immediately, ignoring any existing cache entry.

**Returns:**

(`Promise<Awaited<T>>`) A promise that resolves with the cached (potentially stale) or newly generated value.

### `invalidateCache`

Invalidates (deletes) cache entries based on the provided keys.

```typescript
(...keys: [string, ...(string | number)[]]) => Promise<void>;
```

**Parameters:**

- `...keys`: (`[string, ...(string | number)[]]`) One or more arrays of strings and numbers representing the keys to invalidate.

**Returns:**

(`Promise<void>`) A promise that resolves when the invalidation is complete.

## Secondary Utility Functions

These functions provide lower-level access and additional flexibility for developers.

### `generateCacheKey`

Generates a standardized cache key string based on the provided keys and the factory's `keyPrefix`.

```typescript
(keys: string | [string, ...(string | number)[]]) => string;
```

**Parameters:**

- `keys`: (`string | [string, ...(string | number)[]]`) A string or an array of strings and numbers to be included in the key.

**Returns:**

(`string`) The generated cache key.

### `generateSWRDataKey`

Generates a standardized key string specifically for storing SWR data, based on the provided keys and the factory's `swrKeyPrefix`.

```typescript
(keys: string | [string, ...(string | number)[]]) => string;
```

**Parameters:**

- `keys`: (`string | [string, ...(string | number)[]]`) A string or an array of strings and numbers to be included in the key.

**Returns:**

(`string`) The generated SWR data key.

### `keyPrefix`

The key prefix configured for this cache instance.

```typescript
KeyPrefix;
```

**Type:** `KeyPrefix`

### `swrKeyPrefix`

The key prefix used specifically for Stale-While-Revalidate data.

```typescript
`${KeyPrefix}-swr`;
```

**Type:** `` `${KeyPrefix}-swr` ``

### `memoryCache`

The in-memory cache instance used by this cache utility.

```typescript
MemoryCache<unknown>;
```

**Type:** `MemoryCache<unknown>`

### `setCache`

Manually sets a value in the cache.

```typescript
<T = unknown>(options: {
  populateMemoryCache?: boolean;
  ttl: StringValue | "Infinity";
  keys: string | [string, ...(string | number)[]];
  value: T;
  swr?: boolean;
}) => Promise<void>;
```

**Parameters:**

- `options`: An object containing options for setting the cache value.
  - `populateMemoryCache`: (`boolean`, optional) Whether to also set the value in the in-memory cache. Defaults to the factory's `defaultUseMemoryCache` setting.
  - `ttl`: (`StringValue | "Infinity"`) The time-to-live for the cache entry in Redis.
  - `keys`: (`string | [string, ...(string | number)[]]`) A string or an array of strings and numbers used to generate the cache key.
  - `value`: (`T`) The value to cache.
  - `swr`: (`boolean`, optional) If true, sets the value using the SWR key prefix.

**Returns:**

(`Promise<void>`) A promise that resolves when the value has been set in the cache.

### `readCache`

Reads a value directly from the cache without using a callback to generate it.

```typescript
<T = unknown>(options: {
  keys: string | [string, ...(string | number)[]];
  swr?: boolean;
}) =>
  Promise<{
    found: boolean;
    value: Awaited<T>;
  }>;
```

**Parameters:**

- `options`: An object containing options for reading the cache value.
  - `keys`: (`string | [string, ...(string | number)[]]`) A string or an array of strings and numbers used to generate the cache key.
  - `swr`: (`boolean`, optional) If true, reads the value using the SWR key prefix.

**Returns:**

(`Promise<{ found: boolean; value: Awaited<T>; }>`) A promise that resolves with an object indicating if the key was found and the cached value.

### `getRedisValue`

Gets a raw value directly from Redis using a specific key (without applying the key prefix).

```typescript
(key: string) => Promise<string | null>;
```

**Parameters:**

- `key`: (`string`) The exact Redis key to retrieve.

**Returns:**

(`Promise<string | null>`) A promise that resolves with the value from Redis, or `null` if the key does not exist.

### `setRedisValue`

Sets a raw value directly in Redis using a specific key (without applying the key prefix).

```typescript
({
  key,
  value,
  ttl,
  nx,
}: {
  key: string;
  value: string;
  ttl?: number;
  nx?: boolean;
}) => Promise<unknown>;
```

**Parameters:**

- `options`: An object containing options for setting the Redis value.
  - `key`: (`string`) The exact Redis key to set.
  - `value`: (`string`) The string value to store.
  - `ttl`: (`number`, optional) The time-to-live for the key in seconds.
  - `nx`: (`boolean`, optional) If true, set the key only if it does not already exist.

**Returns:**

(`Promise<unknown>`) A promise that resolves with the result of the Redis SET command.

### `clearRedisValues`

Deletes one or more raw keys directly from Redis (without applying the key prefix).

```typescript
({ keys }: { keys: string | string[] }) => Promise<number>;
```

**Parameters:**

- `options`: An object containing the keys to clear.
  - `keys`: (`string | string[]`) A single string key or an array of string keys to delete.

**Returns:**

(`Promise<number>`) A promise that resolves with the number of keys that were removed.
