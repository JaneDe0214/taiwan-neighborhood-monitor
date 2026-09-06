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
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * 雙埔生活圈 (新埔 ‧ 青埔) 原生 Android 應用程式
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

        // 3. 建立並配置全硬體加速的原生 WebView 視圖
        webView = WebView(this).apply {
            setLayerType(View.LAYER_TYPE_HARDWARE, null)
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
     * 原生直接以 HTTPS GET 抓取遠端字串 (免除瀏覽器同源 CORS 與 Mixed Content 限制)
     */
    @JavascriptInterface
    fun fetchHttp(urlString: String, timeoutMs: Int): String {
        return try {
            val url = URL(urlString)
            val conn = (url.openConnection() as HttpURLConnection).apply {
                connectTimeout = if (timeoutMs > 0) timeoutMs else 4000
                readTimeout = if (timeoutMs > 0) timeoutMs else 4000
                requestMethod = "GET"
                setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14; Mobile) TaiwanNeighborhoodMonitor/1.0")
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
     * 原生整合獲取最新資料庫 (youbike, metro-live, parking, thsr, tymetro)
     * 策略：優先嘗試 GitHub 雲端 (Actions 每 5 分鐘推送最新資料) -> 若網路離線秒降級 Assets 本地快照
     * 100% 獨立自主，完全不依賴任何電腦端本機伺服器！
     */
    @JavascriptInterface
    fun getLatestCloudData(dataType: String): String {
        val cloudUrls = when (dataType) {
            "youbike" -> listOf(
                "https://raw.githubusercontent.com/JaneDe0214/taiwan-neighborhood-monitor/main/data/youbike.json",
                "https://janede0214.github.io/taiwan-neighborhood-monitor/data/youbike.json"
            )
            "metro", "metro-live" -> listOf(
                "https://raw.githubusercontent.com/JaneDe0214/taiwan-neighborhood-monitor/main/data/metro-live.json",
                "https://janede0214.github.io/taiwan-neighborhood-monitor/data/metro-live.json"
            )
            "parking" -> listOf(
                "https://raw.githubusercontent.com/JaneDe0214/taiwan-neighborhood-monitor/main/data/parking.json",
                "https://janede0214.github.io/taiwan-neighborhood-monitor/data/parking.json"
            )
            "thsr" -> listOf(
                "https://raw.githubusercontent.com/JaneDe0214/taiwan-neighborhood-monitor/main/data/thsr.json",
                "https://janede0214.github.io/taiwan-neighborhood-monitor/data/thsr.json"
            )
            "tymetro" -> listOf(
                "https://raw.githubusercontent.com/JaneDe0214/taiwan-neighborhood-monitor/main/data/tymetro.json",
                "https://janede0214.github.io/taiwan-neighborhood-monitor/data/tymetro.json"
            )
            else -> emptyList()
        }

        for (url in cloudUrls) {
            val res = fetchHttp(url, 3500)
            if (res.isNotBlank() && res.trim().startsWith("{")) {
                return res
            }
        }

        // 若雲端暫時逾時或處於離線狀態，秒級回傳 Assets 本地快照
        val assetFile = when (dataType) {
            "metro", "metro-live" -> "data/metro-live.json"
            else -> "data/$dataType.json"
        }
        return fetchAsset(assetFile)
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
