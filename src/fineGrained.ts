import type { Redis } from "ioredis";
import lruCache from "lru-cache";
import ms, { StringValue } from "ms";
import type { default as RedLock, Lock, Settings } from "redlock";
import superjson from "superjson";
import { getRemainingSeconds } from "./utils";

// Cache the calls to the `ms` package
const expiryMsCache: Record<string, number> = {};
const expirySecondsCache: Record<string, number> = {};
function getExpiryMs(value: StringValue) {
  return (expiryMsCache[value] ??= ms(value));
}
function getExpirySeconds(value: StringValue) {
  return (expirySecondsCache[value] ??= getExpiryMs(value) / 1000);
}

const NotFoundSymbol = Symbol.for("CacheNotFound");

interface MemoryCache<T> {
  set(key: string, value: T): void;
  has(key: string): boolean;
  get(key: string): T | undefined;
  clear(): void;
}

const ConcurrentLoadingCache: Record<string, Promise<unknown>> = {};

function ConcurrentCachedCall<T>(key: string, cb: () => Promise<T>) {
  const concurrentLoadingValueCache = ConcurrentLoadingCache[key];

  if (concurrentLoadingValueCache) return concurrentLoadingValueCache as Promise<Awaited<T>>;

  return (ConcurrentLoadingCache[key] = cb()).finally(() => {
    delete ConcurrentLoadingCache[key];
  }) as Promise<Awaited<T>>;
}

export type CachedCallback<T> = (options: {
  setTTL(options: {
    /**
     * Set TTL to `null` to disable caching
     */
    ttl?: StringValue | "Infinity" | null;
    timedInvalidation?: undefined | null | Date | (() => Date | Promise<Date>);
  }): void;
  getTTL(): {
    ttl: StringValue | "Infinity" | null;
    timedInvalidation: undefined | null | Date | (() => Date | Promise<Date>);
  };
}) => T;

