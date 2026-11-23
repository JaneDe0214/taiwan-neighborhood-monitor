/**
 * 雙埔生活即時環境監控系統 - 本機開發與 API 反向代理伺服器
 * 零相依套件 (Pure Node.js 原生模組)，提供靜態網頁託管與官方 YouBike API 快取反向代理
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// 安全解壓遠端 HTTP 回應 Buffer (支援 gzip / deflate / br、防 Zlib Bomb 與未壓縮原文容錯)
const ZLIB_SAFE_OPTS = { maxOutputLength: 32 * 1024 * 1024 };
function decodeCompressedBuffer(buffer, contentEncoding) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return Buffer.alloc(0);
  const enc = String(contentEncoding || '').toLowerCase();
  try {
    if (enc.includes('gzip') || enc.includes('x-gzip')) {
      if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
        return zlib.gunzipSync(buffer, ZLIB_SAFE_OPTS);
      }
      return buffer;
    }
    if (enc.includes('deflate')) {
      try {
        return zlib.inflateSync(buffer, ZLIB_SAFE_OPTS);
      } catch (e) {
        return zlib.inflateRawSync(buffer, ZLIB_SAFE_OPTS);
      }
    }
    if (/\bbr\b/.test(enc) && typeof zlib.brotliDecompressSync === 'function') {
      return zlib.brotliDecompressSync(buffer, ZLIB_SAFE_OPTS);
    }
  } catch (err) {
    // 若上游代理標記錯誤編碼但實際為純文字 JSON/HTML/CSV，保留原文以免錯殺
    const head = buffer.slice(0, 64).toString('utf8').trimStart();
    if (/^[{\[<"\uFEFF]/.test(head)) return buffer;
    throw err;
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
  metroCarWeightMap: new Map(),
  parkingThsr: { data: null, expireAt: 0 },
  weatherMap: new Map(),
  geocodeMap: new Map(),
  busStationMap: new Map(),
  busEtaMap: new Map(),
  busRouteMetaMap: new Map(),
  busRouteStopsMap: new Map(),
  youbikeCityMap: new Map(),
  intlGeocodeMap: new Map(),
  intlTransitMap: new Map(),
  intlTripMap: new Map(),
  cityBikesDir: { data: null, expireAt: 0 },
  cityBikesNetMap: new Map(),
  traStationsAll: { data: null, expireAt: 0 },
  traNearbyMap: new Map(),
  parkingStatic: { taipei: null, taipeiExp: 0, ntpc: null, ntpcExp: 0 },
  parkingLive: { taipei: null, taipeiExp: 0, ntpc: null, ntpcExp: 0, tycg: null, tycgExp: 0 },
  parkingNearbyMap: new Map(),
  freewaySections: { data: null, expireAt: 0 },
  freewayLive: { data: null, expireAt: 0 },
  travelToolkit: { fx: null, fxExp: 0, kp: null, kpExp: 0 },
  flightsNearbyMap: new Map(),
  immersiveLocalMap: new Map(),
  wallSyncMap: new Map()
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
      if (k) setBoundedMap(camMap, k, v, 30);
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
  let settled = false;
  const failOnce = (code, err) => {
    if (settled) return;
    settled = true;
    onError(code, err);
  };
  if (!isAllowedBotePath(targetPath)) {
    failOnce(400, new Error('不允許的臺北市交控串流路徑'));
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
    clearTimeout(totalTimer);
    upstreamRes.on('error', (err) => {
      failOnce(502, err);
    });
    saveBoteSetCookies(camKey, upstreamRes.headers['set-cookie']);
    if (upstreamRes.statusCode === 401 || upstreamRes.statusCode === 403) {
      boteCookieJar.delete(camKey);
    }

    if ([301, 302, 303, 307, 308].includes(upstreamRes.statusCode) && upstreamRes.headers.location && hopCount < 4) {
      upstreamRes.resume();
      try {
        const nextUrl = new URL(upstreamRes.headers.location, BOTE_ORIGIN + targetPath);
        if (nextUrl.hostname !== 'hls.bote.gov.taipei' || nextUrl.protocol !== 'https:') {
          failOnce(403, new Error('禁止跨網域重新導向'));
          return;
        }
        requestBoteUpstream(nextUrl.pathname + nextUrl.search, reqHeaders, onResponse, onError, clientRes, hopCount + 1);
      } catch (e) {
        failOnce(502, e);
      }
      return;
    }

    onResponse(upstreamRes, targetPath);
  });

  const totalTimer = setTimeout(() => {
    upstreamReq.destroy(new Error('臺北市交控上游連線總逾時'));
  }, 10000);

  upstreamReq.setTimeout(10000, () => {
    upstreamReq.destroy(new Error('臺北市交控上游連線逾時'));
  });

  upstreamReq.on('error', (err) => {
    clearTimeout(totalTimer);
    failOnce(502, err);
  });

  if (clientRes && hopCount === 0) {
    clientRes.once('close', () => {
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
        if (req.method === 'HEAD') {
          upstreamRes.resume();
          if (!res.headersSent && !res.writableEnded && !res.destroyed) {
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
            res.writeHead(status);
            res.end();
          }
          return;
        }
        const chunks = [];
        let totalBytes = 0;
        let overflowed = false;
        upstreamRes.on('data', (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > 2 * 1024 * 1024) {
            overflowed = true;
            upstreamRes.destroy(new Error('M3U8 回應超過安全大小上限'));
            return;
          }
          chunks.push(chunk);
        });
        upstreamRes.on('close', () => {
          if ((!upstreamRes.complete || overflowed) && !res.headersSent && !res.writableEnded && !res.destroyed) {
            res.writeHead(502);
            res.end('Upstream closed prematurely');
          }
        });
        upstreamRes.on('end', () => {
          if (overflowed || res.headersSent || res.writableEnded || res.destroyed) return;
          try {
            let body = decodeCompressedBuffer(Buffer.concat(chunks), upstreamRes.headers['content-encoding']).toString('utf8');
            body = body.replace(/(^|\n|URI=")(\/(?:hls|streamapi_[^/"\s]+|live)\/)/g, '$1/api/bote$2');
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
            res.writeHead(status);
            res.end(body);
          } catch (_) {
            if (!res.headersSent && !res.writableEnded && !res.destroyed) {
              res.writeHead(502);
              res.end('Invalid upstream playlist');
            }
          }
        });
        return;
      }

      let contentType = rawType ? rawType.split(';')[0].trim() : '';
      if (cleanPath.endsWith('.mp4')) contentType = 'video/mp4';
      else if (cleanPath.endsWith('.m4s')) contentType = 'video/iso.segment';
      else if (cleanPath.endsWith('.ts')) contentType = 'video/mp2t';
      else if (!contentType) contentType = 'application/octet-stream';

      if (res.headersSent || res.writableEnded || res.destroyed) {
        upstreamRes.resume();
        return;
      }
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      if (upstreamRes.headers['content-length']) {
        res.setHeader('Content-Length', upstreamRes.headers['content-length']);
      }
      if (upstreamRes.headers['content-range']) {
        res.setHeader('Content-Range', upstreamRes.headers['content-range']);
      }
      if (req.method === 'HEAD') {
        upstreamRes.resume();
        res.writeHead(status);
        res.end();
        return;
      }
      res.writeHead(status);
      upstreamRes.on('error', () => {
        if (!res.writableEnded && !res.destroyed) res.destroy();
      });
      res.on('error', () => {
        if (!upstreamRes.destroyed) upstreamRes.destroy();
      });
      upstreamRes.pipe(res);
    },
    (statusCode, err) => {
      if (!res.headersSent && !res.writableEnded && !res.destroyed) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.writeHead(statusCode || 502);
        res.end(JSON.stringify({ success: false, error: '臺北市交控代理失敗', detail: err ? err.message : '' }));
      } else {
        try { if (!res.destroyed) res.destroy(); } catch (_) {}
      }
    },
    res
  );
}

let _lastBotePrewarmBatchMs = 0;
function handleBotePrewarm(req, res, parsedUrl) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const rawIds = (parsedUrl.searchParams.get('ids') || '301,303,304,346,166,028').split(',');
  const validIds = rawIds
    .map(s => s.trim())
    .filter(s => /^[0-9A-Za-z_-]{1,12}$/.test(s))
    .slice(0, 8);

  const now = Date.now();
  const warmedIds = [];
  if (now - _lastBotePrewarmBatchMs >= 2000) {
    _lastBotePrewarmBatchMs = now;
    for (const id of validIds) {
      const last = botePrewarmCooldown.get(id) || 0;
      if (now - last < 20000) continue;
      setBoundedMap(botePrewarmCooldown, id, now, 200);
      warmedIds.push(id);
      requestBoteUpstream(
        `/hls/${id}/index.m3u8`,
        null,
        (upstreamRes) => {
          upstreamRes.on('error', () => {});
          upstreamRes.resume();
        },
        () => {},
        null
      );
    }
  }

  res.writeHead(200);
  res.end(JSON.stringify({ ok: true, prewarmed: warmedIds, totalRequested: validIds.length }));
}

function isDisallowedRedirectHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h === '::1' || h === '0.0.0.0') return true;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return true;
  if (/^(fc|fd|fe80):/i.test(h)) return true;
  return false;
}

// 共用遠端文字抓取函式 (支援相對路徑重新導向、跳轉上限、壓縮解碼、Buffer 安全解碼與連線清理)
function fetchRemoteText(url, acceptHeader, timeoutMs = 8000, hopCount = 0) {
  return new Promise((resolve, reject) => {
    let parsedTarget;
    try {
      parsedTarget = new URL(url);
      if ((parsedTarget.protocol !== 'https:' && parsedTarget.protocol !== 'http:') || isDisallowedRedirectHost(parsedTarget.hostname)) {
        return reject(new Error(`不允許的遠端網址: ${url}`));
      }
    } catch (e) {
      return reject(e);
    }
    const clientMod = parsedTarget.protocol === 'http:' ? http : https;
    let settled = false;
    const doneResolve = (val) => { if (!settled) { settled = true; clearTimeout(totalTimer); resolve(val); } };
    const doneReject = (err) => { if (!settled) { settled = true; clearTimeout(totalTimer); reject(err); } };

    const req = clientMod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': acceptHeader,
        'Accept-Encoding': 'gzip, deflate, br'
      }
    }, (res) => {
      res.on('error', doneReject);
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (hopCount >= 5) {
          return doneReject(new Error('重新導向次數過多'));
        }
        try {
          const nextObj = new URL(res.headers.location, url);
          if ((nextObj.protocol !== 'https:' && nextObj.protocol !== 'http:') || isDisallowedRedirectHost(nextObj.hostname)) {
            return doneReject(new Error('重新導向目標不安全'));
          }
          clearTimeout(totalTimer);
          settled = true;
          return fetchRemoteText(nextObj.toString(), acceptHeader, timeoutMs, hopCount + 1).then(resolve).catch(reject);
        } catch (e) {
          return doneReject(e);
        }
      }
      if (res.statusCode !== 200) {
        res.resume();
        return doneReject(new Error(`HTTP Status ${res.statusCode}`));
      }
      const chunks = [];
      let totalBytes = 0;
      res.on('data', chunk => {
        totalBytes += chunk.length;
        if (totalBytes > 16 * 1024 * 1024) {
          req.destroy();
          doneReject(new Error('遠端回應超過 16MB 安全上限'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        try {
          doneResolve(decodeCompressedBuffer(Buffer.concat(chunks), res.headers['content-encoding']).toString('utf8'));
        } catch (e) {
          doneReject(new Error(`解碼遠端回應失敗: ${e.message}`));
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

// 內部抓取遠端 JSON 函式
function fetchRemoteJson(url) {
  return fetchRemoteText(url, 'application/json, text/plain, */*', 8000);
}

