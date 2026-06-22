const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { WebClient } = require('@slack/web-api');

// 🔑 1. CONFIGURATION
const CHANNEL_ID = 'C0BB1C0RYQ7'; // 👈 Replace with your destination channel ID
const DASHBOARD_PUBLIC_URL = 'https://lokiesh16.github.io/HabitNuTestReports/weekly-dashboard.html';

if (!process.env.SLACK_BOT_TOKEN) {
  console.error("💥 Error: Missing SLACK_BOT_TOKEN environment secret!");
  process.exit(1);
}

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const globalFailureCounts = {};

function getTrailing7Days() {
  const dates = [];
  const daysOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const shortDays = [];
  
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split('T')[0]);
    shortDays.push(daysOfWeek[d.getDay()]);
  }
  return { dates, shortDays };
}

// 🧠 THE SMART ROUTER: Scans a single folder and separates Selenium vs Playwright
function getSplitSuiteMetrics(folderName, validDates) {
  let sel = { pass: [0,0,0,0,0,0,0], broken: [0,0,0,0,0,0,0], fail: [0,0,0,0,0,0,0], activeDays: 0, totalPass: 0, totalIssues: 0 };
  let pw = { pass: [0,0,0,0,0,0,0], broken: [0,0,0,0,0,0,0], fail: [0,0,0,0,0,0,0], activeDays: 0, totalPass: 0, totalIssues: 0 };

  const suitePath = path.join(__dirname, folderName);
  
  if (fs.existsSync(suitePath)) {
    const items = fs.readdirSync(suitePath);
    items.forEach(item => {
      const itemPath = path.join(suitePath, item);
      
      if (fs.statSync(itemPath).isDirectory()) {
        const dateStr = fs.statSync(itemPath).mtime.toISOString().split('T')[0];
        const dayIndex = validDates.indexOf(dateStr);

        if (dayIndex !== -1 && fs.existsSync(path.join(itemPath, 'widgets', 'summary.json'))) {
          try {
            let isPw = false;
            
            // Look into Allure's environment data to figure out which suite ran!
            const envPath = path.join(itemPath, 'widgets', 'environment.json');
            if (fs.existsSync(envPath)) {
              const envData = JSON.parse(fs.readFileSync(envPath, 'utf8'));
              const testPathVar = envData.find(e => e.name === 'Test Path');
              // If the pipeline ran Playwright tests, flag it as a Playwright run
              if (testPathVar && testPathVar.values && 
                 (testPathVar.values[0].includes('PlayWright') || 
                  testPathVar.values[0].includes('FacingPortal'))) {
                isPw = true;
              }
            }

            const summary = JSON.parse(fs.readFileSync(path.join(itemPath, 'widgets', 'summary.json'), 'utf8'));
            const p = summary.statistic.passed || 0;
            const b = summary.statistic.broken || 0;
            const f = summary.statistic.failed || 0;

            // Route the data to the correct internal bucket
            const target = isPw ? pw : sel;
            target.pass[dayIndex] += p;
            target.broken[dayIndex] += b;
            target.fail[dayIndex] += f;

            if ((b + f) > 0) {
              const key = `${folderName}(${isPw ? 'Playwright' : 'Selenium'})::${item}`;
              globalFailureCounts[key] = (globalFailureCounts[key] || 0) + (b + f);
            }
          } catch (e) { console.error(`⚠️ Parse error in ${item}`); }
        }
      }
    });
  }

  // Calculate aggregates for both buckets
  [sel, pw].forEach(t => {
    for(let i=0; i<7; i++) {
      if ((t.pass[i] + t.broken[i] + t.fail[i]) > 0) t.activeDays++;
      t.totalPass += t.pass[i];
      t.totalIssues += (t.broken[i] + t.fail[i]);
    }
    t.grandTotal = t.totalPass + t.totalIssues;
    const pr = t.grandTotal > 0 ? Math.round((t.totalPass / t.grandTotal) * 100) : 0;
    t.passRate = `${pr}%`;
    t.failRate = t.grandTotal > 0 ? `${100 - pr}%` : `0%`;
  });

  return { sel, pw };
}

