import assert from "node:assert/strict";
import { test } from "node:test";
import { everyThread, THREAD_PAGE } from "./all-threads.ts";

/** bb's list call over `total` threads, with the calls it got. */
function bbWith(total: number) {
  const calls: { limit: number; offset: number }[] = [];
  const list = async (page: { limit: number; offset: number }) => {
    calls.push(page);
    return Array.from({ length: Math.max(0, Math.min(page.limit, total - page.offset)) }, (_, i) => `thr_${page.offset + i}`);
  };
  return { list, calls };
}

test("threads past the first page are read too", async () => {
  const bb = bbWith(629);
  const threads = await everyThread(bb.list);
  assert.equal(threads.length, 629);
  assert.equal(new Set(threads).size, 629);
  assert.equal(threads.at(-1), "thr_628");
  assert.deepEqual(bb.calls, [{ limit: THREAD_PAGE, offset: 0 }, { limit: THREAD_PAGE, offset: THREAD_PAGE }]);
});

test("a full last page is followed by one more read, a short one ends it", async () => {
  assert.equal((await everyThread(bbWith(THREAD_PAGE).list)).length, THREAD_PAGE);
  assert.equal(bbWith(0).calls.length, 0);
  const few = bbWith(12);
  assert.equal((await everyThread(few.list)).length, 12);
  assert.equal(few.calls.length, 1);
  const exact = bbWith(THREAD_PAGE * 2);
  assert.equal((await everyThread(exact.list)).length, THREAD_PAGE * 2);
  assert.equal(exact.calls.length, 3);
});
