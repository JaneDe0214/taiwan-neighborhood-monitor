/**
 * 雙埔生活 × 世界即時之窗 - 全大眾運輸與 YouBike 雲端定時同步整合中樞 (高頻極速最佳化版)
 * 特色：
 * 1. 極速平行抓取：YouBike (官方全台 JSON / opendata.vip + 官方 CSV 備援) + 高鐵官網 + 桃捷官網 + 捷運即時看板 + 停車場/公車/台鐵/國道靜態快照
 * 2. 資料極致精簡：過濾 YouBike 冗餘英文字串，保留精簡座標支援附近雷達，瘦身防止高頻 Git 膨脹
 * 3. 智慧去彈跳與靜態保護：網路異常或外部逾時時，確保本機已有資料永不被破壞，也不偽造空白更新時間
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const server = require('../server.js');

function fetchUrl(url, timeoutMs = 8000, hopCount = 0) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
      if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
          (typeof server.isDisallowedRedirectHost === 'function' && server.isDisallowedRedirectHost(parsed.hostname))) {
        return reject(new Error(`不允許的同步目標網址: ${url}`));
      }
    } catch (e) {
      return reject(e);
    }
    const mod = parsed.protocol === 'http:' ? http : https;
    let settled = false;
    const doneResolve = (v) => { if (!settled) { settled = true; clearTimeout(totalTimer); resolve(v); } };
    const doneReject = (e) => { if (!settled) { settled = true; clearTimeout(totalTimer); reject(e); } };

    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br'
      }
    }, res => {
      res.on('error', doneReject);
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (hopCount >= 5) {
          return doneReject(new Error('重新導向次數過多'));
        }
        try {
          const nextParsed = new URL(res.headers.location, url);
          if ((nextParsed.protocol !== 'https:' && nextParsed.protocol !== 'http:') ||
              (typeof server.isDisallowedRedirectHost === 'function' && server.isDisallowedRedirectHost(nextParsed.hostname))) {
            return doneReject(new Error(`不允許的重新導向目標: ${nextParsed.hostname}`));
          }
          clearTimeout(totalTimer);
          settled = true;
          return fetchUrl(nextParsed.toString(), timeoutMs, hopCount + 1).then(resolve).catch(reject);
        } catch (e) {
          return doneReject(e);
        }
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return doneReject(new Error(`HTTP Status ${res.statusCode}`));
      }
      const chunks = [];
      let totalBytes = 0;
      res.on('data', c => {
        totalBytes += c.length;
        if (totalBytes > 16 * 1024 * 1024) {
          req.destroy();
          doneReject(new Error('回應超過 16MB 安全上限'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        try {
          doneResolve(server.decodeCompressedBuffer(Buffer.concat(chunks), res.headers['content-encoding']).toString('utf8'));
        } catch (e) {
          doneReject(new Error(`解碼回應失敗: ${e.message}`));
        }
      });
    });
    const totalTimer = setTimeout(() => {
      req.destroy();
      doneReject(new Error(`連線總逾時: ${url}`));
    }, timeoutMs + 1500);
    req.on('error', doneReject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      doneReject(new Error(`連線逾時: ${url}`));
    });
  });
}

function invokeServerApi(urlPath, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const headers = {};
    let statusCode = 200;
    const chunks = [];
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };
    const timer = setTimeout(() => {
      mockRes.destroyed = true;
      finish(null);
    }, timeoutMs);
    const mockReq = {
      method: 'GET',
      url: urlPath,
      headers: { host: 'localhost' },
      socket: { remoteAddress: '127.0.0.1' },
      on: () => {},
      once: () => {},
      setTimeout: () => {},
      destroy: () => {}
    };
    const mockRes = {
      headersSent: false,
      writableEnded: false,
      destroyed: false,
      setHeader: (k, v) => { headers[String(k).toLowerCase()] = v; },
      writeHead: (code, h) => {
        statusCode = code;
        mockRes.headersSent = true;
        if (h) {
          for (const [k, v] of Object.entries(h)) headers[String(k).toLowerCase()] = v;
        }
      },
      end: (body) => {
        mockRes.writableEnded = true;
        if (body) chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8'));
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          finish(statusCode === 200 ? JSON.parse(raw) : null);
        } catch (_) {
          finish(null);
        }
      },
      destroy: () => {
        mockRes.destroyed = true;
        finish(null);
      },
      on: () => {},
      once: () => {},
      off: () => {}
    };
    try {
      server.emit('request', mockReq, mockRes);
    } catch (_) {
      finish(null);
    }
  });
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx], idx);
    }
  }));
  return results;
}

function getTaiwanNow() {
  return new Date(Date.now() + (3600000 * 8));
}

function getTaiwanTimeString() {
  const tw = getTaiwanNow();
  const hh = String(tw.getUTCHours()).padStart(2, '0');
  const mm = String(tw.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function writeFileAtomic(targetPath, dataStr) {
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, dataStr, 'utf8');
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
    throw err;
  }
}

// 1. 同步 YouBike 2.0 (首選 opendata.vip 逐市獨立抓取，備援官方全台 JSON 與官方 CSV)
async function syncYouBike(outDir) {
  console.log('[1/5] 正在同步 YouBike 2.0 即時動態...');
  let ntpcList = [];
  let tycgList = [];

  const [ntpcSettled, tycgSettled] = await Promise.allSettled([
    fetchUrl('https://www.opendata.vip/tdx/youbikeApi/NewTaipei', 6000),
    fetchUrl('https://www.opendata.vip/tdx/youbikeApi/Taoyuan', 6000)
  ]);

  if (ntpcSettled.status === 'fulfilled') {
    try {
      const p1 = JSON.parse(ntpcSettled.value);
      if (Array.isArray(p1) && p1.length >= 500) ntpcList = p1;
    } catch (_) {}
  }
  if (tycgSettled.status === 'fulfilled') {
    try {
      const p2 = JSON.parse(tycgSettled.value);
      if (Array.isArray(p2) && p2.length >= 200) tycgList = p2;
    } catch (_) {}
  }

  // 若任一市未成功，優先使用官方全台 YouBike 2.0 JSON 補齊
  if (ntpcList.length === 0 || tycgList.length === 0) {
    try {
      const yb2Raw = await fetchUrl('https://apis.youbike.com.tw/json/station-yb2.json', 8000);
      const yb2All = JSON.parse(yb2Raw);
      if (Array.isArray(yb2All) && yb2All.length > 1000) {
        if (ntpcList.length === 0) {
          const nFiltered = yb2All.filter(r => String(r.station_no || '').startsWith('5002') || String(r.area_code || '') === '05');
          if (nFiltered.length >= 500) {
            ntpcList = nFiltered.map(r => ({
              uid: `NWT${r.station_no}`,
              sno: String(r.station_no || ''),
              name: r.name_tw,
              lat: r.lat,
              lng: r.lng,
              ar: r.address_tw,
              bikes: r.available_spaces,
              empty: r.empty_spaces,
              eBikes: r.available_spaces_detail ? r.available_spaces_detail.eyb : 0,
              time: r.time || ''
            }));
          }
        }
        if (tycgList.length === 0) {
          const tFiltered = yb2All.filter(r => String(r.station_no || '').startsWith('5003') || String(r.area_code || '') === '07');
          if (tFiltered.length >= 200) {
            tycgList = tFiltered.map(r => ({
              uid: `TAO${r.station_no}`,
              sno: String(r.station_no || ''),
              name: r.name_tw,
              lat: r.lat,
              lng: r.lng,
              ar: r.address_tw,
              bikes: r.available_spaces,
              empty: r.empty_spaces,
              eBikes: r.available_spaces_detail ? r.available_spaces_detail.eyb : 0,
              time: r.time || ''
            }));
          }
        }
      }
    } catch (_) {}
  }

  // 次級備援：新北市官方全量 CSV 與桃園開放資料
  if (ntpcList.length === 0 || tycgList.length === 0) {
    const NTPC_URL = 'https://data.ntpc.gov.tw/api/datasets/010E5B15-3823-4B20-B401-B1CF000550C5/csv/file';
    const TYCG_URL = 'https://opendata.tycg.gov.tw/api/dataset/5ca2bfc7-9ace-4719-88ae-4034b9a5a55c/resource/08274d61-edbe-419d-8fcc-7a643831283d/download';
    const [nSettled, tSettled] = await Promise.allSettled([
      ntpcList.length === 0 ? fetchUrl(NTPC_URL, 10000) : Promise.resolve(null),
      tycgList.length === 0 ? fetchUrl(TYCG_URL, 10000) : Promise.resolve(null)
    ]);
    if (nSettled.status === 'fulfilled' && nSettled.value) {
      const parsedN = server.parseCsvToJson(nSettled.value);
      if (parsedN.length >= 500) ntpcList = parsedN;
    }
    if (tSettled.status === 'fulfilled' && tSettled.value) {
      try {
        const p = JSON.parse(tSettled.value);
        const arr = Array.isArray(p) ? p : (p.retVal || []);
        if (arr.length >= 200) tycgList = arr;
      } catch (_) {}
    }
  }

  const roundCoord = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? Math.round(n * 100000) / 100000 : undefined;
  };

  const toIntOrZero = (v, fallback = '0') => {
    const n = parseInt(String(v ?? fallback).trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };

  const slimNtpc = ntpcList.map(s => ({
    uid: s.uid || s.sno || s.StationUID,
    name: s.name || s.sna,
    lat: roundCoord(s.lat),
    lng: roundCoord(s.lng != null ? s.lng : s.lon),
    ar: s.address || s.ar || undefined,
    bikes: toIntOrZero(s.bikes != null ? s.bikes : (s.sbi_quantity != null ? s.sbi_quantity : s.sbi)),
    empty: toIntOrZero(s.empty != null ? s.empty : s.bemp),
    eBikes: toIntOrZero(s.eBikes != null ? s.eBikes : (s.eyb_quantity || (s.sbi_detail && s.sbi_detail.eyb))),
    time: s.time || s.mday || ''
  }));

  const slimTycg = tycgList.map(s => ({
    uid: s.uid || s.sno || s.StationUID,
    name: s.name || s.sna,
    lat: roundCoord(s.lat),
    lng: roundCoord(s.lng != null ? s.lng : s.lon),
    ar: s.address || s.ar || undefined,
    bikes: toIntOrZero(s.bikes != null ? s.bikes : (s.sbi != null ? s.sbi : s.sbi_quantity)),
    empty: toIntOrZero(s.empty != null ? s.empty : s.bemp),
    eBikes: toIntOrZero(s.eBikes != null ? s.eBikes : ((s.sbi_detail && s.sbi_detail.eyb) || s.eyb_quantity)),
    time: s.time || s.mday || ''
  }));

  if (slimNtpc.length === 0 && slimTycg.length === 0) {
    console.warn('  - YouBike 本次未取得新資料，略過寫入以保護既有快照與時間戳');
    return false;
  }

  const outFile = path.join(outDir, 'youbike.json');
  let existingData = {};
  if (fs.existsSync(outFile)) {
    try {
      existingData = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    } catch (_e) {}
  }

  const finalNtpc = slimNtpc.length > 0 ? slimNtpc : (Array.isArray(existingData.ntpc) ? existingData.ntpc : []);
  const finalTycg = slimTycg.length > 0 ? slimTycg : (Array.isArray(existingData.tycg) ? existingData.tycg : []);
  const nowIso = new Date().toISOString();
  const timeStr = getTaiwanTimeString();

  const payload = {
    updatedAt: nowIso,
    ntpcUpdatedAt: slimNtpc.length > 0 ? nowIso : (existingData.ntpcUpdatedAt || existingData.updatedAt || nowIso),
    tycgUpdatedAt: slimTycg.length > 0 ? nowIso : (existingData.tycgUpdatedAt || existingData.updatedAt || nowIso),
    updateTimeDisplay: timeStr,
    ntpcCount: finalNtpc.length,
    tycgCount: finalTycg.length,
    ntpc: finalNtpc,
    tycg: finalTycg
  };

  writeFileAtomic(outFile, JSON.stringify(payload));
  console.log(`  -> 已寫入 ${outFile} (更新時間: ${payload.updateTimeDisplay}，精煉站點: ${finalNtpc.length + finalTycg.length} 站)`);
  return true;
}

// 2. 同步台灣高鐵當日時刻表 (南下: 板橋➔桃園 / 北上: 桃園➔板橋)
async function syncThsr(outDir) {
  console.log('[2/5] 正在自台灣高鐵官網同步當日最新班表 (保證停靠桃園)...');
  try {
    const [southTrains, northTrains] = await Promise.all([
      server.fetchOfficialThsrTimetable('BanQiao', 'TaoYuan'),
      server.fetchOfficialThsrTimetable('TaoYuan', 'BanQiao')
    ]);
    if (!southTrains.length || !northTrains.length) {
      throw new Error('高鐵班表數量異常空白');
    }

    const payload = {
      date: server.getTaiwanDateString(true),
      updatedAt: new Date().toISOString(),
      south: { count: southTrains.length, trains: southTrains },
      north: { count: northTrains.length, trains: northTrains }
    };

    const outFile = path.join(outDir, 'thsr.json');
    writeFileAtomic(outFile, JSON.stringify(payload));
    console.log(`  -> 已寫入 ${outFile} (南下: ${southTrains.length} 班, 北上: ${northTrains.length} 班)`);
    return true;
  } catch (err) {
    console.error('  - 高鐵同步失敗 (維持既有快照):', err.message);
    return false;
  }
}

// 3. 同步桃園機場捷運當日時刻表 (南下: A3➔A18 / 北上: A18➔A3)
async function syncTymetro(outDir) {
  console.log('[3/5] 正在自桃園捷運官網同步當日最新班表...');
  try {
    const [southTrains, northTrains] = await Promise.all([
      server.fetchOfficialTymetroTimetable('south'),
      server.fetchOfficialTymetroTimetable('north')
    ]);
    if (!southTrains.length || !northTrains.length) {
      throw new Error('機捷班表數量異常空白');
    }

    const payload = {
      date: server.getTaiwanDateString(true),
      updatedAt: new Date().toISOString(),
      south: { count: southTrains.length, trains: southTrains },
      north: { count: northTrains.length, trains: northTrains }
    };

    const outFile = path.join(outDir, 'tymetro.json');
    writeFileAtomic(outFile, JSON.stringify(payload));
    console.log(`  -> 已寫入 ${outFile} (南下: ${southTrains.length} 班, 北上: ${northTrains.length} 班)`);
    return true;
  } catch (err) {
    console.error('  - 機捷同步失敗 (維持既有快照):', err.message);
    return false;
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

    const hasFreshTrains = liveTrains.length > 0;
    const hasFreshWeight = carWeightData && Object.keys(carWeightData).length > 0;
    if (!hasFreshTrains && !hasFreshWeight) {
      console.warn('  - 捷運看板與車廂擁擠度均無新資料，略過寫入以保護既有快照');
      return false;
    }

    const outFile = path.join(outDir, 'metro-live.json');
    let existingData = {};
    if (fs.existsSync(outFile)) {
      try {
        existingData = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      } catch (e) {}
    }

    const payload = {
      updatedAt: new Date().toISOString(),
      updateTimeDisplay: getTaiwanTimeString(),
      count: hasFreshTrains ? liveTrains.length : (existingData.count || 0),
      trains: hasFreshTrains ? liveTrains : (existingData.trains || []),
      carWeight: hasFreshWeight ? carWeightData : (existingData.carWeight || {})
    };

    writeFileAtomic(outFile, JSON.stringify(payload));
    console.log(`  -> 已寫入 ${outFile} (看板共 ${payload.trains.length} 筆即時進站資訊，車廂擁擠度涵蓋 ${Object.keys(payload.carWeight).length} 站)`);
    return true;
  } catch (err) {
    console.error('  - 捷運看板同步失敗 (維持既有快照):', err.message);
    return false;
  }
}

// 5. 同步高鐵桃園站即時剩餘停車位 + 雙埔周邊停車場/公車/台鐵/國道/機場入出境航班雷達靜態網頁同源備援快照
async function syncParking(outDir) {
  console.log('[5/5] 正在同步高鐵停車場及雙埔周邊公車/台鐵/停車場/國道/全球機場航班雷達同源快照...');
  try {
    const flightHubTargets = [
      { key: 'TPE', lat: 25.0777, lon: 121.2328 },
      { key: 'TSA', lat: 25.0694, lon: 121.5525 },
      { key: 'KHH', lat: 22.5771, lon: 120.3500 },
      { key: 'HND', lat: 35.5494, lon: 139.7798 },
      { key: 'CTS', lat: 42.7752, lon: 141.6923 },
      { key: 'OKA', lat: 26.1958, lon: 127.6458 },
      { key: 'ICN', lat: 37.4602, lon: 126.4407 },
      { key: 'SYD', lat: -33.9399, lon: 151.1753 },
      { key: 'SIN', lat: 1.3644, lon: 103.9915 },
      { key: 'BKK', lat: 13.6900, lon: 100.7501 },
      { key: 'ZRH', lat: 47.4582, lon: 8.5555 },
      { key: 'LHR', lat: 51.4700, lon: -0.4543 },
      { key: 'CDG', lat: 49.0097, lon: 2.5479 },
      { key: 'VCE', lat: 45.5053, lon: 12.3519 },
      { key: 'AMS', lat: 52.3105, lon: 4.7683 },
      { key: 'LAX', lat: 33.9416, lon: -118.4085 },
      { key: 'JFK', lat: 40.6413, lon: -73.7781 },
      { key: 'SFO', lat: 37.6213, lon: -122.3790 },
      { key: 'MIA', lat: 25.7959, lon: -80.2870 },
      { key: 'HNL', lat: 21.3187, lon: -157.9225 },
      { key: 'RVN', lat: 66.5648, lon: 25.8304 },
      { key: 'TOS', lat: 69.6833, lon: 18.9189 },
      { key: 'KEF', lat: 63.9850, lon: -22.6056 },
      { key: 'SJO', lat: 9.9939, lon: -84.2088 },
      { key: 'GIG', lat: -22.8099, lon: -43.2505 },
      { key: 'CUR', lat: 12.1889, lon: -68.9598 },
      { key: 'PMI', lat: 39.5517, lon: 2.7388 },
      { key: 'KTM', lat: 27.6966, lon: 85.3591 },
      { key: 'JRO', lat: -3.4294, lon: 37.0745 },
      { key: 'GYD', lat: 40.4675, lon: 50.0467 },
      { key: 'TER', lat: 38.7618, lon: -27.0908 },
      { key: 'CTU', lat: 30.5785, lon: 103.9471 }
    ];
    const newsCountries = ['TW', 'JP', 'KR', 'AU', 'SG', 'TH', 'CH', 'GB', 'FR', 'IT', 'NO', 'FI', 'IS', 'US', 'CA', 'CR', 'BR', 'CW', 'ES', 'NP', 'TZ', 'AZ'];

    const [lots, qpParking, bpParking, qpBus, bpBus, qpTra, bpTra, fwLive, flightHubList, newsCountryList] = await Promise.all([
      server.fetchThsrParkingData().catch(() => []),
      invokeServerApi('/api/parking/nearby?lat=25.0134&lon=121.2148'),
      invokeServerApi('/api/parking/nearby?lat=25.0225&lon=121.4685'),
      invokeServerApi('/api/bus/nearby?lat=25.0134&lon=121.2148'),
      invokeServerApi('/api/bus/nearby?lat=25.0225&lon=121.4685'),
      invokeServerApi('/api/rail/tra-nearby?lat=25.0134&lon=121.2148'),
      invokeServerApi('/api/rail/tra-nearby?lat=25.0225&lon=121.4685'),
      invokeServerApi('/api/freeway/live'),
      runWithConcurrency(flightHubTargets, 8, async (h) => {
        try {
          if (typeof server.fetchNearbyFlightsData === 'function') {
            const d = await server.fetchNearbyFlightsData(h.lat, h.lon);
            if (d && d.airport && Array.isArray(d.flights)) {
              return [h.key, { ...d, flights: d.flights.slice(0, 18) }];
            }
          }
        } catch (_) {}
        return null;
      }),
      runWithConcurrency(newsCountries, 6, async (cc) => {
        try {
          if (typeof server.fetchLocalNewsHeadlines === 'function') {
            const list = await server.fetchLocalNewsHeadlines(cc);
            if (Array.isArray(list) && list.length > 0) return [cc, list.slice(0, 3)];
          }
        } catch (_) {}
        return null;
      })
    ]);

    const outFile = path.join(outDir, 'parking.json');
    let existingData = {};
    if (fs.existsSync(outFile)) {
      try {
        existingData = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      } catch (e) {}
    }

    const flightsLive = { ...(existingData.flightsLive || {}) };
    let freshFlightHubCount = 0;
    for (const pair of (flightHubList || [])) {
      if (pair && pair[0] && pair[1] && Array.isArray(pair[1].flights) && pair[1].flights.length > 0) {
        flightsLive[pair[0]] = pair[1];
        freshFlightHubCount++;
      }
    }

    const newsLive = { ...(existingData.newsLive || {}) };
    for (const pair of (newsCountryList || [])) {
      if (pair && pair[0] && Array.isArray(pair[1]) && pair[1].length > 0) {
        newsLive[pair[0]] = pair[1];
      }
    }

    const hasFreshThsr = Array.isArray(lots) && lots.length > 0;
    const hasFreshQpLots = Array.isArray(qpParking?.lots) && qpParking.lots.length > 0;
    const hasFreshBpLots = Array.isArray(bpParking?.lots) && bpParking.lots.length > 0;
    const hasFreshQpBus = Array.isArray(qpBus?.stations) && qpBus.stations.length > 0;
    const hasFreshBpBus = Array.isArray(bpBus?.stations) && bpBus.stations.length > 0;
    const hasFreshQpTra = Array.isArray(qpTra?.stations) && qpTra.stations.length > 0;
    const hasFreshBpTra = Array.isArray(bpTra?.stations) && bpTra.stations.length > 0;
    const hasFreshFw = Array.isArray(fwLive?.corridors) && fwLive.corridors.length > 0;

    if (!hasFreshThsr && !hasFreshQpLots && !hasFreshBpLots && !hasFreshQpBus && !hasFreshBpBus && !hasFreshQpTra && !hasFreshBpTra && !hasFreshFw && freshFlightHubCount === 0) {
      console.warn('  - 停車場與周邊交通快照均無新資料，略過寫入以保護既有快照');
      return false;
    }

    const existingLots = Array.isArray(existingData.lots) ? existingData.lots : [];
    const payload = {
      updatedAt: new Date().toISOString(),
      updateTimeDisplay: getTaiwanTimeString(),
      lots: hasFreshThsr ? lots : existingLots,
      qpLots: hasFreshQpLots ? qpParking.lots : (existingData.qpLots || []),
      bpLots: hasFreshBpLots ? bpParking.lots : (existingData.bpLots || []),
      busDual: {
        qingpu: hasFreshQpBus ? qpBus : (existingData.busDual?.qingpu || null),
        banqiao: hasFreshBpBus ? bpBus : (existingData.busDual?.banqiao || null)
      },
      traDual: {
        qingpu: hasFreshQpTra ? qpTra : (existingData.traDual?.qingpu || null),
        banqiao: hasFreshBpTra ? bpTra : (existingData.traDual?.banqiao || null)
      },
      freewayLive: hasFreshFw ? fwLive : (existingData.freewayLive || null),
      flightsLive,
      newsLive
    };

    writeFileAtomic(outFile, JSON.stringify(payload));
    console.log(`  -> 已寫入 ${outFile} (高鐵車位: ${payload.lots.length} 處, 青埔車位: ${payload.qpLots.length} 處, 板橋車位: ${payload.bpLots.length} 處, 國道走廊: ${payload.freewayLive?.corridors?.length || 0} 條, 機場航班雷達: ${Object.keys(payload.flightsLive || {}).length} 座樞紐, 各國新聞脈動: ${Object.keys(payload.newsLive || {}).length} 國)`);
    return true;
  } catch (err) {
    console.error('  - 高鐵停車場與周邊快照同步失敗 (維持既有快照):', err.message);
    return false;
  }
}

async function main() {
  const t0 = Date.now();
  console.log('=== [雙埔大眾運輸] 開始全域雲端自動同步 (全維度極速版) ===\n');

  const outDir = path.join(__dirname, '../data');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const results = await Promise.allSettled([
    syncYouBike(outDir),
    syncThsr(outDir),
    syncTymetro(outDir),
    syncMetroLive(outDir),
    syncParking(outDir)
  ]);

  const successCount = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
  console.log(`\n=== 全域同步作業完成！(成功更新: ${successCount}/5 項，總耗時: ${Date.now() - t0} ms) ===`);
  if (successCount === 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { syncYouBike, syncThsr, syncTymetro, syncMetroLive, syncParking, writeFileAtomic };
