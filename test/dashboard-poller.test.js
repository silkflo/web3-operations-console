// test/dashboard-poller.test.js
//
// The browser side of the incident.
//
// The console used to run `setInterval(load, 15000)` where `load` fetched
// `/health`, `/splits` and `/summary` concurrently. Nothing stopped a new round
// starting while the previous one was still outstanding, and nothing stopped it
// running in a background tab. When the API slowed down, the page kept adding
// requests to a backend that was already failing.
//
// These tests drive lib/dashboard-poller.js directly with an injected clock,
// injected timers and an injected visibility source, so they are deterministic
// and take milliseconds rather than minutes.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createDashboardPoller,
  resolveRefreshIntervalMs,
  DEFAULT_REFRESH_MS,
  MIN_REFRESH_MS,
  MAX_REFRESH_MS,
} = require("../lib/dashboard-poller");

/** Deterministic clock plus timer queue. `advance` runs what is now due. */
const createTestScheduler = () => {
  let clock = 0;
  let nextId = 1;
  const timers = new Map();

  return {
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { fn, dueAt: clock + ms });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id);
    },
    pending: () => timers.size,
    /** Advances time and fires every timer that came due, oldest first. */
    advance: async (ms) => {
      clock += ms;

      const due = [...timers.entries()]
        .filter(([, timer]) => timer.dueAt <= clock)
        .sort((a, b) => a[1].dueAt - b[1].dueAt);

      for (const [id, timer] of due) {
        timers.delete(id);
        timer.fn();
        // Let the load promise chain settle before the next timer fires.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      }
    },
  };
};

/** Controllable stand-in for document.visibilityState. */
const createTestVisibility = (hidden = false) => {
  const listeners = new Set();

  return {
    isHidden: () => hidden,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (nextHidden) => {
      hidden = nextHidden;
      listeners.forEach((listener) => listener(!hidden));
    },
  };
};

