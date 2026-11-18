/**
 * 雙埔生活即時環境監控系統 - 本機開發與 API 反向代理伺服器
 * 零相依套件 (Pure Node.js 原生模組)，提供靜態網頁託管與官方 YouBike API 快取反向代理
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// 安全解壓遠端 HTTP 回應 Buffer (支援 gzip / deflate / br 與未壓縮原文)
function decodeCompressedBuffer(buffer, contentEncoding) {
  const enc = String(contentEncoding || '').toLowerCase();
  if (enc.includes('gzip') || enc.includes('x-gzip')) {
    return zlib.gunzipSync(buffer);
  }
  if (enc.includes('deflate')) {
    try {
      return zlib.inflateSync(buffer);
    } catch (e) {
      return zlib.inflateRawSync(buffer);
    }
  }
  if (enc.includes('br') && typeof zlib.brotliDecompressSync === 'function') {
    return zlib.brotliDecompressSync(buffer);
  }
  return buffer;
}

// 寫入有容量上限的 Map (FIFO/LRU 淘汰最舊鍵值以防止長期記憶體膨脹)
function setBoundedMap(map, key, value, maxEntries = 200) {
  if (map.has(key)) {
    map.delete(key);
  } else {
    while (map.size >= maxEntries) {
      const oldestKey = map.keys().next().value;
      if (oldestKey === undefined) break;
      map.delete(oldestKey);
    }
  }
  map.set(key, value);
}

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
  parkingThsr: { data: null, expireAt: 0 },
  weatherMap: new Map()
};

// 臺北市交工處 (hls.bote.gov.taipei) Keep-Alive 連線池與 Cookie 狀態
const BOTE_ORIGIN = 'https://hls.bote.gov.taipei';
const BOTE_REFERER = 'https://hls.bote.gov.taipei/live/index.html';
const BOTE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const boteHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 24,
  maxFreeSockets: 12,
  keepAliveMsecs: 15000
});
const boteCookieJar = new Map();
const botePrewarmCooldown = new Map();

function extractBoteCamKey(targetPath) {
  const m = String(targetPath || '').match(/^\/(?:hls\/|streamapi_)([0-9A-Za-z_-]+)/);
  return m ? m[1] : 'global';
}

function saveBoteSetCookies(camKey, setCookieHeaders) {
  if (!Array.isArray(setCookieHeaders) || setCookieHeaders.length === 0) return;
  let camMap = boteCookieJar.get(camKey);
  if (!camMap) {
    camMap = new Map();
  }
  setBoundedMap(boteCookieJar, camKey, camMap, 200);
  for (const raw of setCookieHeaders) {
    const firstPart = String(raw || '').split(';')[0];
    const eqIdx = firstPart.indexOf('=');
    if (eqIdx > 0) {
      const k = firstPart.slice(0, eqIdx).trim();
      const v = firstPart.slice(eqIdx + 1).trim();
      if (k) camMap.set(k, v);
    }
  }
}

function getBoteCookieHeader(camKey) {
  const camMap = boteCookieJar.get(camKey);
  if (!camMap || camMap.size === 0) return '';
  return Array.from(camMap.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

function isAllowedBotePath(targetPath) {
  return /^\/(hls\/|streamapi_|live\/|_api\/|api\/)/.test(targetPath);
}

function requestBoteUpstream(targetPath, reqHeaders, onResponse, onError, clientRes, hopCount = 0) {
  if (!isAllowedBotePath(targetPath)) {
    onError(400, new Error('不允許的臺北市交控串流路徑'));
    return;
  }
  const camKey = extractBoteCamKey(targetPath);
  const headers = {
    'Referer': BOTE_REFERER,
    'Origin': BOTE_ORIGIN,
    'User-Agent': BOTE_UA,
    'Accept': '*/*',
    'Accept-Encoding': 'identity'
  };
  const cookieStr = getBoteCookieHeader(camKey);
  if (cookieStr) headers['Cookie'] = cookieStr;
  if (reqHeaders && reqHeaders.range) headers['Range'] = reqHeaders.range;

  const upstreamReq = https.request({
    hostname: 'hls.bote.gov.taipei',
    port: 443,
    path: targetPath,
    method: 'GET',
    agent: boteHttpsAgent,
    headers
  }, (upstreamRes) => {
    saveBoteSetCookies(camKey, upstreamRes.headers['set-cookie']);
    if (upstreamRes.statusCode === 401 || upstreamRes.statusCode === 403) {
      boteCookieJar.delete(camKey);
    }

    if ([301, 302, 303, 307, 308].includes(upstreamRes.statusCode) && upstreamRes.headers.location && hopCount < 4) {
      upstreamRes.resume();
      try {
        const nextUrl = new URL(upstreamRes.headers.location, BOTE_ORIGIN + targetPath);
        if (nextUrl.hostname !== 'hls.bote.gov.taipei') {
          onError(403, new Error('禁止跨網域重新導向'));
          return;
        }
        requestBoteUpstream(nextUrl.pathname + nextUrl.search, reqHeaders, onResponse, onError, clientRes, hopCount + 1);
      } catch (e) {
        onError(502, e);
      }
      return;
    }

    onResponse(upstreamRes, targetPath);
  });

  upstreamReq.setTimeout(10000, () => {
    upstreamReq.destroy(new Error('臺北市交控上游連線逾時'));
  });

  upstreamReq.on('error', (err) => {
    onError(502, err);
  });

  if (clientRes) {
    clientRes.on('close', () => {
      if (!clientRes.writableFinished) {
        try { upstreamReq.destroy(); } catch (_) {}
      }
    });
  }

  upstreamReq.end();
}

