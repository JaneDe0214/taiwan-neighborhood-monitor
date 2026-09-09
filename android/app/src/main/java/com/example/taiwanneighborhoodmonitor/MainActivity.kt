package com.example.taiwanneighborhoodmonitor

import android.annotation.SuppressLint
import android.app.UiModeManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.net.Uri
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import okhttp3.ConnectionPool
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
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
    private lateinit var nativeBridge: AndroidNativeBridge

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 0. 放寬高階手機 I/O 限制與並行管線，支援大頻寬高速預載
        try {
            System.setProperty("http.maxConnections", "32")
            System.setProperty("http.keepAlive", "true")
        } catch (_: Exception) {}

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

        // 4. 背景立即非同步平行預熱所有大眾運輸與 YouBike 即時數據 (0 阻塞、秒開無白屏)
        nativeBridge.prewarmAllData()

        // 5. 載入本機資產庫內建之全功能監控應用程式
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
        @Suppress("DEPRECATION")
        s.databaseEnabled = true
        s.useWideViewPort = true
        s.loadWithOverviewMode = true
        s.displayZoomControls = false
        s.builtInZoomControls = false
        s.allowFileAccess = true
        s.allowContentAccess = true
        s.javaScriptCanOpenWindowsAutomatically = true
        @Suppress("DEPRECATION")
        s.allowFileAccessFromFileURLs = true
        @Suppress("DEPRECATION")
        s.allowUniversalAccessFromFileURLs = true

        // 允許即時視訊串流自動起播，無需使用者點擊
        s.mediaPlaybackRequiresUserGesture = false

        // 啟用智慧快取：讓本地 Assets、圖示、CSS/JS 庫秒速讀取，即時 API 則透過時間戳動態破除快取
        s.cacheMode = WebSettings.LOAD_DEFAULT
        @Suppress("DEPRECATION")
        s.setRenderPriority(WebSettings.RenderPriority.HIGH)

        // 支援混合內容以流暢播放各地交控中心 HTTP/HTTPS 監視器串流
        s.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW

        // 注入原生 JS 橋接器
        nativeBridge = AndroidNativeBridge(this, isTvDevice, wv)
        wv.addJavascriptInterface(nativeBridge, "AndroidBridge")

        wv.webChromeClient = object : WebChromeClient() {}

        wv.webViewClient = object : WebViewClient() {
            override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
                // 攔截 Chromium WebView 子進程崩潰，避免直接彈出顛倒 Android 機器人圖示
                try {
                    view?.let {
                        val parent = it.parent as? android.view.ViewGroup
                        parent?.removeView(it)
                        it.destroy()
                    }
                } catch (_: Exception) {}
                recreate()
                return true
            }

            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val uri = request?.url ?: return false
                val url = uri.toString()
                if (url.startsWith("https://www.google.com/maps") ||
                    url.startsWith("https://maps.google.com") ||
                    url.startsWith("http://maps.google.com") ||
                    url.startsWith("geo:")
                ) {
                    return try {
                        val intent = Intent(Intent.ACTION_VIEW, uri).apply {
                            flags = Intent.FLAG_ACTIVITY_NEW_TASK
                        }
                        this@MainActivity.startActivity(intent)
                        true
                    } catch (e: Exception) {
                        try {
                            val browserIntent = Intent(Intent.ACTION_VIEW, uri).apply {
                                flags = Intent.FLAG_ACTIVITY_NEW_TASK
                            }
                            this@MainActivity.startActivity(browserIntent)
                            true
                        } catch (_: Exception) {
                            false
                        }
                    }
                }
                return super.shouldOverrideUrlLoading(view, request)
            }

            @Deprecated("Deprecated in Java")
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                if (url == null) return false
                if (url.startsWith("https://www.google.com/maps") ||
                    url.startsWith("https://maps.google.com") ||
                    url.startsWith("http://maps.google.com") ||
                    url.startsWith("geo:")
                ) {
                    return try {
                        val uri = Uri.parse(url)
                        val intent = Intent(Intent.ACTION_VIEW, uri).apply {
                            flags = Intent.FLAG_ACTIVITY_NEW_TASK
                        }
                        this@MainActivity.startActivity(intent)
                        true
                    } catch (e: Exception) {
                        try {
                            val browserIntent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                                flags = Intent.FLAG_ACTIVITY_NEW_TASK
                            }
                            this@MainActivity.startActivity(browserIntent)
                            true
                        } catch (_: Exception) {
                            false
                        }
                    }
                }
                return super.shouldOverrideUrlLoading(view, url)
            }

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
                        } else {
                            // 手機版：優先展開交通即時走廊，讓通勤者掌握出門搭車與騎車班況
                            if (window.transitMonitor && window.transitMonitor.isCollapsed) {
                                window.transitMonitor.isCollapsed = false;
                                window.transitMonitor.render();
                            }
                        }
                    })();
                """.trimIndent()
                wv.evaluateJavascript(initJs, null)
            }

            /**
             * 原生網路攔截直通：當 Web 請求外部 API 或串流時，可透過原生 HttpURLConnection 高速並行直取 (免 CORS、免 Referer 限制)
             */
            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?
            ): WebResourceResponse? {
                val url = request?.url?.toString() ?: return null
                if (url.startsWith("http://") || url.startsWith("https://")) {
                    // 針對臺北市交工處 HLS 串流與即時視訊資源進行原生代抓 (精準注入 Referer 與 CORS 標頭，徹底消除 403 與 iframe 破圖)
                    if (url.contains("hls.bote.gov.taipei")) {
                        try {
                            val boteRes = fetchNativeBoteUrl(url)
                            if (boteRes != null) return boteRes
                        } catch (_: Exception) {}
                    } else if (url.contains("raw.githubusercontent.com") || url.contains("janede0214.github.io") ||
                        url.contains("opendata.vip") || url.contains("tdx") || url.contains("data.ntpc.gov.tw") ||
                        url.contains("opendata.tycg.gov.tw") || url.contains("cwa.gov.tw") || url.contains("thsrc.com.tw") ||
                        url.contains("earthquake.usgs.gov")
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
     * 臺北市交通管制工程處 (hls.bote.gov.taipei) 專屬原生高速代理直透實作
     * 1. 精準注入官方防盜鏈驗證標頭 (Referer: https://hls.bote.gov.taipei/live/index.html)
     * 2. 自動分配標準視訊切片 MIME Type (.m3u8 -> application/vnd.apple.mpegurl, .ts -> video/mp2t)
     * 3. 注入 Access-Control-Allow-Origin: * 消除瀏覽器同源限制
     * 4. 消除 CSP 與 X-Frame-Options 限制，確保原生硬體解碼與 iframe 雙重暢通
     */
    private fun fetchNativeBoteUrl(urlString: String): WebResourceResponse? {
        return try {
            val url = URL(urlString)
            val conn = (url.openConnection() as HttpURLConnection).apply {
                connectTimeout = 5000
                readTimeout = 10000
                requestMethod = "GET"
                setRequestProperty("Referer", "https://hls.bote.gov.taipei/live/index.html")
                setRequestProperty("Origin", "https://hls.bote.gov.taipei")
                setRequestProperty("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
                instanceFollowRedirects = true
            }
            conn.connect()
            val code = conn.responseCode
            if (code in 200..299) {
                val rawContentType = conn.contentType ?: ""
                val isM3u8 = urlString.contains(".m3u8")
                val isTs = urlString.contains(".ts")
                val isBinary = isTs || urlString.contains(".png") || urlString.contains(".jpg") || urlString.contains(".ico")

                val mimeType = when {
                    isM3u8 -> "application/vnd.apple.mpegurl"
                    isTs -> "video/mp2t"
                    urlString.contains(".js") -> "application/javascript"
                    urlString.contains(".css") -> "text/css"
                    urlString.contains(".html") || (urlString.contains("/live/") && !urlString.contains(".")) -> "text/html"
                    rawContentType.isNotEmpty() -> rawContentType.split(";")[0].trim()
                    else -> "application/octet-stream"
                }

                // 核心關鍵修復：針對二進位視訊切片 (.ts) 與圖檔，encoding 必須傳入 null！
                // 傳入 "utf-8" 會強制 Chromium 進行字串解碼，導致二進位位元組串流損毀造成 Hls.js demux 失敗黑畫面！
                val encoding = if (isBinary) null else {
                    if (rawContentType.contains("charset=")) {
                        rawContentType.split("charset=")[1].trim()
                    } else {
                        "utf-8"
                    }
                }

                val bytes = conn.inputStream.use { it.readBytes() }

                val headers = mutableMapOf<String, String>()
                headers["Access-Control-Allow-Origin"] = "*"
                headers["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS"
                headers["Access-Control-Allow-Headers"] = "*"
                headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
                headers["Content-Length"] = bytes.size.toString()
                headers["Accept-Ranges"] = "bytes"

                WebResourceResponse(
                    mimeType,
                    encoding,
                    200,
                    "OK",
                    headers,
                    ByteArrayInputStream(bytes)
                )
            } else {
                null
            }
        } catch (_: Exception) {
            null
        }
    }

    /**
     * 原生網路請求實作 (免除瀏覽器 CORS 與 Mixed Content 限制，流式直通)
     */
    private fun fetchNativeUrl(urlString: String): WebResourceResponse? {
        return try {
            val url = URL(urlString)
            val conn = (url.openConnection() as HttpURLConnection).apply {
                connectTimeout = 3000
                readTimeout = 4000
                requestMethod = "GET"
                setRequestProperty("User-Agent", "TaiwanNeighborhoodMonitor-Android/1.0")
            }
            conn.connect()
            if (conn.responseCode in 200..299) {
                val contentType = conn.contentType ?: "application/json"
                val mimeType = contentType.split(";")[0].trim()
                val encoding = if (contentType.contains("charset=")) contentType.split("charset=")[1].trim() else "utf-8"
                WebResourceResponse(mimeType, encoding, java.io.BufferedInputStream(conn.inputStream, 16384))
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
        nativeBridge.cancelScope()
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
    private val bridgeScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val dataMemoryCache = ConcurrentHashMap<String, String>()
    private val isRefreshing = ConcurrentHashMap<String, Boolean>()

    /**
     * 取消所有背景協程，防止 Activity 銷毀後記憶體洩漏
     */
    fun cancelScope() {
        bridgeScope.cancel()
    }

    @JavascriptInterface
    fun isTvMode(): Boolean = isTv

    @JavascriptInterface
    fun getPlatformName(): String = if (isTv) "GoogleTV" else "AndroidMobile"

    /**
     * 原生呼叫外部 Intent 開啟地圖 (支援 Google 地圖 App 或系統瀏覽器)
     */
    @JavascriptInterface
    fun openExternalMap(url: String) {
        activity.runOnUiThread {
            try {
                val uri = Uri.parse(url)
                val intent = Intent(Intent.ACTION_VIEW, uri).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK
                }
                activity.startActivity(intent)
            } catch (e: Exception) {
                try {
                    val browserIntent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK
                    }
                    activity.startActivity(browserIntent)
                } catch (_: Exception) {}
            }
        }
    }

    /**
     * 高效能 OkHttpClient 單例 (配備連線池、HTTP/2 多路複用與 Transparent Gzip 解壓縮)
     */
    private val okHttpClient: OkHttpClient = OkHttpClient.Builder()
        .connectionPool(ConnectionPool(10, 5, TimeUnit.MINUTES))
        .connectTimeout(4000, TimeUnit.MILLISECONDS)
        .readTimeout(4000, TimeUnit.MILLISECONDS)
        .retryOnConnectionFailure(true)
        .build()

    /**
     * 原生直接以 HTTPS GET 抓取遠端字串 (免除瀏覽器同源 CORS 與 Mixed Content 限制，強化破快取時間戳)
     */
    @JavascriptInterface
    fun fetchHttp(urlString: String, timeoutMs: Int): String {
        return try {
            val sep = if (urlString.contains("?")) "&" else "?"
            val finalUrl = if (urlString.contains("_t=")) urlString else "${urlString}${sep}_t=${System.currentTimeMillis()}"
            val request = Request.Builder()
                .url(finalUrl)
                .header("User-Agent", "Mozilla/5.0 (Linux; Android 14; Mobile) TaiwanNeighborhoodMonitor/1.0")
                .header("Cache-Control", "no-cache, no-store, must-revalidate")
                .header("Pragma", "no-cache")
                .header("Accept", "application/json, text/plain, */*")
                .build()

            val client = if (timeoutMs > 0 && timeoutMs != 4000) {
                okHttpClient.newBuilder()
                    .connectTimeout(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
                    .readTimeout(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
                    .build()
            } else {
                okHttpClient
            }

            client.newCall(request).execute().use { response ->
                if (response.isSuccessful) {
                    response.body?.string() ?: ""
                } else {
                    ""
                }
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
     * 原生 POST 請求實作 (支援高鐵官網班表查詢，使用 OkHttp 高效連線池)
     */
    private fun postHttp(urlString: String, postData: String, timeoutMs: Int): String {
        return try {
            val mediaType = "application/x-www-form-urlencoded; charset=UTF-8".toMediaType()
            val body = postData.toRequestBody(mediaType)
            val request = Request.Builder()
                .url(urlString)
                .post(body)
                .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) TaiwanNeighborhoodMonitor/1.0")
                .header("Referer", "https://www.thsrc.com.tw/ArticleContent/a3b630bb-1066-4352-a1ef-58c7b4e8ef7c")
                .header("Origin", "https://www.thsrc.com.tw")
                .build()

            val client = if (timeoutMs > 0 && timeoutMs != 6000) {
                okHttpClient.newBuilder()
                    .connectTimeout(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
                    .readTimeout(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
                    .build()
            } else {
                okHttpClient
            }

            client.newCall(request).execute().use { response ->
                if (response.isSuccessful) {
                    response.body?.string() ?: ""
                } else {
                    ""
                }
            }
        } catch (_: Exception) {
            ""
        }
    }

    /**
     * 背景非同步通知 WebView 前端最新資料已更新完成，平滑重繪 UI (交通走廊與全天候指標同步刷新)
     */
    private fun notifyDataUpdated(dataType: String) {
        activity.runOnUiThread {
            webView.evaluateJavascript("""
                (function() {
                    if (window.transitMonitor && typeof window.transitMonitor.forceRefreshAll === 'function') {
                        window.transitMonitor.forceRefreshAll();
                    }
                    if (window.weatherMonitor) {
                        if (typeof window.weatherMonitor.fetchRealtimeYouBike === 'function') {
                            window.weatherMonitor.fetchRealtimeYouBike(true);
                        }
                        if (typeof window.weatherMonitor.triggerAutoRefresh === 'function') {
                            window.weatherMonitor.triggerAutoRefresh();
                        }
                    }
                })();
            """.trimIndent(), null)
        }
    }

    /**
     * 前端 DOMContentLoaded 就緒雙向握手：打開 App 即刻主動推送最新數據，消除載入延遲
     */
    @JavascriptInterface
    fun onFrontendReady() {
        bridgeScope.launch(Dispatchers.Main) {
            notifyDataUpdated("ready")
        }
    }

    /**
     * 啟動時毫秒級預熱所有資料庫快照，並於背景非同步並行拉取全台交通即時最新動態 (0 毫秒秒開、0 白屏、0 阻塞)
     */
    fun prewarmAllData() {
        bridgeScope.launch(Dispatchers.IO) {
            val prewarmKeys = listOf("youbike", "metro-live", "parking", "thsr", "tymetro")
            for (key in prewarmKeys) {
                try {
                    val text = activity.assets.open("data/$key.json").bufferedReader().use { it.readText() }
                    if (text.isNotBlank()) {
                        dataMemoryCache[key] = text
                    }
                } catch (_: Exception) {}
            }

            // 全並行背景預取最新即時資料 (完全不阻塞主執行緒)
            launch { refreshYouBikeAsync() }
            launch { refreshMetroLiveAsync() }
            launch { refreshParkingAsync() }
            launch { refreshThsrAsync() }
            launch { refreshTymetroAsync() }
        }
    }

    /**
     * 背景非同步拉取 YouBike 即時開放資料 (TDX / 桃園官方 / 雲端)
     */
    private suspend fun refreshYouBikeAsync(force: Boolean = false) = withContext(Dispatchers.IO) {
        if (!force && isRefreshing.putIfAbsent("youbike", true) != null) return@withContext
        try {
            // 1. 優先直打台灣 TDX 即時開放資料 API (opendata.vip，每分鐘動態更新)
            try {
                val ntpcDeferred = async { fetchHttp("https://www.opendata.vip/tdx/youbikeApi/NewTaipei", 3500) }
                val tycgDeferred = async { fetchHttp("https://www.opendata.vip/tdx/youbikeApi/Taoyuan", 3500) }
                val ntpcRaw = ntpcDeferred.await()
                val tycgRaw = tycgDeferred.await()

                fun isValidJsonArray(raw: String?): Boolean {
                    val trimmed = raw?.trim() ?: return false
                    return trimmed.startsWith("[") && trimmed.endsWith("]")
                }
                val safeNtpc = if (isValidJsonArray(ntpcRaw)) ntpcRaw else "[]"
                val safeTycg = if (isValidJsonArray(tycgRaw)) tycgRaw else "[]"

                if (isValidJsonArray(ntpcRaw) || isValidJsonArray(tycgRaw)) {
                    val now = SimpleDateFormat("HH:mm", Locale.TAIWAN).format(Date())
                    val json = """{"success":true,"isDirectApi":true,"updateTimeDisplay":"$now","ntpc":$safeNtpc,"tycg":$safeTycg}"""
                    dataMemoryCache["youbike"] = json
                    notifyDataUpdated("youbike")
                    return@withContext
                }
            } catch (_: Exception) {}

            // 2. 備援 1：官方備援 API (桃園 JSON)
            try {
                val tycgDirect = fetchHttp("https://opendata.tycg.gov.tw/api/dataset/5ca2bfc7-9ace-4719-88ae-4034b9a5a55c/resource/08274d61-edbe-419d-8fcc-7a643831283d/download", 4000)
                val ntpcRaw = fetchHttp("https://www.opendata.vip/tdx/youbikeApi/NewTaipei", 3500)
                if (ntpcRaw.isNotBlank() && tycgDirect.isNotBlank()) {
                    val now = SimpleDateFormat("HH:mm", Locale.TAIWAN).format(Date())
                    val json = """{"success":true,"isDirectApi":true,"updateTimeDisplay":"$now","ntpc":$ntpcRaw,"tycg":$tycgDirect}"""
                    dataMemoryCache["youbike"] = json
                    notifyDataUpdated("youbike")
                    return@withContext
                }
            } catch (_: Exception) {}

            // 3. 備援 2：GitHub 雲端 Actions 資料庫
            val cloudUrls = listOf(
                "https://raw.githubusercontent.com/JaneDe0214/taiwan-neighborhood-monitor/main/data/youbike.json",
                "https://janede0214.github.io/taiwan-neighborhood-monitor/data/youbike.json"
            )
            for (url in cloudUrls) {
                val res = fetchHttp(url, 3500)
                if (res.isNotBlank() && res.trim().startsWith("{")) {
                    dataMemoryCache["youbike"] = res
                    notifyDataUpdated("youbike")
                    return@withContext
                }
            }
        } finally {
            isRefreshing.remove("youbike")
        }
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
        val seenCars = mutableSetOf<String>()

        for (cm in matches) {
            val carNum = cm.groupValues[1].trim()
            if (seenCars.contains(carNum)) continue
            seenCars.add(carNum)

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
     * 背景非同步拉取捷運到站看板與車廂擁擠度
     */
    private suspend fun refreshMetroLiveAsync(force: Boolean = false) = withContext(Dispatchers.IO) {
        if (!force && isRefreshing.putIfAbsent("metro-live", true) != null) return@withContext
        try {
            // 1. 優先直接高速並行打 opendata.vip API
            try {
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

                    val json = JSONObject().apply {
                        put("success", true)
                        put("isDirectApi", true)
                        put("updatedAt", isoStr)
                        put("updateTimeDisplay", timeStr)
                        put("count", allTrains.length())
                        put("trains", allTrains)
                        put("carWeight", carWeightObj)
                    }.toString()

                    dataMemoryCache["metro-live"] = json
                    notifyDataUpdated("metro-live")
                    return@withContext
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
                    dataMemoryCache["metro-live"] = res
                    notifyDataUpdated("metro-live")
                    return@withContext
                }
            }
        } finally {
            isRefreshing.remove("metro-live")
        }
    }

    /**
     * 背景非同步拉取高鐵停車位
     */
    private suspend fun refreshParkingAsync(force: Boolean = false) = withContext(Dispatchers.IO) {
        if (!force && isRefreshing.putIfAbsent("parking", true) != null) return@withContext
        try {
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

                        val json = JSONObject().apply {
                            put("success", true)
                            put("isDirectApi", true)
                            put("updatedAt", isoStr)
                            put("updateTimeDisplay", timeStr)
                            put("count", lotsArray.length())
                            put("lots", lotsArray)
                        }.toString()

                        dataMemoryCache["parking"] = json
                        notifyDataUpdated("parking")
                        return@withContext
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
                    dataMemoryCache["parking"] = res
                    notifyDataUpdated("parking")
                    return@withContext
                }
            }
        } finally {
            isRefreshing.remove("parking")
        }
    }

    /**
     * 背景非同步拉取台灣高鐵即時官方班表
     */
    private suspend fun refreshThsrAsync(force: Boolean = false) = withContext(Dispatchers.IO) {
        if (!force && isRefreshing.putIfAbsent("thsr", true) != null) return@withContext
        try {
            val now = Date()
            val dateStr = SimpleDateFormat("yyyy/MM/dd", Locale.TAIWAN).format(now)
            try {
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

                    val json = JSONObject().apply {
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

                    dataMemoryCache["thsr"] = json
                    notifyDataUpdated("thsr")
                    return@withContext
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
                    dataMemoryCache["thsr"] = res
                    notifyDataUpdated("thsr")
                    return@withContext
                }
            }
        } finally {
            isRefreshing.remove("thsr")
        }
    }

    /**
     * 背景非同步拉取桃園機場捷運即時官方班表
     */
    private suspend fun refreshTymetroAsync(force: Boolean = false) = withContext(Dispatchers.IO) {
        if (!force && isRefreshing.putIfAbsent("tymetro", true) != null) return@withContext
        try {
            val now = Date()
            try {
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

                    val json = JSONObject().apply {
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

                    dataMemoryCache["tymetro"] = json
                    notifyDataUpdated("tymetro")
                    return@withContext
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
                    dataMemoryCache["tymetro"] = res
                    notifyDataUpdated("tymetro")
                    return@withContext
                }
            }
        } finally {
            isRefreshing.remove("tymetro")
        }
    }

    /**
     * 原生秒級即時 YouBike 直取 (0 毫秒極速快取優先，背景自動異步更新)
     */
    @JavascriptInterface
    fun getRealtimeYouBike(): String {
        bridgeScope.launch { refreshYouBikeAsync() }
        val cached = dataMemoryCache["youbike"]
        if (!cached.isNullOrBlank()) return cached
        val asset = fetchAsset("data/youbike.json")
        if (asset.isNotBlank()) dataMemoryCache["youbike"] = asset
        return asset
    }

    /**
     * 原生秒級即時捷運看板與擁擠度直取 (0 毫秒極速快取優先，背景自動異步更新)
     */
    @JavascriptInterface
    fun getRealtimeMetroLive(): String {
        bridgeScope.launch { refreshMetroLiveAsync() }
        val cached = dataMemoryCache["metro-live"]
        if (!cached.isNullOrBlank()) return cached
        val asset = fetchAsset("data/metro-live.json")
        if (asset.isNotBlank()) dataMemoryCache["metro-live"] = asset
        return asset
    }

    /**
     * 原生秒級即時高鐵停車位直取 (0 毫秒極速快取優先，背景自動異步更新)
     */
    @JavascriptInterface
    fun getRealtimeParking(): String {
        bridgeScope.launch { refreshParkingAsync() }
        val cached = dataMemoryCache["parking"]
        if (!cached.isNullOrBlank()) return cached
        val asset = fetchAsset("data/parking.json")
        if (asset.isNotBlank()) dataMemoryCache["parking"] = asset
        return asset
    }

    /**
     * 原生秒級即時台灣高鐵官方班表直取 (0 毫秒極速快取優先，背景自動異步更新)
     */
    @JavascriptInterface
    fun getRealtimeThsr(): String {
        bridgeScope.launch { refreshThsrAsync() }
        val cached = dataMemoryCache["thsr"]
        if (!cached.isNullOrBlank()) return cached
        val asset = fetchAsset("data/thsr.json")
        if (asset.isNotBlank()) dataMemoryCache["thsr"] = asset
        return asset
    }

    /**
     * 原生秒級即時機捷官方班表直取 (0 毫秒極速快取優先，背景自動異步更新)
     */
    @JavascriptInterface
    fun getRealtimeTymetro(): String {
        bridgeScope.launch { refreshTymetroAsync() }
        val cached = dataMemoryCache["tymetro"]
        if (!cached.isNullOrBlank()) return cached
        val asset = fetchAsset("data/tymetro.json")
        if (asset.isNotBlank()) dataMemoryCache["tymetro"] = asset
        return asset
    }

    /**
     * 原生整合獲取最新資料庫 (0 毫秒極速快取優先，全背景異步並行更新)
     */
    @JavascriptInterface
    fun getLatestCloudData(dataType: String): String {
        val key = if (dataType == "metro") "metro-live" else dataType
        val cached = dataMemoryCache[key]
        if (!cached.isNullOrBlank()) return cached
        return when (key) {
            "youbike" -> getRealtimeYouBike()
            "metro-live" -> getRealtimeMetroLive()
            "parking" -> getRealtimeParking()
            "thsr" -> getRealtimeThsr()
            "tymetro" -> getRealtimeTymetro()
            else -> {
                val asset = fetchAsset("data/$dataType.json")
                if (asset.isNotBlank()) dataMemoryCache[dataType] = asset
                asset
            }
        }
    }

    @JavascriptInterface
    fun forceRefreshAll() {
        bridgeScope.launch {
            refreshYouBikeAsync(force = true)
            refreshMetroLiveAsync(force = true)
            refreshParkingAsync(force = true)
            refreshThsrAsync(force = true)
            refreshTymetroAsync(force = true)
        }
    }
}
