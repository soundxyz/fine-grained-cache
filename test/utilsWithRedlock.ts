import Redlock from "redlock";
import { FineGrainedCache } from "../src";
import { logEverything, redis } from "./utils";

export const redLock = new Redlock([redis]);

export const { memoryCache, getCached, invalidateCache, generateCacheKey, keyPrefix } =
  FineGrainedCache({
    redis,
    redLock: {
      client: redLock,
      useByDefault: true,
      maxExpectedTime: "5 seconds",
      retryLockTime: "250 ms",
    },
    logEvents: {
      log: console.log,
      events: logEverything,
    },
  });
