/**
 * Site registry, storage access and the commitment-delay machinery.
 *
 * The delay is asymmetric on purpose. Tightening the rules is free and
 * instant; loosening them is queued and only lands after `guardDelayMinutes`.
 * That puts the friction at the moment of weakness rather than relying on
 * willpower, which is the whole point of this extension.
 */
(function (root, factory) {
  const api = factory(root.InboxOnly || {});
  root.InboxOnly = Object.assign(root.InboxOnly || {}, api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const STORAGE_KEY = "inboxOnlyConfig";
  const CONFIG_VERSION = 2;
  const DEFAULT_DELAY_MINUTES = 24 * 60;
  const MIN_DELAY_MINUTES = 5;

  /**
   * Built-in sites. `allow` is what the user is here for; `alwaysAllow` covers
   * login, checkpoint and 2FA routes — without those, a logged-out session
   * ping-pongs between the site's auth redirect and ours.
   */
  const BUILTIN_SITES = [
    {
      id: "instagram",
      label: "Instagram",
      builtin: true,
      enabled: true,
      hosts: ["instagram.com"],
      home: "/direct/inbox/",
      allow: ["/direct"],
      alwaysAllow: ["/accounts", "/challenge", "/two_factor"],
      hideChrome: true,
    },
    {
      id: "facebook",
      label: "Facebook",
      builtin: true,
      enabled: true,
      hosts: ["facebook.com"],
      home: "/messages/",
      allow: ["/messages", "/marketplace"],
      alwaysAllow: ["/login", "/login.php", "/checkpoint", "/recover"],
      hideChrome: true,
    },
    {
      id: "messenger",
      label: "Messenger",
      builtin: true,
      enabled: true,
      hosts: ["messenger.com"],
      home: "/",
      allow: ["/"],
      alwaysAllow: [],
      hideChrome: false,
    },
  ];

  function defaultConfig() {
    return {
      version: CONFIG_VERSION,
      guardDelayMinutes: DEFAULT_DELAY_MINUTES,
      sites: clone(BUILTIN_SITES),
      pending: [],
    };
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  /**
   * Repairs anything missing or malformed and re-seeds built-ins that were
   * never customised, so a partial write can never leave the guard unarmed.
   */
  function normalizeConfig(raw) {
    const base = defaultConfig();
    if (!raw || typeof raw !== "object") return base;

    const sites = Array.isArray(raw.sites) ? raw.sites.filter(Boolean) : [];
    const byId = new Map(sites.map((s) => [s.id, s]));

    for (const builtin of BUILTIN_SITES) {
      const stored = byId.get(builtin.id);
      byId.set(
        builtin.id,
        stored
          ? { ...builtin, ...stored, builtin: true, id: builtin.id }
          : clone(builtin)
      );
    }

    const merged = [...byId.values()].map((site) => ({
      ...site,
      hosts: (site.hosts || []).map((h) => String(h).toLowerCase()),
      allow: dedupe(site.allow || []),
      alwaysAllow: dedupe(site.alwaysAllow || []),
      enabled: site.enabled !== false,
      home: site.home || "/",
    }));

    const delay = Number(raw.guardDelayMinutes);

    return {
      version: CONFIG_VERSION,
      guardDelayMinutes:
        Number.isFinite(delay) && delay >= MIN_DELAY_MINUTES
          ? Math.round(delay)
          : base.guardDelayMinutes,
      sites: merged,
      pending: Array.isArray(raw.pending) ? raw.pending.filter(isPending) : [],
    };
  }

  function isPending(entry) {
    return (
      entry &&
      typeof entry.id === "string" &&
      typeof entry.applyAt === "number" &&
      entry.action &&
      typeof entry.action.type === "string"
    );
  }

  function dedupe(list) {
    return [...new Set(list.map((v) => String(v).trim()).filter(Boolean))];
  }

  /* ---------------------------------------------------------------- storage */

  async function loadConfig() {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    return normalizeConfig(stored[STORAGE_KEY]);
  }

  async function saveConfig(config) {
    const normalized = normalizeConfig(config);
    await chrome.storage.local.set({ [STORAGE_KEY]: normalized });
    return normalized;
  }

  /* ---------------------------------------------------------------- actions */

  /**
   * Every mutation the options page can request, tagged with whether it
   * loosens the guard. Loosening actions get queued; the rest apply at once.
   */
  const ACTIONS = {
    enableSite: { loosens: false, describe: (a) => `Enable guard on ${a.siteId}` },
    disableSite: { loosens: true, describe: (a) => `Disable guard on ${a.siteId}` },
    addAllowPath: {
      loosens: true,
      describe: (a) => `Allow ${a.path} on ${a.siteId}`,
    },
    removeAllowPath: {
      loosens: false,
      describe: (a) => `Block ${a.path} on ${a.siteId}`,
    },
    addSite: { loosens: false, describe: (a) => `Guard ${a.site.label}` },
    removeSite: { loosens: true, describe: (a) => `Stop guarding ${a.siteId}` },
    setDelay: {
      loosens: true, // overridden below when the delay is being raised
      describe: (a) => `Set commitment delay to ${a.minutes} min`,
    },
  };

  function actionLoosens(action, config) {
    if (action.type === "setDelay") {
      return Number(action.minutes) < Number(config.guardDelayMinutes);
    }
    return Boolean(ACTIONS[action.type] && ACTIONS[action.type].loosens);
  }

  function describeAction(action) {
    const spec = ACTIONS[action.type];
    return spec ? spec.describe(action) : action.type;
  }

  /** Applies an action to a config object, returning a new config. */
  function applyAction(config, action) {
    const next = normalizeConfig(clone(config));
    const site = next.sites.find((s) => s.id === action.siteId);

    switch (action.type) {
      case "enableSite":
        if (site) site.enabled = true;
        break;
      case "disableSite":
        if (site) site.enabled = false;
        break;
      case "addAllowPath":
        if (site) site.allow = dedupe([...site.allow, action.path]);
        break;
      case "removeAllowPath":
        if (site) site.allow = site.allow.filter((p) => p !== action.path);
        break;
      case "addSite":
        next.sites.push({
          hideChrome: true,
          enabled: true,
          alwaysAllow: [],
          ...action.site,
          builtin: false,
        });
        break;
      case "removeSite":
        next.sites = next.sites.filter((s) => s.id !== action.siteId || s.builtin);
        break;
      case "setDelay":
        next.guardDelayMinutes = Math.max(
          MIN_DELAY_MINUTES,
          Math.round(Number(action.minutes))
        );
        break;
    }
    return normalizeConfig(next);
  }

  /**
   * Requests an action. Tightening applies immediately; loosening is queued
   * and returned as a pending entry so the UI can show a countdown.
   */
  function requestAction(config, action, now = Date.now()) {
    if (!actionLoosens(action, config)) {
      return { config: applyAction(config, action), pending: null };
    }
    const entry = {
      id: `p_${now}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now,
      applyAt: now + config.guardDelayMinutes * 60_000,
      label: describeAction(action),
      action,
    };
    const next = normalizeConfig(clone(config));
    next.pending = [...next.pending, entry];
    return { config: next, pending: entry };
  }

  /** Cancelling a queued loosening is itself a tightening — always instant. */
  function cancelPending(config, pendingId) {
    const next = normalizeConfig(clone(config));
    next.pending = next.pending.filter((p) => p.id !== pendingId);
    return next;
  }

  /** Applies every pending entry whose timer has elapsed. */
  function flushPending(config, now = Date.now()) {
    let next = normalizeConfig(clone(config));
    const due = next.pending.filter((p) => p.applyAt <= now);
    if (!due.length) return { config: next, applied: [] };

    next.pending = next.pending.filter((p) => p.applyAt > now);
    for (const entry of due) {
      const pendingCarry = next.pending;
      next = applyAction(next, entry.action);
      next.pending = pendingCarry;
    }
    return { config: next, applied: due };
  }

  function nextPendingDeadline(config) {
    const times = (config.pending || []).map((p) => p.applyAt);
    return times.length ? Math.min(...times) : null;
  }

  return {
    STORAGE_KEY,
    CONFIG_VERSION,
    DEFAULT_DELAY_MINUTES,
    MIN_DELAY_MINUTES,
    BUILTIN_SITES,
    defaultConfig,
    normalizeConfig,
    loadConfig,
    saveConfig,
    actionLoosens,
    describeAction,
    applyAction,
    requestAction,
    cancelPending,
    flushPending,
    nextPendingDeadline,
  };
});
