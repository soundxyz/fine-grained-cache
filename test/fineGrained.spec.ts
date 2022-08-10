import test from "ava";
import { join } from "path";
import { CachedCallback, FineGrainedCache, LogEventArgs } from "../src";
import { getCached, invalidateCache, logEverything, memoryCache, redis } from "./utils";
import { createDeferredPromise } from "../src/utils";
import { setTimeout } from "timers/promises";
import { addMinutes, minutesToSeconds } from "date-fns";

test.beforeEach(async () => {
  await redis.flushall();
  memoryCache.clear();
});

test.after.always(async () => {
  await redis.flushall();
});

test("fine grained - with memory cache", async (t) => {
  let calls = 0;

  async function cb() {
    ++calls;
    await setTimeout(50);

    return "hello world" as const;
  }

  const data = await getCached(cb, {
    keys: "test",
    ttl: "10 seconds",
  });

  t.is(data, "hello world");
  t.is(calls, 1);

  const data2 = await getCached(cb, {
    keys: "test",
    ttl: "10 seconds",
  });

  t.is(data2, data);
  t.is(calls, 1);

  await invalidateCache("test");

  const data3 = await getCached(cb, {
    keys: "test",
    ttl: "10 seconds",
  });

  t.is(data3, data);
  t.is(calls, 2);
});

test("fine grained - without memory cache", async (t) => {
  let calls = 0;

  async function cb() {
    ++calls;
    await setTimeout(50);

    return "hello world" as const;
  }

  memoryCache.clear();
  const data = await getCached(cb, {
    keys: "test",
    ttl: "10 seconds",
  });

  t.is(data, "hello world");
  t.is(calls, 1);

  memoryCache.clear();
  const data2 = await getCached(cb, {
    keys: "test",
    ttl: "10 seconds",
  });

  t.is(data2, data);
  t.is(calls, 1);

  await invalidateCache("test");

  const data3 = await getCached(cb, {
    keys: "test",
    ttl: "10 seconds",
  });

  t.is(data3, data);
  t.is(calls, 2);
});

test("fine grained - without memory cache and invalidate pattern", async (t) => {
  let calls = 0;

  async function cb() {
    ++calls;
    await setTimeout(50);

    return "hello world" as const;
  }

  memoryCache.clear();
  const data = await getCached(cb, {
    keys: ["test", 1],
    ttl: "10 seconds",
    useSuperjson: false,
  });

  t.is(data, "hello world");
  t.is(calls, 1);

  memoryCache.clear();
  const data2 = await getCached(cb, {
    keys: ["test", 1],
    ttl: "10 seconds",
    useSuperjson: false,
  });

  t.is(data2, data);
  t.is(calls, 1);

  await invalidateCache("test", "*");

  const data3 = await getCached(cb, {
    keys: "test",
    ttl: "10 seconds",
    useSuperjson: false,
  });

  t.is(data3, data);
  t.is(calls, 2);
});

test.skip("fine grained - with redlock", async (t) => {
  t.timeout(20000);
  const { execaCommand: command } = await import("execa");
  const cmd = `bob-tsm --cjs ${join(__dirname, "redlock/lock.ts")}`;

  const lockAmount = 10;

  const lockingResult = await Promise.all(
    new Array(lockAmount).fill(0).map(() =>
      command(cmd, {
        stdio: "pipe",
      }).then((v) => ({
        stdout: v.stdout,
        stderr: v.stderr,
      }))
    )
  );

  const readCacheAmount = 10;

  const readCacheResult = await Promise.all(
    new Array(readCacheAmount).fill(0).map(() =>
      command(cmd, {
        stdio: "pipe",
      }).then((v) => ({
        stdout: v.stdout,
        stderr: v.stderr,
      }))
    )
  );

  // Only one instance executes the callback
  t.is(lockingResult.filter((v) => v.stdout.includes("Executing expensive function")).length, 1);

  // Every execution gets the expected data
  t.is(lockingResult.filter((v) => v.stdout.includes("Hello World")).length, lockAmount);

  // No errors found
  t.is(lockingResult.map((v) => v.stderr).join(""), "");

  // No instance executes the callback
  t.is(readCacheResult.filter((v) => v.stdout.includes("Executing expensive function")).length, 0);

  // Every execution gets the expected data
  t.is(readCacheResult.filter((v) => v.stdout.includes("Hello World")).length, readCacheAmount);

  // No errors found
  t.is(readCacheResult.map((v) => v.stderr).join(""), "");
});

