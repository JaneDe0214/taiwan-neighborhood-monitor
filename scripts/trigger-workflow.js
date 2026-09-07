/**
 * 外部觸發 GitHub Action 即時同步輔助腳本 (API 秒級調用)
 * 使用方法：
 *   node scripts/trigger-workflow.js <YOUR_GITHUB_PERSONAL_ACCESS_TOKEN>
 * 
 * 說明：
 * 透過 GitHub REST API 發送 repository_dispatch 事件，
 * 繞過 GitHub 排程 (cron schedule) 的延遲佇列，讓 GitHub Actions 在 3~5 秒內立即啟動！
 */

const https = require('https');

const OWNER = 'JaneDe0214';
const REPO = 'taiwan-neighborhood-monitor';
const EVENT_TYPE = 'sync-transit-data';

const token = process.argv[2] || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

if (!token) {
  console.log('【使用說明】請提供 GitHub Personal Access Token (PAT)：');
  console.log('  node scripts/trigger-workflow.js ghp_xxxxxxxxxxxxxxxxxxxx');
  console.log('或設定環境變數：');
  console.log('  $env:GITHUB_TOKEN="ghp_xxx"; node scripts/trigger-workflow.js');
  console.log('\n提示：Token 僅需勾選「repo」或「contents:write / metadata:read」權限即可。');
  process.exit(0);
}

const payload = JSON.stringify({
  event_type: EVENT_TYPE,
  client_payload: {
    triggeredBy: 'manual-script',
    timestamp: new Date().toISOString()
  }
});

const options = {
  hostname: 'api.github.com',
  path: `/repos/${OWNER}/${REPO}/dispatches`,
  method: 'POST',
  headers: {
    'User-Agent': 'Node-Trigger-Client',
    'Accept': 'application/vnd.github.v3+json',
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  }
};

console.log(`正在發送即時觸發請求至 GitHub API (${OWNER}/${REPO})...`);

const req = https.request(options, (res) => {
  if (res.statusCode === 204) {
    console.log('✅ 成功觸發 GitHub Actions！(HTTP 204 No Content)');
    console.log('GitHub Runner 將在數秒內立即啟動並更新大眾運輸與 YouBike 數據。');
  } else {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      console.error(`❌ 觸發失敗 (HTTP ${res.statusCode}):`);
      console.error(body);
    });
  }
});

req.on('error', (err) => {
  console.error('❌ 連線錯誤:', err.message);
});

req.write(payload);
req.end();
