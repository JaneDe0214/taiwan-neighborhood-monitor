/**
 * 雙埔生活 - YouBike 2.0 單獨同步腳本 (共用 sync-all.js 核心精煉與原子寫入實作)
 */
const fs = require('fs');
const path = require('path');
const { syncYouBike } = require('./sync-all.js');

async function run() {
  const outDir = path.join(__dirname, '../data');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  const ok = await syncYouBike(outDir);
  if (!ok) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  run().catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { run };
