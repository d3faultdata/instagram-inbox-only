const test = require("node:test");
const assert = require("node:assert/strict");
const { launch } = require("./harness.js");

const fixture = (config) =>
  config.sites.find((s) => s.id === "custom_localhost");

/** Reads the config the extension actually persisted. */
async function storedConfig(worker) {
  return worker.evaluate(async () => {
    const { inboxOnlyConfig } = await chrome.storage.local.get("inboxOnlyConfig");
    return inboxOnlyConfig;
  });
}

test("options page enforces the commitment delay", async (t) => {
  const env = await launch();
  t.after(() => env.close());

  const extensionId = new URL(env.worker.url()).host;
  // The built-in sites are re-seeded alongside the fixture, so every selector
  // has to be scoped to the fixture's own card.
  const SITE = '.site[data-site-id="custom_localhost"]';
  const page = await env.context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));

  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await page.waitForSelector(".site");

  await t.test("renders the guarded site without script errors", async () => {
    assert.equal(errors.length, 0, errors.join("; "));
    assert.equal(await page.locator(SITE).count(), 1);
    assert.equal(await page.locator(`${SITE} .status`).textContent(), "guarded");
  });

  await t.test("blocking a path applies immediately", async () => {
    await page.locator(`${SITE} .paths button:text("Block")`).first().click();
    await page.waitForFunction(
      (sel) => document.querySelectorAll(`${sel} .paths li`).length === 0,
      SITE
    );
    const config = await storedConfig(env.worker);
    assert.deepEqual(fixture(config).allow, []);
    assert.equal(config.pending.length, 0);
  });

  await t.test("allowing a path is queued behind the delay", async () => {
    await page.locator(`${SITE} form.inline input`).fill("/feed");
    await page.locator(`${SITE} form.inline button`).click();
    await page.waitForSelector("#pending-list li");

    const config = await storedConfig(env.worker);
    assert.equal(config.pending.length, 1);
    assert.equal(
      fixture(config).allow.includes("/feed"),
      false,
      "the loosening must not have applied yet"
    );
    assert.match(
      await page.locator("#pending-list li span").textContent(),
      /Allow \/feed/
    );
  });

  await t.test("unguarding a site is queued, not applied", async () => {
    await page.locator(`${SITE} .actions button:text("Stop guarding")`).click();
    await page.waitForFunction(
      () => document.querySelectorAll("#pending-list li").length === 2
    );
    const config = await storedConfig(env.worker);
    assert.equal(fixture(config).enabled, true, "still guarded");
  });

  await t.test("the guard is still enforcing while changes are pending", async () => {
    const tab = await env.context.newPage();
    await tab.goto(env.url("/feed/"));
    await tab.waitForURL(env.url("/inbox/"), { timeout: 10_000 });
    await tab.close();
  });

  await t.test("cancelling a pending change is instant", async () => {
    await page.locator('#pending-list button:text("Cancel")').first().click();
    await page.waitForFunction(
      () => document.querySelectorAll("#pending-list li").length === 1
    );
    const config = await storedConfig(env.worker);
    assert.equal(config.pending.length, 1);
  });

  await t.test("raising the delay applies at once, lowering does not", async () => {
    await page.locator('#delay-form input[name="minutes"]').fill("2880");
    await page.locator("#delay-form button").click();
    await page.waitForTimeout(500);
    assert.equal((await storedConfig(env.worker)).guardDelayMinutes, 2880);

    await page.locator('#delay-form input[name="minutes"]').fill("5");
    await page.locator("#delay-form button").click();
    await page.waitForTimeout(500);
    assert.equal(
      (await storedConfig(env.worker)).guardDelayMinutes,
      2880,
      "lowering the delay must wait out the current delay"
    );
  });

  await t.test("no script errors accumulated across the run", async () => {
    assert.deepEqual(errors, []);
  });
});
