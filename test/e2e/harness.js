const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..", "..");

/**
 * Fixture pages standing in for a guarded site. They only need the shape the
 * guard reacts to — a nav landmark and a set of same-origin links.
 */
const PAGES = {
  "/inbox/": page(
    "Inbox",
    `<a id="thread" href="/inbox/thread/1">Thread one</a>
     <a id="feed" href="/feed/">Feed</a>
     <a id="profile" href="/u/someone">Someone</a>
     <a id="external" href="https://example.com/">Example</a>
     <button id="push-feed">push feed</button>
     <button id="push-thread">push thread</button>`
  ),
  "/inbox/thread/1": page("Thread one", `<p id="thread-body">a conversation</p>`),
  "/inbox/thread/2": page("Thread two", `<p id="thread-body">another</p>`),
  "/feed/": page("Feed", `<p id="feed-body">endless scroll</p>`),
  "/u/someone": page("Profile", `<p id="profile-body">a profile</p>`),
};

function page(title, body) {
  return `<!doctype html><html><head><title>${title}</title></head><body>
    <nav role="navigation" id="chrome"><a href="/feed/">Home</a></nav>
    <main>${body}</main>
    <script>
      document.getElementById('push-feed')?.addEventListener('click', () => {
        history.pushState({}, '', '/feed/');
      });
      document.getElementById('push-thread')?.addEventListener('click', () => {
        history.pushState({}, '', '/inbox/thread/2');
      });
    </script>
  </body></html>`;
}

async function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const body = PAGES[url.pathname];
    res.writeHead(body ? 200 : 404, { "content-type": "text/html" });
    res.end(body || page("Not found", "<p>404</p>"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port };
}

/**
 * Copies the extension to a temp dir and widens host_permissions to localhost,
 * so the shipped manifest stays clean while the tests still exercise the real
 * background worker, DNR rules and content guard.
 */
function stageExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-only-ext-"));
  for (const entry of ["manifest.json", "src", "icons"]) {
    fs.cpSync(path.join(ROOT, entry), path.join(dir, entry), { recursive: true });
  }
  const manifestPath = path.join(dir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.host_permissions.push("http://localhost/*", "http://127.0.0.1/*");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

function testSite(port) {
  return {
    id: "custom_localhost",
    label: "Fixture",
    hosts: ["localhost"],
    home: "/inbox/",
    allow: ["/inbox"],
    alwaysAllow: [],
    hideChrome: true,
    enabled: true,
    builtin: false,
  };
}

/**
 * Extensions need the full Chromium build — the headless shell Playwright
 * reaches for by default cannot load them. Honour an explicit path, otherwise
 * pick the newest full build in a preinstalled browser directory.
 */
function resolveChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;

  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (base && fs.existsSync(base)) {
    const builds = fs
      .readdirSync(base)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const build of builds) {
      const exe = path.join(base, build, "chrome-linux", "chrome");
      if (fs.existsSync(exe)) return exe;
    }
  }
  return undefined; // fall back to Playwright's own download
}

async function launch() {
  const { server, port } = await startServer();
  const extensionDir = stageExtension();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-only-profile-"));

  const executablePath = resolveChromium();

  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    // Without an explicit build, ask for the full "chromium" channel: the
    // default resolution picks the headless shell, which cannot load
    // extensions at all.
    ...(executablePath ? { executablePath } : { channel: "chromium" }),
    args: [
      "--no-sandbox",
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
    ],
  });

  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker", { timeout: 15_000 }));

  // Seed the fixture site and wait for the worker to finish wiring up the DNR
  // rules and content script registration it derives from storage.
  await worker.evaluate(async (site) => {
    await chrome.storage.local.set({
      inboxOnlyConfig: {
        version: 2,
        guardDelayMinutes: 1440,
        sites: [site],
        pending: [],
      },
    });
  }, testSite(port));

  await waitForRules(worker);

  const base = `http://localhost:${port}`;

  return {
    context,
    worker,
    base,
    url: (p) => `${base}${p}`,
    async close() {
      await context.close();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(extensionDir, { recursive: true, force: true });
      fs.rmSync(profile, { recursive: true, force: true });
    },
  };
}

/** The worker syncs asynchronously off storage.onChanged; wait it out. */
async function waitForRules(worker, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const ready = await worker.evaluate(async () => {
      const rules = await chrome.declarativeNetRequest.getDynamicRules();
      const scripts = await chrome.scripting.getRegisteredContentScripts();
      return rules.length >= 2 && scripts.length >= 1;
    });
    if (ready) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("extension did not finish syncing rules in time");
}

module.exports = { launch, waitForRules, PAGES };
