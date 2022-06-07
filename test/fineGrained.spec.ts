import test from "ava";
import { join } from "path";

import { getCached, invalidateCache, memoryCache, redis } from "./utils";

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
    await new Promise((resolve) => setTimeout(resolve, 50));

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
    await new Promise((resolve) => setTimeout(resolve, 50));

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
    await new Promise((resolve) => setTimeout(resolve, 50));

    return "hello world" as const;
  }

  memoryCache.clear();
  const data = await getCached(cb, {
    keys: ["test", 1],
    ttl: "10 seconds",
  });

  t.is(data, "hello world");
  t.is(calls, 1);

  memoryCache.clear();
  const data2 = await getCached(cb, {
    keys: ["test", 1],
    ttl: "10 seconds",
  });

  t.is(data2, data);
  t.is(calls, 1);

  await invalidateCache("test", "*");

  const data3 = await getCached(cb, {
    keys: "test",
    ttl: "10 seconds",
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

    await new Promise((resolve) => setTimeout(resolve, 10));

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
  await new Promise((resolve) => setTimeout(resolve, 1000));

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
  await new Promise((resolve) => setTimeout(resolve, 1000));

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
    await new Promise((resolve) => setTimeout(resolve, 50));

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