// 取得台灣時間日期字串 (YYYY/MM/DD)，可依營運日凌晨 04:00 換日線計算
function getTaiwanDateString(operatingDay = false) {
  const shiftMs = operatingDay ? (4 * 3600000) : (8 * 3600000);
  const twDate = new Date(Date.now() + shiftMs);
  const yyyy = twDate.getUTCFullYear();
  const mm = String(twDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(twDate.getUTCDate()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd}`;
}

// 抓取台灣高鐵官方時刻表函式 (原生 HTTPS POST)
function fetchOfficialThsrTimetable(startStation, endStation) {
  return new Promise((resolve, reject) => {
    const dateStr = getTaiwanDateString(true);
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
      res.on('error', reject);
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP Status ${res.statusCode}`));
      }
      const chunks = [];
      let totalBytes = 0;
      res.on('data', chunk => {
        totalBytes += chunk.length;
        if (totalBytes > 8 * 1024 * 1024) {
          req.destroy();
          reject(new Error('高鐵回應超過安全容量上限'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        try {
          const rawData = decodeCompressedBuffer(Buffer.concat(chunks), res.headers['content-encoding']).toString('utf8');
          const json = JSON.parse(rawData);
          const rawItems = (json.data && json.data.DepartureTable && json.data.DepartureTable.TrainItem) || [];

          const cleanTrains = [];
          for (const t of rawItems) {
            const trainNo = String((t && t.TrainNumber) || '').trim();
            const cleanNo = trainNo.replace(/^0+/, '');
            const stInfo = Array.isArray(t?.StationInfo) ? t.StationInfo : [];
            if (stInfo.length > 0) {
              const hasBanQiao = stInfo.some(st => st?.Show && String(st.StationName || '').includes('板橋'));
              const hasTaoYuan = stInfo.some(st => st?.Show && String(st.StationName || '').includes('桃園'));
              if (!hasBanQiao || !hasTaoYuan) continue;
            } else if (/^(?:1\d{2}|2\d{2}|11\d{2}|12\d{2})$/.test(cleanNo)) {
              // 無 StationInfo 時，僅排除不停靠板橋/桃園之 1xx、2xx、11xx、12xx 直達台中車次（保留 5xx/13xx/15xx 通勤及 6xx/16xx 特快）
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
            const isExpress = cleanNo.startsWith('6') || cleanNo.startsWith('16');
            let trainTypeLabel = '8xx全停';
            if (cleanNo.startsWith('16')) trainTypeLabel = '16xx特快';
            else if (isExpress) trainTypeLabel = '6xx特快';
            else if (cleanNo.length === 3 && cleanNo.startsWith('5')) trainTypeLabel = '5xx區間';
            else if (cleanNo.startsWith('15') || cleanNo.startsWith('13')) trainTypeLabel = `${cleanNo.slice(0, 2)}xx區間`;
            const depOpH = depParts[0] < 4 ? depParts[0] + 24 : depParts[0];
            const depMinutes = depOpH * 60 + depParts[1];
            cleanTrains.push({
              trainNo,
              depTime: t.DepartureTime,
              arrTime: t.DestinationTime,
              duration: duration || 12,
              isExpress,
              type: trainTypeLabel,
              stopsAtTaoyuan: true,
              depMinutes
            });
          }

          if (cleanTrains.length === 0) {
            return reject(new Error('高鐵官方回傳空白班表'));
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
      date: getTaiwanDateString(true),
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
      res.on('error', reject);
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP Status ${res.statusCode}`));
      }
      const chunks = [];
      let totalBytes = 0;
      res.on('data', chunk => {
        totalBytes += chunk.length;
        if (totalBytes > 8 * 1024 * 1024) {
          req.destroy();
          reject(new Error('機捷回應超過安全容量上限'));
          return;
        }
        chunks.push(chunk);
      });
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

          if (list.length === 0) {
            return reject(new Error('機捷官方回傳空白班表'));
          }
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
      date: getTaiwanDateString(true),
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

// 解析 CSV 字串為 JSON 物件陣列 (支援 RFC 4180 引號轉義 "" 與引號內逗號/換行)
function parseCsvToJson(csvStr) {
  const raw = String(csvStr || '').replace(/^\uFEFF/, '');
  if (!raw.trim()) return [];
  const rows = [];
  let row = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < raw.length && raw[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cur.trim());
      cur = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && i + 1 < raw.length && raw[i + 1] === '\n') i++;
      row.push(cur.trim());
      cur = '';
      if (row.some(cell => cell.length > 0)) rows.push(row);
      row = [];
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0 || row.length > 0) {
    row.push(cur.trim());
    if (row.some(cell => cell.length > 0)) rows.push(row);
  }
  if (rows.length < 2) return [];
  const headers = rows[0].map(h => h.replace(/^"|"$/g, '').trim());
  const list = [];
  for (let r = 1; r < rows.length; r++) {
    const values = rows[r];
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
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error('新北市 YouBike CSV 解析無站點資料');
      }
      jsonDataStr = JSON.stringify(parsed);
    } else {
      const parsedJson = JSON.parse(rawData);
      const hasRecords = Array.isArray(parsedJson)
        ? parsedJson.length > 0
        : (parsedJson && typeof parsedJson === 'object' && Object.keys(parsedJson).length > 0);
      if (!hasRecords) {
        throw new Error('桃園 YouBike JSON 無有效站點資料');
      }
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
    if (/擷取|無資料|收班|停駛|維護|--:--/.test(countdown)) continue;
    let totalSec = 0;
    if (countdown.includes(':')) {
      const parts = countdown.split(':').map(Number);
      if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) continue;
      totalSec = parts[0] * 60 + parts[1];
    } else if (countdown === '進站中' || countdown === '列車進站' || countdown === '即將進站') {
      totalSec = 20;
    } else {
      continue;
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
  const [xpRes, bqRes, y20Res] = await Promise.allSettled([
    fetchRemoteHtml('https://www.opendata.vip/metro/departure/%E6%96%B0%E5%9F%94', 7000),
    fetchRemoteHtml('https://www.opendata.vip/metro/departure/%E6%9D%BF%E6%A9%8B', 7000),
    fetchRemoteHtml('https://www.opendata.vip/metro/departure/%E6%96%B0%E5%8C%97%E7%94%A2%E6%A5%AD%E5%9C%92%E5%8D%80', 7000)
  ]);

  if (xpRes.status !== 'fulfilled' && bqRes.status !== 'fulfilled' && y20Res.status !== 'fulfilled') {
    throw new Error('捷運即時到站上游全部無回應');
  }

  const list = [];
  if (xpRes.status === 'fulfilled' && xpRes.value) list.push(...parseDepartureHtml(xpRes.value, '新埔站'));
  if (bqRes.status === 'fulfilled' && bqRes.value) list.push(...parseDepartureHtml(bqRes.value, '板橋站'));
  if (y20Res.status === 'fulfilled' && y20Res.value) list.push(...parseDepartureHtml(y20Res.value, '新北產業園區站'));
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
    if (list.length > 0 || !cache.metroLive.data) {
      cache.metroLive = {
        data: serialized,
        expireAt: now + 15000 // 快取 15 秒
      };
    }
    res.writeHead(200);
    res.end(list.length > 0 ? serialized : (cache.metroLive.data || serialized));
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
  const wantBl08 = targetStation === 'all' || targetStation === 'BL08';
  const wantBl07 = targetStation === 'all' || targetStation === 'BL07';
  const [bl08Settled, bl07Settled] = await Promise.allSettled([
    wantBl08 ? fetchRemoteHtml('https://www.opendata.vip/metro/carWeight/BL/BL08', 7000) : Promise.resolve(''),
    wantBl07 ? fetchRemoteHtml('https://www.opendata.vip/metro/carWeight/BL/BL07', 7000) : Promise.resolve('')
  ]);

  const bl08Ok = wantBl08 && bl08Settled.status === 'fulfilled' && Boolean(bl08Settled.value);
  const bl07Ok = wantBl07 && bl07Settled.status === 'fulfilled' && Boolean(bl07Settled.value);
  if (!bl08Ok && !bl07Ok) {
    throw new Error('捷運車廂擁擠度上游無回應');
  }

  const result = {};
  if (bl08Ok) {
    result.BL08 = parseCarWeightHtml(bl08Settled.value, '新埔', 'BL08');
  }
  if (bl07Ok) {
    result.BL07 = parseCarWeightHtml(bl07Settled.value, '板橋', 'BL07');
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

  const cleanCode = (targetCode === 'BL08' || targetCode === 'BL07') ? targetCode : 'all';
  const now = Date.now();
  const cached = cache.metroCarWeightMap.get(cleanCode);
  if (cached && now < cached.expireAt) {
    res.writeHead(200);
    res.end(cached.data);
    return;
  }

  try {
    const weights = await fetchCarWeightData(cleanCode);
    const serialized = JSON.stringify({
      success: true,
      updatedAt: new Date().toISOString(),
      data: weights
    });
    setBoundedMap(cache.metroCarWeightMap, cleanCode, {
      data: serialized,
      expireAt: now + 30000 // 快取 30 秒
    }, 10);
    res.writeHead(200);
    res.end(serialized);
  } catch (err) {
    if (cached && cached.data) {
      res.writeHead(200);
      res.end(cached.data);
    } else {
      res.writeHead(502);
      res.end(JSON.stringify({ success: false, error: '無法取得車廂擁擠度資料', detail: err.message }));
    }
  }
}

// 抓取高鐵即時剩餘停車位 (桃園站 P1/P2/P3 與板橋站，附完整座標與轉乘資訊)
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
          const rawParts = spaceText.split('/');
          const avParsed = parseInt(rawParts[0].trim(), 10);
          const totParsed = parseInt((rawParts[1] || '').trim(), 10);
          available = (Number.isFinite(avParsed) && avParsed >= 0) ? avParsed : 0;
          total = (Number.isFinite(totParsed) && totParsed >= 0) ? totParsed : 0;
        }
        const isTy = name.includes('桃園');
        lots.push({
          id: `THSR_${name}`,
          city: isTy ? '桃園高鐵' : '板橋高鐵',
          area: isTy ? '中壢青埔' : '板橋特區',
          name,
          address: isTy ? '高鐵北路一段 (高鐵桃園站特區)' : '縣民大道二段7號',
          fare: '高鐵轉乘計時收費',
          available,
          total,
          spaceText,
          status,
          lat: isTy ? 25.0134 : 25.0141,
          lon: isTy ? 121.2148 : 121.4638
        });
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
    if (lots.length > 0 || !cache.parkingThsr.data) {
      cache.parkingThsr = {
        data: serialized,
        expireAt: now + 20000 // 快取 20 秒極速更新
      };
    }
    res.writeHead(200);
    res.end(lots.length > 0 ? serialized : (cache.parkingThsr.data || serialized));
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

// ============================================================================
// 台灣精準村里行政區定位 (NLSC 內政部國土測繪中心) 與 TDX 即時最近公車站牌代理引擎
// ============================================================================
const TAIWAN_COUNTIES = [
  { county: '臺北市', alias: '台北市', tdxCity: 'Taipei', cityId: 'taipei', lat: 25.0375, lon: 121.5637 },
  { county: '新北市', alias: '新北市', tdxCity: 'NewTaipei', cityId: 'newtaipei', lat: 25.0125, lon: 121.4658 },
  { county: '基隆市', alias: '基隆市', tdxCity: 'Keelung', cityId: 'newtaipei', lat: 25.1276, lon: 121.7392 },
  { county: '桃園市', alias: '桃園市', tdxCity: 'Taoyuan', cityId: 'taoyuan', lat: 24.9936, lon: 121.3010 },
  { county: '新竹市', alias: '新竹市', tdxCity: 'Hsinchu', cityId: 'hsinchu', lat: 24.8138, lon: 120.9675 },
  { county: '新竹縣', alias: '新竹縣', tdxCity: 'HsinchuCounty', cityId: 'hsinchu', lat: 24.8387, lon: 121.0177 },
  { county: '苗栗縣', alias: '苗栗縣', tdxCity: 'MiaoliCounty', cityId: 'hsinchu', lat: 24.5602, lon: 120.8214 },
  { county: '臺中市', alias: '台中市', tdxCity: 'Taichung', cityId: 'taichung', lat: 24.1624, lon: 120.6472 },
  { county: '彰化縣', alias: '彰化縣', tdxCity: 'ChanghuaCounty', cityId: 'taichung', lat: 24.0518, lon: 120.5161 },
  { county: '南投縣', alias: '南投縣', tdxCity: 'NantouCounty', cityId: 'taichung', lat: 23.9610, lon: 120.9719 },
  { county: '雲林縣', alias: '雲林縣', tdxCity: 'YunlinCounty', cityId: 'tainan', lat: 23.7092, lon: 120.4313 },
  { county: '嘉義市', alias: '嘉義市', tdxCity: 'Chiayi', cityId: 'tainan', lat: 23.4801, lon: 120.4491 },
  { county: '嘉義縣', alias: '嘉義縣', tdxCity: 'ChiayiCounty', cityId: 'tainan', lat: 23.4518, lon: 120.2555 },
  { county: '臺南市', alias: '台南市', tdxCity: 'Tainan', cityId: 'tainan', lat: 22.9972, lon: 120.2025 },
  { county: '高雄市', alias: '高雄市', tdxCity: 'Kaohsiung', cityId: 'kaohsiung', lat: 22.6312, lon: 120.3022 },
  { county: '屏東縣', alias: '屏東縣', tdxCity: 'PingtungCounty', cityId: 'kaohsiung', lat: 22.6761, lon: 120.4929 },
  { county: '宜蘭縣', alias: '宜蘭縣', tdxCity: 'YilanCounty', cityId: 'yilan', lat: 24.7558, lon: 121.7512 },
  { county: '花蓮縣', alias: '花蓮縣', tdxCity: 'HualienCounty', cityId: 'hualien', lat: 23.9932, lon: 121.6015 },
  { county: '臺東縣', alias: '台東縣', tdxCity: 'TaitungCounty', cityId: 'hualien', lat: 22.7583, lon: 121.1444 },
  { county: '澎湖縣', alias: '澎湖縣', tdxCity: 'PenghuCounty', cityId: 'tainan', lat: 23.5712, lon: 119.5793 },
  { county: '金門縣', alias: '金門縣', tdxCity: 'KinmenCounty', cityId: 'tainan', lat: 24.4327, lon: 118.3171 },
  { county: '連江縣', alias: '連江縣', tdxCity: 'LienchiangCounty', cityId: 'taipei', lat: 26.1505, lon: 119.9499 }
];

const VALID_TDX_CITIES = new Set(TAIWAN_COUNTIES.map(c => c.tdxCity));

function calcDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function fallbackCountyByCoords(lat, lon) {
  let best = TAIWAN_COUNTIES[1];
  let minD = Infinity;
  for (const item of TAIWAN_COUNTIES) {
    const d = calcDistanceMeters(lat, lon, item.lat, item.lon);
    if (d < minD) {
      minD = d;
      best = item;
    }
  }
  return {
    county: best.alias,
    town: '',
    village: '',
    tdxCity: best.tdxCity,
    cityId: best.cityId,
    fullLabel: best.alias,
    source: 'coords-fallback'
  };
}

async function resolveTaiwanAdminArea(lat, lon) {
  const key = `${Number(lat).toFixed(4)},${Number(lon).toFixed(4)}`;
  const now = Date.now();
  const cached = cache.geocodeMap.get(key);
  if (cached && now < cached.expireAt) {
    return cached.data;
  }
  try {
    const nlscUrl = `https://api.nlsc.gov.tw/other/TownVillagePointQuery/${Number(lon).toFixed(6)}/${Number(lat).toFixed(6)}/4326`;
    const xml = await fetchRemoteText(nlscUrl, 'application/xml, text/xml, */*', 3500);
    const extractXmlTag = (tag) => {
      const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i'));
      return m ? m[1].trim() : '';
    };
    const rawCty = extractXmlTag('ctyName');
    const town = extractXmlTag('townName');
    const village = extractXmlTag('villageName');
    if (rawCty) {
      const matched = TAIWAN_COUNTIES.find(c => c.county === rawCty || c.alias === rawCty || rawCty.replace(/臺/g, '台') === c.alias);
      if (matched) {
        const cleanCounty = rawCty.replace(/臺/g, '台');
        const info = {
          county: cleanCounty,
          town,
          village,
          tdxCity: matched.tdxCity,
          cityId: matched.cityId,
          fullLabel: `${cleanCounty}${town}${village}`,
          shortLabel: `${cleanCounty}${town}`,
          source: 'nlsc'
        };
        setBoundedMap(cache.geocodeMap, key, { data: info, expireAt: now + 30 * 60 * 1000 }, 240);
        return info;
      }
    }
  } catch (_) {}
  return fallbackCountyByCoords(lat, lon);
}

let _tdxLastCallMs = 0;
let _tdxChain = Promise.resolve();

async function fetchTdxProxyJson(tdxPath, params = {}, timeoutMs = 6000) {
  const u = new URL('https://www.opendata.vip/tdx/proxy');
  u.searchParams.set('path', tdxPath);
  for (const [k, v] of Object.entries(params)) {
    u.searchParams.set(k, v);
  }
  const targetUrl = u.toString();

  // 僅針對發送時間點做 110ms Pacing 節流，釋放佇列鎖後各自並行執行 HTTP 請求與重試，防止單一慢端點卡死全體公車／台鐵／國道 API
  const reserveSlot = async () => {
    const slot = _tdxChain.then(async () => {
      const waitMs = Math.max(0, 110 - (Date.now() - _tdxLastCallMs));
      if (waitMs > 0) {
        await new Promise(r => setTimeout(r, waitMs));
      }
      _tdxLastCallMs = Date.now();
    });
    _tdxChain = slot.catch(() => {});
    return slot;
  };

  await reserveSlot();
  try {
    return await fetchJsonWithRetry(targetUrl, 0, timeoutMs);
  } catch (err) {
    await new Promise(r => setTimeout(r, 320));
    await reserveSlot();
    return fetchJsonWithRetry(targetUrl, 0, timeoutMs);
  }
}

function getTaiwanTimeHHMMSS() {
  const d = new Date(Date.now() + 8 * 3600000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

async function handleGeocodeTaiwanProxy(req, res, parsedUrl) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const lat = parseFloat(parsedUrl.searchParams.get('lat'));
  const lon = parseFloat(parsedUrl.searchParams.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 20 || lat > 27 || lon < 117 || lon > 123.5) {
    res.writeHead(400);
    res.end(JSON.stringify({ success: false, error: '無效的台灣經緯度座標' }));
    return;
  }
  try {
    const info = await resolveTaiwanAdminArea(lat, lon);
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, ...info }));
  } catch (err) {
    res.writeHead(502);
    res.end(JSON.stringify({ success: false, error: '無法解析台灣行政區位置', detail: err.message }));
  }
}

async function handleYouBikeCityProxy(req, res, parsedUrl) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const city = String(parsedUrl.searchParams.get('city') || '').trim();
  if (!VALID_TDX_CITIES.has(city)) {
    res.writeHead(400);
    res.end(JSON.stringify({ success: false, error: '不支援的縣市參數' }));
    return;
  }
  const now = Date.now();
  const cached = cache.youbikeCityMap.get(city);
  if (cached && now < cached.expireAt) {
    res.writeHead(200);
    res.end(cached.data);
    return;
  }
  try {
    const arr = await fetchJsonWithRetry(`https://www.opendata.vip/tdx/youbikeApi/${encodeURIComponent(city)}`, 1, 4500);
    if (!Array.isArray(arr) || arr.length === 0) {
      throw new Error('該縣市 YouBike 回傳空清單');
    }
    const serialized = JSON.stringify(arr);
    setBoundedMap(cache.youbikeCityMap, city, { data: serialized, expireAt: now + 20000 }, 30);
    res.writeHead(200);
    res.end(serialized);
  } catch (err) {
    if (cached && cached.data) {
      res.writeHead(200);
      res.end(cached.data);
    } else {
      res.writeHead(502);
      res.end(JSON.stringify({ success: false, error: '無法取得該縣市 YouBike 即時資料', detail: err.message }));
    }
  }
}

const BUILT_IN_TW_BUS_STOPS = [
  { id: 'tw-taiwan-tdx_TAO12619', name: '青峰路一段', lat: 25.0156, lon: 121.2194, address: '桃園市中壢區青峰路一段' },
  { id: 'tw-taiwan-tdx_TAO2595', name: '青昇一街口', lat: 25.0154, lon: 121.2215, address: '桃園市中壢區青昇路' },
  { id: 'tw-taiwan-tdx_TAO12618', name: '青昇宮', lat: 25.0145, lon: 121.2217, address: '桃園市中壢區領航南路四段' },
  { id: 'tw-taiwan-tdx_TAO20027', name: '青園國小', lat: 25.0176, lon: 121.2202, address: '桃園市中壢區青昇路' },
  { id: 'tw-taiwan-tdx_TAO12620', name: '高鐵桃園站', lat: 25.0128, lon: 121.2151, address: '桃園市中壢區高鐵北路一段' },
  { id: 'tw-taiwan-tdx_NWT122385', name: '捷運新埔站', lat: 25.0226, lon: 121.4686, address: '新北市板橋區民生路二段' },
  { id: 'tw-taiwan-tdx_NWT122386', name: '板橋花市', lat: 25.0223, lon: 121.4688, address: '新北市板橋區民生路二段' },
  { id: 'tw-taiwan-tdx_NWT127467', name: '捷運新埔站(文化路)', lat: 25.0235, lon: 121.4682, address: '新北市板橋區文化路一段' },
  { id: 'tw-taiwan-tdx_NWT185324', name: '新北板橋公車站', lat: 25.0145, lon: 121.4633, address: '新北市板橋區站前路' },
  { id: 'tw-taiwan-tdx_TPE10421', name: '臺北車站(忠孝)', lat: 25.0463, lon: 121.5175, address: '臺北市中正區忠孝西路一段' },
  { id: 'tw-taiwan-tdx_TXG10120', name: '臺中車站', lat: 24.1369, lon: 120.6848, address: '臺中市中區臺灣大道一段' },
  { id: 'tw-taiwan-tdx_TNN10010', name: '臺南火車站', lat: 22.9972, lon: 120.2125, address: '臺南市東區北門路二段' },
  { id: 'tw-taiwan-tdx_KHH10010', name: '高雄車站', lat: 22.6384, lon: 120.3019, address: '高雄市三民區建國二路' }
];

async function discoverNearbyBusStations(lat, lon, primaryTdxCity, extraHub = null) {
  const stationCacheKey = `${lat.toFixed(4)},${lon.toFixed(4)},${primaryTdxCity},${extraHub ? `${extraHub.lat.toFixed(4)}_${extraHub.lon.toFixed(4)}` : ''}`;
  const now = Date.now();
  const cached = cache.busStationMap.get(stationCacheKey);
  if (cached && now < cached.expireAt) {
    return cached.data;
  }

  const queryCities = [primaryTdxCity];
  if (primaryTdxCity === 'NewTaipei') queryCities.push('Taipei');
  else if (primaryTdxCity === 'Taipei') queryCities.push('NewTaipei');

  const transitousHeaders = {
    'Accept': 'application/json',
    'User-Agent': 'TaiwanNeighborhoodMonitor/2.0 (https://github.com/JaneDe0214/taiwan-neighborhood-monitor)'
  };
  const fetchTransitousStops = async (cLat, cLon) => {
    try {
      const r = await fetch(`https://api.transitous.org/api/v1/reverse-geocode?place=${cLat.toFixed(5)},${cLon.toFixed(5)}&type=STOP`, {
        headers: transitousHeaders,
        signal: AbortSignal.timeout(4500)
      });
      if (!r.ok) return [];
      const arr = await r.json();
      return Array.isArray(arr) ? arr : [];
    } catch (_) {
      return [];
    }
  };

  const rawCandidates = [];
  const [nearStops, hubStops] = await Promise.all([
    fetchTransitousStops(lat, lon),
    (extraHub && Number.isFinite(extraHub.lat) && Number.isFinite(extraHub.lon))
      ? fetchTransitousStops(extraHub.lat, extraHub.lon)
      : Promise.resolve([])
  ]);

  for (const st of [...nearStops, ...hubStops]) {
    if (!st?.id || !st?.name || !Number.isFinite(st.lat) || !Number.isFinite(st.lon)) continue;
    if (/_(THSR|TRA|TRTC|TYMC|KRTC|TMRT)_/.test(String(st.id))) continue;
    rawCandidates.push({
      transitousId: String(st.id),
      name: String(st.name).trim(),
      lat: Number(st.lat),
      lon: Number(st.lon),
      address: ''
    });
  }

  for (const fb of BUILT_IN_TW_BUS_STOPS) {
    const d1 = calcDistanceMeters(lat, lon, fb.lat, fb.lon);
    const d2 = (extraHub && Number.isFinite(extraHub.lat) && Number.isFinite(extraHub.lon))
      ? calcDistanceMeters(extraHub.lat, extraHub.lon, fb.lat, fb.lon)
      : Infinity;
    if (d1 <= 2600 || d2 <= 1200) {
      rawCandidates.push({
        transitousId: fb.id,
        name: fb.name,
        lat: fb.lat,
        lon: fb.lon,
        address: fb.address || ''
      });
    }
  }

  const groups = new Map();
  for (const st of rawCandidates) {
    const name = String(st.name || '').trim();
    const baseClean = name.replace(/[（(].*?[）)]/g, '').trim() || name;
    const distMeters = calcDistanceMeters(lat, lon, st.lat, st.lon);
    if (distMeters > 3500) continue;
    let grp = groups.get(baseClean);
    if (!grp) {
      grp = {
        name: baseClean,
        baseName: baseClean,
        transitousId: st.transitousId || '',
        lat: st.lat,
        lon: st.lon,
        distMeters,
        address: st.address || '',
        stops: [],
        etaItems: [],
        etaFetchedAt: 0
      };
      groups.set(baseClean, grp);
    } else {
      if (distMeters < grp.distMeters) {
        grp.distMeters = distMeters;
        grp.lat = st.lat;
        grp.lon = st.lon;
      }
      if (!grp.transitousId && st.transitousId) grp.transitousId = st.transitousId;
      if (!grp.address && st.address) grp.address = st.address;
    }
  }

  const candidateGroups = [...groups.values()].sort((a, b) => a.distMeters - b.distMeters);
  const queryNames = [...new Set([
    ...candidateGroups.slice(0, 6).map(g => g.baseName),
    ...(extraHub && extraHub.keyword ? [extraHub.keyword] : [])
  ])].filter(Boolean).slice(0, 6);

  if (queryNames.length > 0) {
    const filterExpr = queryNames.map(n => `contains(StopName/Zh_tw,'${n.replace(/'/g, "''")}')`).join(' or ');
    const cityEtaBatches = await Promise.all(queryCities.map(async (c) => {
      const arr = await fetchTdxProxyJson(`/v2/Bus/EstimatedTimeOfArrival/City/${c}/`, {
        '$filter': filterExpr,
        '$select': 'StopUID,StopName,RouteUID,RouteID,RouteName,SubRouteName,Direction,EstimateTime,StopStatus,NextBusTime,PlateNumb,SrcUpdateTime',
        '$top': '220',
        '$format': 'JSON'
      }, 5500).catch(() => []);
      return { city: c, arr: Array.isArray(arr) ? arr : [] };
    }));

    for (const { city, arr } of cityEtaBatches) {
      for (const e of arr) {
        const stopUid = String(e?.StopUID || '').trim();
        const stopNameRaw = String(e?.StopName?.Zh_tw || '').trim();
        const routeName = String(e?.SubRouteName?.Zh_tw || e?.RouteName?.Zh_tw || '').trim();
        const baseRouteName = String(e?.RouteName?.Zh_tw || routeName).trim();
        const routeUid = String(e?.RouteUID || e?.RouteID || baseRouteName).trim();
        if (!stopUid || !stopNameRaw || !routeName) continue;

        const eBase = stopNameRaw.replace(/[（(].*?[）)]/g, '').trim() || stopNameRaw;
        let matchedGrp = groups.get(eBase);
        if (!matchedGrp) {
          matchedGrp = candidateGroups.find(g => eBase.includes(g.baseName) || g.baseName.includes(eBase));
        }
        if (!matchedGrp) continue;

        const dedupKey = `${city}|${stopUid}|${routeUid}|${e.Direction ?? 0}`;
        if (!matchedGrp._seenKeys) matchedGrp._seenKeys = new Set();
        if (!matchedGrp._seenKeys.has(dedupKey)) {
          matchedGrp._seenKeys.add(dedupKey);
          matchedGrp.stops.push({
            city,
            stopUid,
            routeUid,
            routeId: String(e?.RouteID || '').trim(),
            routeName: baseRouteName
          });
        }
        matchedGrp.etaItems.push({ ...e, _city: city });
        matchedGrp.etaFetchedAt = Date.now();
      }
    }
  }

  for (const g of groups.values()) {
    delete g._seenKeys;
  }

  const sorted = [...groups.values()]
    .filter(g => g.stops.length > 0)
    .sort((a, b) => a.distMeters - b.distMeters);

  let topList = sorted.slice(0, 5);
  if (extraHub && extraHub.keyword) {
    const hubStation = sorted.find(s => s.name.includes(extraHub.keyword));
    if (hubStation && !topList.some(s => s.name === hubStation.name)) {
      topList = [...topList.slice(0, 4), hubStation];
    }
  }

  if (topList.length > 0) {
    setBoundedMap(cache.busStationMap, stationCacheKey, { data: topList, expireAt: now + 10 * 60 * 1000 }, 160);
  }
  return topList;
}

function formatBusStatusInfo(estimateSec, stopStatus, nextBusTime) {
  if (typeof estimateSec === 'number' && estimateSec >= 0 && (stopStatus === 0 || stopStatus === undefined || stopStatus === null)) {
    if (estimateSec <= 60) return { text: '進站中', state: 'arriving', sortKey: estimateSec };
    if (estimateSec <= 180) return { text: `即將進站 (${Math.ceil(estimateSec / 60)}分)`, state: 'soon', sortKey: estimateSec };
    return { text: `${Math.round(estimateSec / 60)} 分`, state: estimateSec <= 420 ? 'soon' : 'normal', sortKey: estimateSec };
  }
  const cleanNext = (typeof nextBusTime === 'string' && nextBusTime.includes('T')) ? nextBusTime.slice(11, 16) : '';
  if (cleanNext) {
    return { text: `${cleanNext} 發車`, state: 'scheduled', sortKey: 100000 };
  }
  if (stopStatus === 1) return { text: '尚未發車', state: 'waiting', sortKey: 200000 };
  if (stopStatus === 2) return { text: '交管不停靠', state: 'muted', sortKey: 300000 };
  if (stopStatus === 3) return { text: '末班車已過', state: 'ended', sortKey: 400000 };
  if (stopStatus === 4) return { text: '今日未營運', state: 'ended', sortKey: 500000 };
  return { text: '待發車', state: 'waiting', sortKey: 250000 };
}

async function handleBusNearbyProxy(req, res, parsedUrl) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const lat = parseFloat(parsedUrl.searchParams.get('lat'));
  const lon = parseFloat(parsedUrl.searchParams.get('lon'));
  const rawCity = String(parsedUrl.searchParams.get('city') || '').trim();
  const stopIdxReq = Math.max(0, Math.min(4, parseInt(parsedUrl.searchParams.get('stopIdx') || '0', 10) || 0));
  const hubLat = parseFloat(parsedUrl.searchParams.get('hubLat'));
  const hubLon = parseFloat(parsedUrl.searchParams.get('hubLon'));
  const hubKeyword = String(parsedUrl.searchParams.get('hubKeyword') || '').trim();

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 20 || lat > 27 || lon < 117 || lon > 123.5) {
    res.writeHead(400);
    res.end(JSON.stringify({ success: false, error: '無效的台灣經緯度座標' }));
    return;
  }

  const hasValidHub = Number.isFinite(hubLat) && Number.isFinite(hubLon) &&
    hubLat >= 20 && hubLat <= 27 && hubLon >= 117 && hubLon <= 123.5;
  const hubKey = hasValidHub ? `${hubLat.toFixed(4)}_${hubLon.toFixed(4)}_${hubKeyword}` : hubKeyword;
  const etaCacheKey = `${lat.toFixed(4)},${lon.toFixed(4)},${rawCity},${stopIdxReq},${hubKey}`;
  const now = Date.now();
  const cachedEta = cache.busEtaMap.get(etaCacheKey);
  if (cachedEta && now < cachedEta.expireAt) {
    res.writeHead(200);
    res.end(cachedEta.data);
    return;
  }

  try {
    const adminInfo = await resolveTaiwanAdminArea(lat, lon);
    const primaryTdxCity = VALID_TDX_CITIES.has(rawCity) ? rawCity : adminInfo.tdxCity;
    const extraHub = hasValidHub
      ? { lat: hubLat, lon: hubLon, keyword: hubKeyword }
      : null;

    const stations = await discoverNearbyBusStations(lat, lon, primaryTdxCity, extraHub);
    if (!stations.length) {
      const emptyPayload = JSON.stringify({
        success: true,
        admin: adminInfo,
        tdxCity: primaryTdxCity,
        stations: [],
        activeStopIndex: 0,
        activeStop: null,
        buses: [],
        updatedAt: new Date().toISOString(),
        updateTimeDisplay: getTaiwanTimeHHMMSS()
      });
      res.writeHead(200);
      res.end(emptyPayload);
      return;
    }

    const activeStopIndex = Math.min(stopIdxReq, stations.length - 1);
    const activeStop = stations[activeStopIndex];
    const stopBaseName = (activeStop.baseName || activeStop.name || '').replace(/[（(].*?[）)]/g, '').trim() || activeStop.name;

    const citiesToFetch = [...new Set(activeStop.stops.map(s => s.city).filter(Boolean))];
    if (citiesToFetch.length === 0) citiesToFetch.push(primaryTdxCity);

    const hasFreshCachedEtas = Array.isArray(activeStop.etaItems) && activeStop.etaItems.length > 0 && (now - (activeStop.etaFetchedAt || 0) < 14000);

    const [liveEtaBatches, transitousStopTimes] = await Promise.all([
      hasFreshCachedEtas
        ? Promise.resolve([{ city: primaryTdxCity, arr: activeStop.etaItems }])
        : Promise.all(citiesToFetch.map(async (city) => {
            const p = city === 'InterCity' ? '/v2/Bus/EstimatedTimeOfArrival/InterCity' : `/v2/Bus/EstimatedTimeOfArrival/City/${city}/`;
            const arr = await fetchTdxProxyJson(p, {
              '$filter': `contains(StopName/Zh_tw,'${stopBaseName.replace(/'/g, "''")}')`,
              '$select': 'StopUID,StopName,RouteUID,RouteID,RouteName,SubRouteName,Direction,EstimateTime,StopStatus,NextBusTime,PlateNumb,SrcUpdateTime',
              '$top': '180',
              '$format': 'JSON'
            }, 5500).catch(() => []);
            return { city, arr: Array.isArray(arr) ? arr : [] };
          })),
      activeStop.transitousId
        ? fetch(`https://api.transitous.org/api/v1/stoptimes?stopId=${encodeURIComponent(activeStop.transitousId)}&n=30`, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'TaiwanNeighborhoodMonitor/2.0' },
            signal: AbortSignal.timeout(2800)
          }).then(r => r.ok ? r.json() : null).catch(() => null)
        : Promise.resolve(null)
    ]);

    const headsignMap = new Map();
    if (Array.isArray(transitousStopTimes?.stopTimes)) {
      for (const st of transitousStopTimes.stopTimes) {
        const rShort = String(st.routeShortName || st.displayName || '').trim();
        const headsign = String(st.headsign || st.tripTo?.name || '').trim();
        if (rShort && headsign) {
          const cleanR = rShort.replace(/[^\dA-Za-z\u4e00-\u9fa5].*$/, '').trim() || rShort;
          if (!headsignMap.has(cleanR)) headsignMap.set(cleanR, headsign);
          if (!headsignMap.has(rShort)) headsignMap.set(rShort, headsign);
        }
      }
    }

    const etaByStopUid = new Map();
    const allLiveEtas = [];
    for (const { city, arr } of liveEtaBatches) {
      for (const eItem of arr) {
        if (!eItem?.StopUID) continue;
        const itemWithCity = { ...eItem, _city: eItem._city || city };
        allLiveEtas.push(itemWithCity);
        const list = etaByStopUid.get(eItem.StopUID) || [];
        list.push(itemWithCity);
        etaByStopUid.set(eItem.StopUID, list);
      }
    }
    if (!hasFreshCachedEtas && allLiveEtas.length > 0) {
      activeStop.etaItems = allLiveEtas;
      activeStop.etaFetchedAt = Date.now();
    }

    // Merge station routes + real-time ETAs, deduplicating by (routeName, direction)
    const mergedRouteMap = new Map();
    const registerCandidate = (cand) => {
      const key = `${cand.routeName}|${cand.direction}`;
      const existing = mergedRouteMap.get(key);
      if (!existing || cand._sortKey < existing._sortKey) {
        mergedRouteMap.set(key, cand);
      }
    };

    for (const sp of activeStop.stops) {
      const rawEtaList = etaByStopUid.get(sp.stopUid) || [];
      const matchedEtaList = rawEtaList.filter(e => {
        const eUid = String(e.RouteUID || '').trim();
        const eRouteName = String(e.RouteName?.Zh_tw || e.SubRouteName?.Zh_tw || '').trim();
        if (sp.routeUid && eUid && sp.routeUid === eUid) return true;
        return Boolean(sp.routeName && eRouteName && (eRouteName === sp.routeName || eRouteName.startsWith(sp.routeName)));
      });
      const etaList = matchedEtaList.length > 0 ? matchedEtaList : [];
      if (etaList.length > 0) {
        for (const e of etaList) {
          const rName = String(e.SubRouteName?.Zh_tw || e.RouteName?.Zh_tw || sp.routeName).trim();
          const rUid = String(e.RouteUID || sp.routeUid || '').trim();
          const dir = typeof e.Direction === 'number' ? e.Direction : 0;
          const rtMeta = cache.busRouteMetaMap.get(`${sp.city}|${rUid}`) ||
                         cache.busRouteMetaMap.get(`${sp.city}|${sp.routeUid}`) ||
                         cache.busRouteMetaMap.get(`${sp.city}|name:${sp.routeName}`);
          let dest = '';
          if (rtMeta) {
            dest = dir === 1
              ? (rtMeta.DepartureStopNameZh || rtMeta.DestinationStopNameZh || '')
              : (rtMeta.DestinationStopNameZh || rtMeta.DepartureStopNameZh || '');
          }
          if (!dest) {
            dest = headsignMap.get(rName) || headsignMap.get(sp.routeName) || (dir === 1 ? '返程方向' : '去程方向');
          }
          const statusObj = formatBusStatusInfo(e.EstimateTime, e.StopStatus, e.NextBusTime);
          const plate = e.PlateNumb || '';
          registerCandidate({
            city: sp.city,
            stopUid: sp.stopUid,
            routeUid: rUid || sp.routeUid,
            routeId: String(e.RouteID || sp.routeId || rName),
            BaseRouteName: sp.routeName,
            routeName: rName,
            direction: dir,
            destination: dest || activeStop.address || '市區方向',
            estimateSec: typeof e.EstimateTime === 'number' ? e.EstimateTime : null,
            stopStatus: typeof e.StopStatus === 'number' ? e.StopStatus : null,
            nextBusTime: e.NextBusTime || null,
            plateNumb: plate && !plate.startsWith('-') ? plate : '',
            statusText: statusObj.text,
            state: statusObj.state,
            _sortKey: statusObj.sortKey
          });
        }
      } else {
        const rtMeta = cache.busRouteMetaMap.get(`${sp.city}|${sp.routeUid}`) ||
                       cache.busRouteMetaMap.get(`${sp.city}|name:${sp.routeName}`);
        const dest = (rtMeta ? (rtMeta.DestinationStopNameZh || rtMeta.DepartureStopNameZh || '') : '') ||
                     headsignMap.get(sp.routeName) || '去程方向';
        registerCandidate({
          city: sp.city,
          stopUid: sp.stopUid,
          routeUid: sp.routeUid,
          routeId: sp.routeId || sp.routeName,
          BaseRouteName: sp.routeName,
          routeName: sp.routeName,
          direction: 0,
          destination: dest || activeStop.address || '市區方向',
          estimateSec: null,
          stopStatus: 1,
          nextBusTime: null,
          plateNumb: '',
          statusText: '尚未發車',
          state: 'waiting',
          _sortKey: 220000
        });
      }
    }

    const buses = [...mergedRouteMap.values()]
      .sort((a, b) => (a._sortKey - b._sortKey) || a.routeName.localeCompare(b.routeName, 'zh-Hant'))
      .map(({ _sortKey, ...rest }) => rest);

    const responseObj = {
      success: true,
      isDirectTdx: true,
      admin: adminInfo,
      tdxCity: primaryTdxCity,
      stations: stations.map(s => ({
        name: s.name,
        distMeters: s.distMeters,
        address: s.address,
        lat: s.lat,
        lon: s.lon,
        routeCount: new Set(s.stops.map(x => x.routeName)).size
      })),
      activeStopIndex,
      activeStop: {
        name: activeStop.name,
        distMeters: activeStop.distMeters,
        address: activeStop.address,
        lat: activeStop.lat,
        lon: activeStop.lon
      },
      buses,
      updatedAt: new Date().toISOString(),
      updateTimeDisplay: getTaiwanTimeHHMMSS()
    };

    const serialized = JSON.stringify(responseObj);
    setBoundedMap(cache.busEtaMap, etaCacheKey, { data: serialized, expireAt: now + 15000 }, 160);
    res.writeHead(200);
    res.end(serialized);
  } catch (err) {
    if (cachedEta && cachedEta.data) {
      res.writeHead(200);
      res.end(cachedEta.data);
    } else {
      res.writeHead(502);
      res.end(JSON.stringify({ success: false, error: '無法取得即時公車站牌資料', detail: err.message }));
    }
  }
}