test("fine grained - timed invalidation", async (t) => {
  let calls = 0;

  const timedInvalidation = new Date(Date.now() + 1800);

  async function cb() {
    const data = ++calls;

    await setTimeout(10);

    return data;
  }

  t.is((await redis.keys("*")).length, 0);

  // Setter
  const data1 = await getCached(cb, {
    timedInvalidation,
    ttl: "5 minutes",
    keys: "test_timed_invalidation",
  });

  t.is(data1, 1);
  t.is(calls, 1);

  // Immediate cached call

  const data2 = await getCached(cb, {
    timedInvalidation,
    ttl: "5 minutes",
    keys: "test_timed_invalidation",
  });

  t.is(data2, 1);
  t.is(calls, 1);

  const cacheKeys = await redis.keys("*");

  const cacheKeyName = cacheKeys[0]!;

  t.is(cacheKeys.length, 1);

  t.truthy(cacheKeyName);

  const cacheTtl = await redis.ttl(cacheKeyName);

  t.assert(cacheTtl > 0 && cacheTtl <= 2, "Should use the invalidation date remaining seconds");

  // Wait 1 second
  await setTimeout(1000);

  t.is((await redis.keys("*")).length, 1);

  // Cached call before invalidation
  const data3 = await getCached(cb, {
    timedInvalidation,
    ttl: "5 minutes",
    keys: "test_timed_invalidation",
  });

  t.is(data3, 1);
  t.is(calls, 1);

  // Wait 1 second
  await setTimeout(1000);

  // Redis should have invalidated correctly
  t.is((await redis.keys("*")).length, 0);

  // Cached cache after invalidation
  const data4 = await getCached(cb, {
    timedInvalidation,
    ttl: "5 minutes",
    keys: "test_timed_invalidation",
  });

  t.is(data4, 2);
  t.is(calls, 2);

  t.assert(
    (await redis.ttl(cacheKeyName)) > 60 * 4,
    "Cache should use TTL after invalidation time is reached"
  );
});

test("fine grained - forceUpdate", async (t) => {
  let calls = 0;

  async function cb() {
    ++calls;
    await setTimeout(50);

    return "hello world" + calls;
  }

  const data = await getCached(cb, {
    keys: "test",
    ttl: "10 seconds",
    checkShortMemoryCache: false,
  });

  t.is(data, "hello world1");
  t.is(calls, 1);

  const data2 = await getCached(cb, {
    keys: "test",
    ttl: "10 seconds",
    checkShortMemoryCache: false,
  });

  t.is(data2, "hello world1");
  t.is(calls, 1);

  const data3 = await getCached(cb, {
    keys: "test",
    ttl: "10 seconds",
    checkShortMemoryCache: false,
    forceUpdate: true,
  });

  t.is(data3, "hello world2");
  t.is(calls, 2);

  const data4 = await getCached(cb, {
    keys: "test",
    ttl: "10 seconds",
    checkShortMemoryCache: false,
    forceUpdate: false,
  });

  t.is(data4, "hello world2");
  t.is(calls, 2);

  const data5 = await getCached(cb, {
    keys: "test",
    ttl: "10 seconds",
    checkShortMemoryCache: false,
    forceUpdate: true,
  });

  t.is(data5, "hello world3");
  t.is(calls, 3);
});

test("fine grained - dynamic ttl", async (t) => {
  let calls = 0;

  const cb: CachedCallback<unknown> = async function cb({ setTTL, getTTL }) {
    ++calls;
    await setTimeout(50);

    t.deepEqual(getTTL(), {
      ttl: "10 seconds",
      timedInvalidation: undefined,
    });

    const tempTimedInvalidation = new Date();
    setTTL({
      ttl: "1 hour",
      timedInvalidation: tempTimedInvalidation,
    });

    t.deepEqual(getTTL(), {
      ttl: "1 hour",
      timedInvalidation: tempTimedInvalidation,
    });

    setTTL({
      ttl: null,
      timedInvalidation: null,
    });

    t.deepEqual(getTTL(), {
      ttl: null,
      timedInvalidation: null,
    });

    return "hello world" + calls;
  };

  const data = await getCached(cb, {
    keys: "test",
    ttl: "10 seconds",
  });

  t.is(data, "hello world1");
  t.is(calls, 1);

  const data2 = await getCached(cb, {
    keys: "test",
    ttl: "10 seconds",
  });

  t.is(data2, "hello world2");
  t.is(calls, 2);
});

test("set timed invalidation dynamically", async (t) => {
  const events: LogEventArgs[] = [];
  const { getCached } = FineGrainedCache({
    redis,
    pipelineRedisGET: true,
    pipelineRedisSET: true,
    logEvents: {
      events: logEverything,
      log(args) {
        events.push(args);
      },
    },
  });

  const extraMinutes = 15;

  await getCached(
    ({ setTTL }) => {
      setTTL({
        timedInvalidation: addMinutes(new Date(), extraMinutes),
      });

      return 123;
    },
    {
      keys: "test-dynamic-timed",
      ttl: "1 second",
    }
  );

  t.is(
    events.find((event) => event.code === "PIPELINED_REDIS_SET")?.params.ttl,
    minutesToSeconds(extraMinutes).toString()
  );
});

