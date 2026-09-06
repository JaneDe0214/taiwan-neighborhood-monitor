/**
 * 雙埔生活圈即時環境監控系統 - 本機開發與 API 反向代理伺服器
 * 零相依套件 (Pure Node.js 原生模組)，提供靜態網頁託管與官方 YouBike API 快取反向代理
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;

// 官方 YouBike 2.0 API 端點 (新北市官方全量即時 CSV、桃園市官方即時 JSON)
const NTPC_URL = 'https://data.ntpc.gov.tw/api/datasets/010E5B15-3823-4B20-B401-B1CF000550C5/csv/file';
const TYCG_URL = 'https://opendata.tycg.gov.tw/api/dataset/5ca2bfc7-9ace-4719-88ae-4034b9a5a55c/resource/08274d61-edbe-419d-8fcc-7a643831283d/download';
const THSR_SEARCH_URL = 'https://www.thsrc.com.tw/TimeTable/Search';

// 記憶體快取 (YouBike 快取 30 秒；高鐵與機場捷運官方時刻表快取 5 分鐘)
const cache = {
  ntpc: { data: null, expireAt: 0 },
  tycg: { data: null, expireAt: 0 },
  thsrSouth: { data: null, expireAt: 0 },
  thsrNorth: { data: null, expireAt: 0 },
  tymetroSouth: { data: null, expireAt: 0 },
  tymetroNorth: { data: null, expireAt: 0 },
  metroLive: { data: null, expireAt: 0 },
  metroCarWeight: { data: null, expireAt: 0 },
  parkingThsr: { data: null, expireAt: 0 }
};

// 內部抓取遠端 JSON 函式
function fetchRemoteJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NeighborhoodMonitor/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchRemoteJson(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP Status ${res.statusCode}`));
      }
      let rawData = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { rawData += chunk; });
      res.on('end', () => {
        try {
          resolve(rawData);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error('連線逾時 (Timeout)'));
    });
  });
}

// 取得台灣時間日期字串 (YYYY/MM/DD)
function getTaiwanDateString() {
  const d = new Date();
  const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
  const twDate = new Date(utc + (3600000 * 8));
  const yyyy = twDate.getFullYear();
  const mm = String(twDate.getMonth() + 1).padStart(2, '0');
  const dd = String(twDate.getDate()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd}`;
}

// 抓取台灣高鐵官方時刻表函式 (原生 HTTPS POST)
function fetchOfficialThsrTimetable(startStation, endStation) {
  return new Promise((resolve, reject) => {
    const dateStr = getTaiwanDateString();
    const postData = new URLSearchParams({
      SearchType: 'S',
      Lang: 'TW',
      StartStation: startStation,
      EndStation: endStation,
      OutWardSearchDate: dateStr,
      OutWardSearchTime: '05:00',
      ReturnSearchDate: '',
      ReturnSearchTime: '',
      DiscountType: ''
    }).toString();

    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.thsrc.com.tw/ArticleContent/a3b630bb-1066-4352-a1ef-58c7b4e8ef7c',
        'Origin': 'https://www.thsrc.com.tw'
      }
    };

    const req = https.request(THSR_SEARCH_URL, options, (res) => {
      let rawData = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { rawData += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(rawData);
          const rawItems = (json.data && json.data.DepartureTable && json.data.DepartureTable.TrainItem) || [];
          
          const cleanTrains = rawItems.map(t => {
            const depParts = t.DepartureTime.split(':').map(Number);
            const arrParts = t.DestinationTime.split(':').map(Number);
            let duration = (arrParts[0] * 60 + arrParts[1]) - (depParts[0] * 60 + depParts[1]);
            if (duration < 0) duration += 1440;
            const isExpress = t.TrainNumber.startsWith('06') || t.TrainNumber.startsWith('6');
            return {
              trainNo: t.TrainNumber,
              depTime: t.DepartureTime,
              arrTime: t.DestinationTime,
              duration: duration || 12,
              isExpress: isExpress,
              type: isExpress ? '6xx特快' : '8xx全停',
              stopsAtTaoyuan: true,
              depMinutes: depParts[0] * 60 + depParts[1]
            };
          });

          resolve(cleanTrains);
        } catch (e) {
          reject(new Error(`解析高鐵官方資料失敗: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('高鐵官方連線逾時'));
    });

    req.write(postData);
    req.end();
  });
}

// 處理高鐵代理請求 (南下: 板橋➔桃園 / 北上: 桃園➔板橋)
async function handleThsrProxy(req, res, direction) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const cacheKey = direction === 'south' ? 'thsrSouth' : 'thsrNorth';
  const startStation = direction === 'south' ? 'BanQiao' : 'TaoYuan';
  const endStation = direction === 'south' ? 'TaoYuan' : 'BanQiao';
  const now = Date.now();

  if (cache[cacheKey].data && now < cache[cacheKey].expireAt) {
    res.writeHead(200);
    res.end(cache[cacheKey].data);
    return;
  }

  try {
    const trains = await fetchOfficialThsrTimetable(startStation, endStation);
    const serialized = JSON.stringify({
      success: true,
      direction,
      date: getTaiwanDateString(),
      count: trains.length,
      trains
    });
    cache[cacheKey] = {
      data: serialized,
      expireAt: now + (300 * 1000) // 快取 5 分鐘 (300秒)
    };
    res.writeHead(200);
    res.end(serialized);
  } catch (err) {
    if (cache[cacheKey].data) {
      // 官方網路短暫異常時，使用既有快取
      res.writeHead(200);
      res.end(cache[cacheKey].data);
    } else {
      res.writeHead(502);
      res.end(JSON.stringify({ success: false, error: '無法自台灣高鐵取得即時時刻表', detail: err.message }));
    }
  }
}

// 抓取桃園機場捷運官方時刻表函式 (原生 HTTPS GET + 官方表格即時解析)
function fetchOfficialTymetroTimetable(direction) {
  return new Promise((resolve, reject) => {
    const stationCode = direction === 'south' ? 'A3' : 'A18';
    const tableIndex = direction === 'south' ? 1 : 0;
    const targetUrl = `https://www.tymetro.com.tw/tymetro-new/tw/_pages/travel-guide/timetable.php?station=${stationCode}`;

    const req = https.get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NeighborhoodMonitor/1.0' } }, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP Status ${res.statusCode}`));
      }
      let rawData = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { rawData += chunk; });
      res.on('end', () => {
        try {
          const tables = rawData.match(/<table[\s\S]*?<\/table>/g) || [];
          const tbl = tables[tableIndex];
          if (!tbl) {
            return reject(new Error('未找到官方時刻表表格'));
          }
          const rows = tbl.match(/<tr>[\s\S]*?<\/tr>/g) || [];
          const list = [];

          rows.forEach(r => {
            const hourMatch = r.match(/<th[^>]*scope="row"[^>]*>(\d{1,2})<\/th>/);
            if (!hourMatch) return;
            const h = hourMatch[1].padStart(2, '0');
            const tds = r.match(/<td[\s\S]*?<\/td>/g) || [];
            tds.forEach(td => {
              const mMatch = td.match(/<i>(\d{1,2})<\/i>/);
              if (!mMatch) return;
              const m = mMatch[1].padStart(2, '0');
              const isExp = td.includes('直達車');
              const isPeakA18 = td.includes('停靠A18') || td.includes('尖峰增停直達車');
              const depTime = `${h}:${m}`;
              const minutes = parseInt(h, 10) * 60 + parseInt(m, 10);
              const stopsAtA18 = !isExp || isPeakA18;

              if (!stopsAtA18) return; // 嚴格只保留停靠 A18 的可用班次

              const duration = isExp ? 28 : 38;
              const arrMinutes = minutes + duration;
              const arrH = String(Math.floor(arrMinutes / 60) % 24).padStart(2, '0');
              const arrM = String(arrMinutes % 60).padStart(2, '0');

              list.push({
                trainNo: `${direction === 'south' ? 'A3➔A18' : 'A18➔A3'}-${depTime}`,
                depTime,
                arrTime: `${arrH}:${arrM}`,
                duration,
                isExpress: isExp,
                type: isExp ? '尖峰直達' : '普通車',
                depMinutes: minutes,
                min: parseInt(m, 10),
                stopsAtA18: true
              });
            });
          });

          list.sort((a, b) => a.depMinutes - b.depMinutes);
          resolve(list);
        } catch (e) {
          reject(new Error(`解析機捷官方資料失敗: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('機捷官方連線逾時'));
    });
  });
}

// 處理機捷代理請求 (南下: A3➔A18 / 北上: A18➔A3)
async function handleTymetroProxy(req, res, direction) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const cacheKey = direction === 'south' ? 'tymetroSouth' : 'tymetroNorth';
  const now = Date.now();

  if (cache[cacheKey].data && now < cache[cacheKey].expireAt) {
    res.writeHead(200);
    res.end(cache[cacheKey].data);
    return;
  }

  try {
    const trains = await fetchOfficialTymetroTimetable(direction);
    const serialized = JSON.stringify({
      success: true,
      direction,
      date: getTaiwanDateString(),
      count: trains.length,
      trains
    });
    cache[cacheKey] = {
      data: serialized,
      expireAt: now + (300 * 1000) // 快取 5 分鐘 (300秒)
    };
    res.writeHead(200);
    res.end(serialized);
  } catch (err) {
    if (cache[cacheKey].data) {
      // 官方網路短暫異常時，使用既有快取
      res.writeHead(200);
      res.end(cache[cacheKey].data);
    } else {
      res.writeHead(502);
      res.end(JSON.stringify({ success: false, error: '無法自桃園捷運取得即時時刻表', detail: err.message }));
    }
  }
}

// 解析 CSV 字串為 JSON 物件陣列
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

// 處理 YouBike 代理請求
async function handleYouBikeProxy(req, res, cityKey, sourceUrl) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const now = Date.now();
  if (cache[cityKey].data && now < cache[cityKey].expireAt) {
    res.writeHead(200);
    res.end(cache[cityKey].data);
    return;
  }

  try {
    const rawData = await fetchRemoteJson(sourceUrl);
    let jsonDataStr = rawData;
    if (cityKey === 'ntpc' || rawData.trim().startsWith('scity') || rawData.trim().startsWith('\uFEFFscity')) {
      const parsed = parseCsvToJson(rawData);
      jsonDataStr = JSON.stringify(parsed);
    }
    cache[cityKey] = {
      data: jsonDataStr,
      expireAt: now + 30000 // 快取 30 秒
    };
    res.writeHead(200);
    res.end(jsonDataStr);
  } catch (err) {
    if (cache[cityKey].data) {
      // 官方連線失敗時回傳既有舊快取
      res.writeHead(200);
      res.end(cache[cityKey].data);
    } else {
      res.writeHead(502);
      res.end(JSON.stringify({ error: '無法取得官方 YouBike 資料', detail: err.message }));
    }
  }
}

// 內部通用抓取遠端 HTML 函式
function fetchRemoteHtml(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchRemoteHtml(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP Status ${res.statusCode}`));
      }
      let rawData = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { rawData += chunk; });
      res.on('end', () => resolve(rawData));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`連線逾時: ${url}`));
    });
  });
}

// 解析到站時間 HTML 區塊
function parseDepartureHtml(html, defaultStation = '') {
  const list = [];
  const reg = /<div class="departStation">\s*([^<]+)\s*<\/div>[\s\S]*?<div class="destinationStation">\s*([^<]+)\s*<\/div>[\s\S]*?class="countDown"[^>]*data-start="([^"]+)"/g;
  let m;
  while ((m = reg.exec(html)) !== null) {
    const from = m[1].trim();
    const to = m[2].trim();
    const countdown = m[3].trim();
    let totalSec = 0;
    if (countdown.includes(':')) {
      const parts = countdown.split(':').map(Number);
      totalSec = parts[0] * 60 + parts[1];
    } else if (countdown === '進站中' || countdown === '列車進站' || countdown === '即將進站') {
      totalSec = 20;
    }
    list.push({
      station: from || defaultStation,
      dest: to,
      countdownText: countdown,
      remainSec: totalSec,
      line: from.includes('民生') ? '環狀線' : (from.includes('板橋') && (to.includes('大坪林') || to.includes('產業園區')) ? '環狀線' : '板南線')
    });
  }
  return list;
}

// 抓取台北捷運與環狀線 (新埔站、新埔民生站、板橋站) 即時到站看板
async function fetchMetroLiveBoard() {
  const [xpDep, bqDep] = await Promise.all([
    fetchRemoteHtml('https://www.opendata.vip/metro/departure/%E6%96%B0%E5%9F%94', 7000).catch(() => ''),
    fetchRemoteHtml('https://www.opendata.vip/metro/departure/%E6%9D%BF%E6%A9%8B', 7000).catch(() => '')
  ]);

  const list = [];
  if (xpDep) list.push(...parseDepartureHtml(xpDep, '新埔站'));
  if (bqDep) list.push(...parseDepartureHtml(bqDep, '板橋站'));
  return list;
}

// 處理台北捷運與環狀線即時到站看板代理請求
async function handleMetroLiveProxy(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const now = Date.now();
  if (cache.metroLive.data && now < cache.metroLive.expireAt) {
    res.writeHead(200);
    res.end(cache.metroLive.data);
    return;
  }

  try {
    const list = await fetchMetroLiveBoard();
    const serialized = JSON.stringify({
      success: true,
      updatedAt: new Date().toISOString(),
      data: list
    });
    cache.metroLive = {
      data: serialized,
      expireAt: now + 15000 // 快取 15 秒
    };
    res.writeHead(200);
    res.end(serialized);
  } catch (err) {
    if (cache.metroLive.data) {
      res.writeHead(200);
      res.end(cache.metroLive.data);
    } else {
      res.writeHead(502);
      res.end(JSON.stringify({ success: false, error: '無法取得捷運即時到站資料', detail: err.message }));
    }
  }
}

// 解析車廂擁擠度 HTML 區塊
function parseCarWeightHtml(html, stationName, code) {
  const cars = [];
  const carRegex = /<span class="carNum">([^<]+)<\/span>[\s\S]*?<span class="carWeight">([\s\S]*?)<\/span>/gi;
  let cm;
  while ((cm = carRegex.exec(html)) !== null) {
    const carNum = cm[1].trim();
    const raw = cm[2];
    const labelMatch = raw.match(/class="label\s+([^"]+)"[^>]*>([^<]+)<\/label>/i);
    let status = '舒適';
    let level = 1;
    if (labelMatch) {
      status = labelMatch[2].trim();
      const cls = labelMatch[1].toLowerCase();
      if (cls.includes('danger')) level = 4;
      else if (cls.includes('warning')) level = 3;
      else if (cls.includes('info') || cls.includes('primary')) level = 2;
      else level = 1;
    } else {
      status = raw.replace(/<[^>]+>/g, '').trim() || '舒適';
      if (status.includes('擁擠')) level = 4;
      else if (status.includes('略擠')) level = 3;
      else if (status.includes('普通')) level = 2;
      else level = 1;
    }
    cars.push({ carNum, status, level });
  }

  let message = '即時更新中';
  let hasData = cars.length > 0;
  if (!hasData) {
    if (html.includes('尚無資料')) message = '目前無列車停靠';
    else if (html.includes('營運時間已過')) message = '營運時間已過';
    else message = '離峰舒適運轉';
    for (let i = 1; i <= 6; i++) {
      cars.push({ carNum: `${i}車`, status: '舒適', level: 1 });
    }
  }

  return {
    station: stationName,
    code,
    line: '板南線',
    hasData,
    message,
    cars
  };
}

// 抓取車廂擁擠度函式 (BL08 新埔站、BL07 板橋站)
async function fetchCarWeightData(targetStation = 'all') {
  const [bl08Html, bl07Html] = await Promise.all([
    (targetStation === 'all' || targetStation === 'BL08') ? fetchRemoteHtml('https://www.opendata.vip/metro/carWeight/BL/BL08', 7000).catch(() => '') : Promise.resolve(''),
    (targetStation === 'all' || targetStation === 'BL07') ? fetchRemoteHtml('https://www.opendata.vip/metro/carWeight/BL/BL07', 7000).catch(() => '') : Promise.resolve('')
  ]);

  const result = {};
  if (bl08Html) {
    result.BL08 = parseCarWeightHtml(bl08Html, '新埔', 'BL08');
  }
  if (bl07Html) {
    result.BL07 = parseCarWeightHtml(bl07Html, '板橋', 'BL07');
  }
  return result;
}

// 處理車廂擁擠度代理請求
async function handleCarWeightProxy(req, res, targetCode) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const now = Date.now();
  if (cache.metroCarWeight.data && now < cache.metroCarWeight.expireAt) {
    res.writeHead(200);
    res.end(cache.metroCarWeight.data);
    return;
  }

  try {
    const weights = await fetchCarWeightData(targetCode || 'all');
    const serialized = JSON.stringify({
      success: true,
      updatedAt: new Date().toISOString(),
      data: weights
    });
    cache.metroCarWeight = {
      data: serialized,
      expireAt: now + 30000 // 快取 30 秒
    };
    res.writeHead(200);
    res.end(serialized);
  } catch (err) {
    if (cache.metroCarWeight.data) {
      res.writeHead(200);
      res.end(cache.metroCarWeight.data);
    } else {
      res.writeHead(502);
      res.end(JSON.stringify({ success: false, error: '無法取得車廂擁擠度資料', detail: err.message }));
    }
  }
}

// 抓取高鐵即時剩餘停車位 (桃園站 P1/P2/P3 與板橋站)
function parseParkingHtml(html) {
  const lots = [];
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRegex.exec(html)) !== null) {
    const tr = m[1];
    if (tr.includes('桃園') || tr.includes('板橋')) {
      const tds = tr.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
      if (tds.length >= 4) {
        const name = tds[0].replace(/<[^>]+>/g, '').trim();
        const spaceText = tds[1].replace(/<[^>]+>/g, '').trim();
        const status = tds[3].replace(/<[^>]+>/g, '').trim();
        let available = 0;
        let total = 0;
        if (spaceText.includes('/')) {
          const parts = spaceText.split('/').map(s => parseInt(s.replace(/[^0-9]/g, ''), 10));
          available = parts[0] || 0;
          total = parts[1] || 0;
        }
        lots.push({ name, available, total, spaceText, status });
      }
    }
  }
  return lots;
}

// 抓取高鐵停車場資料函式
async function fetchThsrParkingData() {
  const html = await fetchRemoteHtml('https://www.opendata.vip/tdx/parkingTHSR', 7000);
  return parseParkingHtml(html);
}

// 處理高鐵停車場代理請求
async function handleParkingThsrProxy(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const now = Date.now();
  if (cache.parkingThsr.data && now < cache.parkingThsr.expireAt) {
    res.writeHead(200);
    res.end(cache.parkingThsr.data);
    return;
  }

  try {
    const lots = await fetchThsrParkingData();
    const serialized = JSON.stringify({
      success: true,
      updatedAt: new Date().toISOString(),
      lots
    });
    cache.parkingThsr = {
      data: serialized,
      expireAt: now + 60000 // 快取 60 秒
    };
    res.writeHead(200);
    res.end(serialized);
  } catch (err) {
    if (cache.parkingThsr.data) {
      res.writeHead(200);
      res.end(cache.parkingThsr.data);
    } else {
      res.writeHead(502);
      res.end(JSON.stringify({ success: false, error: '無法取得高鐵停車場資料', detail: err.message }));
    }
  }
}

// 建立 HTTP 伺服器
const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // 1. API 路由
  if (pathname === '/api/youbike/ntpc') {
    handleYouBikeProxy(req, res, 'ntpc', NTPC_URL);
    return;
  }
  if (pathname === '/api/youbike/tycg') {
    handleYouBikeProxy(req, res, 'tycg', TYCG_URL);
    return;
  }
  if (pathname === '/api/thsr/south') {
    handleThsrProxy(req, res, 'south');
    return;
  }
  if (pathname === '/api/thsr/north') {
    handleThsrProxy(req, res, 'north');
    return;
  }
  if (pathname === '/api/tymetro/south') {
    handleTymetroProxy(req, res, 'south');
    return;
  }
  if (pathname === '/api/tymetro/north') {
    handleTymetroProxy(req, res, 'north');
    return;
  }
  if (pathname === '/api/metro/liveboard') {
    handleMetroLiveProxy(req, res);
    return;
  }
  if (pathname === '/api/metro/carweight') {
    const stationCode = parsedUrl.searchParams.get('station');
    handleCarWeightProxy(req, res, stationCode);
    return;
  }
  if (pathname === '/api/parking/thsr') {
    handleParkingThsrProxy(req, res);
    return;
  }

  // 2. 靜態檔案路由
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('403 Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml'
    };

    const contentType = mimeTypes[ext] || 'application/octet-stream';

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(500);
        res.end('伺服器讀取檔案失敗');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    });
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[雙埔監控系統] 本機伺服器已啟動: http://localhost:${PORT}`);
    console.log(`[API 代理] 新北市 YouBike 2.0: http://localhost:${PORT}/api/youbike/ntpc`);
    console.log(`[API 代理] 桃園市 YouBike 2.0: http://localhost:${PORT}/api/youbike/tycg`);
    console.log(`[API 代理] 台灣高鐵 (板橋➔桃園): http://localhost:${PORT}/api/thsr/south`);
    console.log(`[API 代理] 台灣高鐵 (桃園➔板橋): http://localhost:${PORT}/api/thsr/north`);
    console.log(`[API 代理] 機場捷運 (A3➔A18):   http://localhost:${PORT}/api/tymetro/south`);
    console.log(`[API 代理] 機場捷運 (A18➔A3):   http://localhost:${PORT}/api/tymetro/north`);
    console.log(`[API 代理] 台北捷運 (即時看板): http://localhost:${PORT}/api/metro/liveboard`);
    console.log(`[API 代理] 捷運車廂擁擠度:     http://localhost:${PORT}/api/metro/carweight`);
    console.log(`[API 代理] 高鐵停車場即時車位: http://localhost:${PORT}/api/parking/thsr`);
  });
}

server.fetchOfficialThsrTimetable = fetchOfficialThsrTimetable;
server.fetchOfficialTymetroTimetable = fetchOfficialTymetroTimetable;
server.fetchMetroLiveBoard = fetchMetroLiveBoard;
server.fetchCarWeightData = fetchCarWeightData;
server.fetchThsrParkingData = fetchThsrParkingData;
server.getTaiwanDateString = getTaiwanDateString;

module.exports = server;
