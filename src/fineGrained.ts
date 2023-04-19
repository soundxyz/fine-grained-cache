import type { Redis } from "ioredis";
import { LRUCache } from "lru-cache";
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

export type StaleWhileRevalidateCallback<T> = (options: {
  setTTL(options: {
    /**
     * Set TTL to `null` to disable updating revalidation time
     */
    revalidationTTL?: StringValue | null;

    /**
     * Set TTL to `null` to disable caching
     */
    dataTTL?: StringValue | "Infinity" | null;
  }): void;
  getTTL(): {
    revalidationTTL: StringValue | null;

    dataTTL: StringValue | "Infinity" | null;
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
  PIPELINED_REDIS_SET: "PIPELINED_REDIS_SET",
  STALE_REVALIDATION_CHECK: "STALE_REVALIDATION_CHECK",
  STALE_BACKGROUND_REVALIDATION: "STALE_BACKGROUND_REVALIDATION",
  REDLOCK_ACQUIRED: "REDLOCK_ACQUIRED",
  REDLOCK_RELEASED: "REDLOCK_RELEASED",
  REDLOCK_GET_AFTER_ACQUIRE: "REDLOCK_GET_AFTER_ACQUIRE",
} as const;

export type Events = (typeof Events)[keyof typeof Events];

export type EventParamsObject = Record<string, string | number | boolean | null | undefined>;

export type LogEventArgs = { message: string; code: Events; params: EventParamsObject };

export type LoggedEvents = Partial<
  Record<Events, string | boolean | null | ((args: LogEventArgs) => void)>
>;

function defaultLog({ message }: LogEventArgs) {
  console.log(message);
}

export function FineGrainedCache<KeyPrefix extends string = "fine-cache-v1">({
  redis,
  redLock: redLockConfig,
  keyPrefix = "fine-cache-v1" as KeyPrefix,
  memoryCache = new LRUCache<string, never>({
    max: 1000,
    ttl: ms("2 seconds"),
  }),
  onError = console.error,
  logEvents,
  GETRedisTimeout,
  pipelineRedisGET,
  pipelineRedisSET,
  defaultUseMemoryCache = true,
  awaitRedisSet = process.env.NODE_ENV === "test",
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
  keyPrefix?: KeyPrefix;
  memoryCache?: MemoryCache<unknown>;
  onError?: (err: unknown) => void;
  /**
   * Enable event logging
   */
  logEvents?: {
    events: LoggedEvents;

    /**
     * @default console.log
     */
    log?: (args: LogEventArgs) => void;
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
   * Enable usage of redis pipelines for redis SET.
   *
   * If "number" is specified, that's the maximum amount of operations to be sent in a single pipeline
   */
  pipelineRedisSET?: boolean | number;

  /**
   * Should `getCached` use memory cache by default?
   *
   * It can be overriden on `getCached`
   *
   * @default true
   */
  defaultUseMemoryCache?: boolean;

  /**
   * Should `getCached` await the Redis set
   *
   * @default process.env.NODE_ENV === "test"
   */
  awaitRedisSet?: boolean;
}) {
  const ConcurrentLoadingCache: Record<string, Promise<unknown>> = {};

  function ConcurrentCachedCall<T>(key: string, cb: () => Promise<T>) {
    const concurrentLoadingValueCache = ConcurrentLoadingCache[key];

    if (concurrentLoadingValueCache) return concurrentLoadingValueCache as Promise<Awaited<T>>;

    return (ConcurrentLoadingCache[key] = cb()).finally(() => {
      delete ConcurrentLoadingCache[key];
    }) as Promise<Awaited<T>>;
  }

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
        const eventValue = logEvents.events[code];

        if (!eventValue) return;

        const log = typeof eventValue === "function" ? eventValue : logEvents.log || defaultLog;

        const codeMessageValue = typeof eventValue === "string" ? eventValue : code;

        let paramsString = "";

        for (const key in params) {
          let value = params[key];

          if (value === undefined) continue;

          if (value === "") value = "null";

          paramsString += " " + key + "=" + value;
        }

        log({
          code,
          message: `[${codeMessageValue}]${paramsString}`,
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

  const freshKeyPrefix = `${keyPrefix}-fresh` as const;

  function generateFreshKey(keys: string | [string, ...(string | number)[]]) {
    return (
      typeof keys === "string"
        ? freshKeyPrefix + ":" + keys
        : freshKeyPrefix + ":" + keys.join(":").replaceAll("*:", "*").replaceAll(":*", "*")
    ).toLowerCase();
  }

  const freshCacheValue = "1";

  let pendingRedisGets: [key: string, promise: DeferredPromise<null | string>][] = [];

  let pendingRedisGetTimeout: ReturnType<typeof setTimeout> | undefined;

  function pipelinedRedisGet(key: string) {
    if (pendingRedisGetTimeout !== undefined) {
      clearTimeout(pendingRedisGetTimeout);
    }

    if (typeof pipelineRedisGET === "number" && pendingRedisGets.length >= pipelineRedisGET) {
      executeGetPipeline();
    }

    const promise = createDeferredPromise<null | string>();

    pendingRedisGets.push([key, promise]);

    pendingRedisGetTimeout = setTimeout(executeGetPipeline);

    return promise.promise;

    async function executeGetPipeline() {
      pendingRedisGetTimeout = undefined;

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
            size,
            keys: commands.map(([, key]) => key).join(","),
            cache:
              results
                ?.map(([, result]) => (typeof result === "string" ? "HIT" : "MISS"))
                .join(",") || "null",
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

  let pendingRedisSets: {
    key: string;
    promise: DeferredPromise<void>;
    value: string;
    ttl?: number;
  }[] = [];

  let pendingRedisSetTimeout: ReturnType<typeof setTimeout> | undefined;

  function pipelinedRedisSet({ key, value, ttl }: { key: string; value: string; ttl?: number }) {
    if (pendingRedisSetTimeout !== undefined) {
      clearTimeout(pendingRedisSetTimeout);
    }

    if (typeof pipelineRedisSET === "number" && pendingRedisSets.length >= pipelineRedisSET) {
      executeSetPipeline();
    }

    const promise = createDeferredPromise<void>();

    pendingRedisSets.push({
      key,
      promise,
      ttl,
      value,
    });

    pendingRedisSetTimeout = setTimeout(executeSetPipeline);

    return promise.promise;

    async function executeSetPipeline() {
      pendingRedisSetTimeout = undefined;

      const size = pendingRedisSets.length;
      const { promises, commands } = pendingRedisSets.reduce<{
        promises: {
          promise: DeferredPromise<void>;
          index: number;
          key: string;
          ttl: number | undefined;
        }[];
        commands: Array<
          | [cmd: "set", key: string, value: string]
          | [cmd: "setex", key: string, ttl: number, value: string]
        >;
      }>(
        (acc, { key, promise, ttl, value }, index) => {
          acc.promises[index] = {
            promise,
            index,
            key,
            ttl,
          };

          if (ttl != null) {
            acc.commands[index] = ["setex", key, ttl, value];
          } else {
            acc.commands[index] = ["set", key, value];
          }

          return acc;
        },
        {
          promises: new Array(size),
          commands: new Array(size),
        }
      );

      const tracing = enabledLogEvents?.PIPELINED_REDIS_SET ? getTracing() : null;

      pendingRedisSets = [];

      try {
        const pipeline = redis.pipeline(commands);

        const results = await pipeline.exec();

        if (tracing) {
          logMessage("PIPELINED_REDIS_SET", {
            size,
            keys: promises.map(({ key }) => key).join(","),
            ttl: promises.map(({ ttl }) => ttl ?? -1).join(","),
            time: tracing(),
          });
        }

        for (const { promise, index } of promises) {
          const result = results?.[index];

          if (!result) {
            promise.resolve();
          } else {
            if (result[0]) {
              promise.reject(result[0]);
            } else {
              promise.resolve();
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

  let currentTimeout: Promise<undefined> | null = null;
  function timeoutRedisPromise() {
    if (currentTimeout) return currentTimeout;

    currentTimeout = timersSetTimeout(GETRedisTimeout, undefined);

    setTimeout(() => {
      currentTimeout = null;
    });

    return currentTimeout;
  }

  async function getRedisValue(key: string): Promise<string | null> {
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
        ? Promise.race([redisGet, timeoutRedisPromise()])
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

        return null;
      }

      return redisValue;
    } catch (err) {
      // If for some reason redis fails, the execution should continue
      onError(err);

      return null;
    }
  }

  function setRedisValue({ key, value, ttl }: { key: string; value: string; ttl?: number }) {
    if (pipelineRedisSET) {
      return pipelinedRedisSet({
        key,
        value,
        ttl,
      });
    } else if (ttl != null) {
      return redis.setex(key, ttl, value);
    } else {
      return redis.set(key, value);
    }
  }

  function clearRedisValues({ keys }: { keys: string | Array<string> }) {
    return redis.del(Array.isArray(keys) ? keys : [keys]);
  }

  async function getRedisCacheValue<T>(
    key: string,
    checkShortMemoryCache: boolean
  ): Promise<T | typeof NotFoundSymbol> {
    try {
      const redisValue = await getRedisValue(key);

      if (redisValue != null) {
        let parsedRedisValue: Awaited<T>;

        try {
          parsedRedisValue = superjson.parse<Awaited<T>>(redisValue);
        } catch (err) {
          onError(new Error(`Unexpected JSON string for ${key}`));

          return NotFoundSymbol;
        }

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

      const redisValue = await getRedisCacheValue<Awaited<T>>(key, checkShortMemoryCache);

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

          const stringifiedValue = superjson.stringify(newValue);
          if (expirySeconds > 0) {
            if (pipelineRedisSET) {
              const set = setRedisValue({
                key,
                value: stringifiedValue,
                ttl: expirySeconds,
              }).catch(onError);

              if (awaitRedisSet || forceUpdate) await set;
            } else {
              const tracing = enabledLogEvents?.REDIS_SET ? getTracing() : null;

              const set = setRedisValue({
                key,
                ttl: expirySeconds,
                value: stringifiedValue,
              })
                .then(() => {
                  if (tracing) {
                    logMessage("REDIS_SET", {
                      key,
                      expirySeconds,
                      timedInvalidationDate: timedInvalidationDate?.toISOString(),
                      time: tracing(),
                    });
                  }
                })
                .catch(onError);

              if (awaitRedisSet || forceUpdate) await set;
            }
          } else if (ttl === "Infinity") {
            if (pipelineRedisSET) {
              const set = setRedisValue({
                key,
                value: stringifiedValue,
              }).catch(onError);

              if (awaitRedisSet || forceUpdate) await set;
            } else {
              const tracing = enabledLogEvents?.REDIS_SET ? getTracing() : null;

              const set = setRedisValue({
                key,
                value: stringifiedValue,
              })
                .then(() => {
                  if (tracing) {
                    logMessage("REDIS_SET", {
                      key,
                      expirySeconds: "Infinity",
                      timedInvalidationDate: timedInvalidationDate?.toISOString(),
                      time: tracing(),
                    });
                  }
                })
                .catch(onError);

              if (awaitRedisSet || forceUpdate) await set;
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

  function getStaleWhileRevalidate<T>(
    cb: StaleWhileRevalidateCallback<T>,
    {
      revalidationTTL,
      dataTTL = "Infinity",
      keys,
      forceUpdate = false,
    }: {
      /**
       * TTL that sets how frequent revalidations are executed
       */
      revalidationTTL: StringValue;
      /**
       * Expiration of the data
       * Expected to be long-lived for stale-while-revalidate mechanism to work as expected
       *
       * @default "Infinity"
       */
      dataTTL?: StringValue | "Infinity";
      /**
       * Unique key combination
       */
      keys: string | [string, ...(string | number)[]];
      /**
       * @default false
       */
      forceUpdate?: boolean;
    }
  ): Promise<Awaited<T>> {
    const key = generateCacheKey(keys);
    const freshKey = generateFreshKey(keys);

    // Multiple concurrent calls with the same key should re-use the same promise
    return ConcurrentCachedCall(key, async () => {
      if (forceUpdate) return getNewValue();

      const [redisValue, isStale] = await Promise.all([
        getRedisCacheValue<Awaited<T>>(key, false),
        getRedisValue(freshKey).then((value) => value == null),
      ]);

      if (redisValue !== NotFoundSymbol) {
        if (isStale) {
          const staleCheckTracing = logEvents?.events.STALE_REVALIDATION_CHECK
            ? getTracing()
            : null;

          redis
            // SET NX so that only 1 instance can do the revalidation at a time
            .set(freshKey, freshCacheValue, "EX", getExpirySeconds(revalidationTTL), "NX")
            .then((value) => {
              const instanceOwnsRevalidation = value != null;

              if (staleCheckTracing) {
                logMessage("STALE_REVALIDATION_CHECK", {
                  key,
                  freshKey,
                  time: staleCheckTracing(),
                  shouldRevalidate: instanceOwnsRevalidation,
                });
              }

              return instanceOwnsRevalidation;
            })
            .catch((err) => {
              if (staleCheckTracing) {
                logMessage("STALE_REVALIDATION_CHECK", {
                  error: true,
                  key,
                  freshKey,
                  time: staleCheckTracing(),
                  shouldRevalidate: false,
                });
              }

              onError(err);

              // If redis fails, fallback to skip revalidation
              return false;
            })
            .then((shouldRevalidate) => {
              if (!shouldRevalidate) return;

              const backgroundRevalidationTracing = logEvents?.events.STALE_BACKGROUND_REVALIDATION
                ? getTracing()
                : null;

              getNewValue()
                .then(() => {
                  if (backgroundRevalidationTracing) {
                    logMessage("STALE_BACKGROUND_REVALIDATION", {
                      key,
                      freshKey,
                      time: backgroundRevalidationTracing(),
                    });
                  }
                })
                .catch(onError);
            });
        }

        return redisValue;
      }

      return getNewValue();

      async function getNewValue() {
        let currentRevalidationTTL: typeof revalidationTTL | null = revalidationTTL;

        let currentDataTTL: typeof dataTTL | null = dataTTL;

        const tracing = enabledLogEvents?.EXECUTION_TIME ? getTracing() : null;

        const newValue = await cb({
          setTTL(options) {
            currentRevalidationTTL =
              options.revalidationTTL !== undefined
                ? options.revalidationTTL
                : currentRevalidationTTL;

            currentDataTTL = options.dataTTL !== undefined ? options.dataTTL : currentDataTTL;
          },
          getTTL() {
            return {
              revalidationTTL: currentRevalidationTTL,
              dataTTL: currentDataTTL,
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
          const revalidationTtlSeconds =
            currentRevalidationTTL == null ? 0 : getExpirySeconds(currentRevalidationTTL);

          const dataTtlSeconds =
            currentDataTTL == null
              ? 0
              : currentDataTTL === "Infinity"
              ? Infinity
              : getExpirySeconds(currentDataTTL);

          const stringifiedValue = superjson.stringify(newValue);
          if (dataTtlSeconds > 0) {
            const set = Promise.all([
              setRedisValue({
                key,
                value: stringifiedValue,
                ttl: dataTtlSeconds !== Infinity ? dataTtlSeconds : undefined,
              }).catch(onError),
              revalidationTtlSeconds > 0 &&
                setRedisValue({
                  key: freshKey,
                  value: freshCacheValue,
                  ttl: revalidationTtlSeconds,
                }).catch(onError),
            ]);

            if (awaitRedisSet || forceUpdate) await set;
          } else if (enabledLogEvents?.REDIS_SKIP_SET) {
            logMessage("REDIS_SKIP_SET", {
              key,
            });
          }
        } catch (err) {
          // If redis/time-invalidation getter fails, report the issue and continue
          onError(err);
        }

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

      await clearRedisValues({ keys: keysToInvalidate });

      if (tracing) {
        logMessage("INVALIDATED_KEYS", {
          key,
          invalidatedKeys: keysToInvalidate.join(",") || "null",
          time: tracing(),
        });
      }
    }
  }

  async function setCache<T = unknown>({
    populateMemoryCache = defaultUseMemoryCache,
    ttl,
    keys,
    value,
  }: {
    populateMemoryCache: boolean;
    ttl: StringValue | "Infinity";
    keys: string | [string, ...(string | number)[]];
    value: T;
  }) {
    const key = generateCacheKey(keys);

    const expirySeconds = ttl === "Infinity" ? -1 : getExpirySeconds(ttl);

    const stringifiedValue = superjson.stringify(value);

    if (expirySeconds > 0) {
      if (populateMemoryCache) memoryCache.set(key, value);

      if (pipelineRedisSET) {
        await setRedisValue({
          key,
          value: stringifiedValue,
          ttl: expirySeconds,
        });
      } else {
        const tracing = enabledLogEvents?.REDIS_SET ? getTracing() : null;

        await setRedisValue({
          key,
          value: stringifiedValue,
          ttl: expirySeconds,
        }).then(() => {
          if (tracing) {
            logMessage("REDIS_SET", {
              key,
              expirySeconds,
              time: tracing(),
            });
          }
        });
      }
    } else if (ttl === "Infinity") {
      if (populateMemoryCache) memoryCache.set(key, value);

      if (pipelineRedisSET) {
        await setRedisValue({
          key,
          value: stringifiedValue,
        });
      } else {
        const tracing = enabledLogEvents?.REDIS_SET ? getTracing() : null;

        await setRedisValue({ key, value: stringifiedValue }).then(() => {
          if (tracing) {
            logMessage("REDIS_SET", {
              key,
              expirySeconds: "Infinity",
              time: tracing(),
            });
          }
        });
      }
    }
  }

  function readCache<T = unknown>({ keys }: { keys: string | [string, ...(string | number)[]] }) {
    const key = generateCacheKey(keys);

    return getRedisCacheValue<Awaited<T>>(key, false).then((value) => {
      if (value === NotFoundSymbol) {
        return {
          found: false,
        } as const;
      }

      return {
        found: true,
        value,
      } as const;
    });
  }

  return {
    getCached,
    getStaleWhileRevalidate,
    generateCacheKey,
    generateFreshKey,
    keyPrefix,
    freshKeyPrefix,
    memoryCache,
    invalidateCache,
    setCache,
    readCache,
    getRedisValue,
    setRedisValue,
    clearRedisValues,
  };
}