async function handleBusRouteStopsProxy(req, res, parsedUrl) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const city = String(parsedUrl.searchParams.get('city') || '').trim();
  const routeName = String(parsedUrl.searchParams.get('routeName') || '').trim();
  const baseRouteName = String(parsedUrl.searchParams.get('baseRouteName') || routeName).trim();
  const routeId = String(parsedUrl.searchParams.get('routeId') || '').trim();
  const direction = parseInt(parsedUrl.searchParams.get('direction') || '0', 10) || 0;
  const currentStopName = String(parsedUrl.searchParams.get('stopName') || '').trim();

  if (!city || !routeName || (city !== 'InterCity' && !VALID_TDX_CITIES.has(city))) {
    res.writeHead(400);
    res.end(JSON.stringify({ success: false, error: '缺少有效路線參數' }));
    return;
  }

  const cacheKey = `${city}|${baseRouteName}|${routeId}|${direction}|${currentStopName}`;
  const now = Date.now();
  const cached = cache.busRouteStopsMap.get(cacheKey);
  if (cached && now < cached.expireAt) {
    res.writeHead(200);
    res.end(cached.data);
    return;
  }

  try {
    const fetchSorForCity = async (targetCity) => {
      const isIC = targetCity === 'InterCity';
      const sorPath = isIC
        ? `/v2/Bus/StopOfRoute/InterCity/${encodeURIComponent(baseRouteName)}`
        : `/v2/Bus/StopOfRoute/City/${targetCity}/${encodeURIComponent(baseRouteName)}`;
      const etaPath = isIC
        ? `/v2/Bus/EstimatedTimeOfArrival/InterCity/${encodeURIComponent(baseRouteName)}`
        : `/v2/Bus/EstimatedTimeOfArrival/City/${targetCity}/${encodeURIComponent(baseRouteName)}`;
      const exactFilter = `RouteName/Zh_tw eq '${baseRouteName.replace(/'/g, "''")}'`;

      const [sorRaw, etaRaw] = await Promise.all([
        fetchTdxProxyJson(sorPath, { '$filter': exactFilter, '$select': 'RouteUID,RouteID,RouteName,SubRouteName,Direction,Stops', '$top': '30', '$format': 'JSON' }, 5500),
        fetchTdxProxyJson(etaPath, { '$filter': exactFilter, '$select': 'StopUID,RouteName,Direction,EstimateTime,StopStatus,NextBusTime,PlateNumb', '$top': '300', '$format': 'JSON' }, 5500).catch(() => [])
      ]);
      return { sorList: Array.isArray(sorRaw) ? sorRaw : [], etaRaw: Array.isArray(etaRaw) ? etaRaw : [] };
    };

    let { sorList, etaRaw } = await fetchSorForCity(city);
    // 雙北聯營公車自動跨市查找備援
    if (sorList.length === 0 && (city === 'NewTaipei' || city === 'Taipei')) {
      const altCity = city === 'NewTaipei' ? 'Taipei' : 'NewTaipei';
      ({ sorList, etaRaw } = await fetchSorForCity(altCity));
    }

    const exactSorList = sorList.filter(s => !s?.RouteName?.Zh_tw || s.RouteName.Zh_tw === baseRouteName);
    const sorCandidates = exactSorList.length > 0 ? exactSorList : sorList;

    const matchedSor = sorCandidates.find(s => (s.Direction ?? 0) === direction && (s.RouteID === routeId || s.SubRouteName?.Zh_tw === routeName))
      || sorCandidates.find(s => (s.Direction ?? 0) === direction)
      || sorCandidates[0];

    const etaMap = new Map();
    if (Array.isArray(etaRaw)) {
      const targetDir = matchedSor?.Direction ?? direction;
      for (const e of etaRaw) {
        if (e?.RouteName?.Zh_tw && e.RouteName.Zh_tw !== baseRouteName) continue;
        if ((e.Direction ?? 0) === targetDir && e.StopUID) {
          const prev = etaMap.get(e.StopUID);
          if (!prev) {
            etaMap.set(e.StopUID, e);
          } else {
            const curScore = formatBusStatusInfo(e.EstimateTime, e.StopStatus, e.NextBusTime).sortKey;
            const prevScore = formatBusStatusInfo(prev.EstimateTime, prev.StopStatus, prev.NextBusTime).sortKey;
            if (curScore < prevScore) etaMap.set(e.StopUID, e);
          }
        }
      }
    }

    const rawStops = Array.isArray(matchedSor?.Stops) ? matchedSor.Stops : [];
    const stops = rawStops.map((st, idx) => {
      const sName = String(st?.StopName?.Zh_tw || '').trim();
      const uid = String(st?.StopUID || '');
      const e = etaMap.get(uid);
      const stInfo = e ? formatBusStatusInfo(e.EstimateTime, e.StopStatus, e.NextBusTime) : { text: '', state: 'none' };
      return {
        seq: idx + 1,
        stopUid: uid,
        name: sName,
        isCurrent: Boolean(sName && currentStopName && (sName === currentStopName || sName.includes(currentStopName) || currentStopName.includes(sName))),
        statusText: stInfo.text,
        state: stInfo.state,
        plateNumb: (e?.PlateNumb && !e.PlateNumb.startsWith('-')) ? e.PlateNumb : ''
      };
    });

    const payload = JSON.stringify({
      success: true,
      city,
      routeName,
      direction: matchedSor?.Direction ?? direction,
      totalStops: stops.length,
      stops
    });
    setBoundedMap(cache.busRouteStopsMap, cacheKey, { data: payload, expireAt: now + 18000 }, 120);
    res.writeHead(200);
    res.end(payload);
  } catch (err) {
    res.writeHead(502);
    res.end(JSON.stringify({ success: false, error: '無法取得路線沿途站序', detail: err.message }));
  }
}

// ============================================================================
// 跨國（日本／韓國／亞太／歐洲／美洲）在地行政區、最近大眾運輸與全球共享單車代理引擎
// ============================================================================
const INTL_TERM_NORMALIZE_PAIRS = [
  [/\u5927\u97e9\u6c11\u56fd|大韓民國/g, '韓國'],
  [/\u7f8e\u5229\u575a\u5408\u4f17\u56fd|美利堅合眾國/g, '美國'],
  [/\u5927\u4e0d\u5217\u98a0[\u53ca\u548c\u8207\u4e0e]*\u5317[\u7231\u611b][\u5c14\u723e][\u5170\u862d][\u8054\u806f]\u5408\u738b[\u56fd\u570b]/g, '英國'],
  [/\u6089\u5c3c|悉尼/g, '雪梨'],
  [/\u65b0\u897f\u5170|新西蘭/g, '紐西蘭'],
  [/\u963f\u8054\u914b|\u963f\u62c9\u4f2f\u8054\u5408\u914b\u957f\u56fd/g, '阿聯'],
  [/\u6c99\u7279\u963f\u62c9\u4f2f/g, '沙烏地阿拉伯'],
  [/\u4e4c\u65af\u6000\u4e9a/g, '烏斯懷亞'],
  [/\u9996\u5c14/g, '首爾'],
  [/\u4e1c\u4eac/g, '東京'],
  [/\u6da9\u8c37/g, '澀谷'],
  [/\u51b2\u7ef3/g, '沖繩'],
  [/\u4f26\u6566/g, '倫敦'],
  [/\u82cf\u9ece\u4e16/g, '蘇黎世'],
  [/\u7f57\u74e6\u6d85\u7c73/g, '羅瓦涅米'],
  [/\u7ebd\u7ea6/g, '紐約'],
  [/\u6d1b\u6749\u77f6/g, '洛杉磯'],
  [/\u62c9\u65af\u7ef4\u52a0\u65af/g, '拉斯維加斯'],
  [/\u5723\u4fdd\u7f57/g, '聖保羅'],
  [/\u5965\u514b\u5170/g, '奧克蘭'],
  [/\u91cc\u7ea6/g, '里約'],
  [/\u53f0\u6e7e/g, '台灣'],
  [/\u533a/g, '區'],
  [/\u56fd/g, '國'],
  [/\u53bf/g, '縣'],
  [/\u5c9b/g, '島'],
  [/\u6e7e/g, '灣'],
  [/\u9547/g, '鎮'],
  [/\u4e61/g, '鄉'],
  [/\u97e9/g, '韓'],
  [/\u4e4c/g, '烏'],
  [/\u6000/g, '懷'],
  [/\u4e9a/g, '亞'],
  [/\u5c14/g, '爾'],
  [/\u5170/g, '蘭'],
  [/\u9a6c/g, '馬'],
  [/\u8fbe/g, '達'],
  [/\u7eb3/g, '納'],
  [/\u4f26/g, '倫'],
  [/\u7ef4/g, '維'],
  [/\u987f/g, '頓'],
  [/\u6b27/g, '歐'],
  [/\u8428/g, '薩'],
  [/\u5fb7/g, '德'],
  [/\u5b66/g, '學'],
  [/\u8054/g, '聯'],
  [/\u8f66/g, '車'],
  [/\u56ed/g, '園'],
  [/\u5e7f\u573a/g, '廣場'],
  [/\u6865/g, '橋'],
  [/\u94c1/g, '鐵'],
  [/\u9986/g, '館'],
  [/\u5bab/g, '宮'],
  [/\u5bfa/g, '寺'],
  [/\u95e8/g, '門']
];

function normalizeIntlTwLabel(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  for (const [re, rep] of INTL_TERM_NORMALIZE_PAIRS) {
    s = s.replace(re, rep);
  }
  return s;
}

function formatTimeInZoneHHMM(isoStr, timeZone = 'UTC') {
  if (!isoStr) return '';
  const ms = Date.parse(isoStr);
  if (!Number.isFinite(ms)) return '';
  try {
    return new Intl.DateTimeFormat('zh-TW', {
      timeZone: timeZone || 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date(ms));
  } catch (_) {
    return new Date(ms).toISOString().slice(11, 16);
  }
}

function mapIntlModeMeta(mode = '') {
  const m = String(mode || '').toUpperCase();
  if (m.includes('SUBWAY') || m.includes('METRO')) return { mode: 'SUBWAY', label: '地鐵', icon: 'fa-train-subway' };
  if (m.includes('HIGHSPEED') || m.includes('LONG_DISTANCE')) return { mode: 'RAIL', label: '高速鐵道', icon: 'fa-train' };
  if (m.includes('RAIL') || m.includes('TRAIN')) return { mode: 'RAIL', label: '鐵道', icon: 'fa-train' };
  if (m.includes('TRAM') || m.includes('LIGHT_RAIL')) return { mode: 'TRAM', label: '路面電車', icon: 'fa-train-tram' };
  if (m.includes('FERRY')) return { mode: 'FERRY', label: '渡輪水上巴士', icon: 'fa-ferry' };
  if (m.includes('AERIAL') || m.includes('FUNICULAR')) return { mode: 'CABLE', label: '登山纜車', icon: 'fa-cable-car' };
  return { mode: 'BUS', label: '公車巴士', icon: 'fa-bus' };
}

async function resolveGlobalAdminInfo(lat, lon) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const now = Date.now();
  const cached = cache.intlGeocodeMap.get(key);
  if (cached && now < cached.expireAt) return cached.data;

  try {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat.toFixed(5)}&longitude=${lon.toFixed(5)}&localityLanguage=zh-tw`;
    const j = await fetchJsonWithRetry(url, 0, 4000);
    const country = normalizeIntlTwLabel(j?.countryName || '');
    const subdiv = normalizeIntlTwLabel(j?.principalSubdivision || '');
    const city = normalizeIntlTwLabel(j?.city || '');
    const locality = normalizeIntlTwLabel(j?.locality || '');
    const primaryCity = city || subdiv || country || '海外地區';
    const subArea = (locality && locality !== primaryCity) ? locality : '';
    const shortLabel = country ? `${country} ‧ ${primaryCity}` : primaryCity;
    const fullLabel = subArea ? `${shortLabel} ${subArea}` : shortLabel;
    const info = {
      county: country || primaryCity,
      town: subArea ? `${primaryCity}${subArea}` : primaryCity,
      village: '',
      countryCode: String(j?.countryCode || '').toUpperCase(),
      shortLabel,
      fullLabel,
      isInternational: true,
      source: 'bigdatacloud'
    };
    setBoundedMap(cache.intlGeocodeMap, key, { data: info, expireAt: now + 3600000 }, 240);
    return info;
  } catch (_) {
    return {
      county: '海外觀測點',
      town: `${lat.toFixed(2)}, ${lon.toFixed(2)}`,
      village: '',
      countryCode: '',
      shortLabel: '海外觀測點',
      fullLabel: '海外觀測點',
      isInternational: true,
      source: 'coords'
    };
  }
}

async function handleGeocodeGlobalProxy(req, res, parsedUrl) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const lat = parseFloat(parsedUrl.searchParams.get('lat'));
  const lon = parseFloat(parsedUrl.searchParams.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    res.writeHead(400);
    res.end(JSON.stringify({ success: false, error: '無效的經緯度座標' }));
    return;
  }
  try {
    const info = await resolveGlobalAdminInfo(lat, lon);
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, ...info }));
  } catch (err) {
    res.writeHead(502);
    res.end(JSON.stringify({ success: false, error: '無法解析海外行政區', detail: err.message }));
  }
}

async function handleIntlTransitNearbyProxy(req, res, parsedUrl) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const lat = parseFloat(parsedUrl.searchParams.get('lat'));
  const lon = parseFloat(parsedUrl.searchParams.get('lon'));
  const reqStopIdx = Math.max(0, Math.min(4, parseInt(parsedUrl.searchParams.get('stopIdx') || '0', 10) || 0));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    res.writeHead(400);
    res.end(JSON.stringify({ success: false, error: '無效的經緯度座標' }));
    return;
  }

  const cacheKey = `${lat.toFixed(4)},${lon.toFixed(4)},${reqStopIdx}`;
  const now = Date.now();
  const cached = cache.intlTransitMap.get(cacheKey);
  if (cached && now < cached.expireAt) {
    res.writeHead(200);
    res.end(cached.data);
    return;
  }

  try {
    const isJapanBox = lat >= 24.0 && lat <= 46.5 && lon >= 122.8 && lon <= 149.0;
    const isLondonBox = lat >= 51.25 && lat <= 51.72 && lon >= -0.55 && lon <= 0.32;
    const isSwissBox = lat >= 45.8 && lat <= 47.85 && lon >= 5.9 && lon <= 10.6;

    const transitousHeaders = {
      'Accept': 'application/json',
      'User-Agent': 'TaiwanNeighborhoodMonitor/2.0 (https://github.com/JaneDe0214/taiwan-neighborhood-monitor)'
    };

    const fetchTransitousJson = async (u, ms = 5500) => {
      const r = await fetch(u, { headers: transitousHeaders, signal: AbortSignal.timeout(ms) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    };

    const [adminInfo, transitousStops, heartRailsRes, tflRes, sbbRes] = await Promise.all([
      resolveGlobalAdminInfo(lat, lon),
      fetchTransitousJson(`https://api.transitous.org/api/v1/reverse-geocode?place=${lat.toFixed(5)},${lon.toFixed(5)}&type=STOP`, 5500).catch(() => []),
      isJapanBox
        ? fetchJsonWithRetry(`https://express.heartrails.com/api/json?method=getStations&x=${lon.toFixed(5)}&y=${lat.toFixed(5)}`, 0, 4000).catch(() => null)
        : Promise.resolve(null),
      isLondonBox
        ? fetchJsonWithRetry(`https://api.tfl.gov.uk/StopPoint?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&stopTypes=NaptanPublicBusCoachTram,NaptanMetroStation&radius=420`, 0, 4500).catch(() => null)
        : Promise.resolve(null),
      isSwissBox
        ? fetchJsonWithRetry(`https://transport.opendata.ch/v1/locations?x=${lat.toFixed(5)}&y=${lon.toFixed(5)}&type=station`, 0, 4500).catch(() => null)
        : Promise.resolve(null)
    ]);

    const stations = [];
    const seenStopNames = new Set();
    let detectedTz = '';

    // 1. 整合 MOTIS Transitous 全球 GTFS / GTFS-RT 站點
    if (Array.isArray(transitousStops)) {
      for (const st of transitousStops) {
        if (!st?.id || !st?.name || !Number.isFinite(st.lat) || !Number.isFinite(st.lon)) continue;
        const distMeters = calcDistanceMeters(lat, lon, st.lat, st.lon);
        if (distMeters > 3500) continue;
        if (!detectedTz && st.tz) detectedTz = st.tz;
        const cleanKey = st.name.toLowerCase().trim();
        if (seenStopNames.has(cleanKey)) continue;
        seenStopNames.add(cleanKey);
        stations.push({
          provider: 'transitous',
          stopId: st.id,
          name: st.name,
          lat: st.lat,
          lon: st.lon,
          distMeters,
          tz: st.tz || '',
          modes: Array.isArray(st.modes) ? st.modes : []
        });
      }
    }

    // 2. 倫敦 TfL 即時站點補充
    if (tflRes && Array.isArray(tflRes.stopPoints)) {
      for (const sp of tflRes.stopPoints) {
        if (!sp?.naptanId || sp.naptanId.startsWith('HUB') || !sp.commonName) continue;
        const distMeters = Number.isFinite(sp.distance) ? Math.round(sp.distance) : calcDistanceMeters(lat, lon, sp.lat, sp.lon);
        if (distMeters > 800) continue;
        const cleanKey = sp.commonName.toLowerCase().trim();
        if (seenStopNames.has(cleanKey)) continue;
        seenStopNames.add(cleanKey);
        stations.push({
          provider: 'tfl',
          stopId: sp.naptanId,
          name: sp.commonName,
          lat: sp.lat,
          lon: sp.lon,
          distMeters,
          tz: 'Europe/London',
          modes: ['BUS']
        });
      }
    }

    // 3. 瑞士國鐵 SBB 高山鐵道／纜車站點補充
    if (sbbRes && Array.isArray(sbbRes.stations)) {
      for (const sp of sbbRes.stations) {
        if (!sp?.id || !sp?.name || !sp?.coordinate) continue;
        const sLat = Number(sp.coordinate.x);
        const sLon = Number(sp.coordinate.y);
        if (!Number.isFinite(sLat) || !Number.isFinite(sLon)) continue;
        const distMeters = Number.isFinite(sp.distance) ? Math.round(sp.distance) : calcDistanceMeters(lat, lon, sLat, sLon);
        if (distMeters > 2500) continue;
        const cleanKey = sp.name.toLowerCase().trim();
        if (seenStopNames.has(cleanKey)) continue;
        seenStopNames.add(cleanKey);
        stations.push({
          provider: 'sbb',
          stopId: String(sp.id),
          name: sp.name,
          lat: sLat,
          lon: sLon,
          distMeters,
          tz: 'Europe/Zurich',
          modes: ['RAIL']
        });
      }
    }

    // 4. 日本 HeartRails Express 鐵道車站與路線補充（涵蓋富士山河口湖、大阪難波、札幌、沖繩等全境車站）
    const hrList = Array.isArray(heartRailsRes?.response?.station) ? heartRailsRes.response.station : [];
    const hrByStation = new Map();
    for (const st of hrList) {
      if (!st?.name || !Number.isFinite(Number(st.y)) || !Number.isFinite(Number(st.x))) continue;
      const sLat = Number(st.y);
      const sLon = Number(st.x);
      const distMeters = calcDistanceMeters(lat, lon, sLat, sLon);
      if (distMeters > 3500) continue;
      const grp = hrByStation.get(st.name) || {
        provider: 'heartrails',
        stopId: `hr:${st.name}`,
        name: `${st.name}駅`,
        lat: sLat,
        lon: sLon,
        distMeters,
        tz: 'Asia/Tokyo',
        modes: ['RAIL'],
        hrLines: []
      };
      if (distMeters < grp.distMeters) grp.distMeters = distMeters;
      grp.hrLines.push({
        line: st.line || '鐵道線',
        prev: st.prev || '',
        next: st.next || '',
        prefecture: st.prefecture || ''
      });
      hrByStation.set(st.name, grp);
    }
    for (const grp of hrByStation.values()) {
      const dup = stations.find(s => s.name.includes(grp.name.replace(/駅$/, '')) && Math.abs(s.distMeters - grp.distMeters) < 180);
      if (dup) {
        dup.hrLines = grp.hrLines;
      } else {
        stations.push(grp);
      }
    }

    stations.sort((a, b) => a.distMeters - b.distMeters);
    const topStations = stations.slice(0, 5);
    if (topStations.length === 0) {
      const emptyPayload = JSON.stringify({
        success: true,
        isInternational: true,
        admin: adminInfo,
        tz: detectedTz || 'UTC',
        stations: [],
        activeStopIndex: 0,
        activeStop: null,
        buses: [],
        updateTimeDisplay: formatTimeInZoneHHMM(new Date().toISOString(), detectedTz || 'Asia/Taipei')
      });
      setBoundedMap(cache.intlTransitMap, cacheKey, { data: emptyPayload, expireAt: now + 30000 }, 160);
      res.writeHead(200);
      res.end(emptyPayload);
      return;
    }

    const activeStopIndex = Math.min(reqStopIdx, topStations.length - 1);
    const activeStop = topStations[activeStopIndex];
    const stopTz = activeStop.tz || detectedTz || (isJapanBox ? 'Asia/Tokyo' : 'UTC');
    const buses = [];

    if (activeStop.provider === 'transitous') {
      const stData = await fetchTransitousJson(`https://api.transitous.org/api/v1/stoptimes?stopId=${encodeURIComponent(activeStop.stopId)}&n=18`, 5500).catch(() => null);
      const seenRoutes = new Set();
      for (const item of (stData?.stopTimes || [])) {
        const rName = String(item.routeShortName || item.displayName || item.routeLongName || '').trim();
        const dest = String(item.headsign || item.tripTo?.name || '').trim();
        if (!rName) continue;
        const dedupKey = `${rName}|${dest}`;
        if (seenRoutes.has(dedupKey)) continue;
        seenRoutes.add(dedupKey);

        const depIso = item.place?.departure || item.place?.arrival || item.place?.scheduledDeparture;
        const depMs = depIso ? Date.parse(depIso) : NaN;
        if (Number.isFinite(depMs) && depMs < Date.now() - 45000) continue;
        const remainSec = Number.isFinite(depMs) ? Math.max(0, Math.round((depMs - Date.now()) / 1000)) : null;
        const hhmm = depIso ? formatTimeInZoneHHMM(depIso, item.place?.tz || stopTz) : '';
        const isRt = Boolean(item.realTime);
        const modeInfo = mapIntlModeMeta(item.mode);

        let statusText = '班表營運中';
        if (remainSec != null) {
          if (isRt) {
            statusText = remainSec <= 60 ? '進站中' : (remainSec <= 180 ? `即將進站 (${Math.ceil(remainSec / 60)}分)` : `${Math.round(remainSec / 60)} 分`);
          } else {
            const mins = Math.round(remainSec / 60);
            statusText = mins <= 1 ? `${hhmm} 發車` : (mins > 60 ? `${hhmm} 班表` : `${mins} 分 (${hhmm} 班表)`);
          }
        }

        buses.push({
          city: 'INTL',
          provider: 'transitous',
          mode: modeInfo.mode,
          modeLabel: modeInfo.label,
          modeIcon: modeInfo.icon,
          routeName: rName,
          direction: item.directionId || 0,
          destination: dest || modeInfo.label,
          estimateSec: isRt ? remainSec : null,
          stopStatus: isRt ? 0 : 1,
          nextBusTime: depIso || null,
          depLocalTime: hhmm,
          isRealtime: isRt,
          tripId: item.tripId || '',
          agencyName: item.agencyName || '',
          plateNumb: '',
          statusText,
          _sortSec: remainSec != null ? remainSec : 999999
        });
      }
    } else if (activeStop.provider === 'tfl') {
      const arr = await fetchJsonWithRetry(`https://api.tfl.gov.uk/StopPoint/${encodeURIComponent(activeStop.stopId)}/Arrivals`, 0, 4500).catch(() => []);
      const seen = new Set();
      if (Array.isArray(arr)) {
        arr.sort((a, b) => (a.timeToStation || 0) - (b.timeToStation || 0));
        for (const a of arr) {
          const rName = String(a.lineName || '').trim();
          const dest = String(a.destinationName || a.towards || '').trim();
          if (!rName || seen.has(`${rName}|${dest}`)) continue;
          seen.add(`${rName}|${dest}`);
          const sec = Math.max(0, Number(a.timeToStation) || 0);
          const modeInfo = mapIntlModeMeta(a.modeName);
          buses.push({
            city: 'INTL',
            provider: 'tfl',
            mode: modeInfo.mode,
            modeLabel: modeInfo.label,
            modeIcon: modeInfo.icon,
            routeName: rName,
            direction: 0,
            destination: dest || 'London',
            estimateSec: sec,
            stopStatus: 0,
            nextBusTime: a.expectedArrival || null,
            depLocalTime: formatTimeInZoneHHMM(a.expectedArrival, 'Europe/London'),
            isRealtime: true,
            tripId: '',
            agencyName: 'TfL',
            plateNumb: a.vehicleId || '',
            statusText: sec <= 60 ? '進站中' : `${Math.round(sec / 60)} 分`,
            _sortSec: sec
          });
        }
      }
    } else if (activeStop.provider === 'sbb') {
      const sb = await fetchJsonWithRetry(`https://transport.opendata.ch/v1/stationboard?id=${encodeURIComponent(activeStop.stopId)}&limit=12`, 0, 4500).catch(() => null);
      const seen = new Set();
      for (const item of (sb?.stationboard || [])) {
        const rName = `${item.category || ''}${item.number || ''}`.trim();
        const dest = String(item.to || '').trim();
        if (!rName || seen.has(`${rName}|${dest}`)) continue;
        seen.add(`${rName}|${dest}`);
        const depIso = item.stop?.prognosis?.departure || item.stop?.departure;
        const isRt = Boolean(item.stop?.prognosis?.departure);
        const depMs = depIso ? Date.parse(depIso) : NaN;
        if (Number.isFinite(depMs) && depMs < Date.now() - 45000) continue;
        const sec = Number.isFinite(depMs) ? Math.max(0, Math.round((depMs - Date.now()) / 1000)) : null;
        const hhmm = formatTimeInZoneHHMM(depIso, 'Europe/Zurich');
        buses.push({
          city: 'INTL',
          provider: 'sbb',
          mode: item.category === 'B' ? 'BUS' : 'RAIL',
          modeLabel: item.category === 'B' ? '郵政巴士' : '瑞士國鐵',
          modeIcon: item.category === 'B' ? 'fa-bus' : 'fa-train',
          routeName: rName,
          direction: 0,
          destination: dest || 'Switzerland',
          estimateSec: isRt ? sec : null,
          stopStatus: isRt ? 0 : 1,
          nextBusTime: depIso || null,
          depLocalTime: hhmm,
          isRealtime: isRt,
          tripId: '',
          agencyName: 'SBB',
          plateNumb: '',
          statusText: sec != null ? (isRt ? `${Math.round(sec / 60)} 分` : `${Math.round(sec / 60)} 分 (${hhmm} 班表)`) : `${hhmm} 發車`,
          _sortSec: sec != null ? sec : 999999
        });
      }
    }

    // 補充日本鐵道路線與前後站資訊（如富士急行線、私鐵與地鐵支線）
    if (Array.isArray(activeStop.hrLines) && activeStop.hrLines.length > 0) {
      activeStop.hrLines.forEach((ln, idx) => {
        if (buses.some(b => b.routeName === ln.line)) return;
        const adj = [ln.prev ? `${ln.prev}駅` : '', ln.next ? `${ln.next}駅` : ''].filter(Boolean).join(' ↔ ');
        buses.push({
          city: 'INTL',
          provider: 'heartrails',
          mode: 'RAIL',
          modeLabel: '日本鐵道',
          modeIcon: 'fa-train',
          routeName: ln.line,
          direction: idx,
          destination: adj || ln.prefecture || '雙向運行',
          estimateSec: null,
          stopStatus: 1,
          nextBusTime: null,
          depLocalTime: '',
          isRealtime: false,
          tripId: '',
          agencyName: 'JR / 私鐵 / 地鐵',
          plateNumb: '',
          hrStops: [ln.prev ? `${ln.prev}駅` : null, activeStop.name, ln.next ? `${ln.next}駅` : null].filter(Boolean),
          statusText: '依站內時刻表運行',
          _sortSec: 500000 + idx
        });
      });
    }

    buses.sort((a, b) => a._sortSec - b._sortSec);
    const cleanBuses = buses.slice(0, 14).map(({ _sortSec, ...rest }) => rest);

    const payload = JSON.stringify({
      success: true,
      isInternational: true,
      admin: adminInfo,
      tz: stopTz,
      stations: topStations.map(s => ({
        name: s.name,
        distMeters: s.distMeters,
        lat: s.lat,
        lon: s.lon,
        modes: s.modes || []
      })),
      activeStopIndex,
      activeStop: {
        name: activeStop.name,
        distMeters: activeStop.distMeters,
        lat: activeStop.lat,
        lon: activeStop.lon,
        modes: activeStop.modes || []
      },
      buses: cleanBuses,
      updateTimeDisplay: formatTimeInZoneHHMM(new Date().toISOString(), stopTz)
    });

    setBoundedMap(cache.intlTransitMap, cacheKey, { data: payload, expireAt: now + 20000 }, 160);
    res.writeHead(200);
    res.end(payload);
  } catch (err) {
    res.writeHead(502);
    res.end(JSON.stringify({ success: false, error: '無法取得跨國大眾運輸資訊', detail: err.message }));
  }
}

