import Redis from "ioredis";
import { FineGrainedCache, LoggedEvents } from "../src";

export const redis = new Redis({
  port: 6389,
});

export const { memoryCache, getCached, invalidateCache, generateCacheKey, keyPrefix, setCache } =
  FineGrainedCache({
    redis,
    logEvents: {
      log: console.log,
      events: {
        MEMORY_CACHE_HIT: true,
      },
    },
  });

export const logEverything: Required<LoggedEvents> = {
  EXECUTION_TIME: true,
  INVALIDATE_KEY_SCAN: true,
  INVALIDATED_KEYS: true,
  MEMORY_CACHE_HIT: true,
  PIPELINED_REDIS_GETS: true,
  REDIS_GET: true,
  REDIS_GET_TIMED_OUT: true,
  REDIS_SET: true,
  REDIS_SKIP_SET: true,
  REDLOCK_ACQUIRED: true,
  REDLOCK_RELEASED: true,
  REDLOCK_GET_AFTER_ACQUIRE: true,
  PIPELINED_REDIS_SET: true,
};