function handleBoteProxy(req, res, parsedUrl) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const targetPath = parsedUrl.pathname.replace(/^\/api\/bote/, '') + (parsedUrl.search || '');
  requestBoteUpstream(
    targetPath,
    req.headers,
    (upstreamRes, finalPath) => {
      const status = upstreamRes.statusCode || 502;
      const cleanPath = finalPath.split('?')[0].toLowerCase();
      const rawType = String(upstreamRes.headers['content-type'] || '');
      const isM3u8 = cleanPath.endsWith('.m3u8') || rawType.toLowerCase().includes('mpegurl');

      if (isM3u8 && status >= 200 && status < 300) {
        const chunks = [];
        upstreamRes.on('data', (chunk) => chunks.push(chunk));
        upstreamRes.on('end', () => {
          let body = Buffer.concat(chunks).toString('utf8');
          body = body.replace(/(^|\n)(\/(?:hls|streamapi_[^/\s]+|live)\/)/g, '$1/api/bote$2');
          res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
          res.writeHead(status);
          res.end(body);
        });
        return;
      }

      let contentType = rawType ? rawType.split(';')[0].trim() : '';
      if (cleanPath.endsWith('.mp4')) contentType = 'video/mp4';
      else if (cleanPath.endsWith('.m4s')) contentType = 'video/iso.segment';
      else if (cleanPath.endsWith('.ts')) contentType = 'video/mp2t';
      else if (!contentType) contentType = 'application/octet-stream';

      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      if (upstreamRes.headers['content-length']) {
        res.setHeader('Content-Length', upstreamRes.headers['content-length']);
      }
      if (upstreamRes.headers['content-range']) {
        res.setHeader('Content-Range', upstreamRes.headers['content-range']);
      }
      res.writeHead(status);
      upstreamRes.pipe(res);
    },
    (statusCode, err) => {
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.writeHead(statusCode || 502);
        res.end(JSON.stringify({ success: false, error: '臺北市交控代理失敗', detail: err ? err.message : '' }));
      } else {
        try { res.end(); } catch (_) {}
      }
    },
    res
  );
}

function handleBotePrewarm(req, res, parsedUrl) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  const rawIds = (parsedUrl.searchParams.get('ids') || '301,303,304,346,166,028').split(',');
  const validIds = rawIds
    .map(s => s.trim())
    .filter(s => /^[0-9A-Za-z_-]{1,12}$/.test(s))
    .slice(0, 8);

  const now = Date.now();
  const warmedIds = [];
  for (const id of validIds) {
    const last = botePrewarmCooldown.get(id) || 0;
    if (now - last < 20000) continue;
    setBoundedMap(botePrewarmCooldown, id, now, 200);
    warmedIds.push(id);
    requestBoteUpstream(
      `/hls/${id}/index.m3u8`,
      null,
      (upstreamRes) => { upstreamRes.resume(); },
      () => {},
      null
    );
  }

  res.writeHead(200);
  res.end(JSON.stringify({ ok: true, prewarmed: warmedIds, totalRequested: validIds.length }));
}