async function handleIntlTripStopsProxy(req, res, parsedUrl) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const tripId = String(parsedUrl.searchParams.get('tripId') || '').trim();
  const stopName = String(parsedUrl.searchParams.get('stopName') || '').trim();
  if (!tripId) {
    res.writeHead(400);
    res.end(JSON.stringify({ success: false, error: '缺少班次識別參數' }));
    return;
  }
  const cacheKey = `${tripId}|${stopName}`;
  const now = Date.now();
  const cached = cache.intlTripMap.get(cacheKey);
  if (cached && now < cached.expireAt) {
    res.writeHead(200);
    res.end(cached.data);
    return;
  }
  try {
    const r = await fetch(`https://api.transitous.org/api/v1/trip?tripId=${encodeURIComponent(tripId)}`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'TaiwanNeighborhoodMonitor/2.0 (https://github.com/JaneDe0214/taiwan-neighborhood-monitor)'
      },
      signal: AbortSignal.timeout(5500)
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const leg = j?.legs?.[0];
    const rawStops = leg ? [leg.from, ...(leg.intermediateStops || []), leg.to].filter(Boolean) : [];
    const stops = rawStops.map((st, idx) => {
      const nm = String(st.name || '').trim();
      const depIso = st.departure || st.arrival || st.scheduledDeparture || st.scheduledArrival;
      const hhmm = depIso ? formatTimeInZoneHHMM(depIso, st.tz || 'UTC') : '';
      return {
        seq: idx + 1,
        name: nm,
        isCurrent: Boolean(nm && stopName && (nm === stopName || nm.includes(stopName) || stopName.includes(nm))),
        statusText: hhmm,
        state: ''
      };
    });
    const payload = JSON.stringify({ success: true, totalStops: stops.length, stops });
    setBoundedMap(cache.intlTripMap, cacheKey, { data: payload, expireAt: now + 60000 }, 120);
    res.writeHead(200);
    res.end(payload);
  } catch (err) {
    res.writeHead(502);
    res.end(JSON.stringify({ success: false, error: '無法取得跨國班次沿途站序', detail: err.message }));
  }
}

async function handleGlobalBikesProxy(req, res, parsedUrl) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const lat = parseFloat(parsedUrl.searchParams.get('lat'));
  const lon = parseFloat(parsedUrl.searchParams.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    res.writeHead(400);
    res.end(JSON.stringify({ success: false, error: '無效的經緯度座標' }));
    return;
  }

  try {
    const now = Date.now();
    let networks = cache.cityBikesDir.data;
    if (!networks || networks.length === 0 || now >= cache.cityBikesDir.expireAt) {
      const dirJson = await fetchJsonWithRetry('https://api.citybik.es/v2/networks?fields=id,name,location', 0, 5500);
      networks = Array.isArray(dirJson?.networks) ? dirJson.networks : [];
      if (networks.length > 0) {
        cache.cityBikesDir = { data: networks, expireAt: now + 6 * 3600000 };
      }
    }

    const candidates = networks
      .map(n => {
        const nLat = Number(n?.location?.latitude);
        const nLon = Number(n?.location?.longitude);
        if (!n?.id || !Number.isFinite(nLat) || !Number.isFinite(nLon)) return null;
        return { id: n.id, name: n.name || n.id, dMeters: calcDistanceMeters(lat, lon, nLat, nLon) };
      })
      .filter(x => x && x.dMeters <= 38000)
      .sort((a, b) => a.dMeters - b.dMeters)
      .slice(0, 2);

    if (candidates.length === 0) {
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, networkName: '', stations: [] }));
      return;
    }

    const pool = [];
    let primaryNetworkName = candidates[0].name;
    for (const cand of candidates) {
      let netStations = null;
      const cachedNet = cache.cityBikesNetMap.get(cand.id);
      if (cachedNet && now < cachedNet.expireAt) {
        netStations = cachedNet.stations;
      } else {
        const netJson = await fetchJsonWithRetry(`https://api.citybik.es/v2/networks/${encodeURIComponent(cand.id)}`, 0, 5500).catch(() => null);
        if (Array.isArray(netJson?.network?.stations)) {
          netStations = netJson.network.stations;
          setBoundedMap(cache.cityBikesNetMap, cand.id, { stations: netStations, expireAt: now + 30000 }, 60);
        }
      }
      if (Array.isArray(netStations)) {
        for (const s of netStations) {
          const sLat = Number(s.latitude);
          const sLon = Number(s.longitude);
          if (!Number.isFinite(sLat) || !Number.isFinite(sLon)) continue;
          const dMeters = calcDistanceMeters(lat, lon, sLat, sLon);
          if (dMeters > 3000) continue;
          const bikes = Math.max(0, Number(s.free_bikes) || 0);
          const spaces = Math.max(0, Number(s.empty_slots) || 0);
          const ebikes = Math.max(0, Number(s.extra?.ebikes) || 0);
          pool.push({
            id: String(s.id || `${cand.id}_${sLat.toFixed(4)}`),
            networkName: cand.name,
            name: String(s.name || '').replace(/^\d+\.\s*/, '').trim(),
            address: String(s.extra?.address || '').trim(),
            lat: sLat,
            lon: sLon,
            distKm: +(dMeters / 1000).toFixed(2),
            bikes,
            spaces,
            ebikes,
            total: Math.max(1, bikes + spaces),
            timestamp: s.timestamp || ''
          });
        }
      }
    }

    pool.sort((a, b) => a.distKm - b.distKm);
    res.writeHead(200);
    res.end(JSON.stringify({
      success: true,
      networkName: primaryNetworkName,
      stations: pool.slice(0, 6)
    }));
  } catch (err) {
    res.writeHead(502);
    res.end(JSON.stringify({ success: false, error: '無法取得跨國共享單車資料', detail: err.message }));
  }
}

// 抓取單一 JSON 並附帶一次重試機制 (優先採用現代內建 fetch / Happy Eyeballs 消除 Open-Meteo TLS 連線重置)
// 抓取單一 JSON 並附帶重試機制 (支援自訂逾時秒數)
async function fetchJsonWithRetry(url, retries = 1, timeoutMs = 4500) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      if (typeof fetch === 'function') {
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'TaiwanNeighborhoodMonitor/1.0 (https://github.com/JaneDe0214/taiwan-neighborhood-monitor)',
            'Accept': 'application/json'
          },
          signal: (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')
            ? AbortSignal.timeout(timeoutMs)
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

// 解析 IANA 時區當前真實 UTC 小時偏移量 (自動涵蓋歐美日光節約時間 DST 與 UTC/GMT，auto 時依經度推算太陽時區)
function resolveIanaTzOffsetHours(timeZone = 'Asia/Taipei', refDate = new Date(), lon = null) {
  if (!timeZone) return 8;
  if (timeZone === 'auto') {
    const numLon = Number(lon);
    return Number.isFinite(numLon) ? Math.max(-12, Math.min(14, Math.round(numLon / 15))) : 8;
  }
  if (timeZone === 'UTC' || timeZone === 'GMT') return 0;
  if (timeZone === 'Asia/Taipei') return 8;
  if (timeZone === 'Asia/Tokyo' || timeZone === 'Asia/Seoul') return 9;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'shortOffset'
    }).formatToParts(refDate);
    const tzPart = (parts.find(p => p.type === 'timeZoneName') || {}).value || '';
    if (tzPart === 'GMT' || tzPart === 'UTC') return 0;
    const m = tzPart.match(/(?:GMT|UTC)([+-])(\d{1,2})(?::(\d{2}))?/);
    if (m) {
      const sign = m[1] === '-' ? -1 : 1;
      return sign * ((parseInt(m[2], 10) || 0) + (parseInt(m[3] || '0', 10) || 0) / 60);
    }
  } catch (_) {}
  const numLon = Number(lon);
  return Number.isFinite(numLon) ? Math.max(-12, Math.min(14, Math.round(numLon / 15))) : 8;
}

// 挪威國家氣象局 (MET Norway) 全球官方即時數值預報備援轉換器 (當 Open-Meteo 主節點瞬斷或維護時無縫接手)
async function fetchMetNorwayWeatherFallback(lat, lon, tz = 'Asia/Taipei') {
  const offsetHours = resolveIanaTzOffsetHours(tz, new Date(), lon);
  const sign = offsetHours >= 0 ? '+' : '-';
  const totalMin = Math.round(Math.abs(offsetHours) * 60);
  const offsetStr = `${sign}${String(Math.floor(totalMin / 60)).padStart(2, '0')}:${String(totalMin % 60).padStart(2, '0')}`;
  const toLocalIso = (utcMs) => new Date(utcMs + offsetHours * 3600000).toISOString().slice(0, 16);
  const localToday = toLocalIso(Date.now()).slice(0, 10);

  const forecastUrl = `https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${Number(lat).toFixed(4)}&lon=${Number(lon).toFixed(4)}`;
  const sunUrl = `https://api.met.no/weatherapi/sunrise/3.0/sun?lat=${Number(lat).toFixed(4)}&lon=${Number(lon).toFixed(4)}&date=${localToday}&offset=${encodeURIComponent(offsetStr)}`;

  const [fcRes, sunRes] = await Promise.allSettled([
    fetchJsonWithRetry(forecastUrl, 0, 5000),
    fetchJsonWithRetry(sunUrl, 0, 4000)
  ]);
  if (fcRes.status !== 'fulfilled' || !fcRes.value?.properties?.timeseries?.length) {
    throw fcRes.reason || new Error('MET Norway 全球預報無回應');
  }

  const series = fcRes.value.properties.timeseries;
  const symbolToWmo = (sym = '') => {
    const s = String(sym).toLowerCase();
    if (s.includes('snowandthunder') || s.includes('rainandthunder')) return 95;
    if (s.includes('thunder')) return 95;
    if (s.includes('heavysnowshowers')) return 86;
    if (s.includes('snowshowers') || s.includes('lightsnowshowers')) return 85;
    if (s.includes('heavysnow')) return 75;
    if (s.includes('lightsnow')) return 71;
    if (s.includes('snow')) return 73;
    if (s.includes('sleet')) return 67;
    if (s.includes('heavyrainshowers')) return 82;
    if (s.includes('heavyrain')) return 65;
    if (s.includes('rainshowers')) return 80;
    if (s.includes('lightrain') || s.includes('drizzle')) return 61;
    if (s.includes('rain')) return 63;
    if (s.includes('fog')) return 45;
    if (s.includes('cloudy') && !s.includes('partly')) return 3;
    if (s.includes('partlycloudy')) return 2;
    if (s.includes('fair')) return 1;
    return 0;
  };
  const estimateRainProb = (step) => {
    const n1 = step?.data?.next_1_hours || step?.data?.next_6_hours || {};
    const det = n1.details || {};
    if (typeof det.probability_of_precipitation === 'number') {
      return Math.round(det.probability_of_precipitation);
    }
    const amt = Number(det.precipitation_amount) || 0;
    const sym = String(n1.summary?.symbol_code || '').toLowerCase();
    const cloud = Number(step?.data?.instant?.details?.cloud_area_fraction) || 0;
    if (amt >= 3.0) return 90;
    if (amt >= 1.0) return 75;
    if (amt >= 0.2) return 55;
    if (amt > 0 || sym.includes('rain') || sym.includes('shower') || sym.includes('snow') || sym.includes('thunder')) return 40;
    if (cloud >= 85) return 20;
    if (cloud >= 55) return 10;
    return 0;
  };

  const nowMs = Date.now();
  let curStep = series[0];
  let bestDiff = Infinity;
  for (const item of series.slice(0, 12)) {
    const tMs = Date.parse(item.time);
    const diff = Math.abs(tMs - nowMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      curStep = item;
    }
  }

  const inst = curStep?.data?.instant?.details || {};
  const next1 = curStep?.data?.next_1_hours || curStep?.data?.next_6_hours || {};
  const windKmh = (Number(inst.wind_speed) || 0) * 3.6;
  const gustKmh = typeof inst.wind_speed_of_gust === 'number'
    ? inst.wind_speed_of_gust * 3.6
    : windKmh * 1.35;
  const fogPct = Number(inst.fog_area_fraction) || 0;
  const precipAmt = Number(next1?.details?.precipitation_amount) || 0;

  const hourlyTimes = [];
  const hourlyProbs = [];
  const hourlyTemps = [];
  const hourlyUvs = [];
  const dailyBuckets = new Map();
  for (const step of series) {
    const ms = Date.parse(step.time);
    if (!Number.isFinite(ms)) continue;
    const d = step.data?.instant?.details || {};
    const localIso = toLocalIso(ms);
    const prob = estimateRainProb(step);
    const temp = Number(d.air_temperature ?? 20);
    const nStep = step?.data?.next_1_hours || step?.data?.next_6_hours || step?.data?.next_12_hours || {};
    const wmo = symbolToWmo(nStep?.summary?.symbol_code);
    if (hourlyTimes.length < 48 && step?.data?.next_1_hours) {
      hourlyTimes.push(localIso);
      hourlyProbs.push(prob);
      hourlyTemps.push(temp);
      hourlyUvs.push(Number(d.ultraviolet_index_clear_sky ?? 0));
    }

    const dayKey = localIso.slice(0, 10);
    const hrNum = parseInt(localIso.slice(11, 13), 10) || 0;
    let bucket = dailyBuckets.get(dayKey);
    if (!bucket) {
      bucket = { maxT: -Infinity, minT: Infinity, maxRain: 0, daytimeCode: null, worstCode: 0 };
      dailyBuckets.set(dayKey, bucket);
    }
    if (temp > bucket.maxT) bucket.maxT = temp;
    if (temp < bucket.minT) bucket.minT = temp;
    const n6Max = Number(step?.data?.next_6_hours?.details?.air_temperature_max);
    const n6Min = Number(step?.data?.next_6_hours?.details?.air_temperature_min);
    if (Number.isFinite(n6Max) && n6Max > bucket.maxT) bucket.maxT = n6Max;
    if (Number.isFinite(n6Min) && n6Min < bucket.minT) bucket.minT = n6Min;
    if (prob > bucket.maxRain) bucket.maxRain = prob;
    if (wmo > bucket.worstCode) bucket.worstCode = wmo;
    if (hrNum >= 9 && hrNum <= 15 && bucket.daytimeCode === null) {
      bucket.daytimeCode = wmo;
    }
  }

  let sunriseLocal = `${localToday}T06:00`;
  let sunsetLocal = `${localToday}T18:00`;
  let inferredIsDay = 1;
  const curHr = parseInt(toLocalIso(nowMs).slice(11, 13), 10) || 0;
  inferredIsDay = (curHr >= 6 && curHr < 18) ? 1 : 0;
  if (sunRes.status === 'fulfilled' && sunRes.value?.properties) {
    const props = sunRes.value.properties;
    const srRaw = props.sunrise?.time;
    const ssRaw = props.sunset?.time;
    if (srRaw === null && ssRaw === null) {
      // 極圈永晝或極夜無日出日落時絕不偽造 06:00 / 18:00
      sunriseLocal = '';
      sunsetLocal = '';
      inferredIsDay = props.solarmidday?.visible === false ? 0 : 1;
    } else {
      if (typeof srRaw === 'string') {
        const srMs = Date.parse(srRaw);
        sunriseLocal = Number.isFinite(srMs) ? toLocalIso(srMs) : srRaw.slice(0, 16);
      }
      if (typeof ssRaw === 'string') {
        const ssMs = Date.parse(ssRaw);
        sunsetLocal = Number.isFinite(ssMs) ? toLocalIso(ssMs) : ssRaw.slice(0, 16);
      }
      const srMs = sunriseLocal ? Date.parse(srRaw || '') : NaN;
      const ssMs = sunsetLocal ? Date.parse(ssRaw || '') : NaN;
      if (Number.isFinite(srMs) && Number.isFinite(ssMs)) {
        inferredIsDay = (nowMs >= srMs && nowMs <= ssMs) ? 1 : 0;
      }
    }
  }

  const dailyTimes = [];
  const dailyCodes = [];
  const dailyMaxTemps = [];
  const dailyMinTemps = [];
  const dailyRainProbs = [];
  for (const [dKey, b] of Array.from(dailyBuckets.entries())
    .filter(([dKey]) => dKey >= localToday)
    .sort((a, z) => a[0].localeCompare(z[0]))
    .slice(0, 7)) {
    dailyTimes.push(dKey);
    dailyCodes.push(b.worstCode >= 61 ? b.worstCode : (b.daytimeCode != null ? b.daytimeCode : b.worstCode));
    dailyMaxTemps.push(Number.isFinite(b.maxT) ? +(b.maxT.toFixed(1)) : 24);
    dailyMinTemps.push(Number.isFinite(b.minT) ? +(b.minT.toFixed(1)) : 18);
    dailyRainProbs.push(Math.round(b.maxRain));
  }

  return {
    latitude: lat,
    longitude: lon,
    timezone: tz,
    utc_offset_seconds: Math.round(offsetHours * 3600),
    sourceProvider: 'met-norway-fallback',
    current: {
      time: toLocalIso(Date.parse(curStep.time) || nowMs),
      is_day: inferredIsDay,
      temperature_2m: Number(inst.air_temperature ?? 20),
      relative_humidity_2m: Math.round(Number(inst.relative_humidity ?? 70)),
      apparent_temperature: Number(inst.apparent_air_temperature ?? inst.air_temperature ?? 20),
      precipitation: precipAmt,
      rain: precipAmt,
      showers: 0,
      weather_code: symbolToWmo(next1?.summary?.symbol_code),
      wind_speed_10m: +(windKmh.toFixed(1)),
      wind_direction_10m: Math.round(Number(inst.wind_from_direction ?? 0)),
      wind_gusts_10m: +(gustKmh.toFixed(1)),
      surface_pressure: Number(inst.air_pressure_at_sea_level ?? 1013),
      uv_index: Number(inst.ultraviolet_index_clear_sky ?? 0),
      visibility: Math.round(Math.max(1200, 10000 - fogPct * 160))
    },
    daily: {
      time: dailyTimes,
      weather_code: dailyCodes,
      temperature_2m_max: dailyMaxTemps,
      temperature_2m_min: dailyMinTemps,
      precipitation_probability_max: dailyRainProbs,
      sunrise: [sunriseLocal],
      sunset: [sunsetLocal]
    },
    hourly: {
      time: hourlyTimes,
      precipitation_probability: hourlyProbs,
      temperature_2m: hourlyTemps,
      uv_index: hourlyUvs
    }
  };
}

// 氣象與空氣品質代理 (Open-Meteo 主線路 + MET Norway 官方全球數值預報雙引擎容錯 + 120 秒記憶體快取)
async function handleWeatherProxy(req, res, latRaw, lonRaw, tzRaw) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const lat = parseFloat(latRaw);
  const lon = parseFloat(lonRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    res.writeHead(400);
    res.end(JSON.stringify({ success: false, error: '無效的經緯度參數' }));
    return;
  }

  let tz = 'Asia/Taipei';
  if (typeof tzRaw === 'string' && tzRaw.length > 0 && tzRaw.length <= 60) {
    if (/^auto$/i.test(tzRaw)) {
      tz = 'auto';
    } else if (/^(?:UTC|GMT|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){1,2})$/.test(tzRaw)) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tzRaw });
        tz = tzRaw;
      } catch (_) {}
    }
  }
  const encodedTz = encodeURIComponent(tz);

  const key = `${lat.toFixed(2)},${lon.toFixed(2)},${tz}`;
  const now = Date.now();
  const cached = cache.weatherMap.get(key);
  if (cached && now < cached.expireAt) {
    res.writeHead(200);
    res.end(cached.payload);
    return;
  }

  const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,showers,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,surface_pressure,uv_index,visibility&daily=sunrise,sunset,weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&hourly=precipitation_probability,temperature_2m,uv_index&timezone=${encodedTz}`;
  const aqiUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=us_aqi,european_aqi,pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone&timezone=${encodedTz}`;

  try {
    const [weatherSettled, aqiSettled] = await Promise.allSettled([
      fetchJsonWithRetry(weatherUrl, 0, 3800).catch(() => fetchMetNorwayWeatherFallback(lat, lon, tz)),
      fetchJsonWithRetry(aqiUrl, 1, 4500)
    ]);
    const weather = weatherSettled.status === 'fulfilled' ? weatherSettled.value : null;
    let prevAqi = null;
    if (aqiSettled.status !== 'fulfilled' && cached?.payload) {
      try { prevAqi = JSON.parse(cached.payload)?.airQuality || null; } catch (_) {}
    }
    const airQuality = aqiSettled.status === 'fulfilled' ? aqiSettled.value : prevAqi;
    if (!weather || !weather.current) {
      throw weatherSettled.reason || new Error('主要與備援氣象服務均暫無回應');
    }
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

// ============================================================================
// TWD97 二度分帶 (EPSG:3826, 中央經線 121°E) 轉 WGS84 經緯度精準公式
// ============================================================================
function twd97ToWgs84(xRaw, yRaw) {
  const x = Number(xRaw);
  const y = Number(yRaw);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 100000 || x > 450000 || y < 2350000 || y > 2900000) {
    return null;
  }
  const a = 6378137.0;
  const b = 6356752.314245;
  const lon0 = 121 * Math.PI / 180;
  const k0 = 0.9999;
  const dx = 250000;
  const e = Math.sqrt(1 - (b * b) / (a * a));
  const e2 = (e * e) / (1 - e * e);
  const xAdj = x - dx;
  const M = y / k0;
  const mu = M / (a * (1 - Math.pow(e, 2) / 4 - 3 * Math.pow(e, 4) / 64 - 5 * Math.pow(e, 6) / 256));
  const e1 = (1 - Math.sqrt(1 - e * e)) / (1 + Math.sqrt(1 - e * e));
  const J1 = (3 * e1 / 2 - 27 * Math.pow(e1, 3) / 32);
  const J2 = (21 * Math.pow(e1, 2) / 16 - 55 * Math.pow(e1, 4) / 32);
  const J3 = (151 * Math.pow(e1, 3) / 96);
  const J4 = (1097 * Math.pow(e1, 4) / 512);
  const fp = mu + J1 * Math.sin(2 * mu) + J2 * Math.sin(4 * mu) + J3 * Math.sin(6 * mu) + J4 * Math.sin(8 * mu);
  const sinFp = Math.sin(fp);
  const cosFp = Math.cos(fp);
  const tanFp = Math.tan(fp);
  const C1 = e2 * cosFp * cosFp;
  const T1 = tanFp * tanFp;
  const R1 = a * (1 - e * e) / Math.pow(1 - e * e * sinFp * sinFp, 1.5);
  const N1 = a / Math.sqrt(1 - e * e * sinFp * sinFp);
  const D = xAdj / (N1 * k0);
  const Q1 = N1 * tanFp / R1;
  const Q2 = (D * D / 2);
  const Q3 = (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * e2) * Math.pow(D, 4) / 24;
  const Q4 = (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 3 * C1 * C1 - 252 * e2) * Math.pow(D, 6) / 720;
  const lat = (fp - Q1 * (Q2 - Q3 + Q4)) * 180 / Math.PI;
  const Q5 = D;
  const Q6 = (1 + 2 * T1 + C1) * Math.pow(D, 3) / 6;
  const Q7 = (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * e2 + 24 * T1 * T1) * Math.pow(D, 5) / 120;
  const lon = (lon0 + (Q5 - Q6 + Q7) / cosFp) * 180 / Math.PI;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat: +lat.toFixed(6), lon: +lon.toFixed(6) };
}

const BUILT_IN_TRA_STATIONS = [
  { stationId: '0900', name: '基隆', lat: 25.1341, lon: 121.7399, address: '基隆市仁愛區港西街5號' },
  { stationId: '0920', name: '八堵', lat: 25.1084, lon: 121.7290, address: '基隆市暖暖區八堵路142號' },
  { stationId: '0930', name: '七堵', lat: 25.0929, lon: 121.7142, address: '基隆市七堵區東新街2號' },
  { stationId: '0960', name: '汐止', lat: 25.0689, lon: 121.6612, address: '新北市汐止區信義路1號' },
  { stationId: '0980', name: '南港', lat: 25.0531, lon: 121.6071, address: '臺北市南港區南港路一段313號' },
  { stationId: '0990', name: '松山', lat: 25.0494, lon: 121.5783, address: '臺北市信義區松山路11號' },
  { stationId: '1000', name: '臺北', lat: 25.0479, lon: 121.5171, address: '臺北市中正區北平西路3號' },
  { stationId: '1010', name: '萬華', lat: 25.0334, lon: 121.5003, address: '臺北市萬華區康定路382號' },
  { stationId: '1020', name: '板橋', lat: 25.0143, lon: 121.4638, address: '新北市板橋區縣民大道二段7號' },
  { stationId: '1030', name: '浮洲', lat: 25.0042, lon: 121.4447, address: '新北市板橋區大觀路二段' },
  { stationId: '1040', name: '樹林', lat: 24.9912, lon: 121.4244, address: '新北市樹林區鎮前街112號' },
  { stationId: '1050', name: '南樹林', lat: 24.9803, lon: 121.4089, address: '新北市樹林區中山路二段230號' },
  { stationId: '1060', name: '山佳', lat: 24.9723, lon: 121.3926, address: '新北市樹林區山佳街28號' },
  { stationId: '1070', name: '鶯歌', lat: 24.9547, lon: 121.3556, address: '新北市鶯歌區文化路68號' },
  { stationId: '1075', name: '鳳鳴', lat: 24.9708, lon: 121.3323, address: '新北市鶯歌區大湖路700號' },
  { stationId: '1080', name: '桃園', lat: 24.9892, lon: 121.3135, address: '桃園市桃園區中正路1號' },
  { stationId: '1090', name: '內壢', lat: 24.9728, lon: 121.2582, address: '桃園市中壢區中華路一段267號' },
  { stationId: '1100', name: '中壢', lat: 24.9537, lon: 121.2256, address: '桃園市中壢區中和路139號' },
  { stationId: '1110', name: '埔心', lat: 24.9194, lon: 121.1837, address: '桃園市楊梅區永美路208號' },
  { stationId: '1120', name: '楊梅', lat: 24.9143, lon: 121.1462, address: '桃園市楊梅區大成路256號' },
  { stationId: '1130', name: '富岡', lat: 24.9344, lon: 121.0831, address: '桃園市楊梅區成功路37號' },
  { stationId: '1160', name: '湖口', lat: 24.9029, lon: 121.0442, address: '新竹縣湖口鄉仁勢村中山路二段121號' },
  { stationId: '1170', name: '新豐', lat: 24.8696, lon: 120.9963, address: '新竹縣新豐鄉新興路202號' },
  { stationId: '1180', name: '竹北', lat: 24.8390, lon: 121.0094, address: '新竹縣竹北市和平街59號' },
  { stationId: '1190', name: '北新竹', lat: 24.8087, lon: 120.9839, address: '新竹市東區中華路一段291之2號' },
  { stationId: '1210', name: '新竹', lat: 24.8016, lon: 120.9716, address: '新竹市東區中華路二段445號' },
  { stationId: '1220', name: '三姓橋', lat: 24.7875, lon: 120.9288, address: '新竹市香山區元培街32巷30號' },
  { stationId: '1230', name: '香山', lat: 24.7631, lon: 120.9142, address: '新竹市香山區中華路五段347巷2弄27號' },
  { stationId: '1250', name: '竹南', lat: 24.6865, lon: 120.8808, address: '苗栗縣竹南鎮中山路166號' },
  { stationId: '3160', name: '苗栗', lat: 24.5700, lon: 120.8224, address: '苗栗縣苗栗市為公路1號' },
  { stationId: '3230', name: '豐原', lat: 24.2541, lon: 120.7229, address: '臺中市豐原區中正路1之1號' },
  { stationId: '3300', name: '臺中', lat: 24.1368, lon: 120.6850, address: '臺中市中區臺灣大道一段1號' },
  { stationId: '3340', name: '新烏日', lat: 24.1095, lon: 120.6143, address: '臺中市烏日區高鐵東一路26號' },
  { stationId: '3360', name: '彰化', lat: 24.0818, lon: 120.5385, address: '彰化縣彰化市三民路1號' },
  { stationId: '3390', name: '員林', lat: 23.9593, lon: 120.5698, address: '彰化縣員林市民權街55號' },
  { stationId: '3470', name: '斗六', lat: 23.7118, lon: 120.5411, address: '雲林縣斗六市民生路187號' },
  { stationId: '4080', name: '嘉義', lat: 23.4791, lon: 120.4411, address: '嘉義市西區中山路528號' },
  { stationId: '4120', name: '新營', lat: 23.3067, lon: 120.3228, address: '臺南市新營區中山路1號' },
  { stationId: '4220', name: '臺南', lat: 22.9971, lon: 120.2129, address: '臺南市東區北門路二段4號' },
  { stationId: '4272', name: '沙崙', lat: 22.9242, lon: 120.2863, address: '臺南市歸仁區歸仁大道102號' },
  { stationId: '4310', name: '岡山', lat: 22.7922, lon: 120.3001, address: '高雄市岡山區岡燕路111號' },
  { stationId: '4340', name: '新左營', lat: 22.6874, lon: 120.3075, address: '高雄市左營區站前北路1號' },
  { stationId: '4400', name: '高雄', lat: 22.6396, lon: 120.3026, address: '高雄市三民區建國二路318號' },
  { stationId: '4440', name: '鳳山', lat: 22.6311, lon: 120.3578, address: '高雄市鳳山區曹公路68號' },
  { stationId: '5000', name: '屏東', lat: 22.6691, lon: 120.4862, address: '屏東縣屏東市公勇路62號' },
  { stationId: '5050', name: '潮州', lat: 22.5501, lon: 120.5363, address: '屏東縣潮州鎮信義路111號' },
  { stationId: '7360', name: '瑞芳', lat: 25.1089, lon: 121.8062, address: '新北市瑞芳區明燈路三段82號' },
  { stationId: '7230', name: '頭城', lat: 24.8590, lon: 121.8226, address: '宜蘭縣頭城鎮纘祥路59號' },
  { stationId: '7210', name: '礁溪', lat: 24.8270, lon: 121.7753, address: '宜蘭縣礁溪鄉溫泉路1號' },
  { stationId: '7190', name: '宜蘭', lat: 24.7546, lon: 121.7582, address: '宜蘭縣宜蘭市光復路1號' },
  { stationId: '7160', name: '羅東', lat: 24.6779, lon: 121.7745, address: '宜蘭縣羅東鎮公正路2號' },
  { stationId: '7130', name: '蘇澳新', lat: 24.6091, lon: 121.8271, address: '宜蘭縣蘇澳鎮中山路二段238巷1號' },
  { stationId: '7120', name: '蘇澳', lat: 24.5952, lon: 121.8514, address: '宜蘭縣蘇澳鎮太平路1號' },
  { stationId: '7000', name: '花蓮', lat: 23.9928, lon: 121.6014, address: '花蓮縣花蓮市國聯一路100號' },
  { stationId: '6250', name: '吉安', lat: 23.9682, lon: 121.5835, address: '花蓮縣吉安鄉南昌村文化街200號' },
  { stationId: '6240', name: '志學', lat: 23.9073, lon: 121.5295, address: '花蓮縣壽豐鄉志學村中正路1號' },
  { stationId: '6230', name: '壽豐', lat: 23.8691, lon: 121.5106, address: '花蓮縣壽豐鄉壽豐村壽山路1號' },
  { stationId: '6130', name: '瑞穗', lat: 23.4975, lon: 121.3768, address: '花蓮縣瑞穗鄉瑞美村四維街13號' },
  { stationId: '6110', name: '玉里', lat: 23.3316, lon: 121.3117, address: '花蓮縣玉里鎮康樂街39號' },
  { stationId: '6050', name: '池上', lat: 23.1260, lon: 121.2192, address: '臺東縣池上鄉福文村鐵花路30號' },
  { stationId: '6030', name: '關山', lat: 23.0457, lon: 121.1643, address: '臺東縣關山鎮博愛路2號' },
  { stationId: '6000', name: '臺東', lat: 22.7937, lon: 121.1232, address: '臺東縣臺東市岩灣路101巷598號' }
];

