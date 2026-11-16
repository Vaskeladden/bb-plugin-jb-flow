import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { orStop, pause, stopOf } from "./service-stop.ts";

/** "stopped" when `service` returns within bb's patience (scaled down), "still running" otherwise. */
const outcome = (service: Promise<void>) =>
  Promise.race([service.then(() => "stopped"), new Promise((resolve) => setTimeout(() => resolve("still running"), 200))]);
const never = new Promise<void>(() => undefined);

test("a signal that has already aborted still ends every wait", async () => {
  // The bug this file exists for: a listener added after the abort never
  // fires, so a backfill stopped during its last step waited for ever.
  const stop = new AbortController();
  stop.abort();
  assert.equal(await outcome(stopOf(stop.signal)), "stopped");
  assert.equal(await outcome(orStop(stop.signal, never)), "stopped");
  assert.equal(await outcome(pause(stop.signal, 60_000)), "stopped");
});

test("a stop ends the wait while the work is still going", async () => {
  const stop = new AbortController();
  const waits = [stopOf(stop.signal), orStop(stop.signal, never), pause(stop.signal, 60_000)];
  assert.equal(await outcome(waits[1]!), "still running");
  stop.abort();
  for (const wait of waits) assert.equal(await outcome(wait), "stopped");
});

test("work that finishes or fails before the stop decides the result", async () => {
  const stop = new AbortController();
  await orStop(stop.signal, Promise.resolve("done"));
  await assert.rejects(orStop(stop.signal, Promise.reject(new Error("read failed"))), /read failed/);
  const started = Date.now();
  await pause(stop.signal, 20);
  assert.ok(Date.now() - started >= 15);
});

test("work that fails after the stop is dropped without an unhandled rejection", async () => {
  const stop = new AbortController();
  let fail!: (error: Error) => void;
  const work = new Promise<void>((_, reject) => (fail = reject));
  const wait = orStop(stop.signal, work);
  stop.abort();
  await wait;
  fail(new Error("bb object invalidated"));
  await new Promise((resolve) => setTimeout(resolve, 10));
});

test("a service that loops for days leaves no listeners behind on its signal", async () => {
  const added: unknown[] = [];
  const signal = {
    aborted: false,
    addEventListener: (_: string, listener: unknown) => void added.push(listener),
    removeEventListener: (_: string, listener: unknown) => void added.splice(added.indexOf(listener), 1),
  } as unknown as AbortSignal;
  for (let round = 0; round < 3; round += 1) {
    await orStop(signal, Promise.resolve());
    await pause(signal, 1);
  }
  assert.equal(added.length, 0);
});

test("every background service waits through this file, never on the signal itself", () => {
  const sources = readdirSync(import.meta.dirname).filter((name) => /\.tsx?$/.test(name) && !name.includes(".test.") && name !== "service-stop.ts");
  const services = sources.filter((name) => readFileSync(`${import.meta.dirname}/${name}`, "utf8").includes("bb.background.service("));
  assert.deepEqual(services.sort(), ["awaiting.ts", "git-clean.ts", "pr-hub.ts", "prs.ts", "watchers.ts"]);
  for (const name of services) {
    const source = readFileSync(`${import.meta.dirname}/${name}`, "utf8");
    assert.match(source, /from "\.\/service-stop\.ts"/, `${name} has a service but does not use service-stop.ts`);
    assert.doesNotMatch(source, /addEventListener\("abort"/, `${name} waits on an abort signal itself`);
  }
});