// 共用遠端文字抓取函式 (支援相對路徑重新導向、跳轉上限、壓縮解碼、Buffer 安全解碼與連線清理)
function fetchRemoteText(url, acceptHeader, timeoutMs = 8000, hopCount = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': acceptHeader,
        'Accept-Encoding': 'gzip, deflate, br'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (hopCount >= 5) {
          return reject(new Error('重新導向次數過多'));
        }
        try {
          const nextUrl = new URL(res.headers.location, url).toString();
          return fetchRemoteText(nextUrl, acceptHeader, timeoutMs, hopCount + 1).then(resolve).catch(reject);
        } catch (e) {
          return reject(e);
        }
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP Status ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        try {
          resolve(decodeCompressedBuffer(Buffer.concat(chunks), res.headers['content-encoding']).toString('utf8'));
        } catch (e) {
          reject(new Error(`解碼遠端回應失敗: ${e.message}`));
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

// 內部抓取遠端 JSON 函式
function fetchRemoteJson(url) {
  return fetchRemoteText(url, 'application/json, text/plain, */*', 8000);
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
        'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.thsrc.com.tw/ArticleContent/a3b630bb-1066-4352-a1ef-58c7b4e8ef7c',
        'Origin': 'https://www.thsrc.com.tw'
      }
    };

    const req = https.request(THSR_SEARCH_URL, options, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP Status ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        try {
          const rawData = decodeCompressedBuffer(Buffer.concat(chunks), res.headers['content-encoding']).toString('utf8');
          const json = JSON.parse(rawData);
          const rawItems = (json.data && json.data.DepartureTable && json.data.DepartureTable.TrainItem) || [];

          const cleanTrains = [];
          for (const t of rawItems) {
            const trainNo = String((t && t.TrainNumber) || '').trim();
            const cleanNo = trainNo.replace(/^0+/, '');
            // 嚴格排除不停靠桃園站之 1xx / 11xx 直達台中車次（保留 16xx）
            if (cleanNo.startsWith('1') && cleanNo.length <= 4 && !cleanNo.startsWith('16')) {
              continue;
            }
            if (!t.DepartureTime || !t.DestinationTime) continue;
            const depParts = t.DepartureTime.split(':').map(Number);
            const arrParts = t.DestinationTime.split(':').map(Number);
            if (depParts.length < 2 || arrParts.length < 2 || depParts.some(Number.isNaN) || arrParts.some(Number.isNaN)) {
              continue;
            }
            let duration = (arrParts[0] * 60 + arrParts[1]) - (depParts[0] * 60 + depParts[1]);
            if (duration < 0) duration += 1440;
            const isExpress = trainNo.startsWith('06') || trainNo.startsWith('6');
            const depOpH = depParts[0] < 4 ? depParts[0] + 24 : depParts[0];
            const depMinutes = depOpH * 60 + depParts[1];
            cleanTrains.push({
              trainNo,
              depTime: t.DepartureTime,
              arrTime: t.DestinationTime,
              duration: duration || 12,
              isExpress,
              type: isExpress ? '6xx特快' : '8xx全停',
              stopsAtTaoyuan: true,
              depMinutes
            });
          }

          cleanTrains.sort((a, b) => a.depMinutes - b.depMinutes);
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

    const req = https.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NeighborhoodMonitor/1.0',
        'Accept-Encoding': 'gzip, deflate, br'
      }
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP Status ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        try {
          const rawData = decodeCompressedBuffer(Buffer.concat(chunks), res.headers['content-encoding']).toString('utf8');
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
              const hourNum = parseInt(h, 10);
              const minNum = parseInt(m, 10);
              const opHour = hourNum < 4 ? hourNum + 24 : hourNum;
              const minutes = opHour * 60 + minNum;
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
  return fetchRemoteText(url, 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', timeoutMs);
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
      line: (from.includes('民生') || from.includes('產業園區')) ? '環狀線' : (from.includes('板橋') && (to.includes('大坪林') || to.includes('產業園區')) ? '環狀線' : '板南線')
    });
  }
  return list;
}

// 抓取台北捷運與環狀線 (新埔站、新埔民生站、板橋站、新北產業園區站) 即時到站看板
async function fetchMetroLiveBoard() {
  const [xpDep, bqDep, y20Dep] = await Promise.all([
    fetchRemoteHtml('https://www.opendata.vip/metro/departure/%E6%96%B0%E5%9F%94', 7000).catch(() => ''),
    fetchRemoteHtml('https://www.opendata.vip/metro/departure/%E6%9D%BF%E6%A9%8B', 7000).catch(() => ''),
    fetchRemoteHtml('https://www.opendata.vip/metro/departure/%E6%96%B0%E5%8C%97%E7%94%A2%E6%A5%AD%E5%9C%92%E5%8D%80', 7000).catch(() => '')
  ]);

  const list = [];
  if (xpDep) list.push(...parseDepartureHtml(xpDep, '新埔站'));
  if (bqDep) list.push(...parseDepartureHtml(bqDep, '板橋站'));
  if (y20Dep) list.push(...parseDepartureHtml(y20Dep, '新北產業園區站'));
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
      expireAt: now + 20000 // 快取 20 秒極速刷新
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

// 抓取單一 JSON 並附帶一次重試機制 (優先採用現代內建 fetch / Happy Eyeballs 消除 Open-Meteo TLS 連線重置)
async function fetchJsonWithRetry(url, retries = 1) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      if (typeof fetch === 'function') {
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'TaiwanNeighborhoodMonitor/1.0',
            'Accept': 'application/json'
          },
          signal: (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')
            ? AbortSignal.timeout(8000)
            : undefined
        });
        if (!res.ok) throw new Error(`HTTP Status ${res.status}`);
        return await res.json();
      }
      const raw = await fetchRemoteJson(url);
      return JSON.parse(raw);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// 氣象與空氣品質代理 (Open-Meteo 雙端點並發查詢 + 120 秒記憶體快取與過期容錯)
