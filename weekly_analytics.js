const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { WebClient } = require('@slack/web-api');

// 🔑 CONFIGURATION PARAMETERS
const CHANNEL_ID = 'YOUR_SLACK_CHANNEL_ID'; // 👈 Replace with your destination channel ID
const REPORT_SUITES = ['web-report', 'coaches-report', 'api-report'];
const DASHBOARD_PUBLIC_URL = 'https://lokiesh16.github.io/HabitNuTestReports/weekly-dashboard.html';

if (!process.env.SLACK_BOT_TOKEN || !process.env.ANTHROPIC_API_KEY) {
  console.error("💥 Errors: Missing environment secrets!");
  process.exit(1);
}

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

function gatherWeeklyTelemetry() {
  const dataPoints = [];
  const failureMessages = [];
  const suiteFailureCounts = {};
  const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);

  REPORT_SUITES.forEach(suite => {
    const suitePath = path.join(__dirname, suite);
    if (!fs.existsSync(suitePath)) return;

    const items = fs.readdirSync(suitePath);
    items.forEach(item => {
      const itemPath = path.join(suitePath, item);
      const stats = fs.statSync(itemPath);

      if (stats.isDirectory() && stats.mtimeMs >= oneWeekAgo) {
        const summaryPath = path.join(itemPath, 'widgets', 'summary.json');
        if (fs.existsSync(summaryPath)) {
          try {
            const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
            const dateStr = stats.mtime.toISOString().split('T')[0];
            const suiteName = suite.replace('-report', '').toUpperCase();
            const failedCount = (summary.statistic.failed || 0) + (summary.statistic.broken || 0);
            
            dataPoints.push({
              label: `${dateStr} (${suiteName})`,
              timestamp: stats.mtimeMs,
              total: summary.statistic.total || 0,
              passed: summary.statistic.passed || 0,
              failed: failedCount
            });

            if (failedCount > 0) {
              const suiteKey = `${suiteName}::${item}`;
              suiteFailureCounts[suiteKey] = (suiteFailureCounts[suiteKey] || 0) + failedCount;
              
              const categoriesPath = path.join(itemPath, 'widgets', 'categories.json');
              if (fs.existsSync(categoriesPath)) {
                const categories = JSON.parse(fs.readFileSync(categoriesPath, 'utf8'));
                categories.forEach(cat => {
                  if (cat.children) cat.children.forEach(c => failureMessages.push(`[${suiteName}] ${c.name || ''} -> ${c.statusDetails?.message || ''}`));
                });
              }
            }
          } catch (e) {
            console.error(`⚠️ Error parsing data: ${e.message}`);
          }
        }
      }
    });
  });

  return {
    sortedRuns: dataPoints.sort((a, b) => a.timestamp - b.timestamp),
    rawTracesLog: failureMessages.slice(0, 25).join('\n'),
    flakyModules: Object.entries(suiteFailureCounts).sort((a,b) => b[1] - a[1]).slice(0, 5)
  };
}

async function getClaudeSummary(totalRuns, passRate, traces) {
  if (!traces) return "All automation passes executed flawlessly over the trailing 7-day layout cycle.";
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 350,
        temperature: 0.1,
        system: "You are a professional software QA dashboard assistant. Write a tight, summary paragraph explaining the recurring test failure roots. Keep it simple and clear.",
        messages: [{ role: 'user', content: `Stats: ${totalRuns} builds run, ${passRate}% health.\nLogs:\n${traces}` }]
      })
    });
    const data = await response.json();
    return data.content[0].text;
  } catch (err) {
    return "Insights brief parsing skipped due to transient network timeout.";
  }
}

async function run() {
  const telemetry = gatherWeeklyTelemetry();
  if (telemetry.sortedRuns.length === 0) return;

  let grandTotal = 0, grandPassed = 0, grandFailed = 0;
  telemetry.sortedRuns.forEach(r => { grandTotal += r.total; grandPassed += r.passed; grandFailed += r.failed; });
  const finalHealthRate = grandTotal > 0 ? Math.round((grandPassed / grandTotal) * 100) : 0;

  const aiBriefText = await getClaudeSummary(telemetry.sortedRuns.length, finalHealthRate, telemetry.rawTracesLog);

  const templatePath = path.join(__dirname, 'weekly-dashboard.html');
  if (fs.existsSync(templatePath)) {
    let html = fs.readFileSync(templatePath, 'utf8');

    // 🌟 LOGO INJECTION PIPELINE (Updated for hn.png)
    let habitnuBase64 = '';
    const habitnuPath = path.join(__dirname, 'hn.png');
    if (fs.existsSync(habitnuPath)) {
      habitnuBase64 = `data:image/png;base64,${fs.readFileSync(habitnuPath, 'base64')}`;
    }
    html = html.replace('{{HABITNU_LOGO}}', habitnuBase64);

    const kpiHtml = `
    <div class="kpi-grid">
      <div class="card"><div class="kpi-title">Weekly Health Rate</div><div class="kpi-value health">${finalHealthRate}%</div></div>
      <div class="card"><div class="kpi-title">Total Tests Run</div><div class="kpi-value">${grandTotal}</div></div>
      <div class="card"><div class="kpi-title">Regression Defect Count</div><div class="kpi-value failures">${grandFailed}</div></div>
      <div class="card"><div class="kpi-title">Automated Runs</div><div class="kpi-value">${telemetry.sortedRuns.length}</div></div>
    </div>`;
    
    html = html.replace(/<div class="kpi-grid">[\s\S]*?<\/div>/, kpiHtml);
    html = html.replace(/<p class="ai-text" id="ai-brief-text">[\s\S]*?<\/p>/, `<p class="ai-text" id="ai-brief-text">${aiBriefText}</p>`);
    
    const chartVars = `
    const trendLabels = ${JSON.stringify(telemetry.sortedRuns.map(r => r.label))};
    const trendData = ${JSON.stringify(telemetry.sortedRuns.map(r => r.total > 0 ? Math.round((r.passed / r.total) * 100) : 0))};
    const flakyLabels = ${JSON.stringify(telemetry.flakyModules.map(m => m[0]))};
    const flakyData = ${JSON.stringify(telemetry.flakyModules.map(m => m[1]))};`;
    
    html = html.replace(/\/\/ INJECT_CHART_DATA[\s\S]*?\/\/ \/INJECT_CHART_DATA/, chartVars);
    fs.writeFileSync(templatePath, html, 'utf8');
  }

  let browser;
  try {
    browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 1050, deviceScaleFactor: 2 });
    await page.setContent(fs.readFileSync(templatePath, 'utf8'), { waitUntil: 'networkidle0' });
    
    // Give charts 1.5s to complete easeOutQuart entry animations cleanly
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    const element = await page.$('#dashboard-capture-zone');
    const imageBuffer = await element.screenshot({ type: 'png' });
    
    let uploadOptions = {
      file: imageBuffer,
      filename: 'weekly-insights.png',
      channel_id: CHANNEL_ID,
      initial_comment: `📊 *Weekly Quality Track Record Report*\n\n📈 *Pass Rate:* \`${finalHealthRate}%\` across \`${telemetry.sortedRuns.length}\` automated builds.\n🧠 *AI Triage Brief:* ${aiBriefText}\n\n🔗 *Live Web Dashboard URL:* ${DASHBOARD_PUBLIC_URL}`
    };

    await slack.files.uploadV2(uploadOptions);
    console.log("🚀 Custom light dashboard delivered cleanly to Slack!");
  } catch (err) {
    console.error("💥 Execution failure:", err.message);
  } finally {
    if (browser) await browser.close();
  }
}

run();