function normalizeTraTrainType(rawType) {
  const s = String(rawType || '').trim();
  if (!s) return '區間';
  if (s.includes('3000') || s === '110G' || s === '110H' || s === '110K' || s === '110M') return '新自強';
  if (s.includes('普悠瑪') || s === '1107') return '普悠瑪';
  if (s.includes('太魯閣') || /^110[6A-F]$/i.test(s)) return '太魯閣';
  if (s.includes('區間快') || s === '1132') return '區間快';
  if (s.includes('區間') || s === '1131' || /^113/.test(s)) return '區間';
  if (s.includes('自強') || /^110/.test(s)) return '自強';
  if (s.includes('莒光') || /^111/.test(s)) return '莒光';
  return s.replace(/\(.*?\)/g, '').trim().slice(0, 5) || '區間';
}

// 台鐵最近車站空間檢索與即時誤點列車看板 (/api/rail/tra-nearby)
async function handleTraNearbyProxy(req, res, parsedUrl) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const lat = parseFloat(parsedUrl.searchParams.get('lat'));
  const lon = parseFloat(parsedUrl.searchParams.get('lon'));
  const reqIdx = Math.max(0, Math.min(3, parseInt(parsedUrl.searchParams.get('stationIdx') || '0', 10) || 0));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    res.writeHead(400);
    res.end(JSON.stringify({ success: false, error: '無效的經緯度參數' }));
    return;
  }

  const cacheKey = `${lat.toFixed(3)},${lon.toFixed(3)},${reqIdx}`;
  const now = Date.now();
  const cached = cache.traNearbyMap.get(cacheKey);
  if (cached && now < cached.expireAt) {
    res.writeHead(200);
    res.end(cached.payload);
    return;
  }

  try {
    const stations = BUILT_IN_TRA_STATIONS
      .map(st => ({
        stationId: st.stationId,
        name: st.name,
        address: st.address,
        lat: st.lat,
        lon: st.lon,
        distMeters: calcDistanceMeters(lat, lon, st.lat, st.lon)
      }))
      .filter(st => st.distMeters <= 10500)
      .sort((a, b) => a.distMeters - b.distMeters)
      .slice(0, 4);

    if (stations.length === 0) {
      const emptyPayload = JSON.stringify({
        success: true,
        stations: [],
        activeStationIndex: 0,
        station: null,
        trains: [],
        updateTimeDisplay: getTaiwanTimeHHMMSS()
      });
      setBoundedMap(cache.traNearbyMap, cacheKey, { payload: emptyPayload, expireAt: now + 30000 }, 120);
      res.writeHead(200);
      res.end(emptyPayload);
      return;
    }

    const activeIdx = Math.min(reqIdx, stations.length - 1);
    const activeStation = stations[activeIdx];
    const sid = activeStation.stationId;
    const sName = activeStation.name;
    const isEastTrunk = /^[67]\d{3}$/.test(sid);

    const twNowStr = getTaiwanTimeHHMMSS();
    const [curH, curM, curS] = twNowStr.split(':').map(n => parseInt(n, 10) || 0);
    const curTotalSec = curH * 3600 + curM * 60 + curS;

    const [liveHtmlRes, transitousRes] = await Promise.allSettled([
      fetchRemoteHtml(`https://www.opendata.vip/tdx/trainLiveBoard/${encodeURIComponent(sid)}`, 5500),
      fetch(`https://api.transitous.org/api/v1/stoptimes?stopId=tw-taiwan-tdx_TRA_${encodeURIComponent(sid)}&n=24`, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'TaiwanNeighborhoodMonitor/2.0' },
        signal: AbortSignal.timeout(5500)
      }).then(r => r.ok ? r.json() : null)
    ]);

    const liveDelayMap = new Map();
    const trainsMap = new Map();

    // 1. 解析 opendata.vip TDX 即時到離站看板 HTML (含即時晚 N 分誤點)
    if (liveHtmlRes.status === 'fulfilled' && liveHtmlRes.value) {
      const tbody = (liveHtmlRes.value.match(/<table class="tlb-table">[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/i) || [])[1] || '';
      const rowMatches = [...tbody.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)].map(m => m[1]);
      for (const rowHtml of rowMatches) {
        const depTime = (rowHtml.match(/<span class="tlb-time">(\d{2}:\d{2})<\/span>/) || [])[1] || '';
        const trainNo = (rowHtml.match(/trainTodayInfo\/(\d+)/) || [])[1] || '';
        const rawType = (rowHtml.match(/<span class="tlb-type"[^>]*>([^<]+)<\/span>/) || [])[1] || '';
        const destMatch = rowHtml.match(/trainLiveBoard\/(\d+)">([^<]+)<\/a>/);
        const endId = destMatch ? destMatch[1].trim() : '';
        const endName = destMatch ? destMatch[2].trim() : '';
        const badgeText = ((rowHtml.match(/<span class="tlb-badge[^"]*">([^<]+)<\/span>/) || [])[1] || '').trim();
        const lateM = badgeText.match(/晚\s*(\d+)\s*分/);
        const delayMin = lateM ? parseInt(lateM[1], 10) : 0;
        if (!trainNo || !depTime || endId === sid || endName === sName) continue;
        liveDelayMap.set(trainNo, delayMin);

        const [sh, sm] = depTime.split(':').map(n => parseInt(n, 10) || 0);
        let diffSec = (sh * 60 + sm + delayMin) * 60 - curTotalSec;
        if (diffSec < -43200) diffSec += 86400;
        if (diffSec > 43200) diffSec -= 86400;
        if (diffSec < -60 || diffSec > 21600) continue;
        const dirNum = (endId && parseInt(endId, 10) < parseInt(sid, 10)) ? 0 : 1;
        // 東部幹線 (宜蘭/北迴/臺東 6xxx/7xxx) Direction 0(順行)為南下、1(逆行)為北上；西部幹線 0(順行)為北上、1(逆行)為南下
        const directionLabel = isEastTrunk
          ? (dirNum === 0 ? '南下' : '北上')
          : (dirNum === 0 ? '北上' : '南下');
        const clampedSec = Math.max(0, diffSec);
        trainsMap.set(trainNo, {
          trainNo,
          trainType: normalizeTraTrainType(rawType),
          direction: dirNum,
          directionLabel,
          destination: endName,
          depTime,
          delayMin,
          remainMin: Math.floor(clampedSec / 60),
          remainSec: clampedSec
        });
      }
    }

    // 2. 融合 Transitous 台灣 TDX GTFS 時刻表 (補充跨夜與後續即將發車班次)
    if (transitousRes.status === 'fulfilled' && Array.isArray(transitousRes.value?.stopTimes)) {
      for (const st of transitousRes.value.stopTimes) {
        const rm = String(st.routeId || '').match(/TRA_(\d+)_([01])_([A-Za-z0-9]+)/);
        const trainNo = rm ? rm[1] : String(st.tripShortName || '').trim();
        if (!trainNo) continue;
        const endName = String(st.headsign || st.tripTo?.name || '').trim().replace(/臺/g, '台');
        if (!endName || endName === sName.replace(/臺/g, '台')) continue;
        const depIso = st.place?.departure || st.place?.scheduledDeparture || st.place?.arrival;
        const depMs = depIso ? Date.parse(depIso) : NaN;
        if (!Number.isFinite(depMs)) continue;
        const delayMin = liveDelayMap.get(trainNo) || 0;
        const remainSec = Math.max(0, Math.round((depMs + delayMin * 60000 - Date.now()) / 1000));
        if (remainSec > 32400) continue;
        const twDep = new Date(depMs + 8 * 3600000).toISOString().slice(11, 16);
        const dirNum = rm ? (parseInt(rm[2], 10) || 0) : (Number(st.directionId) === 1 ? 1 : 0);
        const directionLabel = isEastTrunk
          ? (dirNum === 0 ? '南下' : '北上')
          : (dirNum === 0 ? '北上' : '南下');
        if (!trainsMap.has(trainNo)) {
          trainsMap.set(trainNo, {
            trainNo,
            trainType: normalizeTraTrainType(rm ? rm[3] : ''),
            direction: dirNum,
            directionLabel,
            destination: endName,
            depTime: twDep,
            delayMin,
            remainMin: Math.floor(remainSec / 60),
            remainSec
          });
        } else {
          const existing = trainsMap.get(trainNo);
          existing.direction = dirNum;
          existing.directionLabel = directionLabel;
        }
      }
    }

    const trains = [...trainsMap.values()].sort((a, b) => a.remainSec - b.remainSec);
    const payload = JSON.stringify({
      success: true,
      stations,
      activeStationIndex: activeIdx,
      station: activeStation,
      trains: trains.slice(0, 14),
      updateTimeDisplay: twNowStr
    });
    setBoundedMap(cache.traNearbyMap, cacheKey, { payload, expireAt: now + 20000 }, 150);
    res.writeHead(200);
    res.end(payload);
  } catch (err) {
    if (cached && cached.payload) {
      res.writeHead(200);
      res.end(cached.payload);
      return;
    }
    res.writeHead(502);
    res.end(JSON.stringify({ success: false, error: '無法取得台鐵即時列車動態', detail: err.message }));
  }
}

function summarizeParkingFare(rawFare) {
  const s = String(rawFare || '').replace(/\s+/g, ' ').trim();
  if (!s) return '依現場公告計費';
  const mHr = s.match(/(\d{2,3})\s*元?\s*\/\s*(?:小時|時|hr)/i) || s.match(/(?:臨停|計時|小型車)[^0-9]{0,6}(\d{2,3})\s*元/i);
  if (mHr) return `約 ${mHr[1]} 元/時`;
  return s.length > 26 ? `${s.slice(0, 26)}…` : s;
}

function decodeXmlEntities(str) {
  return String(str || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => {
      const code = parseInt(d, 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : '';
    })
    .trim();
}

function parseTycgParkingXml(xmlText) {
  const lots = [];
  const blockRegex = /<parkingLot>([\s\S]*?)<\/parkingLot>/gi;
  const pickTag = (src, tag) => {
    const m = src.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return m ? decodeXmlEntities(m[1]) : '';
  };
  let m;
  while ((m = blockRegex.exec(String(xmlText || ''))) !== null) {
    const blk = m[1];
    let wgsX = parseFloat(pickTag(blk, 'wgsX'));
    let wgsY = parseFloat(pickTag(blk, 'wgsY'));
    if (!Number.isFinite(wgsX) || !Number.isFinite(wgsY)) continue;
    // 防禦桃園市政府開放資料 XML 欄位命名：<wgsX> 實為緯度 (~24.9)、<wgsY> 實為經度 (~121.2)
    const lat = wgsX <= 90 ? wgsX : wgsY;
    const lon = wgsX <= 90 ? wgsY : wgsX;
    if (lat < 21.5 || lat > 26.5 || lon < 119.0 || lon > 122.5) continue;

    const surplusRaw = pickTag(blk, 'surplusSpace');
    const total = parseInt(pickTag(blk, 'totalSpace'), 10) || 0;
    let available = -1;
    if (/已滿|滿車/.test(surplusRaw)) available = 0;
    else if (/^\d+$/.test(surplusRaw)) available = parseInt(surplusRaw, 10);
    if (available < 0 || total <= 0) continue;

    const area = pickTag(blk, 'areaName');
    const name = pickTag(blk, 'parkName');
    if (!name) continue;
    lots.push({
      id: `TY_${pickTag(blk, 'parkId') || name}`,
      city: '桃園市',
      area,
      name,
      address: pickTag(blk, 'address'),
      fare: summarizeParkingFare(pickTag(blk, 'payGuide')),
      available,
      total,
      lat: +lat.toFixed(6),
      lon: +lon.toFixed(6)
    });
  }
  return lots;
}

// 周邊路外停車場即時剩餘空位整合代理 (/api/parking/nearby)
async function handleParkingNearbyProxy(req, res, parsedUrl) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const lat = parseFloat(parsedUrl.searchParams.get('lat'));
  const lon = parseFloat(parsedUrl.searchParams.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    res.writeHead(400);
    res.end(JSON.stringify({ success: false, error: '無效的經緯度參數' }));
    return;
  }

  const cacheKey = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const now = Date.now();
  const cached = cache.parkingNearbyMap.get(cacheKey);
  if (cached && now < cached.expireAt) {
    res.writeHead(200);
    res.end(cached.payload);
    return;
  }

  const inNorthMetroBox = lat >= 24.75 && lat <= 25.32 && lon >= 120.98 && lon <= 122.02;
  const needTaipeiNtpc = inNorthMetroBox && lon >= 121.32;
  const needTaoyuan = inNorthMetroBox && lon <= 121.48;

  try {
    const pool = [];

    // 1. 臺北市與新北市官方路外停車場即時剩餘車位
    if (needTaipeiNtpc) {
      const loadTaipei = async () => {
        if (!cache.parkingStatic.taipei || now >= cache.parkingStatic.taipeiExp) {
          const descJson = await fetchJsonWithRetry('https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_alldesc.json', 0, 6500);
          const map = new Map();
          for (const p of (descJson?.data?.park || [])) {
            if (!p?.id || !p?.name) continue;
            let coord = twd97ToWgs84(p.tw97x, p.tw97y);
            if (!coord && Array.isArray(p?.EntranceCoord?.EntrancecoordInfo) && p.EntranceCoord.EntrancecoordInfo[0]) {
              const ec = p.EntranceCoord.EntrancecoordInfo[0];
              const xRaw = parseFloat(ec.Xcod);
              const yRaw = parseFloat(ec.Ycod);
              if (Number.isFinite(xRaw) && Number.isFinite(yRaw)) {
                const cLat = xRaw <= 90 ? xRaw : yRaw;
                const cLon = xRaw <= 90 ? yRaw : xRaw;
                if (cLat >= 21.5 && cLat <= 26.5 && cLon >= 119.0 && cLon <= 122.5) {
                  coord = { lat: +cLat.toFixed(6), lon: +cLon.toFixed(6) };
                }
              }
            }
            if (!coord) continue;
            map.set(String(p.id), {
              id: `TPE_${p.id}`,
              city: '臺北市',
              area: String(p.area || ''),
              name: String(p.name).trim(),
              address: String(p.address || '').trim(),
              fare: summarizeParkingFare(p.payex),
              total: Math.max(0, parseInt(p.totalcar, 10) || 0),
              lat: coord.lat,
              lon: coord.lon
            });
          }
          if (map.size > 0) {
            cache.parkingStatic.taipei = map;
            cache.parkingStatic.taipeiExp = now + 6 * 3600000;
          }
        }
        if (!cache.parkingLive.taipei || now >= cache.parkingLive.taipeiExp) {
          const availJson = await fetchJsonWithRetry('https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.json', 0, 5500);
          const availMap = new Map();
          for (const a of (availJson?.data?.park || [])) {
            const av = parseInt(a?.availablecar, 10);
            if (a?.id && Number.isFinite(av) && av >= 0) {
              availMap.set(String(a.id), av);
            }
          }
          if (availMap.size > 0) {
            cache.parkingLive.taipei = availMap;
            cache.parkingLive.taipeiExp = now + 35000;
          }
        }
        if (cache.parkingStatic.taipei && cache.parkingLive.taipei) {
          for (const [id, meta] of cache.parkingStatic.taipei.entries()) {
            if (!cache.parkingLive.taipei.has(id)) continue;
            const dMeters = calcDistanceMeters(lat, lon, meta.lat, meta.lon);
            if (dMeters <= 2500) {
              pool.push({ ...meta, available: cache.parkingLive.taipei.get(id), distMeters: dMeters });
            }
          }
        }
      };

      const loadNtpc = async () => {
        if (!cache.parkingStatic.ntpc || now >= cache.parkingStatic.ntpcExp) {
          const [p0, p1] = await Promise.all([
            fetchJsonWithRetry('https://data.ntpc.gov.tw/api/datasets/B1464EF0-9C7C-4A6F-ABF7-6BDF32847E68/json?page=0&size=1000', 0, 6500).catch(() => []),
            fetchJsonWithRetry('https://data.ntpc.gov.tw/api/datasets/B1464EF0-9C7C-4A6F-ABF7-6BDF32847E68/json?page=1&size=1000', 0, 6500).catch(() => [])
          ]);
          const map = new Map();
          for (const p of [...(Array.isArray(p0) ? p0 : []), ...(Array.isArray(p1) ? p1 : [])]) {
            if (!p?.ID || !p?.NAME) continue;
            const coord = twd97ToWgs84(p.TW97X, p.TW97Y);
            if (!coord) continue;
            map.set(String(p.ID), {
              id: `NTPC_${p.ID}`,
              city: '新北市',
              area: String(p.AREA || ''),
              name: String(p.NAME).trim(),
              address: String(p.ADDRESS || '').trim(),
              fare: summarizeParkingFare(p.PAYEX),
              total: Math.max(0, parseInt(p.TOTALCAR, 10) || 0),
              lat: coord.lat,
              lon: coord.lon
            });
          }
          if (map.size > 0 && (!cache.parkingStatic.ntpc || map.size >= cache.parkingStatic.ntpc.size * 0.5)) {
            cache.parkingStatic.ntpc = map;
            cache.parkingStatic.ntpcExp = now + 6 * 3600000;
          }
        }
        if (!cache.parkingLive.ntpc || now >= cache.parkingLive.ntpcExp) {
          const [a0, a1] = await Promise.all([
            fetchJsonWithRetry('https://data.ntpc.gov.tw/api/datasets/E09B35A5-A738-48CC-B0F5-570B67AD9C78/json?page=0&size=1000', 0, 5500).catch(() => []),
            fetchJsonWithRetry('https://data.ntpc.gov.tw/api/datasets/E09B35A5-A738-48CC-B0F5-570B67AD9C78/json?page=1&size=1000', 0, 5500).catch(() => [])
          ]);
          const availMap = new Map(cache.parkingLive.ntpc instanceof Map && (!Array.isArray(a0) || a0.length === 0 || !Array.isArray(a1) || a1.length === 0)
            ? cache.parkingLive.ntpc.entries()
            : []);
          let freshCount = 0;
          for (const a of [...(Array.isArray(a0) ? a0 : []), ...(Array.isArray(a1) ? a1 : [])]) {
            const av = parseInt(a?.AVAILABLECAR, 10);
            if (a?.ID && Number.isFinite(av) && av >= 0) {
              availMap.set(String(a.ID), av);
              freshCount++;
            }
          }
          if (freshCount > 0) {
            cache.parkingLive.ntpc = availMap;
            cache.parkingLive.ntpcExp = now + 35000;
          }
        }
        if (cache.parkingStatic.ntpc && cache.parkingLive.ntpc) {
          for (const [id, meta] of cache.parkingStatic.ntpc.entries()) {
            if (!cache.parkingLive.ntpc.has(id)) continue;
            const dMeters = calcDistanceMeters(lat, lon, meta.lat, meta.lon);
            if (dMeters <= 2500) {
              pool.push({ ...meta, available: cache.parkingLive.ntpc.get(id), distMeters: dMeters });
            }
          }
        }
      };

      await Promise.allSettled([loadTaipei(), loadNtpc()]);
    }

    // 2. 桃園市官方路外停車場即時剩餘車位 XML + 高鐵桃園／板橋站專屬即時停車場
    if (needTaoyuan) {
      try {
        if (!cache.parkingLive.tycg || now >= cache.parkingLive.tycgExp) {
          const tyXmlUrl = 'https://opendata.tycg.gov.tw/api/dataset/f4cc0b12-86ac-40f9-8745-885bddc18f79/resource/0daad6e6-0632-44f5-bd25-5e1de1e9146f/download';
          const xmlRes = await fetch(tyXmlUrl, { signal: AbortSignal.timeout(6000) });
          if (xmlRes.ok) {
            const xmlText = await xmlRes.text();
            const parsedLots = parseTycgParkingXml(xmlText);
            if (parsedLots.length > 0) {
              cache.parkingLive.tycg = parsedLots;
              cache.parkingLive.tycgExp = now + 40000;
            }
          }
        }
        for (const lot of (cache.parkingLive.tycg || [])) {
          const dMeters = calcDistanceMeters(lat, lon, lot.lat, lot.lon);
          if (dMeters <= 2600) {
            pool.push({ ...lot, distMeters: dMeters });
          }
        }
      } catch (_) {}
    }

    // 3. 高鐵桃園站 P1/P2/P3 與板橋站即時剩餘車位補充
    if (inNorthMetroBox) {
      try {
        let thsrLots = [];
        if (cache.parkingThsr.data && now < cache.parkingThsr.expireAt) {
          try { thsrLots = JSON.parse(cache.parkingThsr.data)?.lots || []; } catch (_) {}
        }
        if (!thsrLots.length) {
          thsrLots = await fetchThsrParkingData();
          if (thsrLots.length > 0) {
            cache.parkingThsr = {
              data: JSON.stringify({ success: true, updatedAt: new Date().toISOString(), lots: thsrLots }),
              expireAt: now + 20000
            };
          }
        }
        for (const tl of (Array.isArray(thsrLots) ? thsrLots : [])) {
          const isTy = tl.name.includes('桃園');
          const tLat = isTy ? 25.0134 : 25.0141;
          const tLon = isTy ? 121.2148 : 121.4638;
          const dMeters = calcDistanceMeters(lat, lon, tLat, tLon);
          if (dMeters <= 2600) {
            const dup = pool.some(p => p.name.includes(tl.name.replace(/\s+/g, '')) && Math.abs(p.distMeters - dMeters) < 250);
            if (!dup) {
              pool.push({
                id: `THSR_${tl.name}`,
                city: isTy ? '桃園高鐵' : '板橋高鐵',
                area: isTy ? '中壢青埔' : '板橋特區',
                name: tl.name,
                address: isTy ? '高鐵北路一段 (高鐵桃園站特區)' : '縣民大道二段7號',
                fare: '高鐵轉乘計時收費',
                available: Math.max(0, Number(tl.available) || 0),
                total: Math.max(0, Number(tl.total) || 0),
                lat: tLat,
                lon: tLon,
                distMeters: dMeters
              });
            }
          }
        }
      } catch (_) {}
    }

    pool.sort((a, b) => a.distMeters - b.distMeters);
    const payload = JSON.stringify({
      success: true,
      coverageSupported: inNorthMetroBox,
      lots: pool.slice(0, 10),
      updateTimeDisplay: getTaiwanTimeHHMMSS()
    });
    setBoundedMap(cache.parkingNearbyMap, cacheKey, { payload, expireAt: now + 25000 }, 150);
    res.writeHead(200);
    res.end(payload);
  } catch (err) {
    res.writeHead(502);
    res.end(JSON.stringify({ success: false, error: '無法取得周邊停車場即時空位', detail: err.message }));
  }
}

function classifyFreewaySpeed(speedKmh) {
  const sp = Math.round(Number(speedKmh) || 0);
  if (sp >= 80) return { level: 'ok', text: '順暢' };
  if (sp >= 60) return { level: 'busy', text: '車多' };
  if (sp >= 40) return { level: 'slow', text: '壅塞' };
  if (sp >= 20) return { level: 'jam', text: '嚴重' };
  return { level: 'gridlock', text: '紫爆' };
}

// 國道高公局即時路段車速與壅塞指標代理 (/api/freeway/live)
async function handleFreewayLiveProxy(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const now = Date.now();
  if (cache.freewayLive.data && now < cache.freewayLive.expireAt) {
    res.writeHead(200);
    res.end(cache.freewayLive.data);
    return;
  }

  try {
    if (!cache.freewaySections.data || now >= cache.freewaySections.expireAt) {
      const secMap = new Map();
      try {
        const secXml = await fetchRemoteText('https://tisvcloud.freeway.gov.tw/history/motc20/Section.xml', 'application/xml, text/xml, */*', 6000);
        const secBlocks = secXml.match(/<Section>[\s\S]*?<\/Section>/g) || [];
        for (const b of secBlocks) {
          const sid = (b.match(/<SectionID>([^<]+)<\/SectionID>/) || [])[1]?.trim();
          const sname = (b.match(/<SectionName>([^<]+)<\/SectionName>/) || [])[1]?.trim();
          if (!sid || !sname) continue;
          secMap.set(sid, {
            sectionId: sid,
            name: sname,
            roadName: ((b.match(/<RoadName>([^<]+)<\/RoadName>/) || [])[1] || '').trim(),
            dir: ((b.match(/<RoadDirection>([^<]+)<\/RoadDirection>/) || [])[1] || '').trim(),
            speedLimit: parseInt(((b.match(/<SpeedLimit>([^<]+)<\/SpeedLimit>/) || [])[1] || '100'), 10) || 100
          });
        }
      } catch (_) {}
      if (secMap.size === 0) {
        const secResp = await fetchTdxProxyJson('/v2/Road/Traffic/Section/Freeway', {
          '$select': 'SectionID,SectionName,RoadID,RoadName,RoadDirection,SpeedLimit',
          '$format': 'JSON'
        }, 6500);
        const secArr = Array.isArray(secResp?.Sections) ? secResp.Sections : (Array.isArray(secResp) ? secResp : []);
        for (const s of (Array.isArray(secArr) ? secArr : [])) {
          if (!s?.SectionID || !s?.SectionName) continue;
          secMap.set(String(s.SectionID), {
            sectionId: String(s.SectionID),
            name: String(s.SectionName).trim(),
            roadName: String(s.RoadName || '').trim(),
            dir: String(s.RoadDirection || '').trim(),
            speedLimit: parseInt(s.SpeedLimit, 10) || 100
          });
        }
      }
      if (secMap.size > 0) {
        cache.freewaySections = { data: secMap, expireAt: now + 6 * 3600000 };
      }
    }

    let liveList = [];
    try {
      const liveXml = await fetchRemoteText('https://tisvcloud.freeway.gov.tw/history/motc20/LiveTraffic.xml', 'application/xml, text/xml, */*', 6000);
      const liveBlocks = liveXml.match(/<LiveTraffic>[\s\S]*?<\/LiveTraffic>/g) || [];
      for (const b of liveBlocks) {
        const SectionID = (b.match(/<SectionID>([^<]+)<\/SectionID>/) || [])[1]?.trim();
        const TravelSpeed = (b.match(/<TravelSpeed>([^<]+)<\/TravelSpeed>/) || [])[1]?.trim();
        const CongestionLevel = (b.match(/<CongestionLevel>([^<]+)<\/CongestionLevel>/) || [])[1]?.trim();
        if (SectionID) liveList.push({ SectionID, TravelSpeed, CongestionLevel });
      }
    } catch (_) {}
    if (liveList.length === 0) {
      const liveResp = await fetchTdxProxyJson('/v2/Road/Traffic/Live/Freeway', {
        '$format': 'JSON'
      }, 6500);
      liveList = Array.isArray(liveResp?.LiveTraffics)
        ? liveResp.LiveTraffics
        : (Array.isArray(liveResp) ? liveResp : []);
    }
    const secMap = cache.freewaySections.data || new Map();

    const allValid = [];
    for (const item of liveList) {
      const sid = String(item?.SectionID || '');
      const sp = Number(item?.TravelSpeed);
      const cLvl = String(item?.CongestionLevel ?? '');
      // TDX 無偵測器或無資料路段常回傳 0 / -99，必須過濾以免誤判 0km/h 紫爆並拖垮走廊車速
      if (!sid || !Number.isFinite(sp) || sp <= 0 || sp > 155 || cLvl === '0' || cLvl === '-99') continue;
      const meta = secMap.get(sid);
      if (!meta) continue;
      const cls = classifyFreewaySpeed(sp);
      allValid.push({
        sectionId: sid,
        name: meta.name,
        roadName: meta.roadName,
        dir: meta.dir,
        speed: Math.round(sp),
        level: cls.level,
        statusText: cls.text
      });
    }

    // 精選北部與雙埔通勤核心走廊代表路段 + 全台重要瓶頸路段
    const corridorMatchers = [
      { key: 'n1_wugu_linkou', shortLabel: '國1 五股-林口', road: '國道1號', pairs: [['五股', '泰山'], ['泰山', '林口'], ['五股', '林口']], kw: ['五股', '林口'] },
      { key: 'n1_taoyuan_neili', shortLabel: '國1 桃園-內壢', road: '國道1號', pairs: [['桃園', '機場系統'], ['機場系統', '中壢服務區'], ['中壢服務區', '內壢'], ['桃園', '內壢']], kw: ['桃園', '內壢'] },
      { key: 'n1_neili_zhongli', shortLabel: '國1 內壢-中壢', road: '國道1號', kw: ['內壢', '中壢'] },
      { key: 'n2_dazhu_airport', shortLabel: '國2 大竹-機場系統', road: '國道2號', kw: ['大竹', '機場系統'] },
      { key: 'n2_dayuan_dazhu', shortLabel: '國2 大園-大竹(青埔)', road: '國道2號', kw: ['大園', '大竹'] },
      { key: 'n3_zhonghe_tucheng', shortLabel: '國3 中和-土城(板橋)', road: '國道3號', kw: ['中和', '土城'] },
      { key: 'n5_nangang_toucheng', shortLabel: '國5 石碇-坪林(雪隧)', road: '國道5號', kw: ['石碇', '坪林'] },
      { key: 'n1_hsinchu', shortLabel: '國1 湖口-竹北', road: '國道1號', kw: ['湖口', '竹北'] },
      { key: 'n1_taichung', shortLabel: '國1 大雅-台中', road: '國道1號', kw: ['大雅', '台中'] },
      { key: 'n1_kaohsiung', shortLabel: '國1 鼎金-高雄', road: '國道1號', kw: ['鼎金', '高雄'] }
    ];

    const corridors = [];
    for (const cm of corridorMatchers) {
      const normName = (n) => String(n || '').replace(/臺/g, '台');
      let matched = Array.isArray(cm.pairs)
        ? allValid.filter(s => s.roadName.includes(cm.road) && cm.pairs.some(pair => pair.every(k => normName(s.name).includes(k))))
        : allValid.filter(s => s.roadName.includes(cm.road) && cm.kw.every(k => normName(s.name).includes(k)));
      if (matched.length === 0) {
        matched = allValid.filter(s => s.roadName.includes(cm.road) && normName(s.name).includes(cm.kw[0]));
      }
      const pick = matched.length > 0
        ? matched.reduce((worst, cur) => (cur.speed < worst.speed ? cur : worst), matched[0])
        : null;
      if (pick) {
        const cls = classifyFreewaySpeed(pick.speed);
        corridors.push({
          key: cm.key,
          shortLabel: cm.shortLabel,
          fullSectionName: pick.name,
          roadName: cm.road,
          speed: pick.speed,
          level: cls.level,
          statusText: cls.text
        });
      }
    }

    const payload = JSON.stringify({
      success: true,
      updateTimeDisplay: getTaiwanTimeHHMMSS(),
      corridors,
      sections: allValid
    });
    if (allValid.length > 0) {
      cache.freewayLive = { data: payload, expireAt: now + 45000 };
    } else if (cache.freewayLive.data) {
      res.writeHead(200);
      res.end(cache.freewayLive.data);
      return;
    }
    res.writeHead(200);
    res.end(payload);
  } catch (err) {
    if (cache.freewayLive.data) {
      res.writeHead(200);
      res.end(cache.freewayLive.data);
      return;
    }
    res.writeHead(502);
    res.end(JSON.stringify({ success: false, error: '無法取得國道即時車速資料', detail: err.message }));
  }
}

// 跨國旅遊百寶箱代理：新台幣即時匯率 + NOAA 全球極光 Kp 指數 (/api/travel/toolkit)
async function handleTravelToolkitProxy(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const now = Date.now();
  try {
    const fetchFx = async () => {
      if (cache.travelToolkit.fx && now < cache.travelToolkit.fxExp) return cache.travelToolkit.fx;
      const j = await fetchJsonWithRetry('https://open.er-api.com/v6/latest/TWD', 0, 5000);
      if (j && j.rates) {
        const fxObj = {
          base: 'TWD',
          updatedUtc: j.time_last_update_utc || new Date().toISOString(),
          rates: j.rates
        };
        cache.travelToolkit.fx = fxObj;
        cache.travelToolkit.fxExp = now + 30 * 60000;
        return fxObj;
      }
      return cache.travelToolkit.fx;
    };

    const fetchKp = async () => {
      if (cache.travelToolkit.kp && now < cache.travelToolkit.kpExp) return cache.travelToolkit.kp;
      const arr = await fetchJsonWithRetry('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json', 0, 5000);
      if (Array.isArray(arr) && arr.length > 0) {
        const last = arr[arr.length - 1];
        const kpVal = typeof last === 'object' && !Array.isArray(last)
          ? parseFloat(last.Kp)
          : parseFloat(Array.isArray(last) ? last[1] : NaN);
        const timeTag = typeof last === 'object' && !Array.isArray(last)
          ? String(last.time_tag || '')
          : String(Array.isArray(last) ? (last[0] || '') : '');
        if (Number.isFinite(kpVal)) {
          const kpObj = {
            kp: +kpVal.toFixed(2),
            timeTagUtc: timeTag
          };
          cache.travelToolkit.kp = kpObj;
          cache.travelToolkit.kpExp = now + 10 * 60000;
          return kpObj;
        }
      }
      return cache.travelToolkit.kp;
    };

    const [fxSettled, kpSettled] = await Promise.allSettled([fetchFx(), fetchKp()]);
    const fx = fxSettled.status === 'fulfilled' ? fxSettled.value : cache.travelToolkit.fx;
    const kp = kpSettled.status === 'fulfilled' ? kpSettled.value : cache.travelToolkit.kp;

    res.writeHead(200);
    res.end(JSON.stringify({
      success: true,
      fx: fx || null,
      auroraKp: kp || null,
      fetchedAt: new Date().toISOString()
    }));
  } catch (err) {
    res.writeHead(502);
    res.end(JSON.stringify({ success: false, error: '無法取得跨國匯率與極光指數', detail: err.message }));
  }
}

// ============================================================================
// 全球與台灣即時飛航雷達（當地國際機場入出境起降航班 + 鏡頭上空巡航）與身歷其境在地脈動代理引擎
// ============================================================================
const AIRPORT_HUB_CATALOG = [
  // 台灣核心機場
  { iata: 'TPE', icao: 'RCTP', name: '臺灣桃園國際機場', city: '桃園／青埔', country: '台灣', countryCode: 'TW', lat: 25.0777, lon: 121.2328, twinIatas: ['TSA'] },
  { iata: 'TSA', icao: 'RCSS', name: '臺北松山國際機場', city: '台北／雙北', country: '台灣', countryCode: 'TW', lat: 25.0694, lon: 121.5525, twinIatas: ['TPE'] },
  { iata: 'RMQ', icao: 'RCMQ', name: '臺中清泉崗國際機場', city: '台中', country: '台灣', countryCode: 'TW', lat: 24.2647, lon: 120.6206, twinIatas: [] },
  { iata: 'TNN', icao: 'RCNN', name: '臺南國際機場', city: '台南', country: '台灣', countryCode: 'TW', lat: 22.9504, lon: 120.2058, twinIatas: ['KHH'] },
  { iata: 'KHH', icao: 'RCKH', name: '高雄國際機場', city: '高雄', country: '台灣', countryCode: 'TW', lat: 22.5771, lon: 120.3500, twinIatas: ['TNN'] },
  { iata: 'HUN', icao: 'RCYU', name: '花蓮機場', city: '花蓮', country: '台灣', countryCode: 'TW', lat: 24.0231, lon: 121.6178, twinIatas: [] },
  { iata: 'TTT', icao: 'RCFN', name: '臺東豐年機場', city: '台東', country: '台灣', countryCode: 'TW', lat: 22.7550, lon: 121.1019, twinIatas: [] },
  // 日本核心機場
  { iata: 'HND', icao: 'RJTT', name: '東京羽田國際機場', city: '東京', country: '日本', countryCode: 'JP', lat: 35.5494, lon: 139.7798, twinIatas: ['NRT'] },
  { iata: 'NRT', icao: 'RJAA', name: '東京成田國際機場', city: '東京／千葉', country: '日本', countryCode: 'JP', lat: 35.7720, lon: 140.3929, twinIatas: ['HND'] },
  { iata: 'KIX', icao: 'RJBB', name: '大阪關西國際機場', city: '大阪／京阪神', country: '日本', countryCode: 'JP', lat: 34.4347, lon: 135.2441, twinIatas: ['ITM', 'UKB'] },
  { iata: 'ITM', icao: 'RJOO', name: '大阪伊丹國際機場', city: '大阪／京都', country: '日本', countryCode: 'JP', lat: 34.7855, lon: 135.4382, twinIatas: ['KIX'] },
  { iata: 'NGO', icao: 'RJGG', name: '名古屋中部國際機場', city: '名古屋／中部', country: '日本', countryCode: 'JP', lat: 34.8584, lon: 136.8054, twinIatas: ['NKM'] },
  { iata: 'CTS', icao: 'RJCC', name: '札幌新千歲國際機場', city: '北海道札幌', country: '日本', countryCode: 'JP', lat: 42.7752, lon: 141.6923, twinIatas: ['OKD'] },
  { iata: 'FUK', icao: 'RJFF', name: '福岡國際機場', city: '九州福岡', country: '日本', countryCode: 'JP', lat: 33.5859, lon: 130.4511, twinIatas: [] },
  { iata: 'OKA', icao: 'ROAH', name: '沖繩那霸國際機場', city: '沖繩那霸', country: '日本', countryCode: 'JP', lat: 26.1958, lon: 127.6458, twinIatas: [] },
  // 韓國核心機場
  { iata: 'ICN', icao: 'RKSI', name: '首爾仁川國際機場', city: '首爾／仁川', country: '韓國', countryCode: 'KR', lat: 37.4602, lon: 126.4407, twinIatas: ['GMP'] },
  { iata: 'GMP', icao: 'RKSS', name: '首爾金浦國際機場', city: '首爾', country: '韓國', countryCode: 'KR', lat: 37.5583, lon: 126.7906, twinIatas: ['ICN'] },
  { iata: 'PUS', icao: 'RKPK', name: '釜山金海國際機場', city: '釜山', country: '韓國', countryCode: 'KR', lat: 35.1796, lon: 128.9382, twinIatas: [] },
  { iata: 'CJU', icao: 'RKPC', name: '濟州國際機場', city: '濟州島', country: '韓國', countryCode: 'KR', lat: 33.5113, lon: 126.4930, twinIatas: [] },
  // 亞太與中東核心機場
  { iata: 'SYD', icao: 'YSSY', name: '雪梨金斯福德史密斯機場', city: '雪梨', country: '澳洲', countryCode: 'AU', lat: -33.9399, lon: 151.1753, twinIatas: [] },
  { iata: 'AKL', icao: 'NZAA', name: '奧克蘭國際機場', city: '奧克蘭', country: '紐西蘭', countryCode: 'NZ', lat: -37.0082, lon: 174.7850, twinIatas: [] },
  { iata: 'SIN', icao: 'WSSS', name: '新加坡樟宜國際機場', city: '新加坡', country: '新加坡', countryCode: 'SG', lat: 1.3644, lon: 103.9915, twinIatas: [] },
  { iata: 'BKK', icao: 'VTBS', name: '曼谷素萬那普國際機場', city: '曼谷', country: '泰國', countryCode: 'TH', lat: 13.6900, lon: 100.7501, twinIatas: ['DMK'] },
  { iata: 'USM', icao: 'VTSM', name: '蘇美島國際機場', city: '蘇美島', country: '泰國', countryCode: 'TH', lat: 9.5478, lon: 100.0623, twinIatas: [] },
  { iata: 'DPS', icao: 'WADD', name: '峇里島伍拉賴國際機場', city: '峇里島', country: '印尼', countryCode: 'ID', lat: -8.7482, lon: 115.1672, twinIatas: [] },
  { iata: 'HKG', icao: 'VHHH', name: '香港國際機場', city: '香港', country: '香港', countryCode: 'HK', lat: 22.3080, lon: 113.9185, twinIatas: ['MFM'] },
  { iata: 'DXB', icao: 'OMDB', name: '杜拜國際機場', city: '杜拜', country: '阿聯', countryCode: 'AE', lat: 25.2532, lon: 55.3657, twinIatas: ['DWC'] },
  { iata: 'JED', icao: 'OEJN', name: '吉達阿卜杜勒阿齊茲國王機場', city: '麥加／吉達', country: '沙烏地阿拉伯', countryCode: 'SA', lat: 21.6796, lon: 39.1565, twinIatas: [] },
  // 歐洲與極地核心機場
  { iata: 'LHR', icao: 'EGLL', name: '倫敦希斯洛國際機場', city: '倫敦', country: '英國', countryCode: 'GB', lat: 51.4700, lon: -0.4543, twinIatas: ['LGW', 'LCY', 'STN'] },
  { iata: 'CDG', icao: 'LFPG', name: '巴黎戴高樂國際機場', city: '巴黎', country: '法國', countryCode: 'FR', lat: 49.0097, lon: 2.5479, twinIatas: ['ORY'] },
  { iata: 'ZRH', icao: 'LSZH', name: '蘇黎世國際機場', city: '蘇黎世／阿爾卑斯', country: '瑞士', countryCode: 'CH', lat: 47.4647, lon: 8.5492, twinIatas: ['GVA', 'BSL'] },
  { iata: 'VCE', icao: 'LIPZ', name: '威尼斯馬可波羅國際機場', city: '威尼斯', country: '義大利', countryCode: 'IT', lat: 45.5053, lon: 12.3519, twinIatas: ['TSF'] },
  { iata: 'AMS', icao: 'EHAM', name: '阿姆斯特丹史基浦機場', city: '阿姆斯特丹', country: '荷蘭', countryCode: 'NL', lat: 52.3105, lon: 4.7683, twinIatas: [] },
  { iata: 'BER', icao: 'EDDB', name: '柏林勃蘭登堡國際機場', city: '柏林', country: '德國', countryCode: 'DE', lat: 52.3667, lon: 13.5033, twinIatas: [] },
  { iata: 'SZG', icao: 'LOWS', name: '薩爾茨堡莫札特機場', city: '哈爾施塔特／薩爾茨堡', country: '奧地利', countryCode: 'AT', lat: 47.7933, lon: 13.0043, twinIatas: ['VIE', 'INN'] },
  { iata: 'CTA', icao: 'LICC', name: '卡塔尼亞國際機場', city: '西西里島埃特納', country: '義大利', countryCode: 'IT', lat: 37.4668, lon: 15.0664, twinIatas: [] },
  { iata: 'PMI', icao: 'LEPA', name: '馬約卡島帕爾馬國際機場', city: '馬約卡島', country: '西班牙', countryCode: 'ES', lat: 39.5517, lon: 2.7388, twinIatas: ['BCN', 'IBZ'] },
  { iata: 'FNC', icao: 'LPMA', name: '馬德拉豐沙爾國際機場', city: '馬德拉島', country: '葡萄牙', countryCode: 'PT', lat: 32.6979, lon: -16.7745, twinIatas: ['LIS'] },
  { iata: 'MRY', icao: 'KMRY', name: '加州蒙特雷半島機場', city: '蒙特雷灣', country: '美國', countryCode: 'US', lat: 36.5870, lon: -121.8430, twinIatas: ['SFO', 'SJC'] },
  { iata: 'AES', icao: 'ENAL', name: '奧勒松維格拉機場', city: '蓋朗厄爾峽灣', country: '挪威', countryCode: 'NO', lat: 62.5625, lon: 6.1197, twinIatas: ['OSL', 'BGO'] },
  { iata: 'RVN', icao: 'EFRO', name: '羅瓦涅米北極圈機場', city: '拉普蘭羅瓦涅米', country: '芬蘭', countryCode: 'FI', lat: 66.5648, lon: 25.8304, twinIatas: ['KTT', 'IVL', 'HEL'] },
  { iata: 'TOS', icao: 'ENTC', name: '特羅姆瑟朗格內斯機場', city: '北極圈特羅姆瑟', country: '挪威', countryCode: 'NO', lat: 69.6833, lon: 18.9189, twinIatas: ['EVE'] },
  { iata: 'KEF', icao: 'BIKF', name: '雷克雅維克凱夫拉維克機場', city: '雷克雅維克', country: '冰島', countryCode: 'IS', lat: 63.9850, lon: -22.6056, twinIatas: ['RKV'] },
  { iata: 'GOH', icao: 'BGGH', name: '格陵蘭努克國際機場', city: '格陵蘭努克', country: '格陵蘭', countryCode: 'GL', lat: 64.1909, lon: -51.6781, twinIatas: ['JAV', 'JHS'] },
  // 美洲、雨林與海洋核心機場
  { iata: 'JFK', icao: 'KJFK', name: '紐約甘迺迪國際機場', city: '紐約', country: '美國', countryCode: 'US', lat: 40.6413, lon: -73.7781, twinIatas: ['LGA', 'EWR'] },
  { iata: 'LAX', icao: 'KLAX', name: '洛杉磯國際機場', city: '洛杉磯', country: '美國', countryCode: 'US', lat: 33.9416, lon: -118.4085, twinIatas: ['BUR', 'SNA', 'LGB'] },
  { iata: 'LAS', icao: 'KLAS', name: '拉斯維加斯哈里瑞德機場', city: '拉斯維加斯', country: '美國', countryCode: 'US', lat: 36.0840, lon: -115.1537, twinIatas: [] },
  { iata: 'SFO', icao: 'KSFO', name: '舊金山國際機場', city: '舊金山／加州', country: '美國', countryCode: 'US', lat: 37.6213, lon: -122.3790, twinIatas: ['OAK', 'SJC', 'MRY'] },
  { iata: 'MIA', icao: 'KMIA', name: '邁阿密國際機場', city: '邁阿密', country: '美國', countryCode: 'US', lat: 25.7959, lon: -80.2870, twinIatas: ['FLL'] },
  { iata: 'HNL', icao: 'PHNL', name: '夏威夷檀香山國際機場', city: '夏威夷檀香山', country: '美國', countryCode: 'US', lat: 21.3187, lon: -157.9225, twinIatas: ['OGG', 'KOA'] },
  { iata: 'JAC', icao: 'KJAC', name: '傑克森霍爾機場', city: '懷俄明／黃石公園', country: '美國', countryCode: 'US', lat: 43.6073, lon: -110.7377, twinIatas: ['BZN'] },
  { iata: 'BUF', icao: 'KBUF', name: '水牛城尼加拉國際機場', city: '尼加拉瀑布', country: '美國', countryCode: 'US', lat: 42.9405, lon: -78.7322, twinIatas: ['YYZ', 'IAG'] },
  { iata: 'SJO', icao: 'MROC', name: '胡安聖瑪麗亞國際機場', city: '哥斯大黎加聖荷西', country: '哥斯大黎加', countryCode: 'CR', lat: 9.9939, lon: -84.2088, twinIatas: ['LIR'] },
  { iata: 'PTY', icao: 'MPTO', name: '巴拿馬托庫門國際機場', city: '巴拿馬城', country: '巴拿馬', countryCode: 'PA', lat: 9.0714, lon: -79.3835, twinIatas: [] },
  { iata: 'GIG', icao: 'SBGL', name: '里約熱內盧加利昂國際機場', city: '里約熱內盧', country: '巴西', countryCode: 'BR', lat: -22.8100, lon: -43.2506, twinIatas: ['SDU', 'GRU'] },
  { iata: 'USH', icao: 'SAWH', name: '烏斯懷亞馬爾維納斯國際機場', city: '烏斯懷亞（南極門戶）', country: '阿根廷', countryCode: 'AR', lat: -54.8433, lon: -68.2958, twinIatas: [] },
  { iata: 'CUR', icao: 'TNCC', name: '庫拉索哈托國際機場', city: '加勒比海庫拉索／波奈', country: '荷屬加勒比', countryCode: 'CW', lat: 12.1889, lon: -68.9598, twinIatas: ['BON', 'AUA'] }
];

const AIRLINE_NAME_ZH_MAP = {
  CAL: '中華航空', CI: '中華航空',
  EVA: '長榮航空', BR: '長榮航空',
  SJX: '星宇航空', JX: '星宇航空',
  TTW: '台灣虎航', IT: '台灣虎航',
  MDA: '華信航空', AE: '華信航空',
  UIA: '立榮航空', B7: '立榮航空',
  CPA: '國泰航空', CX: '國泰航空',
  HKE: '香港快運', UO: '香港快運',
  CRK: '香港航空', HX: '香港航空',
  AMU: '澳門航空', NX: '澳門航空',
  ANA: '全日空', NH: '全日空',
  JAL: '日本航空', JL: '日本航空',
  APJ: '樂桃航空', MM: '樂桃航空',
  SJO: 'Zipair 東京', ZG: 'Zipair 東京',
  SKY: '天馬航空', BC: '天馬航空',
  SFJ: '星悅航空', '7G': '星悅航空',
  ADO: '北海道國際航空', HD: '北海道國際航空',
  SNJ: 'ソラシド航空', '6J': 'ソラシド航空',
  KAL: '大韓航空', KE: '大韓航空',
  AAR: '韓亞航空', OZ: '韓亞航空',
  JJA: '濟州航空', '7C': '濟州航空',
  JNA: '真航空', LJ: '真航空',
  TWB: '德威航空', TW: '德威航空',
  ABL: '釜山航空', BX: '釜山航空',
  SIA: '新加坡航空', SQ: '新加坡航空',
  TGW: '酷航', TR: '酷航',
  THA: '泰國國際航空', TG: '泰國國際航空',
  AIQ: '泰國亞洲航空', FD: '泰國亞洲航空',
  MAS: '馬來西亞航空', MH: '馬來西亞航空',
  AXM: '亞洲航空', AK: '亞洲航空',
  XAX: '全亞航', D7: '全亞航',
  HVN: '越南航空', VN: '越南航空',
  VJC: '越捷航空', VJ: '越捷航空',
  PAL: '菲律賓航空', PR: '菲律賓航空',
  CEB: '宿霧太平洋航空', '5J': '宿霧太平洋航空',
  GIA: '嘉魯達印尼航空', GA: '嘉魯達印尼航空',
  QFA: '澳洲航空', QF: '澳洲航空',
  JST: '捷星航空', JQ: '捷星航空',
  VOZ: '維珍澳洲航空', VA: '維珍澳洲航空',
  ANZ: '紐西蘭航空', NZ: '紐西蘭航空',
  UAE: '阿聯酋航空', EK: '阿聯酋航空',
  ETD: '阿提哈德航空', EY: '阿提哈德航空',
  QTR: '卡達航空', QR: '卡達航空',
  THY: '土耳其航空', TK: '土耳其航空',
  BAW: '英國航空', BA: '英國航空',
  VIR: '維珍大西洋航空', VS: '維珍大西洋航空',
  EZY: '易捷航空', U2: '易捷航空',
  RYR: '瑞安航空', FR: '瑞安航空',
  AFR: '法國航空', AF: '法國航空',
  DLH: '德國漢莎航空', LH: '德國漢莎航空',
  SWR: '瑞士國際航空', LX: '瑞士國際航空',
  EDW: '瑞士雪絨花航空', WK: '瑞士雪絨花航空',
  KLM: '荷蘭皇家航空', KL: '荷蘭皇家航空',
  AUA: '奧地利航空', OS: '奧地利航空',
  ITY: '義大利航空', AZ: '義大利航空',
  IBE: '伊比利亞航空', IB: '伊比利亞航空',
  AEA: '歐洲航空', UX: '歐洲航空',
  FIN: '芬蘭航空', AY: '芬蘭航空',
  SAS: '北歐航空', SK: '北歐航空',
  NOZ: '挪威穿梭航空', DY: '挪威穿梭航空',
  ICE: '冰島航空', FI: '冰島航空',
  GRL: '格陵蘭航空', GL: '格陵蘭航空',
  UAL: '聯合航空', UA: '聯合航空',
  DAL: '達美航空', DL: '達美航空',
  AAL: '美國航空', AA: '美國航空',
  SWA: '西南航空', WN: '西南航空',
  JBU: '捷藍航空', B6: '捷藍航空',
  ASA: '阿拉斯加航空', AS: '阿拉斯加航空',
  HAL: '夏威夷航空', HA: '夏威夷航空',
  ACA: '加拿大航空', AC: '加拿大航空',
  WJA: '西捷航空', WS: '西捷航空',
  CMP: '巴拿馬航空', CM: '巴拿馬航空',
  LAN: '南美航空', LA: '南美航空',
  ARG: '阿根廷航空', AR: '阿根廷航空',
  FDX: '聯邦快遞航空', FX: '聯邦快遞航空',
  UPS: '優比速航空', '5X': '優比速航空',
  CLX: '盧森堡貨運航空', CV: '盧森堡貨運航空'
};

const AIRPORT_IATA_ZH_MAP = {
  TPE: '桃園 TPE', TSA: '台北松山 TSA', RMQ: '台中 RMQ', TNN: '台南 TNN', KHH: '高雄 KHH',
  HUN: '花蓮 HUN', TTT: '台東 TTT', MZG: '澎湖 MZG', KNH: '金門 KNH', LZN: '馬祖南竿 LZN',
  HKG: '香港 HKG', MFM: '澳門 MFM',
  HND: '東京羽田 HND', NRT: '東京成田 NRT', KIX: '大阪關西 KIX', ITM: '大阪伊丹 ITM',
  NGO: '名古屋 NGO', CTS: '札幌新千歲 CTS', FUK: '福岡 FUK', OKA: '沖繩那霸 OKA',
  SDJ: '仙台 SDJ', HIJ: '廣島 HIJ', OKJ: '岡山 OKJ', TAK: '高松 TAK', KMJ: '熊本 KMJ',
  KOJ: '鹿兒島 KOJ', KKJ: '北九州 KKJ', NGS: '長崎 NGS', KMQ: '小松 KMQ', ISG: '石垣島 ISG', MMY: '宮古島 MMY',
  ICN: '首爾仁川 ICN', GMP: '首爾金浦 GMP', PUS: '釜山 PUS', CJU: '濟州 CJU', TAE: '大邱 TAE',
  SIN: '新加坡 SIN', BKK: '曼谷 BKK', DMK: '曼谷廊曼 DMK', CNX: '清邁 CNX', HKT: '普吉島 HKT',
  USM: '蘇美島 USM', KUL: '吉隆坡 KUL', PEN: '檳城 PEN', BKI: '沙巴亞庇 BKI',
  SGN: '胡志明市 SGN', HAN: '河內 HAN', DAD: '峴港 DAD', PQC: '富國島 PQC',
  MNL: '馬尼拉 MNL', CEB: '宿霧 CEB', CRK: '克拉克 CRK',
  CGK: '雅加達 CGK', DPS: '峇里島 DPS', SUB: '泗水 SUB',
  ROR: '帛琉 ROR', GUM: '關島 GUM',
  SYD: '雪梨 SYD', MEL: '墨爾本 MEL', BNE: '布里斯本 BNE', PER: '伯斯 PER',
  AKL: '奧克蘭 AKL', CHC: '基督城 CHC', ZQN: '皇后鎮 ZQN',
  DEL: '新德里 DEL', BOM: '孟買 BOM', DXB: '杜拜 DXB', AUH: '阿布達比 AUH',
  DOH: '多哈 DOH', JED: '吉達 JED', RUH: '利雅德 RUH', IST: '伊斯坦堡 IST',
  LHR: '倫敦希斯洛 LHR', LGW: '倫敦蓋威克 LGW', LCY: '倫敦城市 LCY', STN: '倫敦史坦斯特 STN',
  MAN: '曼徹斯特 MAN', EDI: '愛丁堡 EDI', BHX: '伯明罕 BHX', DUB: '都柏林 DUB',
  CDG: '巴黎戴高樂 CDG', ORY: '巴黎奧利 ORY', NCE: '尼斯 NCE', LYS: '里昂 LYS',
  AMS: '阿姆斯特丹 AMS', BRU: '布魯塞爾 BRU',
  FRA: '法蘭克福 FRA', MUC: '慕尼黑 MUC', BER: '柏林 BER', DUS: '杜塞道夫 DUS', HAM: '漢堡 HAM',
  ZRH: '蘇黎世 ZRH', GVA: '日內瓦 GVA', BSL: '巴塞爾 BSL',
  VIE: '維也納 VIE', SZG: '薩爾茨堡 SZG', INN: '因斯布魯克 INN',
  FCO: '羅馬 FCO', MXP: '米蘭 MXP', VCE: '威尼斯 VCE', NAP: '拿坡里 NAP', CTA: '卡塔尼亞 CTA',
  MAD: '馬德里 MAD', BCN: '巴塞隆納 BCN', PMI: '馬約卡島 PMI',
  LIS: '里斯本 LIS', FNC: '馬德拉島 FNC', ATH: '雅典 ATH', PRG: '布拉格 PRG',
  CPH: '哥本哈根 CPH', OSL: '奧斯陸 OSL', BGO: '卑爾根 BGO', AES: '奧勒松 AES', TOS: '特羅姆瑟 TOS',
  ARN: '斯德哥爾摩 ARN', HEL: '赫爾辛基 HEL', RVN: '羅瓦涅米 RVN',
  KEF: '雷克雅維克 KEF', GOH: '格陵蘭努克 GOH', FAE: '法羅群島 FAE', LYR: '斯瓦爾巴 LYR',
  JFK: '紐約甘迺迪 JFK', LGA: '紐約拉瓜地亞 LGA', EWR: '紐華克 EWR',
  BOS: '波士頓 BOS', IAD: '華盛頓 IAD',DCA: '華盛頓雷根 DCA',
  ORD: '芝加哥 ORD', ATL: '亞特蘭大 ATL', MIA: '邁阿密 MIA', MCO: '奧蘭多 MCO',
  DFW: '達拉斯 DFW', IAH: '休士頓 IAH', DEN: '丹佛 DEN', PHX: '鳳凰城 PHX',
  LAS: '拉斯維加斯 LAS', LAX: '洛杉磯 LAX', SFO: '舊金山 SFO', SEA: '西雅圖 SEA',
  HNL: '夏威夷檀香山 HNL', ANC: '安克拉治 ANC', JAC: '傑克森霍爾 JAC', BUF: '水牛城 BUF',
  YVR: '溫哥華 YVR', YYZ: '多倫多 YYZ', YUL: '蒙特婁 YUL', YYC: '卡加利 YYC',
  MEX: '墨西哥城 MEX', CUN: '坎昆 CUN', SJO: '聖荷西 SJO', PTY: '巴拿馬城 PTY',
  BOG: '波哥大 BOG', LIM: '利馬 LIM', SCL: '聖地牙哥 SCL',
  GRU: '聖保羅 GRU', GIG: '里約 GIG', EZE: '布宜諾斯艾利斯 EZE', USH: '烏斯懷亞 USH',
  CUR: '庫拉索 CUR', BON: '波奈 BON', AUA: '阿魯巴 AUA'
};

const AIRCRAFT_MODEL_ZH_MAP = {
  A359: 'A350-900', A35K: 'A350-1000', A339: 'A330-900neo', A333: 'A330-300', A332: 'A330-200',
  A388: 'A380-800', A321: 'A321', A21N: 'A321neo', A320: 'A320', A20N: 'A320neo', A319: 'A319',
  BCS1: 'A220-100', BCS3: 'A220-300',
  B77W: 'B777-300ER', B77L: 'B777-200LR', B772: 'B777-200', B77F: 'B777F 貨機',
  B788: 'B787-8', B789: 'B787-9 夢幻客機', B78X: 'B787-10 夢幻客機',
  B744: 'B747-400', B748: 'B747-8', B763: 'B767-300', B752: 'B757-200',
  B738: 'B737-800', B739: 'B737-900', B38M: 'B737 MAX 8', B39M: 'B737 MAX 9',
  AT76: 'ATR 72-600', E190: 'E190', E195: 'E195', E290: 'E190-E2', CRJ9: 'CRJ-900'
};

function findNearestAirportHub(lat, lon) {
  let best = AIRPORT_HUB_CATALOG[0];
  let minMeters = Infinity;
  for (const h of AIRPORT_HUB_CATALOG) {
    const d = calcDistanceMeters(lat, lon, h.lat, h.lon);
    if (d < minMeters) {
      minMeters = d;
      best = h;
    }
  }
  return { ...best, distKm: +(minMeters / 1000).toFixed(1) };
}

function resolveAirlineNameZh(flightNo, callsign, airlineIcao) {
  const icao = String(airlineIcao || '').trim().toUpperCase() || String(callsign || '').trim().slice(0, 3).toUpperCase();
  if (AIRLINE_NAME_ZH_MAP[icao]) return AIRLINE_NAME_ZH_MAP[icao];
  const iata = String(flightNo || '').trim().slice(0, 2).toUpperCase();
  if (AIRLINE_NAME_ZH_MAP[iata]) return AIRLINE_NAME_ZH_MAP[iata];
  return icao || iata || '民航航班';
}

function formatAirportCodeZh(iata) {
  const c = String(iata || '').trim().toUpperCase();
  if (!c) return '';
  return AIRPORT_IATA_ZH_MAP[c] || c;
}

async function fetchNearbyFlightsData(lat, lon) {
  const airport = findNearestAirportHub(lat, lon);
  const refLat = airport.distKm <= 160 ? airport.lat : lat;
  const refLon = airport.distKm <= 160 ? airport.lon : lon;
  const minLat = Math.max(-85, Math.min(lat, refLat) - 0.52);
  const maxLat = Math.min(85, Math.max(lat, refLat) + 0.52);
  const minLon = Math.max(-179.9, Math.min(lon, refLon) - 0.62);
  const maxLon = Math.min(179.9, Math.max(lon, refLon) + 0.62);
  const bounds = `${maxLat.toFixed(3)},${minLat.toFixed(3)},${minLon.toFixed(3)},${maxLon.toFixed(3)}`;

  const localIataSet = new Set([airport.iata, ...(airport.twinIatas || [])]);
  const flightsMap = new Map();

  // 主引擎：FlightRadar24 即時區域雷達 (含完整起降機場 IATA、航班號、機型、高度、地速、升降率)
  try {
    const frUrl = `https://data-cloud.flightradar24.com/zones/fcgi/feed.js?bounds=${bounds}&faa=1&satellite=1&mlat=1&flarm=1&adsb=1&gnd=1&air=1&vehicles=0&estimated=1&maxage=14400&gliders=0&stats=1`;
    const frJson = await fetchJsonWithRetry(frUrl, 0, 2400);
    if (frJson && typeof frJson === 'object') {
      for (const [k, v] of Object.entries(frJson)) {
        if (!Array.isArray(v) || v.length < 16) continue;
        const fLat = Number(v[1]);
        const fLon = Number(v[2]);
        if (!Number.isFinite(fLat) || !Number.isFinite(fLon)) continue;
        const track = Math.round(Number(v[3]) || 0);
        const altFt = Math.max(0, Math.round(Number(v[4]) || 0));
        const gsKts = Math.max(0, Math.round(Number(v[5]) || 0));
        const acCode = String(v[8] || '').trim().toUpperCase();
        const reg = String(v[9] || '').trim();
        const origIata = String(v[11] || '').trim().toUpperCase();
        const destIata = String(v[12] || '').trim().toUpperCase();
        const iataNo = String(v[13] || '').trim().toUpperCase();
        const onGround = Number(v[14]) === 1 || altFt === 0;
        const vRate = Math.round(Number(v[15]) || 0);
        const callsign = String(v[16] || '').trim().toUpperCase();
        const airlineIcao = String(v[18] || '').trim().toUpperCase();
        const flightNo = iataNo || callsign || reg;
        if (!flightNo || /^@+$/.test(flightNo)) continue;

        const distCamKm = +(calcDistanceMeters(lat, lon, fLat, fLon) / 1000).toFixed(1);
        const distAptKm = +(calcDistanceMeters(airport.lat, airport.lon, fLat, fLon) / 1000).toFixed(1);

        let phase = 'OVERFLIGHT';
        if (destIata && localIataSet.has(destIata)) {
          phase = 'ARRIVAL';
        } else if (origIata && localIataSet.has(origIata)) {
          phase = 'DEPARTURE';
        } else if (distAptKm <= 48) {
          if (vRate <= -250 && altFt > 0 && altFt <= 16500) phase = 'ARRIVAL';
          else if ((vRate >= 250 && altFt <= 18500) || (onGround && gsKts >= 3)) phase = 'DEPARTURE';
        }

        let statusText = '高空巡航';
        if (phase === 'ARRIVAL') {
          if (onGround || altFt < 150) statusText = '已降落滑行';
          else if (altFt <= 2500) statusText = '最後進場降落';
          else statusText = '下降進場中';
        } else if (phase === 'DEPARTURE') {
          if (onGround || altFt < 150) statusText = '跑道滑行待飛';
          else if (altFt <= 4500) statusText = '剛起飛爬升';
          else statusText = '出境爬升中';
        }

        const airlineZh = resolveAirlineNameZh(iataNo, callsign, airlineIcao);
        const aircraftZh = AIRCRAFT_MODEL_ZH_MAP[acCode] || acCode || '民航客機';
        const originZh = formatAirportCodeZh(origIata) || (phase === 'DEPARTURE' ? formatAirportCodeZh(airport.iata) : '');
        const destZh = formatAirportCodeZh(destIata) || (phase === 'ARRIVAL' ? formatAirportCodeZh(airport.iata) : '');
        const altM = Math.round(altFt * 0.3048);

        flightsMap.set(flightNo, {
          id: k,
          flightNo,
          callsign: callsign || flightNo,
          airlineName: airlineZh,
          airlineZh,
          aircraftCode: acCode,
          aircraftModel: aircraftZh,
          aircraftZh,
          reg,
          originIata: origIata,
          originName: originZh,
          originZh,
          destIata,
          destName: destZh,
          destZh,
          phase,
          category: phase,
          statusText,
          phaseZh: statusText,
          altFt,
          altMeters: altM,
          altM,
          speedKts: gsKts,
          speedKmh: Math.round(gsKts * 1.852),
          vRate,
          track,
          onGround,
          lat: +fLat.toFixed(4),
          lon: +fLon.toFixed(4),
          distKm: distCamKm,
          distAirportKm: distAptKm
        });
      }
    }
  } catch (_) {}

  // 備援引擎：opendata.adsb.fi / api.adsb.lol 開放 ADS-B 雷達
  if (flightsMap.size === 0) {
    const adsbUrls = [
      `https://opendata.adsb.fi/api/v2/lat/${refLat.toFixed(4)}/lon/${refLon.toFixed(4)}/dist/50`,
      `https://api.adsb.lol/v2/point/${refLat.toFixed(4)}/${refLon.toFixed(4)}/50`
    ];
    for (const u of adsbUrls) {
      try {
        const j = await fetchJsonWithRetry(u, 0, 2200);
        const list = Array.isArray(j?.aircraft) ? j.aircraft : (Array.isArray(j?.ac) ? j.ac : []);
        if (list.length === 0) continue;
        for (const a of list) {
          const fLat = Number(a.lat), fLon = Number(a.lon);
          if (!Number.isFinite(fLat) || !Number.isFinite(fLon)) continue;
          const callsign = String(a.flight || '').trim().toUpperCase();
          const reg = String(a.r || '').trim();
          const flightNo = callsign || reg;
          if (!flightNo || /^@+$/.test(flightNo)) continue;
          const onGround = a.alt_baro === 'ground';
          const altFt = onGround ? 0 : Math.max(0, Math.round(Number(a.alt_baro) || 0));
          const gsKts = Math.max(0, Math.round(Number(a.gs) || 0));
          const vRate = Math.round(Number(a.baro_rate) || 0);
          const track = Math.round(Number(a.track) || 0);
          const acCode = String(a.t || '').trim().toUpperCase();
          const distCamKm = +(calcDistanceMeters(lat, lon, fLat, fLon) / 1000).toFixed(1);
          const distAptKm = +(calcDistanceMeters(airport.lat, airport.lon, fLat, fLon) / 1000).toFixed(1);

          let phase = 'OVERFLIGHT';
          if (distAptKm <= 48) {
            if (vRate <= -250 && altFt > 0 && altFt <= 16500) phase = 'ARRIVAL';
            else if ((vRate >= 250 && altFt <= 18500) || (onGround && gsKts >= 3)) phase = 'DEPARTURE';
          }
          const statusText = phase === 'ARRIVAL'
            ? (altFt <= 2500 ? '最後進場降落' : '下降進場中')
            : (phase === 'DEPARTURE' ? (onGround ? '跑道滑行待飛' : '出境爬升中') : '高空巡航');

          const airlineZh = resolveAirlineNameZh('', callsign, '');
          const aircraftZh = AIRCRAFT_MODEL_ZH_MAP[acCode] || a.desc || acCode || '民航客機';
          const originZh = phase === 'DEPARTURE' ? formatAirportCodeZh(airport.iata) : '';
          const destZh = phase === 'ARRIVAL' ? formatAirportCodeZh(airport.iata) : '';
          const altM = Math.round(altFt * 0.3048);

          flightsMap.set(flightNo, {
            id: String(a.hex || flightNo),
            flightNo,
            callsign,
            airlineName: airlineZh,
            airlineZh,
            aircraftCode: acCode,
            aircraftModel: aircraftZh,
            aircraftZh,
            reg,
            originIata: phase === 'DEPARTURE' ? airport.iata : '',
            originName: originZh,
            originZh,
            destIata: phase === 'ARRIVAL' ? airport.iata : '',
            destName: destZh,
            destZh,
            phase,
            category: phase,
            statusText,
            phaseZh: statusText,
            altFt,
            altMeters: altM,
            altM,
            speedKts: gsKts,
            speedKmh: Math.round(gsKts * 1.852),
            vRate,
            track,
            onGround,
            lat: +fLat.toFixed(4),
            lon: +fLon.toFixed(4),
            distKm: distCamKm,
            distAirportKm: distAptKm
          });
        }
        break;
      } catch (_) {}
    }
  }

  const allFlights = [...flightsMap.values()].sort((a, b) => {
    const score = (f) => (f.phase === 'ARRIVAL' || f.phase === 'DEPARTURE' ? 0 : 100) + (f.originIata && f.destIata ? 0 : 30) + Math.min(50, f.distKm);
    return score(a) - score(b);
  });

  const summary = {
    total: allFlights.length,
    arrivals: allFlights.filter(f => f.phase === 'ARRIVAL').length,
    departures: allFlights.filter(f => f.phase === 'DEPARTURE').length,
    overflights: allFlights.filter(f => f.phase === 'OVERFLIGHT').length
  };

  return {
    success: true,
    airport,
    summary,
    flights: allFlights.slice(0, 24),
    updateTimeDisplay: getTaiwanTimeHHMMSS()
  };
}

async function handleFlightsNearbyProxy(req, res, parsedUrl) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const lat = parseFloat(parsedUrl.searchParams.get('lat'));
  const lon = parseFloat(parsedUrl.searchParams.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    res.writeHead(400);
    res.end(JSON.stringify({ success: false, error: '無效的經緯度參數' }));
    return;
  }

  const cacheKey = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const now = Date.now();
  const cached = cache.flightsNearbyMap.get(cacheKey);
  if (cached && now < cached.expireAt) {
    res.writeHead(200);
    res.end(cached.payload);
    return;
  }

  try {
    const data = await fetchNearbyFlightsData(lat, lon);
    const payload = JSON.stringify(data);
    setBoundedMap(cache.flightsNearbyMap, cacheKey, { payload, expireAt: now + 15000 }, 160);
    res.writeHead(200);
    res.end(payload);
  } catch (err) {
    if (cached && cached.payload) {
      res.writeHead(200);
      res.end(cached.payload);
      return;
    }
    res.writeHead(502);
    res.end(JSON.stringify({ success: false, error: '無法取得即時航班雷達資料', detail: err.message }));
  }
}

