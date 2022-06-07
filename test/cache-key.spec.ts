import test from "ava";
import { generateCacheKey, keyPrefix } from "./utils";

test("generate key with string", (t) => {
  const key = generateCacheKey("key");
  t.is(key, keyPrefix + ":key");
});

test("generate key with array of strings", (t) => {
  const key = generateCacheKey(["key", "key2"]);
  t.is(key, keyPrefix + ":key:key2");
});

test("generate key with array", (t) => {
  const key = generateCacheKey(["key", "12", 12]);
  t.is(key, keyPrefix + ":key:12:12");
});

test("generate key UPPERCASE", (t) => {
  const key = generateCacheKey("KEY");
  t.is(key, keyPrefix + ":key");
});

test("generate key with invalidation", (t) => {
  t.is(generateCacheKey(["a", "*", "c"]), keyPrefix + ":a*c");
  t.is(generateCacheKey(["a", "*", "c", "d"]), keyPrefix + ":a*c:d");
  t.is(generateCacheKey(["a", "b", "*", "d", "e"]), keyPrefix + ":a:b*d:e");
  t.is(generateCacheKey(["a", "b", "*", "d", "*", "f"]), keyPrefix + ":a:b*d*f");
});
