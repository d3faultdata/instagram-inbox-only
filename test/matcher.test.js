const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeHost,
  pathMatchesPrefix,
  isAllowedPath,
  isAllowedUrl,
  siteForUrl,
  buildAllowRegex,
  buildCss,
  homeUrl,
} = require("../src/common/matcher.js");
const { BUILTIN_SITES, normalizeConfig } = require("../src/common/config.js");

const SITES = normalizeConfig(null).sites;
const instagram = SITES.find((s) => s.id === "instagram");
const facebook = SITES.find((s) => s.id === "facebook");

test("normalizeHost strips the usual subdomains and ports", () => {
  assert.equal(normalizeHost("www.facebook.com"), "facebook.com");
  assert.equal(normalizeHost("m.facebook.com"), "facebook.com");
  assert.equal(normalizeHost("web.facebook.com"), "facebook.com");
  assert.equal(normalizeHost("facebook.com:443"), "facebook.com");
  assert.equal(normalizeHost("INSTAGRAM.com"), "instagram.com");
});

test("prefix matching respects segment boundaries", () => {
  assert.ok(pathMatchesPrefix("/marketplace", "/marketplace"));
  assert.ok(pathMatchesPrefix("/marketplace/", "/marketplace"));
  assert.ok(pathMatchesPrefix("/marketplace/item/123", "/marketplace"));
  assert.ok(pathMatchesPrefix("/marketplace?ref=x", "/marketplace"));
  assert.equal(pathMatchesPrefix("/marketplace-scam", "/marketplace"), false);
  assert.equal(pathMatchesPrefix("/market", "/marketplace"), false);
  assert.ok(pathMatchesPrefix("/anything/at/all", "/"));
});

test("instagram allows direct threads, not just the inbox", () => {
  // The v1 bug: /direct/t/<id> bounced back to the inbox on every full load.
  assert.ok(isAllowedPath("/direct/inbox/", instagram));
  assert.ok(isAllowedPath("/direct/t/17845", instagram));
  assert.equal(isAllowedPath("/explore/", instagram), false);
  assert.equal(isAllowedPath("/reels/audio/1", instagram), false);
  assert.equal(isAllowedPath("/someuser/", instagram), false);
  assert.equal(isAllowedPath("/", instagram), false);
});

test("instagram keeps auth routes reachable", () => {
  // Without these a logged-out session ping-pongs with the site's own redirect.
  assert.ok(isAllowedPath("/accounts/login/", instagram));
  assert.ok(isAllowedPath("/challenge/", instagram));
  assert.ok(isAllowedPath("/two_factor/", instagram));
});

test("facebook allows messages and marketplace only", () => {
  assert.ok(isAllowedPath("/messages/", facebook));
  assert.ok(isAllowedPath("/messages/t/1234", facebook));
  assert.ok(isAllowedPath("/marketplace", facebook));
  assert.ok(isAllowedPath("/marketplace/item/998", facebook));
  assert.ok(isAllowedPath("/marketplace/inbox", facebook));
  assert.ok(isAllowedPath("/marketplace/you/selling", facebook));

  assert.equal(isAllowedPath("/", facebook), false);
  assert.equal(isAllowedPath("/groups/123", facebook), false);
  assert.equal(isAllowedPath("/watch", facebook), false);
  assert.equal(isAllowedPath("/notifications", facebook), false);
  assert.equal(isAllowedPath("/reel/1", facebook), false);
  assert.equal(isAllowedPath("/zuck", facebook), false);
});

test("siteForUrl resolves across subdomains and skips disabled sites", () => {
  assert.equal(siteForUrl("https://www.instagram.com/x", SITES).id, "instagram");
  assert.equal(siteForUrl("https://m.facebook.com/x", SITES).id, "facebook");
  assert.equal(siteForUrl("https://www.messenger.com/", SITES).id, "messenger");
  assert.equal(siteForUrl("https://example.com/", SITES), null);
  assert.equal(siteForUrl("not a url", SITES), null);

  const off = SITES.map((s) =>
    s.id === "facebook" ? { ...s, enabled: false } : s
  );
  assert.equal(siteForUrl("https://facebook.com/feed", off), null);
});

test("unguarded sites are never blocked", () => {
  assert.ok(isAllowedUrl("https://example.com/anything", SITES));
  assert.equal(isAllowedUrl("https://www.facebook.com/watch", SITES), false);
});

test("messenger is allowed wholesale", () => {
  const messenger = SITES.find((s) => s.id === "messenger");
  assert.ok(isAllowedPath("/t/123", messenger));
  assert.ok(isAllowedPath("/anything", messenger));
});

test("buildAllowRegex compiles and matches exactly the allowed paths", () => {
  const re = new RegExp(buildAllowRegex(facebook));
  assert.ok(re.test("https://www.facebook.com/messages/t/1"));
  assert.ok(re.test("https://www.facebook.com/marketplace"));
  assert.ok(re.test("https://m.facebook.com/marketplace/item/2?ref=a"));
  assert.equal(re.test("https://www.facebook.com/marketplacezzz"), false);
  assert.equal(re.test("https://www.facebook.com/"), false);
  assert.equal(re.test("https://www.facebook.com/groups/1"), false);
});

test("buildAllowRegex degrades to allow-all for wide-open sites", () => {
  const messenger = SITES.find((s) => s.id === "messenger");
  const re = new RegExp(buildAllowRegex(messenger));
  assert.ok(re.test("https://www.messenger.com/t/9"));
});

test("homeUrl preserves the host the user is actually on", () => {
  assert.equal(
    homeUrl(facebook, "https://m.facebook.com/watch"),
    "https://m.facebook.com/messages/"
  );
  assert.equal(
    homeUrl(instagram, "https://www.instagram.com/explore/"),
    "https://www.instagram.com/direct/inbox/"
  );
});

test("buildCss dims same-site links and restores allowed prefixes", () => {
  const css = buildCss(facebook);
  assert.match(css, /a\[href\^="\/"\]/);
  assert.match(css, /a\[href\^="\/marketplace"\]/);
  assert.match(css, /a\[href\^="\/messages"\]/);
  assert.match(css, /nav\[role="navigation"\]/);
});

test("buildCss on an allow-all site dims nothing", () => {
  const messenger = SITES.find((s) => s.id === "messenger");
  assert.equal(buildCss(messenger).includes("opacity"), false);
});

test("built-in defaults are the ones we documented", () => {
  const fb = BUILTIN_SITES.find((s) => s.id === "facebook");
  assert.deepEqual(fb.allow, ["/messages", "/marketplace"]);
});