const CURATED_LOCAL_RADIOS = {
  TW: [
    { name: 'ICRT 台灣國際英語廣播 FM 100.7', genre: '台灣都會流行／雙語即時新聞', country: '台灣', streamUrl: 'https://live.leanstream.co/ICRTFM-MP3' },
    { name: '台北愛樂古典音樂網 Philharmonia', genre: '台灣精緻古典／城市舒壓環境音', country: '台灣', streamUrl: 'https://stream.zeno.fm/0r0xa792kwzuv' }
  ],
  JP: [
    { name: 'J-Pop Sakura 櫻花東京流行電台', genre: '日本東京 J-Pop／澀谷街頭氛圍', country: '日本', streamUrl: 'https://cast1.torontocast.com:2170/;' },
    { name: 'ビーム FM 東京都市爵士與環境音', genre: '日本都會 City Pop／輕爵士', country: '日本', streamUrl: 'https://ice1.somafm.com/suburbsofgoa-128-mp3' }
  ],
  KR: [
    { name: 'BIG B Radio K-Pop 首爾韓流音樂台', genre: '韓國首爾弘大 K-Pop 即時熱播', country: '韓國', streamUrl: 'https://antares.dribbcast.com/proxy/kpop?mp=/s' }
  ],
  CH: [
    { name: 'Radio Swiss Classic 瑞士國家古典音樂台', genre: '瑞士阿爾卑斯山岳交響樂', country: '瑞士', streamUrl: 'https://stream.srg-ssr.ch/m/rsc_de/mp3_128' },
    { name: 'Radio Swiss Jazz 瑞士國家爵士音樂台', genre: '蘇黎世湖畔經典爵士', country: '瑞士', streamUrl: 'https://stream.srg-ssr.ch/m/rsj/mp3_128' }
  ],
  GB: [
    { name: 'Classic FM UK 倫敦皇家古典電台', genre: '英國倫敦泰晤士河畔古典樂', country: '英國', streamUrl: 'https://media-ice.musicradio.com/ClassicFMMP3' }
  ],
  FR: [
    { name: 'FIP Radio France 巴黎左岸音樂台', genre: '法國巴黎香榭麗舍／塞納河香頌爵士', country: '法國', streamUrl: 'https://icecast.radiofrance.fr/fip-midfi.mp3' }
  ],
  US: [
    { name: 'SomaFM Groove Salad 舊金山灣區環境電台', genre: '美國海岸 Chillout／環境電子', country: '美國', streamUrl: 'https://ice1.somafm.com/groovesalad-128-mp3' },
    { name: 'SomaFM Secret Agent 紐約都會爵士電台', genre: '美國都會 Lounge／復古爵士', country: '美國', streamUrl: 'https://ice1.somafm.com/secretagent-128-mp3' }
  ],
  NO: [
    { name: 'NRK Klassisk 挪威國家峽灣古典台', genre: '北歐挪威峽灣與極光交響樂', country: '挪威', streamUrl: 'https://lyd.nrk.no/nrk_radio_klassisk_mp3_h' }
  ],
  FI: [
    { name: 'Yle Klassinen 芬蘭拉普蘭極光古典台', genre: '北極圈拉普蘭靜謐古典環境音', country: '芬蘭', streamUrl: 'https://icecast.live.yle.fi/radio/YleKlassinen/icecast.audio' }
  ]
};