/** A load function whose completion the test controls. */
const createGatedLoad = () => {
  const calls = [];
  let resolveCurrent = null;

  return {
    calls,
    load: ({ reason }) => {
      calls.push(reason);
      return new Promise((resolve) => {
        resolveCurrent = resolve;
      });
    },
    finish: async () => {
      if (resolveCurrent) {
        resolveCurrent();
        resolveCurrent = null;
      }

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
};

// ------------------------------------------------------------ configuration ----

test("the refresh interval is clamped to a sane range", () => {
  assert.equal(resolveRefreshIntervalMs(undefined), DEFAULT_REFRESH_MS);
  assert.equal(resolveRefreshIntervalMs(""), DEFAULT_REFRESH_MS);
  assert.equal(resolveRefreshIntervalMs("not a number"), DEFAULT_REFRESH_MS);
  assert.equal(resolveRefreshIntervalMs("0"), DEFAULT_REFRESH_MS);

  // The old 15s poll is below the floor and cannot be reintroduced by config.
  assert.equal(resolveRefreshIntervalMs("15000"), MIN_REFRESH_MS);
  assert.equal(resolveRefreshIntervalMs("99999999"), MAX_REFRESH_MS);
  assert.equal(resolveRefreshIntervalMs("90000"), 90000);
});

test("the shipped default sits in the intended 60-120s band", () => {
  assert.ok(DEFAULT_REFRESH_MS >= 60000 && DEFAULT_REFRESH_MS <= 120000);
});

// ---------------------------------------------------------------- overlap ----

test("a refresh never starts while one is in flight", async () => {
  const scheduler = createTestScheduler();
  const gated = createGatedLoad();

  const poller = createDashboardPoller({
    load: gated.load,
    intervalMs: 60000,
    now: scheduler.now,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    visibility: createTestVisibility(false),
  });

  poller.start();
  await Promise.resolve();

  assert.equal(gated.calls.length, 1, "one initial load");
  assert.equal(poller.isRefreshing(), true);

  // Everything that could race: the interval, a manual retry, another manual.
  poller.refresh({ reason: "manual" });
  poller.refresh({ reason: "manual" });
  await scheduler.advance(120000);

  assert.equal(gated.calls.length, 1, "still exactly one load in flight");
  assert.ok(poller.stats().overlapsPrevented >= 2);

  await gated.finish();

  assert.equal(poller.isRefreshing(), false);

  poller.stop();
});

test("the next refresh is scheduled after the previous one finishes", async () => {
  const scheduler = createTestScheduler();
  const gated = createGatedLoad();

  const poller = createDashboardPoller({
    load: gated.load,
    intervalMs: 60000,
    now: scheduler.now,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    visibility: createTestVisibility(false),
  });

  poller.start();
  await Promise.resolve();
  await gated.finish();

  assert.equal(scheduler.pending(), 1, "one timer armed after completion");

  await scheduler.advance(60000);

  assert.equal(gated.calls.length, 2);
  assert.equal(gated.calls[1], "interval");

  poller.stop();
});

// ------------------------------------------------------------- visibility ----

test("polling pauses while the tab is hidden", async () => {
  const scheduler = createTestScheduler();
  const visibility = createTestVisibility(false);
  const gated = createGatedLoad();

  const poller = createDashboardPoller({
    load: gated.load,
    intervalMs: 60000,
    now: scheduler.now,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    visibility,
  });

  poller.start();
  await Promise.resolve();
  await gated.finish();

  assert.equal(gated.calls.length, 1);

  visibility.set(true); // hidden

  assert.equal(scheduler.pending(), 0, "the armed timer is cancelled");

  await scheduler.advance(600000); // ten minutes in a background tab

  assert.equal(gated.calls.length, 1, "a hidden tab makes no requests");
  assert.ok(poller.stats().pauses > 0);

  poller.stop();
});

test("becoming visible refreshes, but only after the minimum interval", async () => {
  const scheduler = createTestScheduler();
  const visibility = createTestVisibility(false);
  const gated = createGatedLoad();

  const poller = createDashboardPoller({
    load: gated.load,
    intervalMs: 60000,
    minVisibleRefreshMs: 30000,
    now: scheduler.now,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    visibility,
  });

  poller.start();
  await Promise.resolve();
  await gated.finish();

  // Hidden and shown again straight away: too soon to be worth a request.
  visibility.set(true);
  await scheduler.advance(5000);
  visibility.set(false);
  await Promise.resolve();

  assert.equal(gated.calls.length, 1, "a quick tab switch costs nothing");
  assert.equal(poller.stats().visibilityRefreshes, 0);

  // Hidden for longer than the minimum: worth refreshing on return.
  visibility.set(true);
  await scheduler.advance(45000);
  visibility.set(false);
  await Promise.resolve();

  assert.equal(gated.calls.length, 2, "a real absence does refresh");
  assert.equal(gated.calls[1], "visible");
  assert.equal(poller.stats().visibilityRefreshes, 1);

  poller.stop();
});

test("a refresh that arrives too soon is scheduled, not dropped", async () => {
  const scheduler = createTestScheduler();
  const visibility = createTestVisibility(false);
  const gated = createGatedLoad();

  const poller = createDashboardPoller({
    load: gated.load,
    intervalMs: 60000,
    minVisibleRefreshMs: 30000,
    now: scheduler.now,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    visibility,
  });

  poller.start();
  await Promise.resolve();
  await gated.finish();

  visibility.set(true);
  await scheduler.advance(5000);
  visibility.set(false);

  assert.equal(scheduler.pending(), 1, "the remainder is armed");

  await scheduler.advance(25000);
  await gated.finish();

  assert.equal(gated.calls.length, 2, "it fires once the minimum has elapsed");

  poller.stop();
});

// ------------------------------------------------------- failure handling ----

test("a failing load does not stop the schedule", async () => {
  const scheduler = createTestScheduler();
  const errors = [];
  let calls = 0;

  const poller = createDashboardPoller({
    load: async () => {
      calls += 1;
      throw new Error("API unreachable");
    },
    intervalMs: 60000,
    now: scheduler.now,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    visibility: createTestVisibility(false),
    onError: (error) => errors.push(error),
  });

  await poller.start();

  assert.equal(calls, 1);
  assert.equal(errors.length, 1, "the failure is reported, not swallowed");
  assert.equal(scheduler.pending(), 1, "and the next attempt is still armed");

  await scheduler.advance(60000);

  assert.equal(calls, 2, "the console recovers on its own");

  poller.stop();
});

test("stop() cancels everything and unsubscribes", async () => {
  const scheduler = createTestScheduler();
  const visibility = createTestVisibility(false);
  const gated = createGatedLoad();

  const poller = createDashboardPoller({
    load: gated.load,
    intervalMs: 60000,
    now: scheduler.now,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    visibility,
  });

  poller.start();
  await Promise.resolve();
  await gated.finish();

  poller.stop();

  assert.equal(scheduler.pending(), 0);

  // An unmounted component must not be woken by a visibility change.
  visibility.set(true);
  visibility.set(false);
  await scheduler.advance(600000);

  assert.equal(gated.calls.length, 1);
});

test("a manual refresh still works and is still not duplicated", async () => {
  const scheduler = createTestScheduler();
  const gated = createGatedLoad();

  const poller = createDashboardPoller({
    load: gated.load,
    intervalMs: 60000,
    now: scheduler.now,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    visibility: createTestVisibility(false),
  });

  poller.start();
  await Promise.resolve();
  await gated.finish();

  const first = poller.refresh({ reason: "manual" });
  const second = poller.refresh({ reason: "manual" });

  assert.equal(first, second, "the second caller joins the first");

  await Promise.resolve();

  assert.equal(gated.calls.length, 2);
  assert.equal(gated.calls[1], "manual");

  await gated.finish();

  poller.stop();
});
