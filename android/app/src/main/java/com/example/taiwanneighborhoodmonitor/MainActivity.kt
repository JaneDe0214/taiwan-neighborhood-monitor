package com.example.taiwanneighborhoodmonitor

import android.annotation.SuppressLint
import android.app.UiModeManager
import android.content.Context
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * 雙埔生活 (新埔 ‧ 青埔) 原生 Android 應用程式
 * 雙平台深度最佳化支援：
 * 1. Google TV / Android TV 電視版：16:9 大螢幕交控電視牆、D-Pad 遙控器焦點導航、長亮防休眠
 * 2. Android 手機版：單手通勤快速瀏覽、雙埔微移動走廊、下拉強制更新
 * 3. 原生極速資料直透：硬體加速解碼、免 CORS、自動快取破除
 */
class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private var isTvDevice: Boolean = false
    private val scope = CoroutineScope(Dispatchers.Main)

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 1. 智慧識別設備類型 (Google TV / Android TV vs 手機版)
        isTvDevice = detectIsTvDevice(this)

        // 2. 電視模式下啟用常亮保持，防止電視牆休眠黑屏
        if (isTvDevice) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }

        // 3. 建立並配置全硬體加速的原生 WebView 視圖 (使用 LAYER_TYPE_NONE 交由 Chromium 內建管線加速，避免雙重離屏緩衝破圖黑塊)
        webView = WebView(this).apply {
            setLayerType(View.LAYER_TYPE_NONE, null)
            setBackgroundColor(android.graphics.Color.parseColor("#0a0e17"))
            isFocusable = true
            isFocusableInTouchMode = true
        }
        setContentView(webView)

        configureWebView(webView)

        // 4. 載入本機資產庫內建之全功能監控應用程式
        webView.loadUrl("file:///android_asset/index.html")
    }

    /**
     * 檢測設備是否為 Google TV 或 Android TV 電視盒子
     */
    private fun detectIsTvDevice(context: Context): Boolean {
        val uiModeManager = context.getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager
        if (uiModeManager?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION) {
            return true
        }
        return context.packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK)
    }

    /**
     * 最佳化 WebView 效能與網路直通配置
     */
    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView(wv: WebView) {
        val s = wv.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.useWideViewPort = true
        s.loadWithOverviewMode = true
        s.displayZoomControls = false
        s.builtInZoomControls = false
        s.allowFileAccess = true
        s.allowContentAccess = true
        @Suppress("DEPRECATION")
        s.allowFileAccessFromFileURLs = true
        @Suppress("DEPRECATION")
        s.allowUniversalAccessFromFileURLs = true

        // 允許即時視訊串流自動起播，無需使用者點擊
        s.mediaPlaybackRequiresUserGesture = false

        // 原生最高頻率：完全禁用舊快取，強迫每次請求獲取最新鮮數據
        s.cacheMode = WebSettings.LOAD_NO_CACHE

        // 支援混合內容以流暢播放各地交控中心 HTTP/HTTPS 監視器串流
        s.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW

        // 注入原生 JS 橋接器
        wv.addJavascriptInterface(AndroidNativeBridge(this, isTvDevice, wv), "AndroidBridge")

        wv.webChromeClient = object : WebChromeClient() {}

        wv.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                // 自動依據設備注入樣式類別與初始化腳本
                val modeClass = if (isTvDevice) "native-tv-mode" else "native-mobile-mode"
                val initJs = """
                    (function() {
                        document.body.classList.add('$modeClass');
                        if ($isTvDevice) {
                            // 電視版：調大字體與電視牆卡片比重，最佳化 3 公尺客廳視距
                            document.documentElement.style.setProperty('--tv-zoom', '1.15');
                        }
                    })();
                """.trimIndent()
                wv.evaluateJavascript(initJs, null)
            }

            /**
             * 原生網路攔截直通：當 Web 請求外部 API 時，可透過原生 HttpURLConnection 高速並行直取 (免 CORS)
             */
            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?
            ): WebResourceResponse? {
                val url = request?.url?.toString() ?: return null
                // 針對外部雲端資料庫與各官方 API 走原生網路連線，秒開且無 CORS 限制
                if (url.startsWith("http://") || url.startsWith("https://")) {
                    if (url.contains("raw.githubusercontent.com") || url.contains("janede0214.github.io") ||
                        url.contains("opendata.vip") || url.contains("tdx") || url.contains("data.ntpc.gov.tw") ||
                        url.contains("opendata.tycg.gov.tw") || url.contains("cwa.gov.tw") || url.contains("thsrc.com.tw")
                    ) {
                        try {
                            val nativeRes = fetchNativeUrl(url)
                            if (nativeRes != null) return nativeRes
                        } catch (_: Exception) {}
                    }
                }
                return super.shouldInterceptRequest(view, request)
            }
        }
    }

    /**
     * 原生網路請求實作 (免除瀏覽器 CORS 與 Mixed Content 限制)
     */
    private fun fetchNativeUrl(urlString: String): WebResourceResponse? {
        return try {
            val url = URL(urlString)
            val conn = (url.openConnection() as HttpURLConnection).apply {
                connectTimeout = 4000
                readTimeout = 4000
                requestMethod = "GET"
                setRequestProperty("User-Agent", "TaiwanNeighborhoodMonitor-Android/1.0")
            }
            conn.connect()
            if (conn.responseCode == 200) {
                val contentType = conn.contentType ?: "application/json"
                val mimeType = contentType.split(";")[0].trim()
                val encoding = if (contentType.contains("charset=")) contentType.split("charset=")[1].trim() else "utf-8"
                val bytes = conn.inputStream.readBytes()
                WebResourceResponse(mimeType, encoding, ByteArrayInputStream(bytes))
            } else {
                null
            }
        } catch (_: Exception) {
            null
        }
    }

    /**
     * 電視遙控器 D-Pad 支援與手勢攔截
     */
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> {
                // 電視遙控器確定鍵：觸發焦點元素點擊
                webView.evaluateJavascript("document.activeElement && document.activeElement.click();", null)
                return true
            }
            KeyEvent.KEYCODE_DPAD_DOWN -> {
                // 遙控器下鍵：平滑向下滾動視窗
                webView.scrollBy(0, 150)
                return true
            }
            KeyEvent.KEYCODE_DPAD_UP -> {
                // 遙控器上鍵：平滑向上滾動視窗
                webView.scrollBy(0, -150)
                return true
            }
            KeyEvent.KEYCODE_MENU -> {
                // 遙控器選單鍵：強制全域立即刷新所有資料
                triggerForceRefreshAll()
                return true
            }
            KeyEvent.KEYCODE_BACK -> {
                // 遙控器返回鍵：若 Modal 開啟先關閉 Modal，否則退出
                webView.evaluateJavascript("""
                    (function() {
                        const modal = document.getElementById('cameraModal');
                        if (modal && modal.classList.contains('active')) {
                            const closeBtn = document.getElementById('modalCloseBtn');
                            if (closeBtn) closeBtn.click();
                            return true;
                        }
                        return false;
                    })();
                """.trimIndent()) { result ->
                    if (result != "true") {
                        finish()
                    }
                }
                return true
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    /**
     * 強制全域立即刷新大眾運輸、車廂擁擠度與 YouBike 資料
     */
    private fun triggerForceRefreshAll() {
        webView.evaluateJavascript("""
            (function() {
                if (window.transitMonitor && typeof window.transitMonitor.forceRefreshAll === 'function') {
                    window.transitMonitor.forceRefreshAll();
                }
                if (window.weatherMonitor && typeof window.weatherMonitor.triggerAutoRefresh === 'function') {
                    window.weatherMonitor.triggerAutoRefresh();
                }
            })();
        """.trimIndent(), null)
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        // 前景喚醒時立即觸發最新資料更新
        triggerForceRefreshAll()
    }

    override fun onPause() {
        super.onPause()
        webView.onPause()
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}

/**
 * 原生與前端 JavaScript 交互橋接器
 */
class AndroidNativeBridge(
    private val activity: ComponentActivity,
    private val isTv: Boolean,
    private val webView: WebView
) {
    @JavascriptInterface
    fun isTvMode(): Boolean = isTv

    @JavascriptInterface
    fun getPlatformName(): String = if (isTv) "GoogleTV" else "AndroidMobile"

    /**
     * 原生直接以 HTTPS GET 抓取遠端字串 (免除瀏覽器同源 CORS 與 Mixed Content 限制，強化破快取時間戳)
     */
    @JavascriptInterface
    fun fetchHttp(urlString: String, timeoutMs: Int): String {
        return try {
            val sep = if (urlString.contains("?")) "&" else "?"
            val finalUrl = if (urlString.contains("_t=")) urlString else "${urlString}${sep}_t=${System.currentTimeMillis()}"
            val url = URL(finalUrl)
            val conn = (url.openConnection() as HttpURLConnection).apply {
                connectTimeout = if (timeoutMs > 0) timeoutMs else 4000
                readTimeout = if (timeoutMs > 0) timeoutMs else 4000
                useCaches = false
                defaultUseCaches = false
                requestMethod = "GET"
                setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14; Mobile) TaiwanNeighborhoodMonitor/1.0")
                setRequestProperty("Cache-Control", "no-cache, no-store, must-revalidate")
                setRequestProperty("Pragma", "no-cache")
                setRequestProperty("Accept", "application/json, text/plain, */*")
            }
            conn.connect()
            if (conn.responseCode in 200..299) {
                conn.inputStream.bufferedReader().use { it.readText() }
            } else {
                ""
            }
        } catch (_: Exception) {
            ""
        }
    }

    /**
     * 原生秒讀 Assets 內的資料快照
     */
    @JavascriptInterface
    fun fetchAsset(assetPath: String): String {
        return try {
            activity.assets.open(assetPath).bufferedReader().use { it.readText() }
        } catch (_: Exception) {
            ""
        }
    }

    /**
     * 原生秒級即時 YouBike 直取 (台灣 TDX / opendata.vip 即時開放資料 API，每 30 秒即時動態更新)
     * 策略：
     * 1. 優先直打新北與桃園即時 API (耗時僅 ~300ms，秒級真實車況，徹底跳脫 GitHub Actions 5~15 分鐘延遲)
     * 2. 備援 1：新北市政府官方全量 CSV 與桃園市政府官方即時 JSON
     * 3. 備援 2：GitHub 雲端每 5 分鐘 Actions 資料庫 (帶破快取時間戳)
     * 4. 備援 3：本地 Assets 快照
     */
    @JavascriptInterface
    fun getRealtimeYouBike(): String {
        // 1. 優先直打台灣 TDX 即時開放資料 API (opendata.vip，每分鐘動態更新)
        try {
            val ntpcRaw = fetchHttp("https://www.opendata.vip/tdx/youbikeApi/NewTaipei", 3500)
            val tycgRaw = fetchHttp("https://www.opendata.vip/tdx/youbikeApi/Taoyuan", 3500)
            if (ntpcRaw.isNotBlank() && tycgRaw.isNotBlank() && ntpcRaw.trim().startsWith("[") && tycgRaw.trim().startsWith("[")) {
                val now = java.text.SimpleDateFormat("HH:mm", java.util.Locale.TAIWAN).format(java.util.Date())
                return """{"success":true,"isDirectApi":true,"updateTimeDisplay":"$now","ntpc":$ntpcRaw,"tycg":$tycgRaw}"""
            }
        } catch (_: Exception) {}

        // 2. 備援 1：官方備援 API (桃園 JSON)
        try {
            val tycgDirect = fetchHttp("https://opendata.tycg.gov.tw/api/dataset/5ca2bfc7-9ace-4719-88ae-4034b9a5a55c/resource/08274d61-edbe-419d-8fcc-7a643831283d/download", 4000)
            val ntpcRaw = fetchHttp("https://www.opendata.vip/tdx/youbikeApi/NewTaipei", 3500)
            if (ntpcRaw.isNotBlank() && tycgDirect.isNotBlank()) {
                val now = java.text.SimpleDateFormat("HH:mm", java.util.Locale.TAIWAN).format(java.util.Date())
                return """{"success":true,"isDirectApi":true,"updateTimeDisplay":"$now","ntpc":$ntpcRaw,"tycg":$tycgDirect}"""
            }
        } catch (_: Exception) {}

        // 3. 備援 2：GitHub 雲端 Actions 資料庫 (帶時間戳防 CDN 快取)
        val cloudUrls = listOf(
            "https://raw.githubusercontent.com/JaneDe0214/taiwan-neighborhood-monitor/main/data/youbike.json",
            "https://janede0214.github.io/taiwan-neighborhood-monitor/data/youbike.json"
        )
        for (url in cloudUrls) {
            val res = fetchHttp(url, 3500)
            if (res.isNotBlank() && res.trim().startsWith("{")) {
                return res
            }
        }

        // 4. 備援 3：離線本地資產
        return fetchAsset("data/youbike.json")
    }

    /**
     * 解析捷運到站看板 HTML
     */
    private fun parseDepartureHtml(html: String, defaultStation: String): List<JSONObject> {
        val list = mutableListOf<JSONObject>()
        val regex = Regex("""<div class="departStation">\s*([^<]+)\s*</div>[\s\S]*?<div class="destinationStation">\s*([^<]+)\s*</div>[\s\S]*?class="countDown"[^>]*data-start="([^"]+)"""")
        for (m in regex.findAll(html)) {
            val from = m.groupValues[1].trim().ifEmpty { defaultStation }
            val to = m.groupValues[2].trim()
            val countdown = m.groupValues[3].trim()
            var totalSec = 0
            if (countdown.contains(":")) {
                val parts = countdown.split(":").mapNotNull { it.toIntOrNull() }
                if (parts.size >= 2) {
                    totalSec = parts[0] * 60 + parts[1]
                }
            } else if (countdown.contains("進站")) {
                totalSec = 20
            }
            val line = when {
                from.contains("民生") -> "環狀線"
                from.contains("板橋") && (to.contains("大坪林") || to.contains("產業園區")) -> "環狀線"
                else -> "板南線"
            }
            val item = JSONObject().apply {
                put("station", from)
                put("dest", to)
                put("countdownText", countdown)
                put("remainSec", totalSec)
                put("line", line)
            }
            list.add(item)
        }
        return list
    }

    /**
     * 解析捷運車廂載重擁擠度 HTML (1~6 車廂)
     */
    private fun parseCarWeightHtml(html: String, stationName: String, code: String): JSONObject {
        val carsArray = JSONArray()
        val carRegex = Regex("""<span class="carNum">([^<]+)</span>[\s\S]*?<span class="carWeight">([\s\S]*?)</span>""", RegexOption.IGNORE_CASE)
        val labelRegex = Regex("""class="label\s+([^"]+)"[^>]*>([^<]+)</label>""", RegexOption.IGNORE_CASE)
        val matches = carRegex.findAll(html).toList()

        for (cm in matches) {
            val carNum = cm.groupValues[1].trim()
            val raw = cm.groupValues[2]
            val lm = labelRegex.find(raw)
            var status = "舒適"
            var level = 1
            if (lm != null) {
                status = lm.groupValues[2].trim()
                val cls = lm.groupValues[1].lowercase()
                level = when {
                    cls.contains("danger") -> 4
                    cls.contains("warning") -> 3
                    cls.contains("info") || cls.contains("primary") -> 2
                    else -> 1
                }
            } else {
                val clean = raw.replace(Regex("<[^>]+>"), "").trim()
                status = clean.ifEmpty { "舒適" }
                level = when {
                    status.contains("擁擠") -> 4
                    status.contains("略擠") -> 3
                    status.contains("普通") || status.contains("適中") -> 2
                    else -> 1
                }
            }
            val carObj = JSONObject().apply {
                put("carNum", carNum)
                put("status", status)
                put("level", level)
            }
            carsArray.put(carObj)
        }

        var message = "即時更新中"
        val hasData = carsArray.length() > 0
        if (!hasData) {
            message = when {
                html.contains("尚無資料") -> "目前無列車停靠"
                html.contains("營運時間已過") -> "營運時間已過"
                else -> "離峰舒適運轉"
            }
            for (i in 1..6) {
                val carObj = JSONObject().apply {
                    put("carNum", "${i}車")
                    put("status", "舒適")
                    put("level", 1)
                }
                carsArray.put(carObj)
            }
        }

        return JSONObject().apply {
            put("station", stationName)
            put("code", code)
            put("line", "板南線")
            put("hasData", hasData)
            put("message", message)
            put("cars", carsArray)
        }
    }

    /**
     * 解析高鐵剩餘停車位 HTML
     */
    private fun parseParkingHtml(html: String): JSONArray {
        val lotsArray = JSONArray()
        val trRegex = Regex("""<tr[^>]*>([\s\S]*?)</tr>""", RegexOption.IGNORE_CASE)
        val tdRegex = Regex("""<td[^>]*>([\s\S]*?)</td>""", RegexOption.IGNORE_CASE)
        val tagRegex = Regex("""<[^>]+>""")

        for (tm in trRegex.findAll(html)) {
            val tr = tm.groupValues[1]
            if (tr.contains("桃園") || tr.contains("板橋")) {
                val tds = tdRegex.findAll(tr).map { it.groupValues[1] }.toList()
                if (tds.size >= 4) {
                    val name = tds[0].replace(tagRegex, "").trim()
                    val spaceText = tds[1].replace(tagRegex, "").trim()
                    val status = tds[3].replace(tagRegex, "").trim()
                    var available = 0
                    var total = 0
                    if (spaceText.contains("/")) {
                        val parts = spaceText.split("/").map { it.replace(Regex("[^0-9]"), "").toIntOrNull() ?: 0 }
                        if (parts.size >= 2) {
                            available = parts[0]
                            total = parts[1]
                        }
                    }
                    val lotObj = JSONObject().apply {
                        put("name", name)
                        put("available", available)
                        put("total", total)
                        put("spaceText", spaceText)
                        put("status", status)
                    }
                    lotsArray.put(lotObj)
                }
            }
        }
        return lotsArray
    }

    /**
     * 原生秒級即時捷運到站看板與車廂擁擠度直取 (opendata.vip 高速直打優先，免除 5 分鐘 Actions 延遲)
     * 平行並行抓取：新埔站到站看板、板橋站到站看板、BL08新埔車廂載重、BL07板橋車廂載重
     */
    @JavascriptInterface
    fun getRealtimeMetroLive(): String {
        // 1. 優先直接高速並行打 opendata.vip API (免除 CORS 限制，秒級最新鮮車廂擁擠度與列車進站)
        try {
            val result = runBlocking(Dispatchers.IO) {
                val xpDepDeferred = async { fetchHttp("https://www.opendata.vip/metro/departure/%E6%96%B0%E5%9F%94", 3500) }
                val bqDepDeferred = async { fetchHttp("https://www.opendata.vip/metro/departure/%E6%9D%BF%E6%A9%8B", 3500) }
                val bl08Deferred = async { fetchHttp("https://www.opendata.vip/metro/carWeight/BL/BL08", 3500) }
                val bl07Deferred = async { fetchHttp("https://www.opendata.vip/metro/carWeight/BL/BL07", 3500) }

                val xpDep = xpDepDeferred.await()
                val bqDep = bqDepDeferred.await()
                val bl08Html = bl08Deferred.await()
                val bl07Html = bl07Deferred.await()

                val allTrains = JSONArray()
                if (xpDep.isNotBlank()) {
                    parseDepartureHtml(xpDep, "新埔站").forEach { allTrains.put(it) }
                }
                if (bqDep.isNotBlank()) {
                    parseDepartureHtml(bqDep, "板橋站").forEach { allTrains.put(it) }
                }

                val carWeightObj = JSONObject()
                if (bl08Html.isNotBlank()) {
                    carWeightObj.put("BL08", parseCarWeightHtml(bl08Html, "新埔", "BL08"))
                }
                if (bl07Html.isNotBlank()) {
                    carWeightObj.put("BL07", parseCarWeightHtml(bl07Html, "板橋", "BL07"))
                }

                if (allTrains.length() > 0 || carWeightObj.length() > 0) {
                    val now = Date()
                    val timeStr = SimpleDateFormat("HH:mm", Locale.TAIWAN).format(now)
                    val isoStr = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.TAIWAN).apply {
                        timeZone = TimeZone.getTimeZone("UTC")
                    }.format(now)

                    JSONObject().apply {
                        put("success", true)
                        put("isDirectApi", true)
                        put("updatedAt", isoStr)
                        put("updateTimeDisplay", timeStr)
                        put("count", allTrains.length())
                        put("trains", allTrains)
                        put("carWeight", carWeightObj)
                    }.toString()
                } else {
                    null
                }
            }
            if (!result.isNullOrBlank()) {
                return result
            }
        } catch (_: Exception) {}

        // 2. 備援 1：GitHub 雲端 Actions 資料庫
        val cloudUrls = listOf(
            "https://raw.githubusercontent.com/JaneDe0214/taiwan-neighborhood-monitor/main/data/metro-live.json",
            "https://janede0214.github.io/taiwan-neighborhood-monitor/data/metro-live.json"
        )
        for (url in cloudUrls) {
            val res = fetchHttp(url, 3500)
            if (res.isNotBlank() && res.trim().startsWith("{")) {
                return res
            }
        }

        // 3. 備援 2：本地 Assets 快照
        return fetchAsset("data/metro-live.json")
    }

    /**
     * 原生秒級即時高鐵剩餘停車位直取 (opendata.vip 高鐵即時停車場 API)
     */
    @JavascriptInterface
    fun getRealtimeParking(): String {
        // 1. 優先直接高速打 opendata.vip 高鐵即時停車位 API
        try {
            val html = fetchHttp("https://www.opendata.vip/tdx/parkingTHSR", 3500)
            if (html.isNotBlank()) {
                val lotsArray = parseParkingHtml(html)
                if (lotsArray.length() > 0) {
                    val now = Date()
                    val timeStr = SimpleDateFormat("HH:mm", Locale.TAIWAN).format(now)
                    val isoStr = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.TAIWAN).apply {
                        timeZone = TimeZone.getTimeZone("UTC")
                    }.format(now)

                    return JSONObject().apply {
                        put("success", true)
                        put("isDirectApi", true)
                        put("updatedAt", isoStr)
                        put("updateTimeDisplay", timeStr)
                        put("count", lotsArray.length())
                        put("lots", lotsArray)
                    }.toString()
                }
            }
        } catch (_: Exception) {}

        // 2. 備援 1：GitHub 雲端 Actions 資料庫
        val cloudUrls = listOf(
            "https://raw.githubusercontent.com/JaneDe0214/taiwan-neighborhood-monitor/main/data/parking.json",
            "https://janede0214.github.io/taiwan-neighborhood-monitor/data/parking.json"
        )
        for (url in cloudUrls) {
            val res = fetchHttp(url, 3500)
            if (res.isNotBlank() && res.trim().startsWith("{")) {
                return res
            }
        }

        // 3. 備援 2：本地 Assets 快照
        return fetchAsset("data/parking.json")
    }

    /**
     * 原生 POST 請求實作 (支援高鐵官網班表查詢)
     */
    private fun postHttp(urlString: String, postData: String, timeoutMs: Int): String {
        return try {
            val url = URL(urlString)
            val conn = (url.openConnection() as HttpURLConnection).apply {
                connectTimeout = if (timeoutMs > 0) timeoutMs else 6000
                readTimeout = if (timeoutMs > 0) timeoutMs else 6000
                requestMethod = "POST"
                doOutput = true
                useCaches = false
                defaultUseCaches = false
                setRequestProperty("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
                setRequestProperty("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) TaiwanNeighborhoodMonitor/1.0")
                setRequestProperty("Referer", "https://www.thsrc.com.tw/ArticleContent/a3b630bb-1066-4352-a1ef-58c7b4e8ef7c")
                setRequestProperty("Origin", "https://www.thsrc.com.tw")
            }
            conn.outputStream.use { os ->
                os.write(postData.toByteArray(Charsets.UTF_8))
            }
            conn.connect()
            if (conn.responseCode in 200..299) {
                conn.inputStream.bufferedReader().use { it.readText() }
            } else {
                ""
            }
        } catch (_: Exception) {
            ""
        }
    }

    /**
     * 解析台灣高鐵官網回傳 JSON 資料
     */
    private fun parseOfficialThsr(jsonStr: String): JSONArray {
        val trainsArray = JSONArray()
        try {
            val root = JSONObject(jsonStr)
            val data = root.optJSONObject("data") ?: return trainsArray
            val depTable = data.optJSONObject("DepartureTable") ?: return trainsArray
            val trainItem = depTable.optJSONArray("TrainItem") ?: return trainsArray

            for (i in 0 until trainItem.length()) {
                val t = trainItem.getJSONObject(i)
                val trainNo = t.optString("TrainNumber", "")
                val depTime = t.optString("DepartureTime", "")
                val arrTime = t.optString("DestinationTime", "")
                if (depTime.isNotBlank() && arrTime.isNotBlank()) {
                    val depParts = depTime.split(":").mapNotNull { it.toIntOrNull() }
                    val arrParts = arrTime.split(":").mapNotNull { it.toIntOrNull() }
                    if (depParts.size >= 2 && arrParts.size >= 2) {
                        var duration = (arrParts[0] * 60 + arrParts[1]) - (depParts[0] * 60 + depParts[1])
                        if (duration < 0) duration += 1440
                        val isExpress = trainNo.startsWith("06") || trainNo.startsWith("6")
                        val item = JSONObject().apply {
                            put("trainNo", trainNo)
                            put("depTime", depTime)
                            put("arrTime", arrTime)
                            put("duration", if (duration > 0) duration else 12)
                            put("isExpress", isExpress)
                            put("type", if (isExpress) "6xx特快" else "8xx全停")
                            put("stopsAtTaoyuan", true)
                            put("depMinutes", depParts[0] * 60 + depParts[1])
                        }
                        trainsArray.put(item)
                    }
                }
            }
        } catch (_: Exception) {}
        return trainsArray
    }

    /**
     * 原生秒級即時台灣高鐵官方班表直取 (直打台灣高鐵官網查詢端點，南下/北上並行抓取，免除 5 分鐘 Actions 延遲)
     */
    @JavascriptInterface
    fun getRealtimeThsr(): String {
        try {
            val now = Date()
            val dateStr = SimpleDateFormat("yyyy/MM/dd", Locale.TAIWAN).format(now)
            val result = runBlocking(Dispatchers.IO) {
                val southPost = "SearchType=S&Lang=TW&StartStation=BanQiao&EndStation=TaoYuan&OutWardSearchDate=" +
                    java.net.URLEncoder.encode(dateStr, "UTF-8") + "&OutWardSearchTime=05%3A00&ReturnSearchDate=&ReturnSearchTime=&DiscountType="
                val northPost = "SearchType=S&Lang=TW&StartStation=TaoYuan&EndStation=BanQiao&OutWardSearchDate=" +
                    java.net.URLEncoder.encode(dateStr, "UTF-8") + "&OutWardSearchTime=05%3A00&ReturnSearchDate=&ReturnSearchTime=&DiscountType="

                val southDeferred = async { postHttp("https://www.thsrc.com.tw/TimeTable/Search", southPost, 6000) }
                val northDeferred = async { postHttp("https://www.thsrc.com.tw/TimeTable/Search", northPost, 6000) }

                val southRaw = southDeferred.await()
                val northRaw = northDeferred.await()

                val southTrains = parseOfficialThsr(southRaw)
                val northTrains = parseOfficialThsr(northRaw)

                if (southTrains.length() > 0 || northTrains.length() > 0) {
                    val isoStr = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.TAIWAN).apply {
                        timeZone = TimeZone.getTimeZone("UTC")
                    }.format(now)

                    JSONObject().apply {
                        put("date", dateStr)
                        put("updatedAt", isoStr)
                        put("isDirectApi", true)
                        put("south", JSONObject().apply {
                            put("count", southTrains.length())
                            put("trains", southTrains)
                        })
                        put("north", JSONObject().apply {
                            put("count", northTrains.length())
                            put("trains", northTrains)
                        })
                    }.toString()
                } else {
                    null
                }
            }
            if (!result.isNullOrBlank()) {
                return result
            }
        } catch (_: Exception) {}

        // 備援 1：GitHub 雲端 Actions 資料庫
        val cloudUrls = listOf(
            "https://raw.githubusercontent.com/JaneDe0214/taiwan-neighborhood-monitor/main/data/thsr.json",
            "https://janede0214.github.io/taiwan-neighborhood-monitor/data/thsr.json"
        )
        for (url in cloudUrls) {
            val res = fetchHttp(url, 3500)
            if (res.isNotBlank() && res.trim().startsWith("{")) {
                return res
            }
        }

        // 備援 2：本地 Assets 快照
        return fetchAsset("data/thsr.json")
    }

    /**
     * 解析桃園機場捷運官網 HTML 時刻表
     */
    private fun parseOfficialTymetro(html: String, isSouth: Boolean): JSONArray {
        val trainsArray = JSONArray()
        try {
            val tableRegex = Regex("""<table[\s\S]*?</table>""", RegexOption.IGNORE_CASE)
            val tables = tableRegex.findAll(html).map { it.value }.toList()
            val targetTableIndex = if (isSouth) 1 else 0
            val tbl = if (tables.size > targetTableIndex) tables[targetTableIndex] else return trainsArray

            val rowRegex = Regex("""<tr>([\s\S]*?)</tr>""", RegexOption.IGNORE_CASE)
            val thRegex = Regex("""<th[^>]*scope="row"[^>]*>(\d{1,2})</th>""", RegexOption.IGNORE_CASE)
            val tdRegex = Regex("""<td[\s\S]*?</td>""", RegexOption.IGNORE_CASE)
            val minRegex = Regex("""<i>(\d{1,2})</i>""", RegexOption.IGNORE_CASE)

            for (rm in rowRegex.findAll(tbl)) {
                val row = rm.groupValues[1]
                val hm = thRegex.find(row) ?: continue
                val h = hm.groupValues[1].padStart(2, '0')
                val hInt = h.toIntOrNull() ?: continue

                for (tdm in tdRegex.findAll(row)) {
                    val td = tdm.value
                    val mm = minRegex.find(td) ?: continue
                    val m = mm.groupValues[1].padStart(2, '0')
                    val mInt = m.toIntOrNull() ?: continue

                    val isExp = td.contains("直達車")
                    val isPeakA18 = td.contains("停靠A18") || td.contains("尖峰增停直達車")
                    val stopsAtA18 = !isExp || isPeakA18

                    if (!stopsAtA18) continue // 嚴格只保留停靠 A18 的班次

                    val depTime = "$h:$m"
                    val depMinutes = hInt * 60 + mInt
                    val duration = if (isExp) 28 else 38
                    val arrMinutes = depMinutes + duration
                    val arrH = String.format(Locale.TAIWAN, "%02d", (arrMinutes / 60) % 24)
                    val arrM = String.format(Locale.TAIWAN, "%02d", arrMinutes % 60)
                    val trainNoPrefix = if (isSouth) "A3➔A18" else "A18➔A3"

                    val item = JSONObject().apply {
                        put("trainNo", "$trainNoPrefix-$depTime")
                        put("depTime", depTime)
                        put("arrTime", "$arrH:$arrM")
                        put("duration", duration)
                        put("isExpress", isExp)
                        put("type", if (isExp) "尖峰直達" else "普通車")
                        put("depMinutes", depMinutes)
                        put("min", mInt)
                        put("stopsAtA18", true)
                    }
                    trainsArray.put(item)
                }
            }
        } catch (_: Exception) {}
        return trainsArray
    }

    /**
     * 原生秒級即時桃園機場捷運官方班表直取 (直打桃園捷運官網 A3 與 A18 時刻表，南下/北上並行抓取，免除 5 分鐘 Actions 延遲)
     */
    @JavascriptInterface
    fun getRealtimeTymetro(): String {
        try {
            val now = Date()
            val result = runBlocking(Dispatchers.IO) {
                val southDeferred = async { fetchHttp("https://www.tymetro.com.tw/tymetro-new/tw/_pages/travel-guide/timetable.php?station=A3", 6000) }
                val northDeferred = async { fetchHttp("https://www.tymetro.com.tw/tymetro-new/tw/_pages/travel-guide/timetable.php?station=A18", 6000) }

                val southHtml = southDeferred.await()
                val northHtml = northDeferred.await()

                val southTrains = parseOfficialTymetro(southHtml, true)
                val northTrains = parseOfficialTymetro(northHtml, false)

                if (southTrains.length() > 0 || northTrains.length() > 0) {
                    val dateStr = SimpleDateFormat("yyyy/MM/dd", Locale.TAIWAN).format(now)
                    val isoStr = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.TAIWAN).apply {
                        timeZone = TimeZone.getTimeZone("UTC")
                    }.format(now)

                    JSONObject().apply {
                        put("date", dateStr)
                        put("updatedAt", isoStr)
                        put("isDirectApi", true)
                        put("south", JSONObject().apply {
                            put("count", southTrains.length())
                            put("trains", southTrains)
                        })
                        put("north", JSONObject().apply {
                            put("count", northTrains.length())
                            put("trains", northTrains)
                        })
                    }.toString()
                } else {
                    null
                }
            }
            if (!result.isNullOrBlank()) {
                return result
            }
        } catch (_: Exception) {}

        // 備援 1：GitHub 雲端 Actions 資料庫
        val cloudUrls = listOf(
            "https://raw.githubusercontent.com/JaneDe0214/taiwan-neighborhood-monitor/main/data/tymetro.json",
            "https://janede0214.github.io/taiwan-neighborhood-monitor/data/tymetro.json"
        )
        for (url in cloudUrls) {
            val res = fetchHttp(url, 3500)
            if (res.isNotBlank() && res.trim().startsWith("{")) {
                return res
            }
        }

        // 備援 2：本地 Assets 快照
        return fetchAsset("data/tymetro.json")
    }

    /**
     * 原生整合獲取最新資料庫 (youbike, metro-live, parking, thsr, tymetro)
     * 策略：所有資料來源 (youbike、metro-live、parking、thsr、tymetro) 100% 全數走原生秒級直打開放資料與官方 API 優先！
     * 真正發揮 Android 原生不受同源 CORS 限制之最高頻極致新鮮度！
     * 若網路異常才平滑降級至 GitHub 雲端資料庫 -> 本地 Assets 快照，保證高可用性與零白屏！
     */
    @JavascriptInterface
    fun getLatestCloudData(dataType: String): String {
        if (dataType == "youbike") {
            return getRealtimeYouBike()
        }
        if (dataType == "metro" || dataType == "metro-live") {
            return getRealtimeMetroLive()
        }
        if (dataType == "parking") {
            return getRealtimeParking()
        }
        if (dataType == "thsr") {
            return getRealtimeThsr()
        }
        if (dataType == "tymetro") {
            return getRealtimeTymetro()
        }

        // 備援：其他類型嘗試 GitHub 雲端
        val cloudUrls = listOf(
            "https://raw.githubusercontent.com/JaneDe0214/taiwan-neighborhood-monitor/main/data/$dataType.json",
            "https://janede0214.github.io/taiwan-neighborhood-monitor/data/$dataType.json"
        )
        for (url in cloudUrls) {
            val res = fetchHttp(url, 3500)
            if (res.isNotBlank() && res.trim().startsWith("{")) {
                return res
            }
        }

        // 若雲端暫時逾時或處於離線狀態，秒級回傳 Assets 本地快照
        return fetchAsset("data/$dataType.json")
    }

    @JavascriptInterface
    fun forceRefreshAll() {
        activity.runOnUiThread {
            webView.evaluateJavascript("""
                if (window.transitMonitor && typeof window.transitMonitor.forceRefreshAll === 'function') {
                    window.transitMonitor.forceRefreshAll();
                }
                if (window.weatherMonitor && typeof window.weatherMonitor.triggerAutoRefresh === 'function') {
                    window.weatherMonitor.triggerAutoRefresh();
                }
            """.trimIndent(), null)
        }
    }
}