async function run() {
  const { dates, shortDays } = getTrailing7Days();
  
  console.log("🔍 Scanning and routing mixed folders...");
  // Extract and split data natively from your two primary folders
  const dataWeb = getSplitSuiteMetrics('web-report', dates);
  const dataCoach = getSplitSuiteMetrics('coaches-report', dates);

  const allRunsTotal = dataWeb.sel.grandTotal + dataWeb.pw.grandTotal + dataCoach.sel.grandTotal + dataCoach.pw.grandTotal;
  const allRunsPass = dataWeb.sel.totalPass + dataWeb.pw.totalPass + dataCoach.sel.totalPass + dataCoach.pw.totalPass;
  const globalHealth = allRunsTotal > 0 ? Math.round((allRunsPass / allRunsTotal) * 100) : 0;

  const sortedFlaky = Object.entries(globalFailureCounts).sort((a,b) => b[1] - a[1]).slice(0, 5);
  const flakyLabels = sortedFlaky.map(m => m[0].split('::')[0]); 
  const flakyData = sortedFlaky.map(m => m[1]);

  const templatePath = path.join(__dirname, 'weekly-dashboard.html');
  if (fs.existsSync(templatePath)) {
    let html = fs.readFileSync(templatePath, 'utf8');

    // 1. Inject UI KPIs
    html = html.replace('{{WEB_SEL_RUNS}}', dataWeb.sel.activeDays)
               .replace('{{WEB_SEL_PASS}}', dataWeb.sel.passRate)
               .replace('{{WEB_SEL_FAIL}}', dataWeb.sel.failRate)
               
               .replace('{{WEB_PW_RUNS}}', dataWeb.pw.activeDays)
               .replace('{{WEB_PW_PASS}}', dataWeb.pw.passRate)
               .replace('{{WEB_PW_FAIL}}', dataWeb.pw.failRate)
               
               .replace('{{COACH_SEL_RUNS}}', dataCoach.sel.activeDays)
               .replace('{{COACH_SEL_PASS}}', dataCoach.sel.passRate)
               .replace('{{COACH_SEL_FAIL}}', dataCoach.sel.failRate)
               
               .replace('{{COACH_PW_RUNS}}', dataCoach.pw.activeDays)
               .replace('{{COACH_PW_PASS}}', dataCoach.pw.passRate)
               .replace('{{COACH_PW_FAIL}}', dataCoach.pw.failRate);

    // 2. Inject Array Data for Charts
    html = html.replace('{{CHART_DAYS}}', JSON.stringify(shortDays))
               .replace('{{DATA_WEB_SEL}}', JSON.stringify(dataWeb.sel))
               .replace('{{DATA_WEB_PW}}', JSON.stringify(dataWeb.pw))
               .replace('{{DATA_COACH_SEL}}', JSON.stringify(dataCoach.sel))
               .replace('{{DATA_COACH_PW}}', JSON.stringify(dataCoach.pw))
               .replace('{{FLAKY_LABELS}}', JSON.stringify(flakyLabels))
               .replace('{{FLAKY_DATA}}', JSON.stringify(flakyData));

    fs.writeFileSync(templatePath, html, 'utf8');
  }

  let browser;
  try {
    browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 1050, deviceScaleFactor: 2 });
    
    await page.setContent(fs.readFileSync(templatePath, 'utf8'), { waitUntil: 'networkidle0' });
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    const element = await page.$('#dashboard-capture-zone');
    const imageBuffer = await element.screenshot({ type: 'png' });
    
    let uploadOptions = {
      file: imageBuffer,
      filename: 'weekly-pulse-summary.png',
      channel_id: CHANNEL_ID,
      initial_comment: `📊 *Summary of the Last Week: Pulse*\n\n📈 *Overall Pipeline Health:* \`${globalHealth}%\` (Total Assets Validated: \`${allRunsTotal}\`).\n🔗 *Live Web Dashboard URL:* ${DASHBOARD_PUBLIC_URL}`
    };

    await slack.files.uploadV2(uploadOptions);
    console.log("🚀 Consolidated folder dashboard delivered flawlessly to Slack!");
  } catch (err) {
    console.error("💥 Execution failure:", err.message);
  } finally {
    if (browser) await browser.close();
  }
}

run();
