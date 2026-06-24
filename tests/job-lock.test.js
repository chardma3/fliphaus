const test = require("node:test");
const assert = require("node:assert/strict");

const lock = require("../api/job-lock");

test("starts idle; acquire takes it; release frees it", () => {
  lock._reset();
  assert.equal(lock.isBusy(), false);
  assert.equal(lock.currentJob(), null);

  assert.equal(lock.acquire("scrape"), true);
  assert.equal(lock.isBusy(), true);
  assert.equal(lock.currentJob(), "scrape");

  lock.release("scrape");
  assert.equal(lock.isBusy(), false);
});

test("a second acquire is refused while held; the holder still owns it", () => {
  lock._reset();
  assert.equal(lock.acquire("scrape"), true);
  assert.equal(lock.acquire("coverage-sweep"), false);
  assert.equal(lock.currentJob(), "scrape");
  lock.release("scrape");
});

test("release by a non-holder is a no-op (can't clobber the real holder)", () => {
  lock._reset();
  lock.acquire("scrape");
  lock.release("coverage-sweep"); // not the holder
  assert.equal(lock.currentJob(), "scrape");
  lock.release("scrape");
  assert.equal(lock.isBusy(), false);
});

test("withLock runs fn while held and releases after, even on throw", async () => {
  lock._reset();
  let ranWhileHeld = false;
  const out = await lock.withLock("coverage-sweep", async () => {
    ranWhileHeld = lock.currentJob() === "coverage-sweep";
    return 42;
  });
  assert.equal(ranWhileHeld, true);
  assert.equal(out, 42);
  assert.equal(lock.isBusy(), false);

  await assert.rejects(
    lock.withLock("coverage-sweep", async () => { throw new Error("boom"); }),
    /boom/
  );
  assert.equal(lock.isBusy(), false, "lock released after a throw");
});

test("withLock skips (does not run fn) when the lock is already held", async () => {
  lock._reset();
  lock.acquire("scrape");
  let ran = false;
  const out = await lock.withLock("coverage-sweep", async () => { ran = true; });
  assert.equal(ran, false);
  assert.deepEqual(out, { skipped: true, busyWith: "scrape" });
  lock.release("scrape");
});
