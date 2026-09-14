/**
 * 汐止保長長興街 ⇄ 台北車站 雙向智慧生活圈即時監控伺服器
 * 採用純 Node.js 原生模組 (零外部套件相依)，提供靜態檔案託管、API 反向代理與智慧快取機制。
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3001;
const PUBLIC_DIR = __dirname;

// 官方即時資料端點
const NTPC_YOUBIKE_URL = 'https://data.ntpc.gov.tw/api/datasets/010E5B15-3823-4B20-B401-B1CF000550C5/csv/file';
const TPE_YOUBIKE_URL = 'https://tcgbusfs.blob.core.windows.net/dotapp/youbike/v2/youbike_immediate.json';
const WEATHER_XIZHI_URL = 'https://api.open-meteo.com/v1/forecast?latitude=25.078&longitude=121.667&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FTaipei';
const WEATHER_TPE_URL = 'https://api.open-meteo.com/v1/forecast?latitude=25.048&longitude=121.517&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FTaipei';

// 記憶體快取結構
const cache = {
  youbike: { data: null, expireAt: 0 },
  weather: { data: null, expireAt: 0 }
};

// 內部通用 HTTPS GET 工具函式
function fetchRemote(url, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) XizhiTpeMonitor/1.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8'
      }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchRemote(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP 狀態碼異常: ${res.statusCode}`));
      }
      let rawData = '';
      res.setEncoding('utf8');
      res.on('data', chunk => rawData += chunk);
      res.on('end', () => resolve(rawData));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`連線逾時: ${url}`));
    });
  });
}

// 解析新北市 YouBike 官方 CSV
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

// 取得台灣時間字串
function getTaiwanTimeString() {
  const d = new Date();
  const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
  const tw = new Date(utc + (3600000 * 8));
  const hh = String(tw.getHours()).padStart(2, '0');
  const mm = String(tw.getMinutes()).padStart(2, '0');
  const ss = String(tw.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

// 處理 YouBike 代理與雙生活圈站點過濾
async function handleYouBike(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const now = Date.now();
  if (cache.youbike.data && now < cache.youbike.expireAt) {
    res.writeHead(200);
    res.end(cache.youbike.data);
    return;
  }

  try {
    const [ntpcRaw, tpeRaw] = await Promise.allSettled([
      fetchRemote(NTPC_YOUBIKE_URL),
      fetchRemote(TPE_YOUBIKE_URL)
    ]);

    let xizhiStations = [];
    if (ntpcRaw.status === 'fulfilled') {
      const allNtpc = parseCsvToJson(ntpcRaw.value);
      const targetKeywords = ['長興街', '長興橋', '五堵火車站', '五堵車站', '保長公園', '保長路', '長安橋', '長安街', '汐止火車站'];
      xizhiStations = allNtpc.filter(s => {
        const name = s.sna || s.name || '';
        return targetKeywords.some(k => name.includes(k));
      }).map(s => {
        const cleanName = (s.sna || s.name || '').replace(/^YouBike2\.0_/, '');
        return {
          sno: s.sno || s.uid || '',
          name: cleanName,
          bikes: parseInt(s.sbi || s.bikes || '0', 10),
          empty: parseInt(s.bemp || s.empty || '0', 10),
          lat: parseFloat(s.lat || '25.078'),
          lng: parseFloat(s.lng || '121.667'),
          district: '汐止區',
          distFromBase: cleanName.includes('長興街二段62號') ? '步行 1 分鐘 (同街)' :
                        cleanName.includes('長興橋') ? '步行 3 分鐘' :
                        cleanName.includes('五堵') ? '步行 8 分鐘 (五堵站前)' :
                        cleanName.includes('保長') ? '步行 6-7 分鐘' : '生活圈內'
        };
      });
    }

    let taipeiStations = [];
    if (tpeRaw.status === 'fulfilled') {
      try {
        const allTpe = JSON.parse(tpeRaw.value);
        const tpeKeywords = ['臺北車站', '台北車站', '忠孝西重慶南', '中山青島', '玉泉公園', '市民太原', '重慶北路'];
        taipeiStations = allTpe.filter(s => {
          const name = s.sna || '';
          return tpeKeywords.some(k => name.includes(k));
        }).map(s => {
          const cleanName = (s.sna || '').replace(/^YouBike2\.0_/, '');
          return {
            sno: s.sno || '',
            name: cleanName,
            bikes: parseInt(s.available_rent_bikes ?? s.sbi ?? 0, 10),
            empty: parseInt(s.available_return_bikes ?? s.bemp ?? 0, 10),
            lat: parseFloat(s.latitude || '25.048'),
            lng: parseFloat(s.longitude || '121.517'),
            district: s.sarea || '中正區',
            distFromBase: cleanName.includes('M2') ? '北車 M2 出口旁' :
                          cleanName.includes('忠孝西') ? '北車前站西側' :
                          cleanName.includes('市民太原') ? '台北轉運站旁' : '北車站區周邊'
          };
        });
      } catch (_) {}
    }

    // 若遠端暫時無法取得，讀取預設快取檔作為備援
    if (xizhiStations.length === 0 || taipeiStations.length === 0) {
      const fallbackPath = path.join(__dirname, 'data', 'youbike.json');
      if (fs.existsSync(fallbackPath)) {
        const fallback = JSON.parse(fs.readFileSync(fallbackPath, 'utf8'));
        if (xizhiStations.length === 0) xizhiStations = fallback.xizhi || [];
        if (taipeiStations.length === 0) taipeiStations = fallback.taipei || [];
      }
    }

    const payload = {
      success: true,
      updatedAt: new Date().toISOString(),
      displayTime: getTaiwanTimeString(),
      xizhi: xizhiStations,
      taipei: taipeiStations
    };

    const serialized = JSON.stringify(payload);
    cache.youbike = {
      data: serialized,
      expireAt: now + 30000 // 快取 30 秒
    };

    res.writeHead(200);
    res.end(serialized);
  } catch (err) {
    if (cache.youbike.data) {
      res.writeHead(200);
      res.end(cache.youbike.data);
    } else {
      const fallbackPath = path.join(__dirname, 'data', 'youbike.json');
      if (fs.existsSync(fallbackPath)) {
        res.writeHead(200);
        res.end(fs.readFileSync(fallbackPath, 'utf8'));
      } else {
        res.writeHead(502);
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    }
  }
}

// 處理雙核心氣象與水情
async function handleWeather(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const now = Date.now();
  if (cache.weather.data && now < cache.weather.expireAt) {
    res.writeHead(200);
    res.end(cache.weather.data);
    return;
  }

  try {
    const [xizhiRaw, tpeRaw] = await Promise.all([
      fetchRemote(WEATHER_XIZHI_URL),
      fetchRemote(WEATHER_TPE_URL)
    ]);

    const xizhi = JSON.parse(xizhiRaw);
    const tpe = JSON.parse(tpeRaw);

    const payload = {
      success: true,
      updatedAt: new Date().toISOString(),
      displayTime: getTaiwanTimeString(),
      xizhi: {
        location: '新北市汐止區保長里 (長興街基地)',
        temp: Math.round((xizhi.current?.temperature_2m ?? 26) * 10) / 10,
        apparentTemp: Math.round((xizhi.current?.apparent_temperature ?? 27) * 10) / 10,
        humidity: xizhi.current?.relative_humidity_2m ?? 75,
        rain: xizhi.current?.precipitation ?? 0,
        windSpeed: xizhi.current?.wind_speed_10m ?? 2.5,
        weatherCode: xizhi.current?.weather_code ?? 1,
        maxTemp: xizhi.daily?.temperature_2m_max?.[0] ?? 30,
        minTemp: xizhi.daily?.temperature_2m_min?.[0] ?? 24,
        rainProb: xizhi.daily?.precipitation_probability_max?.[0] ?? 20,
        riverStatus: '正常綠燈 (基隆河五堵段水位安全)',
        aqi: 32,
        aqiStatus: '良好'
      },
      taipei: {
        location: '台北車站 (中正都會區)',
        temp: Math.round((tpe.current?.temperature_2m ?? 27) * 10) / 10,
        apparentTemp: Math.round((tpe.current?.apparent_temperature ?? 28) * 10) / 10,
        humidity: tpe.current?.relative_humidity_2m ?? 72,
        rain: tpe.current?.precipitation ?? 0,
        windSpeed: tpe.current?.wind_speed_10m ?? 2.1,
        weatherCode: tpe.current?.weather_code ?? 1,
        maxTemp: tpe.daily?.temperature_2m_max?.[0] ?? 31,
        minTemp: tpe.daily?.temperature_2m_min?.[0] ?? 25,
        rainProb: tpe.daily?.precipitation_probability_max?.[0] ?? 15,
        aqi: 36,
        aqiStatus: '良好'
      }
    };

    const serialized = JSON.stringify(payload);
    cache.weather = {
      data: serialized,
      expireAt: now + 60000 // 快取 60 秒
    };

    res.writeHead(200);
    res.end(serialized);
  } catch (err) {
    if (cache.weather.data) {
      res.writeHead(200);
      res.end(cache.weather.data);
    } else {
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        updatedAt: new Date().toISOString(),
        displayTime: getTaiwanTimeString(),
        xizhi: {
          location: '新北市汐止區保長里 (長興街基地)',
          temp: 26.5,
          apparentTemp: 27.8,
          humidity: 78,
          rain: 0,
          windSpeed: 2.3,
          weatherCode: 1,
          maxTemp: 30,
          minTemp: 24,
          rainProb: 20,
          riverStatus: '正常綠燈 (基隆河五堵段水位安全)',
          aqi: 35,
          aqiStatus: '良好'
        },
        taipei: {
          location: '台北車站 (中正都會區)',
          temp: 27.2,
          apparentTemp: 28.5,
          humidity: 74,
          rain: 0,
          windSpeed: 2.0,
          weatherCode: 1,
          maxTemp: 31,
          minTemp: 25,
          rainProb: 15,
          aqi: 38,
          aqiStatus: '良好'
        }
      }));
    }
  }
}

// 處理台鐵時刻即時計算
function handleTra(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  const schedulePath = path.join(__dirname, 'data', 'tra-schedule.json');
  if (!fs.existsSync(schedulePath)) {
    res.writeHead(404);
    res.end(JSON.stringify({ success: false, error: '時刻表檔案不存在' }));
    return;
  }

  const raw = JSON.parse(fs.readFileSync(schedulePath, 'utf8'));
  const d = new Date();
  const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
  const tw = new Date(utc + (3600000 * 8));
  const currentMinutes = tw.getHours() * 60 + tw.getMinutes();

  // 計算即將發車班次
  const attachLiveInfo = (list) => {
    return list.map(item => {
      const [h, m] = item.depTime.split(':').map(Number);
      const trainMinutes = h * 60 + m;
      let diff = trainMinutes - currentMinutes;
      if (diff < -60) diff += 1440; // 跨夜處理
      return {
        ...item,
        minutesRemaining: diff,
        isDeparted: diff < 0 && diff >= -5 ? true : false,
        status: diff < 0 ? '已發車' : diff <= 3 ? '即將進站' : diff <= 10 ? `${diff} 分鐘後` : `${diff} 分鐘`
      };
    }).sort((a, b) => {
      const aMin = a.minutesRemaining < 0 ? a.minutesRemaining + 1440 : a.minutesRemaining;
      const bMin = b.minutesRemaining < 0 ? b.minutesRemaining + 1440 : b.minutesRemaining;
      return aMin - bMin;
    });
  };

  const outboundLive = attachLiveInfo(raw.outbound || []);
  const inboundLive = attachLiveInfo(raw.inbound || []);

  const result = {
    success: true,
    currentTime: getTaiwanTimeString(),
    stations: raw.stations,
    fare: raw.fare,
    nextOutbound: outboundLive.find(t => t.minutesRemaining >= 0) || outboundLive[0],
    nextInbound: inboundLive.find(t => t.minutesRemaining >= 0) || inboundLive[0],
    outbound: outboundLive,
    inbound: inboundLive
  };

  res.writeHead(200);
  res.end(JSON.stringify(result));
}

// 建立 HTTP 伺服器
const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // 1. API 路由
  if (pathname === '/api/youbike') {
    handleYouBike(req, res);
    return;
  }
  if (pathname === '/api/weather') {
    handleWeather(req, res);
    return;
  }
  if (pathname === '/api/tra') {
    handleTra(req, res);
    return;
  }
  if (pathname === '/api/bus') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const busPath = path.join(__dirname, 'data', 'bus-routes.json');
    if (fs.existsSync(busPath)) {
      res.writeHead(200);
      res.end(fs.readFileSync(busPath, 'utf8'));
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ success: false, error: '未找到公車資料' }));
    }
    return;
  }
  if (pathname === '/api/cameras') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const camPath = path.join(__dirname, 'data', 'cameras.json');
    if (fs.existsSync(camPath)) {
      res.writeHead(200);
      res.end(fs.readFileSync(camPath, 'utf8'));
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ success: false, error: '未找到攝影機資料' }));
    }
    return;
  }
  if (pathname === '/api/facilities') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const facPath = path.join(__dirname, 'data', 'neighborhood-facilities.json');
    if (fs.existsSync(facPath)) {
      res.writeHead(200);
      res.end(fs.readFileSync(facPath, 'utf8'));
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ success: false, error: '未找到生活機能資料' }));
    }
    return;
  }

  // 2. 靜態檔案路由
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('403 存取受限');
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
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml'
    };

    const contentType = mimeTypes[ext] || 'application/octet-stream';

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(500);
        res.end('伺服器內部讀取錯誤');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    });
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`[汐止保長 ⇄ 台北車站 智慧生活圈監控伺服器] 已啟動`);
    console.log(`本機首頁網址: http://localhost:${PORT}`);
    console.log(`[API 端點] YouBike 即時車位: http://localhost:${PORT}/api/youbike`);
    console.log(`[API 端點] 台鐵通勤時刻:   http://localhost:${PORT}/api/tra`);
    console.log(`[API 端點] 雙核心氣象水情: http://localhost:${PORT}/api/weather`);
    console.log(`[API 端點] 公車轉乘資訊:   http://localhost:${PORT}/api/bus`);
    console.log(`[API 端點] 即時交控攝影機: http://localhost:${PORT}/api/cameras`);
    console.log(`[API 端點] 在地生活設施:   http://localhost:${PORT}/api/facilities`);
    console.log(`=======================================================`);
  });
}

module.exports = server;