test("logged events", async (t) => {
  const events: LogEventArgs[] = [];

  const { getCached } = FineGrainedCache({
    redis,
    logEvents: {
      log: (args) => events.push(args),
      events: logEverything,
    },
  });

  await getCached(
    () => {
      return 123;
    },
    {
      keys: "test",
      ttl: "Infinity",
    }
  );

  t.deepEqual(
    events.map((v) => v.code),
    ["REDIS_GET", "EXECUTION_TIME", "REDIS_SET"]
  );
});

test("logged events with timeout", async (t) => {
  const events: LogEventArgs[] = [];

  const redisGetPass = createDeferredPromise();

  const redisGetDone = createDeferredPromise();

  const redisGet = redis.get;

  t.teardown(() => {
    redis.get = redisGet;
  });

  redis.get = async (...args) => {
    await redisGetPass.promise;
    const response = await redisGet.call(redis, ...args);

    redisGetDone.resolve();

    return response;
  };

  const { getCached } = FineGrainedCache({
    redis,
    logEvents: {
      log: (args) => events.push(args),
      events: logEverything,
    },
    GETRedisTimeout: 0,
  });

  await getCached(
    async () => {
      return 123;
    },
    {
      keys: "test",
      ttl: "Infinity",
    }
  );

  t.true(events[0].code === "REDIS_GET_TIMED_OUT");

  redisGetPass.resolve();

  await redisGetDone.promise;

  t.is(events.length, 4);

  t.is(events[1].code, "EXECUTION_TIME");

  t.is(events[2].code, "REDIS_SET");

  t.is(events[3].code, "REDIS_GET");
});

test("pipelined gets", async (t) => {
  const events: LogEventArgs[] = [];

  const { getCached } = FineGrainedCache({
    redis,
    logEvents: {
      log: (args) => events.push(args),
      events: logEverything,
    },
    pipelineRedisGET: true,
  });

  await Promise.all([
    getCached(
      async () => {
        return 123;
      },
      {
        keys: "test",
        ttl: "Infinity",
      }
    ),
    getCached(
      () => {
        return 123;
      },
      {
        keys: "test2",
        ttl: "Infinity",
      }
    ),
  ]);

  t.is(events.length, 5);

  t.is(events[0].code, "PIPELINED_REDIS_GETS");

  t.is(events[0].params.size, 2);

  t.is(events[1].code, "EXECUTION_TIME");

  t.is(events[2].code, "EXECUTION_TIME");

  t.is(events[3].code, "REDIS_SET");

  t.is(events[4].code, "REDIS_SET");
});

test("pipelined sets", async (t) => {
  const events: LogEventArgs[] = [];

  const { getCached } = FineGrainedCache({
    redis,
    logEvents: {
      log: (args) => events.push(args),
      events: logEverything,
    },
    pipelineRedisSET: true,
    onError: (err) => {
      throw err;
    },
    defaultUseMemoryCache: false,
  });

  const valuesOnSet = await Promise.all([
    getCached(
      async () => {
        return 111;
      },
      {
        keys: "test",
        ttl: "5 minutes",
      }
    ),
    getCached(
      () => {
        return 222;
      },
      {
        keys: "test2",
        ttl: "Infinity",
      }
    ),
  ]);

  t.is(events.length, 5);

  t.is(events[0].code, "REDIS_GET");
  t.is(events[1].code, "REDIS_GET");

  t.is(events[2].code, "EXECUTION_TIME");

  t.is(events[3].code, "EXECUTION_TIME");

  t.is(events[4].code, "PIPELINED_REDIS_SET");

  t.is(events[4].params.size, 2);

  t.is(events[4].params.ttl, "300,-1");

  t.deepEqual(valuesOnSet, [111, 222]);

  const valuesOnGet = await Promise.all([
    getCached(
      async () => {
        return 111;
      },
      {
        keys: "test",
        ttl: "5 minutes",
      }
    ),
    getCached(
      () => {
        return 222;
      },
      {
        keys: "test2",
        ttl: "Infinity",
      }
    ),
  ]);

  t.is(events.length, 7);

  t.is(events[5].code, "REDIS_GET");
  t.is(events[5].params.cache, "HIT");
  t.is(events[6].code, "REDIS_GET");
  t.is(events[6].params.cache, "HIT");

  t.deepEqual(valuesOnGet, [111, 222]);
});
