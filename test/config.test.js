const test = require("node:test");
const assert = require("node:assert/strict");

const {
  defaultConfig,
  normalizeConfig,
  applyAction,
  requestAction,
  cancelPending,
  flushPending,
  actionLoosens,
  nextPendingDeadline,
  DEFAULT_DELAY_MINUTES,
  MIN_DELAY_MINUTES,
} = require("../src/common/config.js");

const NOW = 1_000_000_000_000;
const site = (config, id) => config.sites.find((s) => s.id === id);

test("normalizeConfig repairs junk and re-seeds built-ins", () => {
  for (const junk of [null, undefined, 42, "nope", {}, { sites: "bad" }]) {
    const config = normalizeConfig(junk);
    assert.equal(config.sites.length, 3);
    assert.equal(config.guardDelayMinutes, DEFAULT_DELAY_MINUTES);
    assert.deepEqual(config.pending, []);
  }
});

test("normalizeConfig keeps user edits to built-in sites", () => {
  const stored = defaultConfig();
  site(stored, "facebook").allow = ["/messages"];
  const config = normalizeConfig(stored);
  assert.deepEqual(site(config, "facebook").allow, ["/messages"]);
  assert.equal(site(config, "facebook").builtin, true);
});

test("a deleted built-in site comes back guarded", () => {
  const stored = defaultConfig();
  stored.sites = stored.sites.filter((s) => s.id !== "instagram");
  const config = normalizeConfig(stored);
  assert.ok(site(config, "instagram"));
  assert.equal(site(config, "instagram").enabled, true);
});

test("normalizeConfig floors an absurdly short delay", () => {
  assert.equal(
    normalizeConfig({ guardDelayMinutes: 0 }).guardDelayMinutes,
    DEFAULT_DELAY_MINUTES
  );
  assert.equal(
    normalizeConfig({ guardDelayMinutes: -5 }).guardDelayMinutes,
    DEFAULT_DELAY_MINUTES
  );
  assert.equal(normalizeConfig({ guardDelayMinutes: 30 }).guardDelayMinutes, 30);
});

test("tightening actions classify as instant", () => {
  const config = defaultConfig();
  for (const action of [
    { type: "enableSite", siteId: "facebook" },
    { type: "removeAllowPath", siteId: "facebook", path: "/marketplace" },
    { type: "addSite", site: { id: "x", label: "X", hosts: ["x.com"], home: "/" } },
    { type: "setDelay", minutes: DEFAULT_DELAY_MINUTES * 2 },
  ]) {
    assert.equal(actionLoosens(action, config), false, action.type);
  }
});

test("loosening actions classify as delayed", () => {
  const config = defaultConfig();
  for (const action of [
    { type: "disableSite", siteId: "instagram" },
    { type: "addAllowPath", siteId: "facebook", path: "/watch" },
    { type: "removeSite", siteId: "custom_x" },
    { type: "setDelay", minutes: MIN_DELAY_MINUTES },
  ]) {
    assert.equal(actionLoosens(action, config), true, action.type);
  }
});

test("tightening applies immediately, with nothing queued", () => {
  const { config, pending } = requestAction(
    defaultConfig(),
    { type: "removeAllowPath", siteId: "facebook", path: "/marketplace" },
    NOW
  );
  assert.equal(pending, null);
  assert.deepEqual(site(config, "facebook").allow, ["/messages"]);
  assert.equal(config.pending.length, 0);
});

test("loosening is queued and does not take effect yet", () => {
  const { config, pending } = requestAction(
    defaultConfig(),
    { type: "disableSite", siteId: "instagram" },
    NOW
  );
  assert.ok(pending);
  assert.equal(site(config, "instagram").enabled, true, "still guarded");
  assert.equal(config.pending.length, 1);
  assert.equal(pending.applyAt, NOW + DEFAULT_DELAY_MINUTES * 60_000);
});

