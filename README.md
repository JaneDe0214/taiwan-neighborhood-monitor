# 雙埔生活 × 世界即時之窗 (Taiwan Neighborhood & World Live Window)

全維度跨區生活智慧監控、雙城通勤決策與**世界即時之窗 (World Live Window)** 多元高畫質實況平台。整合台灣「桃園青埔 ⇄ 板橋新埔」雙生活圈與全球 17 大主題分區、400+ 處 4K / 2K / 1080P 多來源即時影像（涵蓋**原生 HLS `.m3u8` 國際直連頻道、NOAA GOES-18/19 太空地球全幅 4K 衛星、中央氣象署向日葵 9 號真彩色衛星、NASA SDO 太陽天文台、歐洲阿爾卑斯 Panomax 360° 全幅實況、高公局與雙北桃官方交通 MJPEG/HLS 串流，以及全球 YouTube 4K 實況**）。

---

## 核心特色

1. **世界即時之窗 (World Live Window) 多元高畫質串流引擎**
   - **跨協定多來源支援**：不僅止於 YouTube，原生整合 **HLS (`.m3u8`)**、**FLV**、**MJPEG 即時串流**、**4K/2K 太空衛星與天文動態快照 (`NOAA GOES-18/19`、`CWA Himawari-9`、`NASA SDO`、`Panomax 360°`)** 及 **官方交控內嵌 (`BOTE`)**。
   - **智慧排序與多元篩選**：嚴格依「最高畫質 (`4K 2160P > 2K 1440P > 1080P`) ➔ 熱門程度 (`popScore`)」優先排序；支援一鍵篩選「多元直連 (非 YouTube 原生源)」、動態顯示各標籤命中數並自動隱藏零命中標籤。
   - **日夜極景 (Day/Night Solar Engine)**：內建 Spencer (1971) 天文太陽赤緯、均時差與大氣折射演算法，搭配全球 IANA 標準時區（自動處理夏令時間 DST），在台灣白天一鍵觀看地球另一端的璀璨夜景與極光、在台灣夜晚觀看全球陽光白晝與黃金晨昏。
   - **世界任意門與自訂視訊窗**：支援一鍵「🌍 任意門」隨機探索全球高畫質實況，並可自行新增任意 HLS `.m3u8`、MJPEG/影像或 YouTube 網址至個人收藏視訊牆。

2. **雙埔通勤走廊與全台即時交通整合**
   - **高鐵 × 機捷 × 北捷 × 環狀線**：即時整合台灣高鐵（板橋 ⇄ 桃園）、桃園機場捷運（A3 ⇄ A18）、台北捷運板南線與環狀線即時到站秒數、車廂擁擠度與「黃金出門倒數建議」。
   - **全台灣 YouBike 2.0 官方 CORS 直連**：直連微笑單車官方全台即時介面（涵蓋 9,800+ 站點、自動識別營運狀態與電輔車數量），並具備 TDX 與同源靜態快照三層備援。
   - **附近公車、台鐵誤點、路外停車場與國道時速**：整合內政部 NLSC 村里定位、TDX 公車路線與沿途站序、台鐵即時看板、雙北桃與高鐵 P1~P3 剩餘車位、高公局 TISV 國道走廊即時車速，以及**進站語音＋震動鬧鐘**。

3. **跨國在地化氣象、雷達、匯率與防災監測**
   - **雙引擎氣象與空品**：整合 Open-Meteo 與挪威氣象局 MET Norway 雙引擎、24 小時降雨機率曲線、7 日預報、US AQI 空氣品質與外出生活管家指標。
   - **地理雷達與跨國路網**：整合中央氣象署雷達、RainViewer 全球降水雷達圖層、Transitous / HeartRails / TfL / SBB 跨國大眾運輸與 CityBikes 全球共享單車。
   - **跨國旅遊百寶箱與地震快報**：即時新台幣雙向匯率換算、當地時差秒錶、NOAA 行星極光 Kp 指數，以及 USGS 顯著有感地震全螢幕語音告警。

4. **跨端體驗（Web / PWA / Android 手機 / Google TV 電視盒）**
   - 支援深色／淺色／跟隨系統主題、螢幕常亮防休眠 (Wake Lock)、子母畫面 (PiP)、單頁滿版模式、QR Code 與 4 位數配對碼跨裝置收藏牆同步，以及完整 Google TV D-Pad 遙控器方向鍵導覽。

---

## 環境需求與啟動方式

- **Node.js 版本**：建議 **Node.js 20+**（最低需求 Node.js 18+）
- **啟動本機伺服器（零外部 NPM 相依套件）**：
  ```bash
  node server.js
  ```
  啟動後請以瀏覽器開啟 `http://localhost:3000`（預設埠號 `3000`，可透過環境變數 `PORT` 調整）。
- **手動執行雲端資料同步腳本**：
  ```bash
  node scripts/sync-all.js
  ```
- **建置 Android 原生 Debug APK**：
  ```bash
  cd android
  ./gradlew testDebugUnitTest assembleDebug
  ```
  輸出路徑：`android/app/build/outputs/apk/debug/app-debug.apk`
