# 雙埔生活即時環境與大眾運輸監控系統 (Taiwan Neighborhood Monitor)

提供新北（新埔／板橋）與桃園（青埔）雙核心生活圈之即時天氣、空氣品質、雷達回波、即時交通路網監控，以及雙埔核心 YouBike 2.0 官方即時車況動態看板。

## 官方即時資料來源

- **新北市 YouBike 2.0 即時資料**：
  - 資料集：新北市政府資料開放平台 [新北市公共自行車租賃系統(YouBike2.0)](https://data.ntpc.gov.tw/datasets/010e5b15-3823-4b20-b401-b1cf000550c5)
  - OpenAPI 規格：新北市政府交通局 OpenAPI (代碼 1130000)
- **桃園市 YouBike 2.0 即時資料**：
  - 資料集：桃園市政府資料開放平台 [桃園公共自行車即時服務資料](https://opendata.tycg.gov.tw/datalist/5ca2bfc7-9ace-4719-88ae-4034b9a5a55c)

## 啟動方式

### 方法一：使用內建輕量反向代理伺服器（推薦，支援 CORS 代理與 30 秒快取）
```bash
node server.js
```
伺服器啟動後，使用瀏覽器開啟 `http://localhost:3000` 即可檢視完整動態看板。

### 方法二：直接以靜態檔案瀏覽
直接以現代瀏覽器開啟 `index.html` 即可。系統內建多層備援連線機制，支援官方 OpenAPI 直連。
