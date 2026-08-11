<img width="1280" height="640" alt="inboxonly-open-graph" src="https://github.com/user-attachments/assets/790ea3d1-9faa-442b-a76a-24ac8131d389" />

# Inbox Only

A browser extension that locks social sites to their messaging pages. Instagram
opens on your DMs, Facebook opens on Messages with Marketplace still reachable,
and everything else on those domains is redirected away.

For people who need these sites for messaging and want nothing else from them.

## What is allowed

| Site | Lands on | Reachable | Blocked |
| --- | --- | --- | --- |
| Instagram | `/direct/inbox/` | DMs and conversation threads, login and 2FA | Feed, explore, reels, profiles, stories |
| Facebook | `/messages/` | Messages, all of Marketplace, login and checkpoints | Feed, groups, watch, reels, notifications, profiles |
| Messenger | `/` | Everything | — |

Any other site can be added yourself: give it a domain, a landing page, and the
paths that stay open.

## How it works

Three layers, deliberately overlapping, because each one has a blind spot the
others cover.

**1. Network redirect.** A `declarativeNetRequest` rule pair per site: a
high-priority `allow` rule exempting the permitted path prefixes, and a
lower-priority `redirect` rule catching everything else. The redirect uses a
path transform, so `m.facebook.com` stays on `m.facebook.com`.

**2. Page CSS.** Links pointing outside the allowed area are dimmed and made
unclickable by a stylesheet generated from the site's config. This is pure CSS
with no DOM mutation, so it costs nothing on a live DM thread and cannot be
undone by a React re-render.

**3. Route guard.** A capture-phase click interceptor plus a location watcher,
backed by `webNavigation.onHistoryStateUpdated` in the service worker. This is
what catches single-page-app navigation — a `pushState` into the feed never
touches the network layer, so the redirect rule never sees it.

## Making it hard to turn off

A pause button defeats the point, so there isn't one. There is no toolbar popup
and no keyboard shortcut. The only place anything can be changed is the options
page, and changes there are asymmetric:

- **Tightening applies instantly** — guarding a site, blocking a path,
  cancelling a queued change, raising the delay.
- **Loosening is queued** — unguarding a site, allowing a new path, removing a
  site, lowering the delay. It sits in a pending list for the commitment delay
  (24 hours by default) with a visible countdown, and only lands when the timer
  expires.

Cancelling a pending change is itself a tightening, so it takes effect at once.
Lowering the delay is subject to the *current* delay, so it cannot be used to
shorten its own wait.

### The honest limit

**No extension can prevent you from disabling it.** `chrome://extensions` is
always there, and nothing running inside the browser can take that away. Every
mechanism above is friction, placed where the impulse actually happens.

If you want a real lock, force-install the extension with an enterprise policy
on your own machine. On Linux, drop a file in
`/etc/opt/chrome/policies/managed/`:

```json
{
  "ExtensionInstallForcelist": ["<extension-id>;<update-url>"],
  "ExtensionSettings": {
    "<extension-id>": { "installation_mode": "force_installed" }
  }
}
```

A force-installed extension cannot be disabled or removed from the extensions
page, and reverting the policy needs root. That is the only genuine lock
available.

## Install

1. Clone the repository
2. Open `chrome://extensions` (or `brave://extensions`, `edge://extensions`)
3. Enable **Developer mode**
4. **Load unpacked** → select the folder containing `manifest.json`

Settings live at **Extensions → Inbox Only → Details → Extension options**.

## Adding a site

On the options page, give the site a domain, the page it should land on, and
the path prefixes that stay reachable. Prefixes match whole segments, so
`/messages` allows `/messages/t/123` but never `/messages-archive`. The browser
will ask for permission for that domain.

Adding a site is a tightening change, so it applies immediately.

## Development

```bash
npm install
npm run test:unit     # matcher and commitment-delay logic
npm run test:e2e      # loads the real extension into Chromium
npm test              # both
```

The end-to-end tests stage the extension into a temp directory, widen its host
permissions to `localhost`, and drive it against fixture pages through
Playwright — the actual service worker, the actual DNR rules, the actual
content guard. They need the full Chromium build rather than the headless
shell; set `CHROMIUM_PATH` to point at one if it is not auto-detected.

### Layout

```
manifest.json
src/common/matcher.js      URL and path matching (pure, no chrome.*)
src/common/config.js       site registry, storage, commitment delay
src/background/            DNR rules, script registration, timers
src/content/guard.js       page-side enforcement
src/options/               settings UI
test/                      unit tests
test/e2e/                  Playwright tests against a real browser
scripts/validate-manifest.js
```

`matcher.js` and `config.js` hold all the logic and touch neither the DOM nor
the extension APIs, which is why the unit tests can run them directly in Node.

## Privacy

No analytics, no external requests, no tracking. All state is local to the
browser and never leaves it.

## License

MIT