async function handleWeatherProxy(req, res, latRaw, lonRaw, tzRaw) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  const lat = parseFloat(latRaw);
  const lon = parseFloat(lonRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    res.writeHead(400);
    res.end(JSON.stringify({ success: false, error: '無效的經緯度參數' }));
    return;
  }

  const allowedTz = new Set(['Asia/Taipei', 'Asia/Tokyo', 'auto']);
  const tz = allowedTz.has(tzRaw) ? tzRaw : 'Asia/Taipei';
  const encodedTz = encodeURIComponent(tz);

  const key = `${lat.toFixed(2)},${lon.toFixed(2)},${tz}`;
  const now = Date.now();
  const cached = cache.weatherMap.get(key);
  if (cached && now < cached.expireAt) {
    res.writeHead(200);
    res.end(cached.payload);
    return;
  }

  const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,showers,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,surface_pressure,uv_index,visibility&daily=sunrise,sunset&hourly=precipitation_probability,temperature_2m,uv_index&timezone=${encodedTz}`;
  const aqiUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=us_aqi,european_aqi,pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone&timezone=${encodedTz}`;

  try {
    const [weather, airQuality] = await Promise.all([
      fetchJsonWithRetry(weatherUrl, 1),
      fetchJsonWithRetry(aqiUrl, 1)
    ]);
    const payload = JSON.stringify({
      success: true,
      weather,
      airQuality,
      fetchedAt: new Date().toISOString()
    });
    setBoundedMap(cache.weatherMap, key, { payload, expireAt: now + 120000 }, 200);
    res.writeHead(200);
    res.end(payload);
  } catch (err) {
    if (cached && cached.payload) {
      res.writeHead(200);
      res.end(cached.payload);
      return;
    }
    res.writeHead(502);
    res.end(JSON.stringify({ success: false, error: '無法取得氣象與空氣品質資料', detail: err.message }));
  }
}

// 建立 HTTP 伺服器
const server = http.createServer((req, res) => {
  let parsedUrl;
  let pathname;
  try {
    const rawPathname = decodeURIComponent(String(req.url || '/').split('?')[0]);
    if (rawPathname.split(/[\\/]/).some(seg => seg === '..')) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403 Forbidden');
      return;
    }
    parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    pathname = decodeURIComponent(parsedUrl.pathname);
  } catch (_) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400 Bad Request');
    return;
  }

  // 1. API 路由
  if (pathname === '/api/health') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, uptimeSec: Math.round(process.uptime()) }));
    return;
  }
  if (pathname === '/api/weather') {
    handleWeatherProxy(
      req,
      res,
      parsedUrl.searchParams.get('lat'),
      parsedUrl.searchParams.get('lon'),
      parsedUrl.searchParams.get('tz')
    );
    return;
  }
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
  if (pathname === '/api/bote/prewarm') {
    handleBotePrewarm(req, res, parsedUrl);
    return;
  }
  if (pathname.startsWith('/api/bote/')) {
    handleBoteProxy(req, res, parsedUrl);
    return;
  }

  // 2. 靜態檔案路由 (嚴格防範目錄穿越與後端/設定檔外洩)
  const relStaticPath = (pathname === '/' ? 'index.html' : pathname).replace(/^\/+/, '');
  if (!relStaticPath ||
      relStaticPath.split(/[\\/]/).some(seg => seg.startsWith('.') || seg === '..') ||
      relStaticPath === 'server.js' ||
      relStaticPath === 'package.json' ||
      relStaticPath === 'package-lock.json' ||
      relStaticPath.startsWith('scripts/') ||
      relStaticPath.startsWith('android/')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  let filePath = path.resolve(PUBLIC_DIR, relStaticPath);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, relStaticPath.startsWith('data/')
        ? { 'Content-Type': 'application/json; charset=utf-8' }
        : { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(relStaticPath.startsWith('data/')
        ? JSON.stringify({ success: false, error: '找不到資料檔案' })
        : '404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.webmanifest': 'application/manifest+json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon'
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
server.decodeCompressedBuffer = decodeCompressedBuffer;
server.setBoundedMap = setBoundedMap;
server._internal = { cache, boteCookieJar, botePrewarmCooldown };

module.exports = server;