const TAIWAN_FIXED_HOLIDAYS = [
  { mmdd: '01-01', localName: '中華民國開國紀念日（元旦）', name: 'New Year\'s Day' },
  { mmdd: '02-28', localName: '和平紀念日', name: 'Peace Memorial Day' },
  { mmdd: '04-04', localName: '兒童節', name: 'Children\'s Day' },
  { mmdd: '04-05', localName: '民族掃墓節（清明節）', name: 'Tomb Sweeping Day' },
  { mmdd: '05-01', localName: '勞動節', name: 'Labor Day' },
  { mmdd: '10-10', localName: '中華民國國慶日（雙十節）', name: 'National Day' },
  { mmdd: '10-25', localName: '臺灣光復暨金門古寧頭大捷紀念日', name: 'Taiwan Retrocession Day' },
  { mmdd: '12-25', localName: '行憲紀念日／聖誕節', name: 'Constitution Day' }
];

const COUNTRY_NEWS_QUERY_MAP = {
  TW: '台灣 桃園 新北 台北 生活 交通',
  JP: '日本 東京 北海道 大阪 觀光 氣象',
  KR: '韓國 首爾 釜山 觀光',
  AU: '澳洲 雪梨 觀光',
  NZ: '紐西蘭 奧克蘭 觀光',
  SG: '新加坡 城市 觀光',
  TH: '泰國 曼谷 蘇美島 觀光',
  ID: '峇里島 印尼 觀光',
  HK: '香港 維多利亞港',
  AE: '杜拜 阿聯 觀光',
  SA: '沙烏地阿拉伯 吉達 紅海',
  CH: '瑞士 阿爾卑斯 蘇黎世 策馬特',
  GB: '英國 倫敦 泰晤士河',
  FR: '法國 巴黎 觀光',
  IT: '義大利 威尼斯 西西里',
  NL: '荷蘭 阿姆斯特丹 運河',
  DE: '德國 柏林',
  AT: '奧地利 薩爾茨堡 哈爾施塔特',
  ES: '西班牙 馬約卡 巴塞隆納',
  PT: '葡萄牙 馬德拉 里斯本',
  NO: '挪威 峽灣 極光 特羅姆瑟',
  FI: '芬蘭 羅瓦涅米 拉普蘭 極光',
  IS: '冰島 雷克雅維克 火山 極光',
  GL: '格陵蘭 冰川 極地',
  US: '美國 紐約 洛杉磯 夏威夷',
  CA: '加拿大 溫哥華 洛磯山',
  CR: '哥斯大黎加 熱帶雨林 生態',
  PA: '巴拿馬 運河 雨林',
  BR: '巴西 里約熱內盧',
  AR: '阿根廷 烏斯懷亞 南極',
  CW: '加勒比海 珊瑚礁 海洋'
};

