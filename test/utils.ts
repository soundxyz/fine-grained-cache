import Redis from "ioredis";
import { FineGrainedCache } from "../src";

export const redis = new Redis({
  port: 6389,
});

export const { memoryCache, getCached, invalidateCache, generateCacheKey, keyPrefix } =
  FineGrainedCache({
    redis,
  });
