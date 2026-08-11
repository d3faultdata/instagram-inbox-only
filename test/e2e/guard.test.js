const test = require("node:test");
const assert = require("node:assert/strict");
const { launch } = require("./harness.js");

test("guard blocks and allows the right pages", async (t) => {
  const env = await launch();
  t.after(() => env.close());

  await t.test("a blocked page redirects to the inbox", async () => {
    const page = await env.context.newPage();
    await page.goto(env.url("/feed/"));
    await page.waitForURL(env.url("/inbox/"), { timeout: 10_000 });
    assert.equal(new URL(page.url()).pathname, "/inbox/");
    await page.close();
  });

  await t.test("a profile page redirects to the inbox", async () => {
    const page = await env.context.newPage();
    await page.goto(env.url("/u/someone"));
    await page.waitForURL(env.url("/inbox/"), { timeout: 10_000 });
    await page.close();
  });

  await t.test("a deep thread URL loads and stays put", async () => {
    // The v1 regression: only /direct/inbox was allowed, so reloading a
    // conversation threw you back to the inbox list.
    const page = await env.context.newPage();
    await page.goto(env.url("/inbox/thread/1"));
    await page.waitForSelector("#thread-body");
    await page.waitForTimeout(800);
    assert.equal(new URL(page.url()).pathname, "/inbox/thread/1");
    await page.close();
  });

  await t.test("the inbox itself is not redirected in a loop", async () => {
    const page = await env.context.newPage();
    const response = await page.goto(env.url("/inbox/"));
    assert.equal(response.status(), 200);
    await page.waitForTimeout(800);
    assert.equal(new URL(page.url()).pathname, "/inbox/");
    await page.close();
  });

  await t.test("site chrome is hidden", async () => {
    const page = await env.context.newPage();
    await page.goto(env.url("/inbox/"));
    await page.waitForSelector("#thread");
    assert.equal(await page.locator("#chrome").isVisible(), false);
    await page.close();
  });

  await t.test("out-of-scope links are dimmed, allowed links are not", async () => {
    const page = await env.context.newPage();
    await page.goto(env.url("/inbox/"));
    await page.waitForSelector("#thread");

    const opacity = (id) =>
      page.locator(id).evaluate((el) => getComputedStyle(el).opacity);
    const events = (id) =>
      page.locator(id).evaluate((el) => getComputedStyle(el).pointerEvents);

    assert.equal(await opacity("#feed"), "0.3");
    assert.equal(await events("#feed"), "none");
    assert.equal(await opacity("#profile"), "0.3");
    assert.equal(await opacity("#thread"), "1");
    assert.equal(await events("#thread"), "auto");
    await page.close();
  });

  await t.test("clicking a blocked link does not navigate", async () => {
    const page = await env.context.newPage();
    await page.goto(env.url("/inbox/"));
    await page.waitForSelector("#thread");
    await page.locator("#feed").click({ force: true });
    await page.waitForTimeout(800);
    assert.equal(new URL(page.url()).pathname, "/inbox/");
    await page.close();
  });

  await t.test("clicking an allowed link still works", async () => {
    const page = await env.context.newPage();
    await page.goto(env.url("/inbox/"));
    await page.locator("#thread").click();
    await page.waitForSelector("#thread-body");
    assert.equal(new URL(page.url()).pathname, "/inbox/thread/1");
    await page.close();
  });

  await t.test("a pushState into a blocked route is reverted", async () => {
    // The escape hatch v1 had no answer for: SPA routing never touches the
    // network layer, so the DNR rules never see it.
    const page = await env.context.newPage();
    await page.goto(env.url("/inbox/"));
    await page.waitForSelector("#thread");
    await page.locator("#push-feed").click();
    await page.waitForURL(env.url("/inbox/"), { timeout: 10_000 });
    assert.equal(new URL(page.url()).pathname, "/inbox/");
    await page.close();
  });

  await t.test("a pushState within the allowed area survives", async () => {
    const page = await env.context.newPage();
    await page.goto(env.url("/inbox/"));
    await page.waitForSelector("#thread");
    await page.locator("#push-thread").click();
    await page.waitForTimeout(1200);
    assert.equal(new URL(page.url()).pathname, "/inbox/thread/2");
    await page.close();
  });

  await t.test("unguarded origins are untouched", async () => {
    const page = await env.context.newPage();
    await page.goto(`http://127.0.0.1:${new URL(env.base).port}/feed/`);
    await page.waitForTimeout(800);
    assert.equal(new URL(page.url()).pathname, "/feed/");
    assert.equal(await page.locator("#chrome").isVisible(), true);
    await page.close();
  });
});
