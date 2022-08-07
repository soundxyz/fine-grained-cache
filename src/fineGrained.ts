import type { Redis } from "ioredis";
import lruCache from "lru-cache";
import ms, { StringValue } from "ms";
import type { default as RedLock, Lock, Settings } from "redlock";
import superjson from "superjson";
import { createDeferredPromise, DeferredPromise, getRemainingSeconds } from "./utils";
import { setTimeout as timersSetTimeout } from "timers/promises";

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
    timedInvalidation?: null | Date | (() => Date | Promise<Date>);
  }): void;
  getTTL(): {
    ttl: StringValue | "Infinity" | null;
    timedInvalidation: undefined | null | Date | (() => Date | Promise<Date>);
  };
}) => T;

export const Events = {
  REDIS_GET: "REDIS_GET",
  REDIS_GET_TIMED_OUT: "REDIS_GET_TIMED_OUT",
  REDIS_SET: "REDIS_SET",
  REDIS_SKIP_SET: "REDIS_SKIP_SET",
  MEMORY_CACHE_HIT: "MEMORY_CACHE_HIT",
  INVALIDATE_KEY_SCAN: "INVALIDATE_KEY_SCAN",
  INVALIDATED_KEYS: "INVALIDATED_KEYS",
  EXECUTION_TIME: "EXECUTION_TIME",
  PIPELINED_REDIS_GETS: "PIPELINED_REDIS_GETS",
  REDLOCK_ACQUIRED: "REDLOCK_ACQUIRED",
  REDLOCK_RELEASED: "REDLOCK_RELEASED",
  REDLOCK_GET_AFTER_ACQUIRE: "REDLOCK_GET_AFTER_ACQUIRE",
} as const;

export type Events = typeof Events[keyof typeof Events];

export type EventParamsObject = Record<string, string | number | boolean | null | undefined>;

export type LogEventArgs = { message: string; code: Events; params: EventParamsObject };

export type LoggedEvents = Partial<Record<Events, string | boolean | null>>;

