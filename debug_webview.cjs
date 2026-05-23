const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 }
  });
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
  await page.goto('https://www.reddit.com/r/flairguard_app_dev/?playtest=flairguard-app', { waitUntil: 'load' });

  console.log('Waiting for custom post to appear in feed...');
  await page.waitForTimeout(5000);

  // Take a screenshot of the feed
  await page.screenshot({ path: 'feed_screenshot.png' });
  console.log('Captured feed_screenshot.png');

  console.log('Clicking into the custom post...');
  const postLink = page.locator('text="⚙️ FlairGuard — Rules Dashboard (Mods Only)"').first();
  if (await postLink.count() > 0) {
    await postLink.click();
    console.log('Clicked post. Waiting for WebView to load...');
    await page.waitForTimeout(7000);

    // Save screenshot of the post view
    await page.screenshot({ path: 'post_screenshot.png' });
    console.log('Captured post_screenshot.png');

    // Locate the iframe
    const frames = page.frames();
    console.log(`Found ${frames.length} frames on page.`);
    for (const frame of frames) {
      const url = frame.url();
      if (url.includes('settings.html') || url.includes('devvit')) {
        console.log(`Analyzing Devvit WebView frame: ${url}`);
        // Check for access-denied element
        const hasAccessDenied = await frame.locator('#access-denied').isVisible().catch(() => false);
        const hasDashboard = await frame.locator('#dashboard-ui').isVisible().catch(() => false);
        
        console.log(`Frame status - Access Denied Visible: ${hasAccessDenied}, Dashboard UI Visible: ${hasDashboard}`);
        
        const content = await frame.locator('body').innerHTML().catch(() => 'No body content');
        console.log(`Frame body content preview: ${content.substring(0, 500)}...`);
      }
    }
  } else {
    console.log('Custom post "⚙️ FlairGuard — Rules Dashboard (Mods Only)" not found in feed. Checking page content...');
    const bodyText = await page.locator('body').innerText();
    console.log(`Body text snippet: ${bodyText.substring(0, 300)}`);
  }

  console.log('Test complete, shutting down...');
  await browser.close();
})();