function decodeXmlEntitiesSimple(str) {
  return String(str || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}

async function fetchLocalNewsHeadlines(cc = 'TW', cityHint = '') {
  const cleanCc = String(cc || 'TW').trim().toUpperCase();
  const baseQuery = COUNTRY_NEWS_QUERY_MAP[cleanCc] || `${cityHint || cleanCc} 國際新聞`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(baseQuery)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
  try {
    const xml = await fetchRemoteHtml(url, 2400);
    const items = [];
    const seenTitles = new Set();
    const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);
    for (const m of itemMatches) {
      const block = m[1];
      const rawTitle = decodeXmlEntitiesSimple((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
      const link = decodeXmlEntitiesSimple((block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '');
      const pubDate = decodeXmlEntitiesSimple((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '');
      let source = decodeXmlEntitiesSimple((block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '');
      let cleanTitle = normalizeIntlTwLabel(rawTitle);
      const dashIdx = cleanTitle.lastIndexOf(' - ');
      if (dashIdx > 8) {
        if (!source) source = cleanTitle.slice(dashIdx + 3).trim();
        cleanTitle = cleanTitle.slice(0, dashIdx).trim();
      }
      if (!cleanTitle || !link) continue;
      const dedupKey = cleanTitle.slice(0, 14);
      if (seenTitles.has(dedupKey)) continue;
      seenTitles.add(dedupKey);
      items.push({
        title: cleanTitle,
        source: normalizeIntlTwLabel(source || '即時新聞'),
        link,
        pubDate
      });
      if (items.length >= 4) break;
    }
    return items;
  } catch (_) {
    return [];
  }
}

let issTelemetryCache = { data: null, expireAt: 0 };
async function fetchIssTelemetry() {
  const now = Date.now();
  if (issTelemetryCache.data && now < issTelemetryCache.expireAt) {
    return issTelemetryCache.data;
  }
  try {
    const j = await fetchJsonWithRetry('https://api.wheretheiss.at/v1/satellites/25544', 0, 2200);
    if (j && Number.isFinite(Number(j.latitude)) && Number.isFinite(Number(j.longitude))) {
      const data = {
        lat: +Number(j.latitude).toFixed(4),
        lon: +Number(j.longitude).toFixed(4),
        altKm: +Number(j.altitude || 420).toFixed(1),
        velocityKmh: Math.round(Number(j.velocity || 27550)),
        visibility: String(j.visibility || 'daylight'),
        footprintKm: Math.round(Number(j.footprint || 4500)),
        timestamp: Number(j.timestamp) || Math.floor(now / 1000)
      };
      issTelemetryCache = { data, expireAt: now + 15000 };
      return data;
    }
  } catch (_) {}
  if (issTelemetryCache.data) return issTelemetryCache.data;
  // 克卜勒軌道參數即時推算備援 (週期 92.68 分鐘，傾角 51.64°)
  const tSec = now / 1000;
  const meanMotion = (2 * Math.PI) / 5560.8;
  const earthRot = (2 * Math.PI) / 86164;
  const lat = +(51.64 * Math.sin(meanMotion * tSec)).toFixed(4);
  const lon = +((((tSec * (meanMotion - earthRot) * 180) / Math.PI) % 360 + 540) % 360 - 180).toFixed(4);
  return {
    lat,
    lon,
    altKm: 421.8,
    velocityKmh: 27576,
    visibility: 'daylight',
    footprintKm: 4510,
    timestamp: Math.floor(tSec)
  };
}

function analyzeHourlyTideSeries(times = [], levels = []) {
  if (!Array.isArray(times) || !Array.isArray(levels) || levels.length < 6) return null;
  const nowMs = Date.now();
  let curIdx = 0;
  let minDiff = Infinity;
  for (let i = 0; i < times.length; i++) {
    const tMs = Date.parse(times[i] + 'Z');
    const diff = Math.abs(tMs - nowMs);
    if (Number.isFinite(diff) && diff < minDiff) {
      minDiff = diff;
      curIdx = i;
    }
  }
  const curVal = Number(levels[curIdx]);
  const nextVal = Number(levels[Math.min(levels.length - 1, curIdx + 1)]);
  if (!Number.isFinite(curVal)) return null;
  const isRising = Number.isFinite(nextVal) ? nextVal >= curVal : true;
  let nextHigh = null;
  let nextLow = null;
  for (let i = Math.max(1, curIdx); i < levels.length - 1; i++) {
    const prev = Number(levels[i - 1]);
    const v = Number(levels[i]);
    const nxt = Number(levels[i + 1]);
    if (!Number.isFinite(prev) || !Number.isFinite(v) || !Number.isFinite(nxt)) continue;
    const hhmm = String(times[i] || '').slice(11, 16);
    if (!nextHigh && v >= prev && v >= nxt && v > curVal - 0.05) {
      nextHigh = { time: hhmm, heightM: +v.toFixed(2) };
    }
    if (!nextLow && v <= prev && v <= nxt && v < curVal + 0.05) {
      nextLow = { time: hhmm, heightM: +v.toFixed(2) };
    }
    if (nextHigh && nextLow) break;
  }
  return {
    tideState: isRising ? 'RISING' : 'FALLING',
    tideLabelZh: isRising ? '漲潮中 ▲' : '退潮中 ▼',
    nextHighTide: nextHigh,
    nextLowTide: nextLow
  };
}

async function handleImmersiveLocalProxy(req, res, parsedUrl) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const lat = parseFloat(parsedUrl.searchParams.get('lat'));
  const lon = parseFloat(parsedUrl.searchParams.get('lon'));
  const rawCc = String(parsedUrl.searchParams.get('cc') || '').trim().toUpperCase();
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    res.writeHead(400);
    res.end(JSON.stringify({ success: false, error: '無效的經緯度參數' }));
    return;
  }

  const nearestAirport = findNearestAirportHub(lat, lon);
  const cc = /^[A-Z]{2}$/.test(rawCc) ? rawCc : (nearestAirport.countryCode || 'TW');
  const cacheKey = `${lat.toFixed(2)},${lon.toFixed(2)},${cc}`;
  const now = Date.now();
  const cached = cache.immersiveLocalMap.get(cacheKey);
  if (cached && now < cached.expireAt) {
    res.writeHead(200);
    res.end(cached.payload);
    return;
  }

  try {
    const fetchMarine = async () => {
      const u = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=wave_height,wave_direction,wave_period,swell_wave_height,sea_surface_temperature,ocean_current_velocity,ocean_current_direction,sea_level_height_msl&hourly=sea_level_height_msl&forecast_days=2`;
      const j = await fetchJsonWithRetry(u, 0, 2400);
      const cur = j?.current;
      if (!cur || (cur.wave_height == null && cur.sea_surface_temperature == null && cur.sea_level_height_msl == null)) return null;
      const tideInfo = analyzeHourlyTideSeries(j?.hourly?.time, j?.hourly?.sea_level_height_msl);
      return {
        waveHeightM: cur.wave_height != null ? +Number(cur.wave_height).toFixed(2) : null,
        waveDirDeg: cur.wave_direction != null ? Math.round(Number(cur.wave_direction)) : null,
        wavePeriodSec: cur.wave_period != null ? +Number(cur.wave_period).toFixed(1) : null,
        swellHeightM: cur.swell_wave_height != null ? +Number(cur.swell_wave_height).toFixed(2) : null,
        seaTempC: cur.sea_surface_temperature != null ? +Number(cur.sea_surface_temperature).toFixed(1) : null,
        seaLevelM: cur.sea_level_height_msl != null ? +Number(cur.sea_level_height_msl).toFixed(2) : null,
        currentVelKmh: cur.ocean_current_velocity != null ? +Number(cur.ocean_current_velocity).toFixed(1) : null,
        currentDirDeg: cur.ocean_current_direction != null ? Math.round(Number(cur.ocean_current_direction)) : null,
        tideState: tideInfo?.tideState || null,
        tideLabelZh: tideInfo?.tideLabelZh || null,
        nextHighTide: tideInfo?.nextHighTide || null,
        nextLowTide: tideInfo?.nextLowTide || null
      };
    };

    const fetchAlpine = async () => {
      const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=temperature_2m,snowfall,snow_depth&hourly=freezing_level_height&forecast_days=1`;
      const j = await fetchJsonWithRetry(u, 0, 2400);
      if (!j) return null;
      const elevM = Number.isFinite(Number(j.elevation)) ? Math.round(Number(j.elevation)) : null;
      const cur = j.current || {};
      const snowDepthCm = cur.snow_depth != null ? Math.round(Number(cur.snow_depth) * 100) : 0;
      const snowfallCmHr = cur.snowfall != null ? +Number(cur.snowfall).toFixed(1) : 0;
      const freezeArr = j.hourly?.freezing_level_height;
      const firstFreeze = Array.isArray(freezeArr) ? freezeArr.find(v => v != null && Number.isFinite(Number(v))) : null;
      const curTemp = Number(cur.temperature_2m);
      const freezingLevelM = firstFreeze != null
        ? Math.round(Number(firstFreeze))
        : (Number.isFinite(curTemp) ? (curTemp <= 0 ? 0 : Math.round((elevM || 0) + (curTemp / 6.5) * 1000)) : null);
      return {
        elevationM: elevM,
        snowDepthCm,
        snowfallCmHr,
        freezingLevelM
      };
    };

    const fetchRadios = async () => {
      const curated = [...(CURATED_LOCAL_RADIOS[cc] || CURATED_LOCAL_RADIOS.US || [])];
      try {
        const u = `https://de1.api.radio-browser.info/json/stations/search?countrycode=${encodeURIComponent(cc)}&limit=6&hidebroken=true&order=clickcount&reverse=true&is_https=true`;
        const arr = await fetchJsonWithRetry(u, 0, 1300);
        if (Array.isArray(arr)) {
          for (const s of arr) {
            const streamUrl = String(s?.url_resolved || s?.url || '').trim();
            const name = normalizeIntlTwLabel(String(s?.name || '').trim());
            if (!name || !/^https:\/\//i.test(streamUrl) || curated.some(c => c.streamUrl === streamUrl || c.name === name)) continue;
            curated.push({
              name: name.slice(0, 42),
              genre: normalizeIntlTwLabel(String(s?.tags || '').split(',').slice(0, 2).join(' ‧ ')) || '當地即時廣播',
              country: nearestAirport.country || cc,
              streamUrl
            });
          }
        }
      } catch (_) {}
      return curated.slice(0, 6);
    };

    const fetchLandmarks = async () => {
      const zhUrl = `https://zh.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${lat.toFixed(5)}%7C${lon.toFixed(5)}&gsradius=10000&gslimit=6&format=json&origin=*`;
      const zhJson = await fetchJsonWithRetry(zhUrl, 0, 2200).catch(() => null);
      let rawList = Array.isArray(zhJson?.query?.geosearch) ? zhJson.query.geosearch.map(x => ({ ...x, lang: 'zh' })) : [];
      if (rawList.length < 2) {
        const enUrl = `https://en.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${lat.toFixed(5)}%7C${lon.toFixed(5)}&gsradius=10000&gslimit=5&format=json&origin=*`;
        const enJson = await fetchJsonWithRetry(enUrl, 0, 2000).catch(() => null);
        const enList = Array.isArray(enJson?.query?.geosearch) ? enJson.query.geosearch.map(x => ({ ...x, lang: 'en' })) : [];
        rawList = [...rawList, ...enList];
      }
      const seen = new Set();
      const out = [];
      for (const item of rawList) {
        const title = normalizeIntlTwLabel(String(item?.title || '').trim());
        if (!title || seen.has(title)) continue;
        seen.add(title);
        const distMeters = Math.round(Number(item?.dist) || calcDistanceMeters(lat, lon, Number(item.lat), Number(item.lon)));
        const wikiUrl = item.lang === 'en'
          ? `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title)}`
          : `https://zh.wikipedia.org/zh-tw/${encodeURIComponent(item.title)}`;
        out.push({
          title,
          distMeters,
          lat: Number(item.lat),
          lon: Number(item.lon),
          url: wikiUrl,
          wikiUrl
        });
      }
      return out.slice(0, 5);
    };

    const fetchHolidays = async () => {
      const twNow = new Date(Date.now() + 8 * 3600000);
      const yr = twNow.getUTCFullYear();
      const todayIso = twNow.toISOString().slice(0, 10);
      if (cc === 'TW') {
        const list = [
          ...TAIWAN_FIXED_HOLIDAYS.map(h => ({ date: `${yr}-${h.mmdd}`, localName: h.localName, name: h.name, countryCode: 'TW' })),
          ...TAIWAN_FIXED_HOLIDAYS.map(h => ({ date: `${yr + 1}-${h.mmdd}`, localName: h.localName, name: h.name, countryCode: 'TW' }))
        ].filter(h => h.date >= todayIso);
        return list.slice(0, 3);
      }
      const arr = await fetchJsonWithRetry(`https://date.nager.at/api/v3/NextPublicHolidays/${encodeURIComponent(cc)}`, 0, 4200);
      if (!Array.isArray(arr)) return [];
      return arr.slice(0, 3).map(h => ({
        date: String(h.date || ''),
        localName: normalizeIntlTwLabel(String(h.localName || h.name || '')),
        name: String(h.name || ''),
        countryCode: cc
      }));
    };

    const [marineRes, alpineRes, radiosRes, landmarksRes, holidaysRes, newsRes, issRes] = await Promise.allSettled([
      fetchMarine(),
      fetchAlpine(),
      fetchRadios(),
      fetchLandmarks(),
      fetchHolidays(),
      fetchLocalNewsHeadlines(cc, nearestAirport.city),
      fetchIssTelemetry()
    ]);

    let issData = issRes.status === 'fulfilled' && issRes.value ? { ...issRes.value } : null;
    if (issData) {
      issData.distKm = Math.round(calcDistanceMeters(lat, lon, issData.lat, issData.lon) / 1000);
    }

    const payload = JSON.stringify({
      success: true,
      countryCode: cc,
      countryName: nearestAirport.country || cc,
      marine: marineRes.status === 'fulfilled' ? marineRes.value : null,
      alpine: alpineRes.status === 'fulfilled' ? alpineRes.value : null,
      iss: issData,
      news: newsRes.status === 'fulfilled' ? newsRes.value : [],
      radios: radiosRes.status === 'fulfilled' ? radiosRes.value : [],
      landmarks: landmarksRes.status === 'fulfilled' ? landmarksRes.value : [],
      holidays: holidaysRes.status === 'fulfilled' ? holidaysRes.value : [],
      fetchedAt: new Date().toISOString()
    });
    setBoundedMap(cache.immersiveLocalMap, cacheKey, { payload, expireAt: now + 180000 }, 160);
    res.writeHead(200);
    res.end(payload);
  } catch (err) {
    res.writeHead(502);
    res.end(JSON.stringify({ success: false, error: '無法取得身歷其境在地脈動資訊', detail: err.message }));
  }
}

// 跨裝置收藏牆與情境預設集 4 位數配對同步 (/api/wall-sync)
const crypto = require('crypto');
function handleWallSyncApi(req, res, parsedUrl) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const now = Date.now();
  for (const [k, v] of cache.wallSyncMap.entries()) {
    if (!v || now >= v.expireAt) cache.wallSyncMap.delete(k);
  }

  if (req.method === 'GET') {
    const code = String(parsedUrl.searchParams.get('code') || '').trim();
    if (!/^\d{4}$/.test(code)) {
      res.writeHead(400);
      res.end(JSON.stringify({ success: false, error: '請輸入有效的 4 位數配對編號' }));
      return;
    }
    const entry = cache.wallSyncMap.get(code);
    if (!entry || now >= entry.expireAt) {
      res.writeHead(404);
      res.end(JSON.stringify({ success: false, error: '配對編號不存在或已逾 20 分鐘有效期限' }));
      return;
    }
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, code, data: entry.data }));
    return;
  }

  if (req.method === 'POST') {
    const chunks = [];
    let totalBytes = 0;
    let aborted = false;
    req.setTimeout(6000, () => {
      aborted = true;
      if (!res.headersSent && !res.writableEnded) {
        res.writeHead(408);
        res.end(JSON.stringify({ success: false, error: '讀取同步內容逾時' }));
      }
      req.destroy();
    });
    req.on('error', () => {
      aborted = true;
      if (!res.headersSent && !res.writableEnded) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: '請求串流中斷' }));
      }
    });
    req.on('data', chunk => {
      if (aborted) return;
      totalBytes += chunk.length;
      if (totalBytes > 49152) {
        aborted = true;
        if (!res.headersSent && !res.writableEnded) {
          res.writeHead(413);
          res.end(JSON.stringify({ success: false, error: '同步資料超過容量上限' }));
        }
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted || res.headersSent || res.writableEnded) return;
      try {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        const parsed = JSON.parse(rawBody || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('格式無效');

        const cleanId = (v, def = '') => {
          const s = String(v || '').trim().slice(0, 80);
          return /^[A-Za-z0-9_.:-]+$/.test(s) && !/^(__proto__|constructor|prototype)$/i.test(s) ? s : def;
        };
        const safeFavorites = Array.isArray(parsed.favorites)
          ? parsed.favorites.slice(0, 80).map(v => cleanId(v)).filter(Boolean)
          : [];
        const safePresets = Array.isArray(parsed.presets)
          ? parsed.presets.slice(0, 12).map(p => {
            if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
            const id = cleanId(p.id);
            if (!id) return null;
            const iconRaw = String(p.icon || 'fa-star').trim();
            return {
              id,
              name: String(p.name || '精選視訊牆').trim().slice(0, 24),
              icon: /^fa-[a-z0-9-]{1,32}$/.test(iconRaw) ? iconRaw : 'fa-star',
              cameraIds: Array.isArray(p.cameraIds) ? p.cameraIds.slice(0, 80).map(v => cleanId(v)).filter(Boolean) : []
            };
          }).filter(Boolean)
          : [];
        const safeMeta = {};
        if (parsed.favoriteMeta && typeof parsed.favoriteMeta === 'object' && !Array.isArray(parsed.favoriteMeta)) {
          for (const [k, m] of Object.entries(parsed.favoriteMeta).slice(0, 80)) {
            const safeK = cleanId(k);
            if (!safeK || !m || typeof m !== 'object' || Array.isArray(m)) continue;
            const safeUrl = (u) => {
              const s = String(u || '').trim();
              if (!/^https?:\/\//i.test(s) || /["'<>\\\s\x00-\x1f]/.test(s)) return '';
              return s.slice(0, 400);
            };
            const allowedTypes = new Set(['hls', 'flv', 'mjpeg', 'snapshot', 'youtube', 'iframe']);
            const rawType = String(m.type || '').trim().toLowerCase();
            safeMeta[safeK] = {
              id: safeK,
              name: String(m.name || safeK).trim().slice(0, 80),
              areaTag: String(m.areaTag || '').trim().slice(0, 24),
              type: allowedTypes.has(rawType) ? rawType : 'youtube',
              videoId: /^[A-Za-z0-9_-]{6,20}$/.test(String(m.videoId || '')) ? String(m.videoId) : '',
              streamUrl: safeUrl(m.streamUrl),
              sourceUrl: safeUrl(m.sourceUrl),
              authority: String(m.authority || '').trim().slice(0, 60),
              lat: Number.isFinite(Number(m.lat)) ? Number(m.lat) : undefined,
              lon: Number.isFinite(Number(m.lon)) ? Number(m.lon) : undefined,
              maxRes: Number.isFinite(Number(m.maxRes)) ? Number(m.maxRes) : undefined
            };
          }
        }
        const safeData = {
          favorites: safeFavorites,
          presets: safePresets,
          activePresetId: cleanId(parsed.activePresetId, 'default') || 'default',
          favoriteMeta: safeMeta,
          syncedAt: new Date().toISOString()
        };
        let code = String(crypto.randomInt(1000, 10000));
        for (let tries = 0; tries < 25; tries++) {
          if (!cache.wallSyncMap.has(code)) break;
          code = String(crypto.randomInt(1000, 10000));
        }
        setBoundedMap(cache.wallSyncMap, code, { data: safeData, expireAt: now + 20 * 60000 }, 200);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, code, expiresInSec: 1200 }));
      } catch (e) {
        if (!res.headersSent && !res.writableEnded) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: '無法解析同步內容' }));
        }
      }
    });
    return;
  }

  res.writeHead(405);
  res.end(JSON.stringify({ success: false, error: '不支援的請求方法' }));
}

const STATIC_ROOT_ALLOWMAP = new Map([
  ['index.html', 'index.html'],
  ['manifest.json', 'manifest.json'],
  ['favicon.png', 'favicon.png'],
  ['dpulogo.jpg', 'dpuLogo.jpg'],
  ['dpulogo_icon.png', 'dpuLogo_icon.png']
]);

function runAsyncRoute(fn, req, res, ...args) {
  Promise.resolve(fn(req, res, ...args)).catch((err) => {
    if (!res.headersSent && !res.writableEnded && !res.destroyed) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.writeHead(500);
      res.end(JSON.stringify({ success: false, error: '伺服器內部處理異常', detail: err ? err.message : '' }));
    }
  });
}

// 建立 HTTP 伺服器
const server = http.createServer((req, res) => {
  let parsedUrl;
  let pathname;
  try {
    const rawReqUrl = String(req.url || '/');
    const qIdx = rawReqUrl.indexOf('?');
    const rawPathPart = qIdx >= 0 ? rawReqUrl.slice(0, qIdx) : rawReqUrl;
    const rawQueryPart = qIdx >= 0 ? rawReqUrl.slice(qIdx) : '';
    const safeReqUrl = '/' + rawPathPart.replace(/^[\/\\]+/, '') + rawQueryPart;
    const rawPathname = decodeURIComponent(rawPathPart);
    if (rawPathname.includes('\0') || rawPathname.includes(':') || rawPathname.split(/[\\/]/).some(seg => seg === '..')) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403 Forbidden');
      return;
    }
    parsedUrl = new URL(safeReqUrl, 'http://localhost');
    pathname = decodeURIComponent(parsedUrl.pathname);
    if (pathname.includes('\0') || pathname.includes(':') || pathname.split(/[\\/]/).some(seg => seg === '..')) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403 Forbidden');
      return;
    }
  } catch (_) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400 Bad Request');
    return;
  }

  // 1. 統一 API CORS 標頭與 OPTIONS 預檢處理
  if (pathname.startsWith('/api/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Cache-Control, Range, Authorization, X-Requested-With');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
  }

  if (pathname === '/api/health') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.writeHead(200);
    res.end(req.method === 'HEAD' ? '' : JSON.stringify({ ok: true, uptimeSec: Math.round(process.uptime()) }));
    return;
  }
  if (pathname === '/api/weather') {
    runAsyncRoute(handleWeatherProxy, req, res,
      parsedUrl.searchParams.get('lat'),
      parsedUrl.searchParams.get('lon'),
      parsedUrl.searchParams.get('tz')
    );
    return;
  }
  if (pathname === '/api/youbike/ntpc') {
    runAsyncRoute(handleYouBikeProxy, req, res, 'ntpc', NTPC_URL);
    return;
  }
  if (pathname === '/api/youbike/tycg') {
    runAsyncRoute(handleYouBikeProxy, req, res, 'tycg', TYCG_URL);
    return;
  }
  if (pathname === '/api/thsr/south') {
    runAsyncRoute(handleThsrProxy, req, res, 'south');
    return;
  }
  if (pathname === '/api/thsr/north') {
    runAsyncRoute(handleThsrProxy, req, res, 'north');
    return;
  }
  if (pathname === '/api/tymetro/south') {
    runAsyncRoute(handleTymetroProxy, req, res, 'south');
    return;
  }
  if (pathname === '/api/tymetro/north') {
    runAsyncRoute(handleTymetroProxy, req, res, 'north');
    return;
  }
  if (pathname === '/api/metro/liveboard') {
    runAsyncRoute(handleMetroLiveProxy, req, res);
    return;
  }
  if (pathname === '/api/metro/carweight') {
    const stationCode = parsedUrl.searchParams.get('station');
    runAsyncRoute(handleCarWeightProxy, req, res, stationCode);
    return;
  }
  if (pathname === '/api/parking/thsr') {
    runAsyncRoute(handleParkingThsrProxy, req, res);
    return;
  }
  if (pathname === '/api/geocode/taiwan') {
    runAsyncRoute(handleGeocodeTaiwanProxy, req, res, parsedUrl);
    return;
  }
  if (pathname === '/api/youbike/city') {
    runAsyncRoute(handleYouBikeCityProxy, req, res, parsedUrl);
    return;
  }
  if (pathname === '/api/bus/nearby') {
    runAsyncRoute(handleBusNearbyProxy, req, res, parsedUrl);
    return;
  }
  if (pathname === '/api/bus/route-stops') {
    runAsyncRoute(handleBusRouteStopsProxy, req, res, parsedUrl);
    return;
  }
  if (pathname === '/api/geocode/global') {
    runAsyncRoute(handleGeocodeGlobalProxy, req, res, parsedUrl);
    return;
  }
  if (pathname === '/api/transit/intl-nearby') {
    runAsyncRoute(handleIntlTransitNearbyProxy, req, res, parsedUrl);
    return;
  }
  if (pathname === '/api/transit/intl-trip') {
    runAsyncRoute(handleIntlTripStopsProxy, req, res, parsedUrl);
    return;
  }
  if (pathname === '/api/bikes/global') {
    runAsyncRoute(handleGlobalBikesProxy, req, res, parsedUrl);
    return;
  }
  if (pathname === '/api/rail/tra-nearby') {
    runAsyncRoute(handleTraNearbyProxy, req, res, parsedUrl);
    return;
  }
  if (pathname === '/api/parking/nearby') {
    runAsyncRoute(handleParkingNearbyProxy, req, res, parsedUrl);
    return;
  }
  if (pathname === '/api/freeway/live') {
    runAsyncRoute(handleFreewayLiveProxy, req, res);
    return;
  }
  if (pathname === '/api/travel/toolkit') {
    runAsyncRoute(handleTravelToolkitProxy, req, res);
    return;
  }
  if (pathname === '/api/flights/nearby') {
    runAsyncRoute(handleFlightsNearbyProxy, req, res, parsedUrl);
    return;
  }
  if (pathname === '/api/immersive/local') {
    runAsyncRoute(handleImmersiveLocalProxy, req, res, parsedUrl);
    return;
  }
  if (pathname === '/api/wall-sync') {
    runAsyncRoute(handleWallSyncApi, req, res, parsedUrl);
    return;
  }
  if (pathname === '/api/bote/prewarm') {
    runAsyncRoute(handleBotePrewarm, req, res, parsedUrl);
    return;
  }
  if (pathname.startsWith('/api/bote/')) {
    runAsyncRoute(handleBoteProxy, req, res, parsedUrl);
    return;
  }
  if (pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.writeHead(404);
    res.end(JSON.stringify({ success: false, error: '找不到指定的 API 端點' }));
    return;
  }

  // 2. 靜態檔案路由 (嚴格防範 Windows 不分大小寫、反斜線與尾部點空白繞過)
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('405 Method Not Allowed');
    return;
  }

  const rawRelPath = (pathname === '/' ? 'index.html' : pathname).replace(/^[\/\\]+/, '');
  const normRelPath = rawRelPath.replace(/\\/g, '/').replace(/\/+/g, '/');
  const normLower = normRelPath.toLowerCase();
  const hasBadSegment = normRelPath.split('/').some(seg => !seg || seg === '.' || seg === '..' || seg.startsWith('.') || /[. ]$/.test(seg));

  const isAllowedDataFile = normLower.startsWith('data/') && normLower.endsWith('.json') && !hasBadSegment;
  const isAllowedRootFile = STATIC_ROOT_ALLOWMAP.has(normLower) && !hasBadSegment;

  if (!normRelPath || hasBadSegment || (!isAllowedRootFile && !isAllowedDataFile)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  const resolvedRel = isAllowedRootFile ? STATIC_ROOT_ALLOWMAP.get(normLower) : normLower;
  const filePath = path.resolve(PUBLIC_DIR, resolvedRel);
  const relFromPub = path.relative(PUBLIC_DIR, filePath);
  if (!relFromPub || relFromPub.startsWith('..') || path.isAbsolute(relFromPub)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, normLower.startsWith('data/')
        ? { 'Content-Type': 'application/json; charset=utf-8' }
        : { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(normLower.startsWith('data/')
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
    const cacheCtrl = normLower.startsWith('data/') ? 'no-cache' : 'public, max-age=30';
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stats.size,
        'Cache-Control': cacheCtrl
      });
      res.end();
      return;
    }

    fs.readFile(filePath, (readErr, content) => {
      if (res.headersSent || res.writableEnded || res.destroyed) return;
      if (readErr) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('伺服器讀取檔案失敗');
        return;
      }
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': content.length,
        'Cache-Control': cacheCtrl
      });
      res.end(content);
    });
  });
});

server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.keepAliveTimeout = 5000;

if (require.main === module) {
  server.on('error', (err) => {
    console.error(`[雙埔監控系統] 伺服器啟動或運行異常 (${err.code || 'ERROR'}):`, err.message);
  });
  server.listen(PORT, () => {
    console.log(`[雙埔生活 × 世界即時之窗] 本機伺服器已啟動: http://localhost:${PORT}`);
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
server.handleParkingNearbyProxy = handleParkingNearbyProxy;
server.handleBusNearbyProxy = handleBusNearbyProxy;
server.handleTraNearbyProxy = handleTraNearbyProxy;
server.handleFreewayLiveProxy = handleFreewayLiveProxy;
server.handleFlightsNearbyProxy = handleFlightsNearbyProxy;
server.handleImmersiveLocalProxy = handleImmersiveLocalProxy;
server.fetchNearbyFlightsData = fetchNearbyFlightsData;
server.fetchLocalNewsHeadlines = fetchLocalNewsHeadlines;
server.fetchIssTelemetry = fetchIssTelemetry;
server.getTaiwanDateString = getTaiwanDateString;
server.decodeCompressedBuffer = decodeCompressedBuffer;
server.parseCsvToJson = parseCsvToJson;
server.parseTycgParkingXml = parseTycgParkingXml;
server.setBoundedMap = setBoundedMap;
server.twd97ToWgs84 = twd97ToWgs84;
server._internal = { cache, boteCookieJar, botePrewarmCooldown };

module.exports = server;
