const puppeteer = require('puppeteer');
const { WebClient } = require('@slack/web-api');

// 🔑 1. LINK CONFIGURATION PARAMETERS
const CHANNEL_ID = 'C0BB1C0RYQ7'; // 
const ALLURE_DASHBOARD_URL = 'https://lokiesh16.github.io/HabNuTestReports/'; 

if (!process.env.SLACK_BOT_TOKEN) {
  console.error("💥 Error: SLACK_BOT_TOKEN environment secret is missing!");
  process.exit(1);
}

const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);

/**
 * Resilient loader wrapper built to gracefully outwait GitHub Pages 404 pipeline delays
 */
async function loadAllurePageWithRetry(page, url, maxRetries = 5, waitIntervalMs = 30000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`🌐 [Attempt ${attempt}/${maxRetries}] Navigating to Allure Dashboard: ${url}`);
    
    try {
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
      
      // Check the page content for common signs of a GitHub Pages 404 error page
      const pageTitle = await page.title();
      const bodyText = await page.evaluate(() => document.body.innerText);
      
      const is404 = pageTitle.includes('404') || 
                    bodyText.includes('Page not found') || 
                    bodyText.includes('File not found');

      if (!is404) {
        console.log("✅ Page loaded successfully with real Allure data elements detected!");
        return true; 
      }
      
      console.warn(`⚠️ GitHub Pages returned a 404 (Still processing deployment asset cache).`);
    } catch (err) {
      console.warn(`⚠️ Navigation encountered an issue or timeout on attempt ${attempt}: ${err.message}`);
    }

    if (attempt < maxRetries) {
      console.log(`⏳ Sleeping for ${waitIntervalMs / 1000} seconds before retrying navigation loop...`);
      await new Promise(resolve => setTimeout(resolve, waitIntervalMs));
    }
  }
  
  throw new Error("💥 Max page loading retrieval retries exhausted. GitHub Pages remained unavailable.");
}

async function runWeeklyScreenshotEngine() {
  let browser;
  try {
    console.log("🚀 Initializing headless viewport manager context...");
    browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    // High density viewport frame settings to ensure Allure widgets wrap cleanly
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });

    // Execute the resilient loading sequence to defeat deployment lag
    await loadAllurePageWithRetry(page, ALLURE_DASHBOARD_URL);

    console.log("⏳ Pausing 5 seconds for Allure internal charts animation rendering to lock finish...");
    await new Promise(resolve => setTimeout(resolve, 5000));

    console.log("📸 Clipping high-definition overview dashboard layout viewport frame...");
    // Captures the whole loaded dashboard screen structure directly
    const imageBuffer = await page.screenshot({ type: 'png', fullPage: false });

    console.log("📤 Delivering direct Allure History track record visual summary straight to Slack...");
    await slackClient.files.uploadV2({
      file: imageBuffer,
      filename: 'weekly-allure-trend.png',
      channel_id: CHANNEL_ID,
      initial_comment: `📊 *Pulse Weekly Executive Track Record Report*\nHere is the historical test stability matrix harvested directly from the live Allure Pages engine pipeline dashboard over the past week.`
    });

    console.log("🚀 Weekly interactive dashboard deployment asset sent successfully!");

  } catch (error) {
    console.error("💥 Weekly Summary Automation Engine Loop Crashed:", error.message);
  } finally {
    if (browser) await browser.close();
  }
}

runWeeklyScreenshotEngine();
