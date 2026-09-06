const https = require('https');
const fs = require('fs');
const path = require('path');

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NeighborhoodMonitor/1.0' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    }).on('error', reject);
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

const NTPC_URL = 'https://data.ntpc.gov.tw/api/datasets/010E5B15-3823-4B20-B401-B1CF000550C5/csv/file';
const TYCG_URL = 'https://opendata.tycg.gov.tw/api/dataset/5ca2bfc7-9ace-4719-88ae-4034b9a5a55c/resource/08274d61-edbe-419d-8fcc-7a643831283d/download';

async function sync() {
  console.log('[YouBike 同步] 正在抓取新北市與桃園市官方即時車況...');
  const [ntpcRaw, tycgRaw] = await Promise.all([
    fetchUrl(NTPC_URL),
    fetchUrl(TYCG_URL)
  ]);

  const ntpcList = parseCsvToJson(ntpcRaw);
  let tycgList = [];
  try {
    const parsed = JSON.parse(tycgRaw);
    tycgList = Array.isArray(parsed) ? parsed : (parsed.retVal || []);
  } catch (e) {
    console.error('桃園資料解析失敗:', e.message);
  }

  const d = new Date();
  const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
  const twDate = new Date(utc + (3600000 * 8));
  const hh = String(twDate.getHours()).padStart(2, '0');
  const mm = String(twDate.getMinutes()).padStart(2, '0');
  const updateTime = `${hh}:${mm}`;

  const payload = {
    updatedAt: twDate.toISOString(),
    updateTimeDisplay: updateTime,
    ntpcCount: ntpcList.length,
    tycgCount: tycgList.length,
    ntpc: ntpcList,
    tycg: tycgList
  };

  const outDir = path.join(__dirname, '../data');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const outFile = path.join(outDir, 'youbike.json');
  fs.writeFileSync(outFile, JSON.stringify(payload));
  console.log(`[YouBike 同步完成] 已儲存至 ${outFile}，新北: ${ntpcList.length} 站，桃園: ${tycgList.length} 站，更新時間: ${updateTime}`);
}

sync().catch(console.error);
