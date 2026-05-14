const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  // Listen for ALL console logs, including from iframes!
  page.on('console', msg => {
    console.log(`[WebView Console] ${msg.type()}: ${msg.text()}`);
  });

  page.on('pageerror', exception => {
    console.log(`[WebView Error] Uncaught exception: "${exception}"`);
  });

  console.log('Navigating to local playtest URL...');
  // The playtest URL is the subreddit feed with the playtest query param
  await page.goto('https://www.reddit.com/r/flairguardtest/?playtest=flairguard-app', { waitUntil: 'networkidle' });

  console.log('Waiting for custom post to appear in feed...');
  // Find the Launch App button or wait for iframe
  await page.waitForTimeout(5000);

  console.log('Clicking into the custom post...');
  // We need to click the post titled "⚙️ FlairGuard — Rules Dashboard (Mods Only)"
  const postLink = await page.locator('text="⚙️ FlairGuard — Rules Dashboard (Mods Only)"').first();
  if (await postLink.count() > 0) {
    await postLink.click();
    await page.waitForTimeout(5000);
  }

  console.log('Test complete, shutting down...');
  await browser.close();
})();