export function FineGrainedCache({
  redis,
  redLock: redLockConfig,
  keyPrefix = "fine-cache-v1",
  memoryCache = new lruCache<string, unknown>({
    max: 1000,
    ttl: ms("2 seconds"),
  }),
  onError = console.error,
}: {
  redis: Redis;
  redLock?: {
    client: RedLock;
    maxExpectedTime?: StringValue;
    retryLockTime?: StringValue;
    /**
     * @default false
     */
    useByDefault?: boolean;
  };
  keyPrefix?: string;
  memoryCache?: MemoryCache<unknown>;
  onError?: (err: unknown) => void;
}) {
  const redLock = redLockConfig?.client;
  const defaultMaxExpectedTime = redLockConfig?.maxExpectedTime || "5 seconds";
  const defaultRetryLockTime = redLockConfig?.retryLockTime || "250 ms";
  const useRedlockByDefault = redLockConfig?.useByDefault ?? false;

  function generateCacheKey(keys: string | [string, ...(string | number)[]]) {
    return (
      typeof keys === "string"
        ? keyPrefix + ":" + keys
        : keyPrefix + ":" + keys.join(":").replaceAll("*:", "*").replaceAll(":*", "*")
    ).toLowerCase();
  }

  async function getRedisCacheValue<T>(
    key: string,
    useSuperjson: boolean,
    checkShortMemoryCache: boolean
  ): Promise<T | typeof NotFoundSymbol> {
    try {
      const redisValue = await redis.get(key);

      if (redisValue != null) {
        const parsedRedisValue = useSuperjson
          ? superjson.parse<Awaited<T>>(redisValue)
          : (JSON.parse(redisValue) as Awaited<T>);

        if (checkShortMemoryCache) memoryCache.set(key, parsedRedisValue);

        return parsedRedisValue;
      }
    } catch (err) {
      // If for some reason redis fails, the execution should continue
      onError(err);
    }

    return NotFoundSymbol;
  }

  function getCached<T>(
    cb: CachedCallback<T>,
    {
      timedInvalidation,
      ttl,
      keys,
      maxExpectedTime = defaultMaxExpectedTime,
      retryLockTime = defaultRetryLockTime,
      // Don't use memory cache for time-specific invalidations
      checkShortMemoryCache = timedInvalidation == null,
      useSuperjson = true,
      useRedlock = useRedlockByDefault,
      forceUpdate = false,
    }: {
      timedInvalidation?: Date | (() => Date | Promise<Date>);
      ttl: StringValue | "Infinity";
      keys: string | [string, ...(string | number)[]];
      maxExpectedTime?: StringValue;
      retryLockTime?: StringValue;
      /**
       * By default `getCached` checks a short-lived memory cache before hitting redis
       *
       * For some specific use-cases where synchronization and realtime cache invalidation is important, it can be disabled
       *
       * @default true
       */
      checkShortMemoryCache?: boolean;
      /**
       * @default true
       */
      useSuperjson?: boolean;
      /**
       *  @default false
       */
      useRedlock?: boolean;
      /**
       * @default false
       */
      forceUpdate?: boolean;
    }
  ): Awaited<T> | Promise<Awaited<T>> {
    const key = generateCacheKey(keys);

    // Check the in-memory cache
    if (checkShortMemoryCache && forceUpdate === false) {
      if (memoryCache.has(key)) return memoryCache.get(key) as Awaited<T>;
    }

    // Multiple concurrent calls with the same key should re-use the same promise
    return ConcurrentCachedCall(key, async () => {
      if (forceUpdate) return getNewValue();

      const redisValue = await getRedisCacheValue<Awaited<T>>(
        key,
        useSuperjson,
        checkShortMemoryCache
      );

      if (redisValue !== NotFoundSymbol) return redisValue;

      let lock: Lock | undefined | null;

      if (useRedlock && redLock) {
        const maxLockTime = getExpiryMs(maxExpectedTime);
        const retryDelay = getExpiryMs(retryLockTime);
        const retryCount = Math.round((maxLockTime / retryDelay) * 2);

        try {
          // Acquire a lock to prevent this function being called at the same time by more than a single instance
          lock = await redLock.acquire(["lock:" + key], maxLockTime, {
            retryCount,
            retryDelay,
          } as Settings);
        } catch (err) {
          // If acquiring the lock fails, fallback into executing the callback
          onError(err);
        }
      }

      try {
        // If it took more than 1 attempt to get the lock, check if the value in redis has been set
        if (lock && lock.attempts.length > 1) {
          // Release the lock for other readers
          lock
            .release()
            // Errors while releasing the lock don't matter
            .catch(() => null)
            .finally(() => (lock = null));

          const redisValueAfterLock = await getRedisCacheValue<Awaited<T>>(
            key,
            useSuperjson,
            checkShortMemoryCache
          );

          if (redisValueAfterLock !== NotFoundSymbol) return redisValueAfterLock;
        }

        return await getNewValue();
      } finally {
        // Gracefully fail if releasing the lock rejects, as it won't break anything
        lock?.release().catch(() => null);
      }

      async function getNewValue() {
        let currentTTL: typeof ttl | null = ttl;
        let currentTimedInvalidation: typeof timedInvalidation | null = timedInvalidation;

        let expirySeconds: number = 1;

        const newValue = await cb({
          setTTL(options) {
            currentTTL = options.ttl !== undefined ? options.ttl : currentTTL;
            currentTimedInvalidation =
              options.timedInvalidation !== undefined
                ? options.timedInvalidation
                : currentTimedInvalidation;
          },
          getTTL() {
            return {
              ttl: currentTTL,
              timedInvalidation: currentTimedInvalidation,
            };
          },
        });

        try {
          const timedInvalidationDate = currentTimedInvalidation
            ? typeof currentTimedInvalidation === "function"
              ? await currentTimedInvalidation()
              : currentTimedInvalidation
            : null;

          const ttlSeconds =
            currentTTL == null ? 0 : currentTTL === "Infinity" ? -1 : getExpirySeconds(currentTTL);

          expirySeconds =
            timedInvalidationDate && timedInvalidationDate.getTime() > Date.now()
              ? getRemainingSeconds(timedInvalidationDate)
              : ttlSeconds;

          const stringifiedValue = useSuperjson
            ? superjson.stringify(newValue)
            : JSON.stringify(newValue);

          if (expirySeconds > 0) {
            await redis.setex(key, expirySeconds, stringifiedValue);
          } else if (ttl === "Infinity") {
            await redis.set(key, stringifiedValue);
          }
        } catch (err) {
          // If redis/time-invalidation getter fails, report the issue and continue
          onError(err);
        }

        if (expirySeconds > 0 && checkShortMemoryCache) memoryCache.set(key, newValue);

        return newValue;
      }
    });
  }

  async function invalidateCache(...keys: [string, ...(string | number)[]]) {
    // Memory cache is meant to be a short-lived cache anyways
    // And filtering the keys to be cleared is overkill
    memoryCache.clear();

    const key = generateCacheKey(keys);

    const keysToInvalidate = key.includes("*") ? await redis.keys(key) : [key];

    if (keysToInvalidate.length) {
      await redis.del(keysToInvalidate);
    }
  }

  return {
    getCached,
    generateCacheKey,
    keyPrefix,
    memoryCache,
    invalidateCache,
  };
}
