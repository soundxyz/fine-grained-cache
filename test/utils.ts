import Redis from "ioredis";
import { FineGrainedCache, LoggedEvents } from "../src";

export const redis = new Redis({
  port: 6389,
});

export const { memoryCache, getCached, invalidateCache, generateCacheKey, keyPrefix } =
  FineGrainedCache({
    redis,
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
};
