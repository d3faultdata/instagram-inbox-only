/**
 * Keeps the browser state in sync with the stored config:
 *   - declarativeNetRequest rules that redirect full page loads
 *   - dynamically registered content scripts, one per guarded site
 *   - an alarm that lands pending (loosening) changes when their timer expires
 *
 * Everything is derived from storage and rebuilt from scratch on every sync,
 * so a partial write or a corrupted rule set self-heals on the next event
 * rather than silently leaving the guard down.
 */
importScripts("../common/matcher.js", "../common/config.js");

const {
  siteForUrl,
  buildAllowRegex,
  normalizePath,
  loadConfig,
  saveConfig,
  flushPending,
  nextPendingDeadline,
} = globalThis.InboxOnly;

const PENDING_ALARM = "inbox-only-pending";
const CONTENT_SCRIPT_PREFIX = "inbox-only-guard-";

/* ------------------------------------------------------------ DNR rules */

/**
 * Two rules per site. The higher-priority "allow" rule exempts every
 * permitted prefix; anything it does not match falls through to the redirect.
 * Expressing it this way keeps the negation in DNR instead of in a regex.
 */
function buildRules(sites) {
  const rules = [];
  let id = 1;

  for (const site of sites) {
    if (site.enabled === false) continue;
    const domains = expandHosts(site.hosts);
    if (!domains.length) continue;

    rules.push({
      id: id++,
      priority: 2,
      action: { type: "allow" },
      condition: {
        resourceTypes: ["main_frame"],
        requestDomains: domains,
        regexFilter: buildAllowRegex(site),
      },
    });

    rules.push({
      id: id++,
      priority: 1,
      action: {
        type: "redirect",
        // transform keeps the current scheme and host, so m.facebook.com
        // stays on m.facebook.com instead of bouncing to www.
        redirect: { transform: { path: normalizePath(site.home), query: "" } },
      },
      condition: {
        resourceTypes: ["main_frame"],
        requestDomains: domains,
      },
    });
  }
  return rules;
}

/** requestDomains matches subdomains already; include the bare host too. */
function expandHosts(hosts) {
  return [...new Set((hosts || []).map((h) => String(h).toLowerCase()))];
}

async function syncRules(config) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules: buildRules(config.sites),
  });
}

/* -------------------------------------------------------- content scripts */

function matchPatterns(site) {
  const patterns = [];
  for (const host of site.hosts || []) {
    patterns.push(`*://${host}/*`, `*://*.${host}/*`);
  }
  return patterns;
}

/**
 * Registered dynamically rather than declared in the manifest so that custom
 * sites added by the user are guarded without an extension reload.
 */
async function syncContentScripts(config) {
  const registered = await chrome.scripting.getRegisteredContentScripts();
  const stale = registered
    .filter((s) => s.id.startsWith(CONTENT_SCRIPT_PREFIX))
    .map((s) => s.id);
  if (stale.length) {
    await chrome.scripting.unregisterContentScripts({ ids: stale });
  }

  const scripts = config.sites
    .filter((site) => site.enabled !== false)
    .map((site) => ({
      id: CONTENT_SCRIPT_PREFIX + site.id,
      matches: matchPatterns(site),
      js: ["src/common/matcher.js", "src/common/config.js", "src/content/guard.js"],
      runAt: "document_start",
      allFrames: false,
      persistAcrossSessions: true,
    }));

  for (const script of scripts) {
    try {
      await chrome.scripting.registerContentScripts([script]);
    } catch (err) {
      // A site the user has not granted host permission for; skip it rather
      // than aborting the whole sync and leaving other sites unguarded.
      console.warn("[inbox-only] could not register guard for", script.id, err);
    }
  }
}

/* ------------------------------------------------------------- scheduling */

async function schedulePendingAlarm(config) {
  const deadline = nextPendingDeadline(config);
  await chrome.alarms.clear(PENDING_ALARM);
  if (deadline == null) return;
  await chrome.alarms.create(PENDING_ALARM, {
    when: Math.max(deadline, Date.now() + 1000),
  });
}

/* ------------------------------------------------------------------- sync */

let syncing = null;

async function sync() {
  // Serialise: storage.onChanged can fire while an earlier sync is mid-flight,
  // and two concurrent rule rebuilds can interleave into an empty rule set.
  syncing = (syncing || Promise.resolve()).then(async () => {
    let config = await loadConfig();

    const { config: flushed, applied } = flushPending(config);
    if (applied.length) {
      config = await saveConfig(flushed); // re-enters sync via onChanged
    }

    await Promise.all([syncRules(config), syncContentScripts(config)]);
    await schedulePendingAlarm(config);
    return config;
  });
  return syncing;
}

chrome.runtime.onInstalled.addListener(() => sync());
chrome.runtime.onStartup.addListener(() => sync());

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PENDING_ALARM) sync();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[globalThis.InboxOnly.STORAGE_KEY]) sync();
});

/**
 * Backstop for SPA navigations that never hit the network layer: DNR only
 * sees main_frame requests, so a pushState into the feed is invisible to it.
 * The content guard catches these too; this covers the window before the
 * guard has loaded its config.
 */
chrome.webNavigation?.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const config = await loadConfig();
  const site = siteForUrl(details.url, config.sites);
  if (!site) return;
  if (globalThis.InboxOnly.isAllowedPath(new URL(details.url).pathname, site)) return;
  chrome.tabs.update(details.tabId, {
    url: globalThis.InboxOnly.homeUrl(site, details.url),
  });
});

sync();