export function FineGrainedCache({
  redis,
  redLock: redLockConfig,
  keyPrefix = "fine-cache-v1",
  memoryCache = new lruCache<string, unknown>({
    max: 1000,
    ttl: ms("2 seconds"),
  }),
  onError = console.error,
  logEvents,
  GETRedisTimeout,
  pipelineRedisGET,
  defaultUseMemoryCache = true,
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
  /**
   * Enable event logging
   */
  logEvents?: {
    log: (args: LogEventArgs) => void;

    events: LoggedEvents;
  };
  /**
   * Set a maximum amount of milliseconds for getCached to wait for the GET redis response
   */
  GETRedisTimeout?: number;
  /**
   * Enable usage of redis pipelines for redis GET.
   *
   * If "number" is specified, that's the maximum amount of operations to be sent in a single pipeline
   */
  pipelineRedisGET?: boolean | number;
  /**
   * Should `getCached` use memory cache by default?
   *
   * It can be overriden on `getCached`
   *
   * @default true
   */
  defaultUseMemoryCache?: boolean;
}) {
  const redLock = redLockConfig?.client;
  const defaultMaxExpectedTime = redLockConfig?.maxExpectedTime || "5 seconds";
  const defaultRetryLockTime = redLockConfig?.retryLockTime || "250 ms";
  const useRedlockByDefault = redLockConfig?.useByDefault ?? false;

  function getTracing() {
    const start = performance.now();

    return () => `${(performance.now() - start).toFixed()}ms`;
  }

  const enabledLogEvents = logEvents?.events;

  const logMessage = logEvents
    ? function logMessage(code: Events, params: EventParamsObject) {
        let codeValue = logEvents.events[code];

        if (!codeValue) return;

        if (typeof codeValue !== "string") codeValue = Events[code];

        let paramsString = "";

        for (const key in params) {
          let value = params[key];

          if (value === undefined) continue;

          if (value === "") value = "null";

          paramsString += " " + key + "=" + value;
        }

        logEvents.log({
          code,
          message: `[${codeValue}]${paramsString}`,
          params,
        });
      }
    : () => void 0;

  function generateCacheKey(keys: string | [string, ...(string | number)[]]) {
    return (
      typeof keys === "string"
        ? keyPrefix + ":" + keys
        : keyPrefix + ":" + keys.join(":").replaceAll("*:", "*").replaceAll(":*", "*")
    ).toLowerCase();
  }

  let pendingRedisGets: [key: string, promise: DeferredPromise<null | string>][] = [];

  let pendingRedisTimeout: ReturnType<typeof setTimeout> | undefined;

  function pipelinedRedisGet(key: string) {
    if (pendingRedisTimeout !== undefined) {
      clearTimeout(pendingRedisTimeout);
    }

    if (typeof pipelineRedisGET === "number" && pendingRedisGets.length >= pipelineRedisGET) {
      executePipeline();
    }

    const promise = createDeferredPromise<null | string>();

    pendingRedisGets.push([key, promise]);

    pendingRedisTimeout = setTimeout(executePipeline);

    return promise.promise;

    async function executePipeline() {
      pendingRedisTimeout = undefined;

      const size = pendingRedisGets.length;
      const { promises, commands } = pendingRedisGets.reduce<{
        promises: {
          promise: DeferredPromise<string | null>;
          index: number;
        }[];
        commands: ["get", string][];
      }>(
        (acc, [key, promise], index) => {
          acc.promises[index] = {
            promise,
            index,
          };

          acc.commands[index] = ["get", key];

          return acc;
        },
        {
          promises: new Array(size),
          commands: new Array(size),
        }
      );

      const tracing = enabledLogEvents?.PIPELINED_REDIS_GETS ? getTracing() : null;

      pendingRedisGets = [];

      try {
        const pipeline = redis.pipeline(commands);

        const results = await pipeline.exec();

        if (tracing) {
          logMessage("PIPELINED_REDIS_GETS", {
            keys: commands.map(([, key]) => key).join(","),
            cache:
              results
                ?.map(([, result]) => (typeof result === "string" ? "HIT" : "MISS"))
                .join(",") || "null",
            size,
            time: tracing(),
          });
        }

        for (const { promise, index } of promises) {
          const result = results?.[index];

          if (!result) {
            promise.resolve(null);
          } else {
            const [error, value] = result;

            if (error) {
              promise.reject(error);
            } else {
              promise.resolve(typeof value != "string" ? null : value);
            }
          }
        }
      } catch (err) {
        for (const { promise } of promises) {
          promise.reject(err);
        }
      }
    }
  }

  async function getRedisCacheValue<T>(
    key: string,
    useSuperjson: boolean,
    checkShortMemoryCache: boolean
  ): Promise<T | typeof NotFoundSymbol> {
    const tracing =
      enabledLogEvents?.REDIS_GET || enabledLogEvents?.REDIS_GET_TIMED_OUT ? getTracing() : null;

    let timedOut: true | undefined = undefined;
    try {
      const redisGet = pipelineRedisGET
        ? pipelinedRedisGet(key)
        : redis.get(key).then(
            (value) => {
              if (enabledLogEvents?.REDIS_GET) {
                logMessage("REDIS_GET", {
                  key,
                  cache: value == null ? "MISS" : "HIT",
                  timedOut,
                  time: tracing?.(),
                });
              }

              return value;
            },
            (err) => {
              onError(err);

              return null;
            }
          );

      const redisValue = await (GETRedisTimeout != null
        ? Promise.race([redisGet, timersSetTimeout(GETRedisTimeout, undefined)])
        : redisGet);

      if (redisValue === undefined) {
        timedOut = true;

        if (enabledLogEvents?.REDIS_GET_TIMED_OUT) {
          logMessage("REDIS_GET_TIMED_OUT", {
            key,
            timeout: GETRedisTimeout,
            time: tracing?.(),
          });
        }

        return NotFoundSymbol;
      }

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
      checkShortMemoryCache = defaultUseMemoryCache,
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
    // Don't use memory cache for time-specific invalidations
    if (checkShortMemoryCache && timedInvalidation != null) {
      checkShortMemoryCache = false;
    }

    const key = generateCacheKey(keys);

    // Check the in-memory cache
    if (checkShortMemoryCache && forceUpdate === false) {
      if (memoryCache.has(key)) {
        if (enabledLogEvents?.MEMORY_CACHE_HIT) {
          logMessage("MEMORY_CACHE_HIT", {
            key,
          });
        }

        return memoryCache.get(key) as Awaited<T>;
      }
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
          const tracing = enabledLogEvents?.REDLOCK_ACQUIRED ? getTracing() : null;

          // Acquire a lock to prevent this function being called at the same time by more than a single instance
          lock = await redLock.acquire(["lock:" + key], maxLockTime, {
            retryCount,
            retryDelay,
          } as Settings);

          if (tracing) {
            logMessage("REDLOCK_ACQUIRED", {
              key,
              attempts: lock.attempts.length,
              time: tracing(),
            });
          }
        } catch (err) {
          // If acquiring the lock fails, fallback into executing the callback
          onError(err);
        }
      }

      try {
        // If it took more than 1 attempt to get the lock, check if the value in redis has been set
        if (lock && lock.attempts.length > 1) {
          {
            const tracing = enabledLogEvents?.REDLOCK_RELEASED ? getTracing() : null;
            // Release the lock for other readers
            lock
              .release()
              .then(({ attempts }) => {
                if (tracing) {
                  logMessage("REDLOCK_RELEASED", {
                    key,
                    attempts: attempts.length,
                    time: tracing(),
                  });
                }
              })
              // Errors while releasing the lock don't matter
              .catch(() => null)
              .finally(() => (lock = null));
          }

          {
            const tracing = enabledLogEvents?.REDLOCK_GET_AFTER_ACQUIRE ? getTracing() : null;

            const redisValueAfterLock = await getRedisCacheValue<Awaited<T>>(
              key,
              useSuperjson,
              checkShortMemoryCache
            );

            if (tracing) {
              logMessage("REDLOCK_GET_AFTER_ACQUIRE", {
                key,
                cache: redisValueAfterLock !== NotFoundSymbol ? "HIT" : "MISS",
                time: tracing(),
              });
            }

            if (redisValueAfterLock !== NotFoundSymbol) return redisValueAfterLock;
          }
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

        const tracing = enabledLogEvents?.EXECUTION_TIME ? getTracing() : null;

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

        if (tracing) {
          logMessage("EXECUTION_TIME", {
            key,
            time: tracing(),
          });
        }

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
            const tracing = enabledLogEvents?.REDIS_SET ? getTracing() : null;

            await redis.setex(key, expirySeconds, stringifiedValue);

            if (tracing) {
              logMessage("REDIS_SET", {
                key,
                expirySeconds,
                timedInvalidationDate: timedInvalidationDate?.toISOString(),
                time: tracing(),
              });
            }
          } else if (ttl === "Infinity") {
            const tracing = enabledLogEvents?.REDIS_SET ? getTracing() : null;

            await redis.set(key, stringifiedValue);

            if (tracing) {
              logMessage("REDIS_SET", {
                key,
                expirySeconds: "Infinity",
                timedInvalidationDate: timedInvalidationDate?.toISOString(),
                time: tracing(),
              });
            }
          } else if (enabledLogEvents?.REDIS_SKIP_SET) {
            logMessage("REDIS_SKIP_SET", {
              key,
              timedInvalidationDate: timedInvalidationDate?.toISOString(),
            });
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

    let keysToInvalidate: string[];

    if (key.includes("*")) {
      const tracing = enabledLogEvents?.INVALIDATE_KEY_SCAN ? getTracing() : null;
      keysToInvalidate = await redis.keys(key);
      if (tracing) {
        logMessage("INVALIDATE_KEY_SCAN", {
          key,
          keysToInvalidate: keysToInvalidate.join(",") || "null",
          time: tracing(),
        });
      }
    } else {
      keysToInvalidate = [key];
    }

    if (keysToInvalidate.length) {
      const tracing = enabledLogEvents?.INVALIDATED_KEYS ? getTracing() : null;

      await redis.del(keysToInvalidate);

      if (tracing) {
        logMessage("INVALIDATED_KEYS", {
          key,
          invalidatedKeys: keysToInvalidate.join(",") || "null",
          time: tracing(),
        });
      }
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
