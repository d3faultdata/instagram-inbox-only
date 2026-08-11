/**
 * Page-side guard. Runs at document_start in the isolated world.
 *
 * Three layers, deliberately overlapping:
 *   1. CSS that dims and disables out-of-scope links (no MutationObserver —
 *      the old version rescanned the whole document on every mutation, which
 *      is brutal on a live DM thread)
 *   2. A capture-phase click interceptor for links the SPA routes in JS
 *   3. A location watcher, as a net for history changes neither of the above
 *      nor the network layer sees
 */
(function () {
  const { siteForUrl, isAllowedPath, buildCss, homeUrl, loadConfig } =
    globalThis.InboxOnly;

  const PROVISIONAL_ID = "inbox-only-provisional";
  const STYLE_ID = "inbox-only-style";

  /**
   * Config lives in async storage, but chrome hangs its own nav bar in the
   * first paint. Hide the landmarks up front and reconcile once the real
   * config arrives — a few ms of hidden nav on a site we turn out not to
   * guard is a far better failure than a flash of the feed on one we do.
   */
  function injectProvisional() {
    if (!document.documentElement) return;
    const style = document.createElement("style");
    style.id = PROVISIONAL_ID;
    style.textContent = `nav[role="navigation"],[role="banner"]{display:none!important}`;
    document.documentElement.appendChild(style);
  }

  function clearProvisional() {
    document.getElementById(PROVISIONAL_ID)?.remove();
  }

  function injectSiteCss(site) {
    const css = buildCss(site);
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = css;
    clearProvisional();
  }

  function enforce(site) {
    if (isAllowedPath(location.pathname, site)) return false;
    // replace() rather than assign() so the blocked page never lands in
    // history — otherwise Back walks straight into it.
    location.replace(homeUrl(site, location.href));
    return true;
  }

  function interceptClicks(site) {
    document.addEventListener(
      "click",
      (event) => {
        const anchor = event.target?.closest?.("a[href]");
        if (!anchor) return;

        let url;
        try {
          url = new URL(anchor.getAttribute("href"), location.href);
        } catch {
          return;
        }
        if (url.origin !== location.origin) return; // leaving the site is fine
        if (isAllowedPath(url.pathname, site)) return;

        event.preventDefault();
        event.stopImmediatePropagation();
      },
      true
    );
  }

  /**
   * Backstop for in-page navigation. Patching history.pushState from the
   * isolated world would not affect the page's own copy, and injecting into
   * the MAIN world just to observe it is not worth the exposure — a cheap
   * string comparison covers the same ground.
   */
  function watchLocation(site) {
    let last = location.href;
    const check = () => {
      if (location.href === last) return;
      last = location.href;
      enforce(site);
    };
    window.addEventListener("popstate", check);
    window.addEventListener("hashchange", check);
    setInterval(check, 400);
  }

  async function start() {
    injectProvisional();

    let config;
    try {
      config = await loadConfig();
    } catch {
      clearProvisional(); // storage unavailable: fail open rather than break the page
      return;
    }

    const site = siteForUrl(location.href, config.sites);
    if (!site) {
      clearProvisional();
      return;
    }

    injectSiteCss(site);
    if (enforce(site)) return; // navigating away; no point wiring listeners
    interceptClicks(site);
    watchLocation(site);
  }

  start();
})();
