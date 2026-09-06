/**
 * 雙埔生活圈 - 全大眾運輸與 YouBike 雲端定時同步整合中樞
 * 支援一次抓取：
 * 1. YouBike 2.0 (opendata.vip 優先 + 官方 CSV 備援)
 * 2. 台灣高鐵當日官方時刻表 (南下 + 北上)
 * 3. 桃園機場捷運官方時刻表 (南下 + 北上)
 * 4. 台北捷運 / 環狀線新埔站即時看板 (opendata.vip)
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const server = require('../server.js');

function fetchUrl(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8'
      }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`連線逾時: ${url}`));
    });
  });
}

function parseCsvToJson(csvStr) {
  const lines = csvStr.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headerLine = lines[0].replace(/^\uFEFF/, '');
  const headers = headerLine.split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const list = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = [];
    let cur = '';
    let inQuotes = false;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        values.push(cur.trim().replace(/^"|"$/g, ''));
        cur = '';
      } else {
        cur += ch;
      }
    }
    values.push(cur.trim().replace(/^"|"$/g, ''));

    const obj = {};
    for (let h = 0; h < headers.length; h++) {
      obj[headers[h]] = values[h] != null ? values[h] : '';
    }
    list.push(obj);
  }
  return list;
}

function getTaiwanNow() {
  const d = new Date();
  const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
  return new Date(utc + (3600000 * 8));
}

function getTaiwanTimeString() {
  const tw = getTaiwanNow();
  const hh = String(tw.getHours()).padStart(2, '0');
  const mm = String(tw.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// 1. 同步 YouBike 2.0 (首選 opendata.vip，備援官方端點)
async function syncYouBike(outDir) {
  console.log('[1/4] 正在同步 YouBike 2.0 即時動態...');
  let ntpcList = [];
  let tycgList = [];

  // 嘗試優先從 opendata.vip 高速抓取 (JSON 格式且省流)
  try {
    const [ntpcRaw, tycgRaw] = await Promise.all([
      fetchUrl('https://www.opendata.vip/tdx/youbikeApi/NewTaipei', 8000),
      fetchUrl('https://www.opendata.vip/tdx/youbikeApi/Taoyuan', 8000)
    ]);
    const p1 = JSON.parse(ntpcRaw);
    const p2 = JSON.parse(tycgRaw);
    if (Array.isArray(p1) && p1.length > 500) ntpcList = p1;
    if (Array.isArray(p2) && p2.length > 300) tycgList = p2;
    console.log(`  - [opendata.vip 優先成功] 新北: ${ntpcList.length} 站, 桃園: ${tycgList.length} 站`);
  } catch (err) {
    console.warn('  - opendata.vip 連線或解析異常，切換至官方備援端點:', err.message);
  }

  // 備援：若未成功則切換為新北市官方全量 CSV 與桃園開放資料
  if (ntpcList.length === 0 || tycgList.length === 0) {
    try {
      const NTPC_URL = 'https://data.ntpc.gov.tw/api/datasets/010E5B15-3823-4B20-B401-B1CF000550C5/csv/file';
      const TYCG_URL = 'https://opendata.tycg.gov.tw/api/dataset/5ca2bfc7-9ace-4719-88ae-4034b9a5a55c/resource/08274d61-edbe-419d-8fcc-7a643831283d/download';
      const [nRaw, tRaw] = await Promise.all([
        ntpcList.length === 0 ? fetchUrl(NTPC_URL, 12000) : null,
        tycgList.length === 0 ? fetchUrl(TYCG_URL, 12000) : null
      ]);
      if (nRaw) ntpcList = parseCsvToJson(nRaw);
      if (tRaw) {
        const p = JSON.parse(tRaw);
        tycgList = Array.isArray(p) ? p : (p.retVal || []);
      }
      console.log(`  - [官方備援成功] 新北: ${ntpcList.length} 站, 桃園: ${tycgList.length} 站`);
    } catch (e2) {
      console.error('  - 官方備援也遭遇錯誤:', e2.message);
    }
  }

  const timeStr = getTaiwanTimeString();
  const payload = {
    updatedAt: getTaiwanNow().toISOString(),
    updateTimeDisplay: timeStr,
    ntpcCount: ntpcList.length,
    tycgCount: tycgList.length,
    ntpc: ntpcList,
    tycg: tycgList
  };

  const outFile = path.join(outDir, 'youbike.json');
  fs.writeFileSync(outFile, JSON.stringify(payload));
  console.log(`  -> 已寫入 ${outFile} (更新時間: ${timeStr})`);
}

// 2. 同步台灣高鐵當日時刻表 (南下: 板橋➔桃園 / 北上: 桃園➔板橋)
async function syncThsr(outDir) {
  console.log('[2/4] 正在自台灣高鐵官網同步當日最新班表 (保證停靠桃園)...');
  try {
    const [southTrains, northTrains] = await Promise.all([
      server.fetchOfficialThsrTimetable('BanQiao', 'TaoYuan'),
      server.fetchOfficialThsrTimetable('TaoYuan', 'BanQiao')
    ]);

    const payload = {
      date: server.getTaiwanDateString(),
      updatedAt: getTaiwanNow().toISOString(),
      south: { count: southTrains.length, trains: southTrains },
      north: { count: northTrains.length, trains: northTrains }
    };

    const outFile = path.join(outDir, 'thsr.json');
    fs.writeFileSync(outFile, JSON.stringify(payload));
    console.log(`  -> 已寫入 ${outFile} (南下: ${southTrains.length} 班, 北上: ${northTrains.length} 班)`);
  } catch (err) {
    console.error('  - 高鐵同步失敗:', err.message);
  }
}

// 3. 同步桃園機場捷運當日時刻表 (南下: A3➔A18 / 北上: A18➔A3)
async function syncTymetro(outDir) {
  console.log('[3/4] 正在自桃園捷運官網同步當日最新班表...');
  try {
    const [southTrains, northTrains] = await Promise.all([
      server.fetchOfficialTymetroTimetable('south'),
      server.fetchOfficialTymetroTimetable('north')
    ]);

    const payload = {
      date: server.getTaiwanDateString(),
      updatedAt: getTaiwanNow().toISOString(),
      south: { count: southTrains.length, trains: southTrains },
      north: { count: northTrains.length, trains: northTrains }
    };

    const outFile = path.join(outDir, 'tymetro.json');
    fs.writeFileSync(outFile, JSON.stringify(payload));
    console.log(`  -> 已寫入 ${outFile} (南下: ${southTrains.length} 班, 北上: ${northTrains.length} 班)`);
  } catch (err) {
    console.error('  - 機捷同步失敗:', err.message);
  }
}

// 4. 同步台北捷運新埔站 / 環狀線新埔民生站即時到站看板
async function syncMetroLive(outDir) {
  console.log('[4/4] 正在自 opendata.vip 同步捷運新埔即時看板動態...');
  try {
    const liveTrains = await server.fetchMetroLiveBoard();
    const payload = {
      updatedAt: getTaiwanNow().toISOString(),
      updateTimeDisplay: getTaiwanTimeString(),
      count: liveTrains.length,
      trains: liveTrains
    };

    const outFile = path.join(outDir, 'metro-live.json');
    fs.writeFileSync(outFile, JSON.stringify(payload));
    console.log(`  -> 已寫入 ${outFile} (看板共 ${liveTrains.length} 筆即時進站資訊)`);
  } catch (err) {
    console.error('  - 捷運看板同步失敗:', err.message);
  }
}

async function main() {
  const t0 = Date.now();
  console.log('=== [雙埔大眾運輸] 開始全域雲端自動同步 ===\n');

  const outDir = path.join(__dirname, '../data');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  // 平行執行四大資料同步任務
  await Promise.allSettled([
    syncYouBike(outDir),
    syncThsr(outDir),
    syncTymetro(outDir),
    syncMetroLive(outDir)
  ]);

  console.log(`\n=== 全域同步作業圓滿完成！(總耗時: ${Date.now() - t0} ms) ===`);
}

main().catch(console.error);
