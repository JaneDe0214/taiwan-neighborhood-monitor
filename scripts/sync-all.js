/**
 * 雙埔生活 - 全大眾運輸與 YouBike 雲端定時同步整合中樞 (高頻極速最佳化版)
 * 特色：
 * 1. 極速平行抓取：YouBike (opendata.vip 優先 + 官方 CSV 備援) + 高鐵官網 + 桃捷官網 + 捷運新埔即時看板
 * 2. 數據極致精簡：過濾 YouBike 冗餘英文與地址欄位，檔案瘦身 50%+，防止高頻 Git 膨脹
 * 3. 智慧防抖與靜態保護：網路異常或外部逾時時，確保本地已有資料永不被破壞
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const server = require('../server.js');

function fetchUrl(url, timeoutMs = 8000, hopCount = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br'
      }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (hopCount >= 5) {
          return reject(new Error('重新導向次數過多'));
        }
        try {
          const nextUrl = new URL(res.headers.location, url).toString();
          return fetchUrl(nextUrl, timeoutMs, hopCount + 1).then(resolve).catch(reject);
        } catch (e) {
          return reject(e);
        }
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP Status ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        try {
          resolve(server.decodeCompressedBuffer(Buffer.concat(chunks), res.headers['content-encoding']).toString('utf8'));
        } catch (e) {
          reject(new Error(`解碼回應失敗: ${e.message}`));
        }
      });
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

// 1. 同步 YouBike 2.0 (首選 opendata.vip，備援官方端點；精煉壓縮欄位)
async function syncYouBike(outDir) {
  console.log('[1/4] 正在同步 YouBike 2.0 即時動態...');
  let ntpcList = [];
  let tycgList = [];

  // 嘗試優先從 opendata.vip 高速抓取
  try {
    const [ntpcRaw, tycgRaw] = await Promise.all([
      fetchUrl('https://www.opendata.vip/tdx/youbikeApi/NewTaipei', 6000),
      fetchUrl('https://www.opendata.vip/tdx/youbikeApi/Taoyuan', 6000)
    ]);
    const p1 = JSON.parse(ntpcRaw);
    const p2 = JSON.parse(tycgRaw);
    if (Array.isArray(p1) && p1.length > 500) ntpcList = p1;
    if (Array.isArray(p2) && p2.length > 300) tycgList = p2;
    console.log(`  - [opendata.vip 優先成功] 新北: ${ntpcList.length} 站, 桃園: ${tycgList.length} 站`);
  } catch (err) {
    console.warn('  - opendata.vip 暫時連線異常，切換至官方備援端點:', err.message);
  }

  // 備援：若未成功則切換為新北市官方全量 CSV 與桃園開放資料
  if (ntpcList.length === 0 || tycgList.length === 0) {
    try {
      const NTPC_URL = 'https://data.ntpc.gov.tw/api/datasets/010E5B15-3823-4B20-B401-B1CF000550C5/csv/file';
      const TYCG_URL = 'https://opendata.tycg.gov.tw/api/dataset/5ca2bfc7-9ace-4719-88ae-4034b9a5a55c/resource/08274d61-edbe-419d-8fcc-7a643831283d/download';
      const [nRaw, tRaw] = await Promise.all([
        ntpcList.length === 0 ? fetchUrl(NTPC_URL, 10000) : null,
        tycgList.length === 0 ? fetchUrl(TYCG_URL, 10000) : null
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

  // 核心精煉：只保留比對與即時車況所需欄位，拿掉多餘英文字串，瘦身 50% 避免 Git 膨脹
  const slimNtpc = ntpcList.map(s => ({
    uid: s.uid || s.sno || s.StationUID,
    name: s.name || s.sna,
    bikes: s.bikes != null ? s.bikes : parseInt(s.sbi_quantity != null ? s.sbi_quantity : (s.sbi || '0'), 10),
    empty: s.empty != null ? s.empty : parseInt(s.bemp || '0', 10),
    eBikes: s.eBikes != null ? s.eBikes : parseInt(s.eyb_quantity || (s.sbi_detail && s.sbi_detail.eyb) || '0', 10),
    time: s.time || s.mday || ''
  }));

  const slimTycg = tycgList.map(s => ({
    uid: s.uid || s.sno || s.StationUID,
    name: s.name || s.sna,
    bikes: s.bikes != null ? s.bikes : parseInt(s.sbi != null ? s.sbi : (s.sbi_quantity || '0'), 10),
    empty: s.empty != null ? s.empty : parseInt(s.bemp || '0', 10),
    eBikes: s.eBikes != null ? s.eBikes : parseInt((s.sbi_detail && s.sbi_detail.eyb) || s.eyb_quantity || '0', 10),
    time: s.time || s.mday || ''
  }));

  const outFile = path.join(outDir, 'youbike.json');
  let existingData = {};
  if (fs.existsSync(outFile)) {
    try {
      existingData = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    } catch (_e) {}
  }

  const finalNtpc = slimNtpc.length > 0 ? slimNtpc : (Array.isArray(existingData.ntpc) ? existingData.ntpc : []);
  const finalTycg = slimTycg.length > 0 ? slimTycg : (Array.isArray(existingData.tycg) ? existingData.tycg : []);

  if (finalNtpc.length === 0 && finalTycg.length === 0) {
    console.warn('  - YouBike 雙端點均無有效資料，略過寫入以保護本地快照');
    return;
  }

  const timeStr = getTaiwanTimeString();
  const payload = {
    updatedAt: new Date().toISOString(),
    updateTimeDisplay: (slimNtpc.length > 0 || slimTycg.length > 0) ? timeStr : (existingData.updateTimeDisplay || timeStr),
    ntpcCount: finalNtpc.length,
    tycgCount: finalTycg.length,
    ntpc: finalNtpc,
    tycg: finalTycg
  };

  fs.writeFileSync(outFile, JSON.stringify(payload));
  console.log(`  -> 已寫入 ${outFile} (更新時間: ${payload.updateTimeDisplay}，精煉站點: ${finalNtpc.length + finalTycg.length} 站)`);
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
      updatedAt: new Date().toISOString(),
      south: { count: southTrains.length, trains: southTrains },
      north: { count: northTrains.length, trains: northTrains }
    };

    const outFile = path.join(outDir, 'thsr.json');
    fs.writeFileSync(outFile, JSON.stringify(payload));
    console.log(`  -> 已寫入 ${outFile} (南下: ${southTrains.length} 班, 北上: ${northTrains.length} 班)`);
  } catch (err) {
    console.error('  - 高鐵同步失敗 (維持既有快照):', err.message);
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
      updatedAt: new Date().toISOString(),
      south: { count: southTrains.length, trains: southTrains },
      north: { count: northTrains.length, trains: northTrains }
    };

    const outFile = path.join(outDir, 'tymetro.json');
    fs.writeFileSync(outFile, JSON.stringify(payload));
    console.log(`  -> 已寫入 ${outFile} (南下: ${southTrains.length} 班, 北上: ${northTrains.length} 班)`);
  } catch (err) {
    console.error('  - 機捷同步失敗 (維持既有快照):', err.message);
  }
}

// 4. 同步台北捷運新埔/板橋即時到站看板與車廂擁擠度 (BL08 新埔 / BL07 板橋)
async function syncMetroLive(outDir) {
  console.log('[4/5] 正在自 opendata.vip 同步捷運新埔/板橋即時看板與車廂擁擠度...');
  try {
    const [liveTrains, carWeightData] = await Promise.all([
      server.fetchMetroLiveBoard().catch(err => {
        console.warn('  - 即時到站看板暫時異常:', err.message);
        return [];
      }),
      server.fetchCarWeightData('all').catch(err => {
        console.warn('  - 車廂擁擠度暫時異常:', err.message);
        return {};
      })
    ]);

    const outFile = path.join(outDir, 'metro-live.json');
    let existingData = {};
    if (fs.existsSync(outFile)) {
      try {
        existingData = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      } catch (e) {}
    }

    const hasFreshTrains = liveTrains.length > 0;
    const hasFreshWeight = carWeightData && Object.keys(carWeightData).length > 0;
    const payload = {
      updatedAt: (hasFreshTrains || hasFreshWeight) ? new Date().toISOString() : (existingData.updatedAt || new Date().toISOString()),
      updateTimeDisplay: (hasFreshTrains || hasFreshWeight) ? getTaiwanTimeString() : (existingData.updateTimeDisplay || getTaiwanTimeString()),
      count: hasFreshTrains ? liveTrains.length : (existingData.count || 0),
      trains: hasFreshTrains ? liveTrains : (existingData.trains || []),
      carWeight: hasFreshWeight ? carWeightData : (existingData.carWeight || {})
    };

    fs.writeFileSync(outFile, JSON.stringify(payload));
    console.log(`  -> 已寫入 ${outFile} (看板共 ${payload.trains.length} 筆即時進站資訊，車廂擁擠度涵蓋 ${Object.keys(payload.carWeight).length} 站)`);
  } catch (err) {
    console.error('  - 捷運看板同步失敗 (維持既有快照):', err.message);
  }
}

// 5. 同步高鐵桃園站即時剩餘停車位 (P1/P2/P3 停車場)
async function syncParking(outDir) {
  console.log('[5/5] 正在自 opendata.vip 同步高鐵即時停車場剩餘車位...');
  try {
    const lots = await server.fetchThsrParkingData();
    const outFile = path.join(outDir, 'parking.json');
    let existingData = {};
    if (fs.existsSync(outFile)) {
      try {
        existingData = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      } catch (e) {}
    }
    const existingLots = Array.isArray(existingData.lots) ? existingData.lots : [];

    const payload = {
      updatedAt: lots.length > 0 ? new Date().toISOString() : (existingData.updatedAt || new Date().toISOString()),
      updateTimeDisplay: lots.length > 0 ? getTaiwanTimeString() : (existingData.updateTimeDisplay || getTaiwanTimeString()),
      lots: lots.length > 0 ? lots : existingLots
    };

    fs.writeFileSync(outFile, JSON.stringify(payload));
    console.log(`  -> 已寫入 ${outFile} (停車場共 ${payload.lots.length} 處即時車位資料)`);
  } catch (err) {
    console.error('  - 高鐵停車場同步失敗 (維持既有快照):', err.message);
  }
}

async function main() {
  const t0 = Date.now();
  console.log('=== [雙埔大眾運輸] 開始全域雲端自動同步 (全維度極速版) ===\n');

  const outDir = path.join(__dirname, '../data');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  // 平行執行五大資料同步任務
  await Promise.allSettled([
    syncYouBike(outDir),
    syncThsr(outDir),
    syncTymetro(outDir),
    syncMetroLive(outDir),
    syncParking(outDir)
  ]);

  console.log(`\n=== 全域同步作業圓滿完成！(總耗時: ${Date.now() - t0} ms) ===`);
}

main().catch(console.error);