test("a queued loosening lands only once its timer expires", () => {
  const queued = requestAction(
    defaultConfig(),
    { type: "disableSite", siteId: "instagram" },
    NOW
  ).config;

  const early = flushPending(queued, NOW + 60_000);
  assert.equal(early.applied.length, 0);
  assert.equal(site(early.config, "instagram").enabled, true);

  const late = flushPending(queued, NOW + DEFAULT_DELAY_MINUTES * 60_000 + 1);
  assert.equal(late.applied.length, 1);
  assert.equal(site(late.config, "instagram").enabled, false);
  assert.equal(late.config.pending.length, 0);
});

test("cancelling a pending loosening is instant", () => {
  const { config, pending } = requestAction(
    defaultConfig(),
    { type: "addAllowPath", siteId: "facebook", path: "/watch" },
    NOW
  );
  const cancelled = cancelPending(config, pending.id);
  assert.equal(cancelled.pending.length, 0);

  const flushed = flushPending(cancelled, NOW + 10 * 24 * 60 * 60_000);
  assert.equal(
    site(flushed.config, "facebook").allow.includes("/watch"),
    false,
    "a cancelled change must never apply"
  );
});

test("lowering the delay is itself subject to the current delay", () => {
  let config = defaultConfig();
  config = requestAction(config, { type: "setDelay", minutes: 5 }, NOW).config;
  assert.equal(config.guardDelayMinutes, DEFAULT_DELAY_MINUTES);

  // ...and a second loosening queued in the meantime still uses the old delay.
  const second = requestAction(
    config,
    { type: "addAllowPath", siteId: "facebook", path: "/watch" },
    NOW
  );
  assert.equal(
    second.pending.applyAt,
    NOW + DEFAULT_DELAY_MINUTES * 60_000,
    "the short delay must not apply before it has landed"
  );
});

test("raising the delay is instant", () => {
  const { config, pending } = requestAction(
    defaultConfig(),
    { type: "setDelay", minutes: 4320 },
    NOW
  );
  assert.equal(pending, null);
  assert.equal(config.guardDelayMinutes, 4320);
});

test("flushing several due entries applies all of them and keeps the rest", () => {
  let config = defaultConfig();
  config = requestAction(config, { type: "disableSite", siteId: "instagram" }, NOW).config;
  config = requestAction(
    config,
    { type: "addAllowPath", siteId: "facebook", path: "/watch" },
    NOW
  ).config;
  config.pending.push({
    id: "later",
    createdAt: NOW,
    applyAt: NOW + 10 * 24 * 60 * 60_000,
    label: "much later",
    action: { type: "disableSite", siteId: "facebook" },
  });

  const { config: next, applied } = flushPending(
    config,
    NOW + DEFAULT_DELAY_MINUTES * 60_000 + 1
  );
  assert.equal(applied.length, 2);
  assert.equal(site(next, "instagram").enabled, false);
  assert.ok(site(next, "facebook").allow.includes("/watch"));
  assert.equal(site(next, "facebook").enabled, true, "not yet due");
  assert.equal(next.pending.length, 1);
});

test("nextPendingDeadline reports the soonest timer", () => {
  const config = requestAction(
    defaultConfig(),
    { type: "disableSite", siteId: "instagram" },
    NOW
  ).config;
  assert.equal(nextPendingDeadline(config), NOW + DEFAULT_DELAY_MINUTES * 60_000);
  assert.equal(nextPendingDeadline(defaultConfig()), null);
});

test("custom sites can be added and removed, built-ins cannot be removed", () => {
  let config = applyAction(defaultConfig(), {
    type: "addSite",
    site: { id: "custom_x", label: "X", hosts: ["x.com"], home: "/messages", allow: ["/messages"] },
  });
  assert.ok(site(config, "custom_x"));
  assert.equal(site(config, "custom_x").builtin, false);

  config = applyAction(config, { type: "removeSite", siteId: "custom_x" });
  assert.equal(site(config, "custom_x"), undefined);

  config = applyAction(config, { type: "removeSite", siteId: "instagram" });
  assert.ok(site(config, "instagram"), "built-ins survive removal");
});

test("applyAction never mutates the config it was given", () => {
  const original = defaultConfig();
  const snapshot = JSON.stringify(original);
  applyAction(original, { type: "disableSite", siteId: "instagram" });
  assert.equal(JSON.stringify(original), snapshot);
});
