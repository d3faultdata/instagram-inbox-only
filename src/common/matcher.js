/**
 * Pure URL / path matching logic shared by the service worker, the content
 * guard and the options page.
 *
 * Nothing in here touches chrome.* or the DOM, so it runs unchanged in Node
 * under test. Loaded as a classic script (importScripts / content_scripts),
 * exporting onto globalThis.InboxOnly.
 */
(function (root, factory) {
  const api = factory();
  root.InboxOnly = Object.assign(root.InboxOnly || {}, api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  /** Subdomains treated as the same site, so m.facebook.com === facebook.com. */
  const HOST_PREFIXES = ["www.", "m.", "mobile.", "web.", "mbasic.", "touch."];

  function normalizeHost(host) {
    let h = String(host || "").toLowerCase();
    if (h.includes(":")) h = h.split(":")[0];
    for (const prefix of HOST_PREFIXES) {
      if (h.startsWith(prefix)) return h.slice(prefix.length);
    }
    return h;
  }

  /**
   * Path prefix match that respects segment boundaries: "/marketplace" matches
   * "/marketplace", "/marketplace/" and "/marketplace/item/1" but never
   * "/marketplace-scam".
   */
  function pathMatchesPrefix(path, prefix) {
    if (!prefix) return false;
    const p = normalizePath(path);
    let q = normalizePath(prefix);
    if (q === "/") return true;
    if (q.endsWith("/")) q = q.slice(0, -1);
    if (p === q) return true;
    return p.startsWith(q + "/");
  }

  function normalizePath(path) {
    let p = String(path || "/");
    const cut = p.search(/[?#]/);
    if (cut !== -1) p = p.slice(0, cut);
    if (!p.startsWith("/")) p = "/" + p;
    return p;
  }

  /** Every path prefix a site permits: explicit allow list, home, auth escapes. */
  function allowedPrefixes(site) {
    if (!site) return [];
    return [
      ...(site.allow || []),
      ...(site.alwaysAllow || []),
      site.home || "/",
    ].filter(Boolean);
  }

  function isAllowedPath(path, site) {
    return allowedPrefixes(site).some((prefix) =>
      pathMatchesPrefix(path, prefix)
    );
  }

  /** The enabled site governing this URL, or null if the URL is none of ours. */
  function siteForUrl(url, sites) {
    let host;
    try {
      host = normalizeHost(new URL(url).hostname);
    } catch {
      return null;
    }
    const list = Array.isArray(sites) ? sites : Object.values(sites || {});
    return (
      list.find(
        (site) =>
          site &&
          site.enabled !== false &&
          (site.hosts || []).some((h) => normalizeHost(h) === host)
      ) || null
    );
  }

  function isAllowedUrl(url, sites) {
    const site = siteForUrl(url, sites);
    if (!site) return true;
    try {
      return isAllowedPath(new URL(url).pathname, site);
    } catch {
      return true;
    }
  }

  function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * RE2-compatible regexFilter for a declarativeNetRequest "allow" rule that
   * exempts every permitted prefix of a site. Host is constrained separately
   * via the rule's requestDomains condition.
   */
  function buildAllowRegex(site) {
    const alternatives = allowedPrefixes(site)
      .map((prefix) => {
        let p = normalizePath(prefix);
        if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
        return p;
      })
      .filter((p, i, arr) => arr.indexOf(p) === i);

    if (alternatives.includes("/")) return "^https?://";

    const body = alternatives.map(escapeRegex).join("|");
    return `^https?://[^/]+(${body})([/?#]|$)`;
  }

  /**
   * CSS that dims and disables in-site links pointing outside the allow list.
   * Pure CSS so there is no MutationObserver churn on chatty SPA pages: dim
   * every same-site link, then restore the permitted prefixes.
   */
  function buildCss(site) {
    const rules = [];

    if (site.hideChrome !== false) {
      rules.push(
        `nav[role="navigation"],[role="banner"]{display:none!important}`
      );
    }

    const linkSelectors = [`a[href^="/"]`];
    for (const host of site.hosts || []) {
      linkSelectors.push(`a[href^="https://${host}/"]`);
      linkSelectors.push(`a[href^="http://${host}/"]`);
    }

    const allowSelectors = [];
    for (const prefix of allowedPrefixes(site)) {
      let p = normalizePath(prefix);
      if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
      if (p === "/") return rules.join("\n");
      allowSelectors.push(`a[href^="${p}"]`);
      for (const host of site.hosts || []) {
        allowSelectors.push(`a[href^="https://${host}${p}"]`);
        allowSelectors.push(`a[href^="http://${host}${p}"]`);
      }
    }

    rules.push(
      `${linkSelectors.join(",")}{opacity:.3!important;pointer-events:none!important;cursor:default!important}`
    );
    if (allowSelectors.length) {
      rules.push(
        `${allowSelectors.join(",")}{opacity:1!important;pointer-events:auto!important;cursor:pointer!important}`
      );
    }
    return rules.join("\n");
  }

  /** Absolute URL of a site's landing page, preserving the current host. */
  function homeUrl(site, currentUrl) {
    const home = normalizePath(site.home || "/");
    try {
      const u = new URL(currentUrl);
      return `${u.protocol}//${u.host}${home}`;
    } catch {
      const host = (site.hosts || [])[0] || "";
      return `https://${host}${home}`;
    }
  }

  return {
    HOST_PREFIXES,
    normalizeHost,
    normalizePath,
    pathMatchesPrefix,
    allowedPrefixes,
    isAllowedPath,
    isAllowedUrl,
    siteForUrl,
    buildAllowRegex,
    buildCss,
    homeUrl,
    escapeRegex,
  };
});
