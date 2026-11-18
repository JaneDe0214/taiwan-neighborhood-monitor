package com.example.taiwanneighborhoodmonitor

import android.annotation.SuppressLint
import android.app.UiModeManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.view.HapticFeedbackConstants
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.graphics.toColorInt
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.ConnectionPool
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FilterInputStream
import java.io.InputStream
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * 雙埔生活 (新埔 ‧ 青埔) 原生 Android 應用程式
 * 雙平台深度最佳化支援：
 * 1. Google TV / Android TV 電視版：16:9 大螢幕交控電視牆、D-Pad 遙控器焦點導航、長亮防休眠
 * 2. Android 手機版：單手通勤快速瀏覽、雙埔微移動走廊、下拉強制更新
 * 3. 原生極速資料直透：硬體加速解碼、免 CORS、自動快取破除
 */
class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private var rootLayoutRef: FrameLayout? = null
    private var isTvDevice: Boolean = false
    private lateinit var nativeBridge: AndroidNativeBridge

    private var pendingLocationCallback: android.webkit.GeolocationPermissions.Callback? = null
    private var pendingLocationOrigin: String? = null
    private val locationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { results ->
        val granted = results.values.any { it }
        pendingLocationCallback?.invoke(pendingLocationOrigin, granted, false)
        pendingLocationCallback = null
        pendingLocationOrigin = null
    }

    // HTML5 影片 / iframe 原生全螢幕視圖管理
    private var customFullscreenView: View? = null
    private var customFullscreenCallback: WebChromeClient.CustomViewCallback? = null
    private var customFullscreenContainer: FrameLayout? = null
    private var lastTriggerRefreshMs: Long = 0L
    @Volatile
    private var hadNetworkLoss: Boolean = false
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 0. 放寬高階手機 I/O 限制與並行管線，支援大頻寬高速預載
        try {
            System.setProperty("http.maxConnections", "32")
            System.setProperty("http.keepAlive", "true")
        } catch (_: Exception) {}

        // 1. 智慧識別裝置類型 (Google TV / Android TV vs 手機版)
        isTvDevice = detectIsTvDevice(this)

        // 2. Android 15/16+ (targetSdk 36) 標準 Edge-to-Edge 系統列外觀設定（支援自動跟隨系統深淺色與前端手動切換）
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val initialSystemLight = !isTvDevice &&
            (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_NO
        val initialBgColor = if (initialSystemLight) "#f1f5f9".toColorInt() else "#05080f".toColorInt()

        // 電視模式下啟用常亮保持，防止電視牆休眠黑畫面
        if (isTvDevice) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }

        // 3. 建立並配置全硬體加速的原生 WebView 視圖 (使用 LAYER_TYPE_NONE 交由 Chromium 內建管線加速，避免雙重離屏緩衝破圖黑塊)
        webView = WebView(this).apply {
            setLayerType(View.LAYER_TYPE_NONE, null)
            setBackgroundColor(initialBgColor)
            isFocusable = true
            isFocusableInTouchMode = true
        }

        val rootLayout = FrameLayout(this).apply {
            setBackgroundColor(initialBgColor)
            addView(
                webView,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
            )
        }
        rootLayoutRef = rootLayout
        applyNativeSystemBarTheme(initialSystemLight)

        // 手機與平板動態套用狀態列、挖孔鏡頭區、底部手勢列與虛擬鍵盤安全邊距，徹底杜絕遮擋
        if (!isTvDevice) {
            ViewCompat.setOnApplyWindowInsetsListener(rootLayout) { v, windowInsets ->
                val insets = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars() or
                        WindowInsetsCompat.Type.displayCutout() or
                        WindowInsetsCompat.Type.ime()
                )
                v.setPadding(insets.left, insets.top, insets.right, insets.bottom)
                WindowInsetsCompat.CONSUMED
            }
        }
        setContentView(rootLayout)

        configureWebView(webView)
        registerBackNavigation()
        registerConnectivityWatcher()

        // 4. 背景立即非同步平行預熱所有大眾運輸與 YouBike 即時資料 (0 阻塞、秒開無白畫面)
        lastTriggerRefreshMs = System.currentTimeMillis()
        nativeBridge.prewarmAllData()

        // 5. 透過官方建議的 HTTPS 虛擬網域載入本機資產應用程式（確保 YouTube/外部嵌入接收合法 HTTPS Referer，徹底消除錯誤 153）
        webView.loadUrl("https://appassets.androidplatform.net/index.html")
    }

    /**
     * 監聽行動網路／Wi-Fi 連線狀態：出地下捷運隧道或網路斷而復連時，自動為前景畫面同步最新班次與車況
     */
    private fun registerConnectivityWatcher() {
        try {
            val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
            val callback = object : ConnectivityManager.NetworkCallback() {
                override fun onLost(network: Network) {
                    hadNetworkLoss = true
                }

                override fun onAvailable(network: Network) {
                    if (hadNetworkLoss) {
                        hadNetworkLoss = false
                        if (::nativeBridge.isInitialized && nativeBridge.isForeground()) {
                            runOnUiThread {
                                triggerForceRefreshAll(force = false)
                            }
                        }
                    }
                }
            }
            cm.registerDefaultNetworkCallback(callback)
            networkCallback = callback
        } catch (_: Exception) {}
    }

    /**
     * 使用 AndroidX OnBackPressedDispatcher 處理返回與 Android 16+ 預測返回手勢
     */
    private fun registerBackNavigation() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (customFullscreenView != null) {
                    hideCustomFullscreenView()
                    return
                }
                webView.evaluateJavascript(
                    """
                    (function() {
                        const eqModal = document.getElementById('earthquakeModalOverlay');
                        if (eqModal && eqModal.classList.contains('active')) {
                            if (window.earthquakeMonitor && typeof window.earthquakeMonitor.dismissAlert === 'function') {
                                window.earthquakeMonitor.dismissAlert();
                            } else {
                                eqModal.classList.remove('active');
                            }
                            return true;
                        }
                        const cp = document.getElementById('commandPaletteOverlay');
                        if (cp && cp.classList.contains('active')) {
                            cp.classList.remove('active');
                            return true;
                        }
                        const modal = document.getElementById('cameraModal');
                        if (modal && modal.classList.contains('active')) {
                            const closeBtn = document.getElementById('modalCloseBtn');
                            if (closeBtn) closeBtn.click();
                            return true;
                        }
                        return false;
                    })();
                    """.trimIndent()
                ) { handled ->
                    if (handled == "true") return@evaluateJavascript
                    if (webView.canGoBack()) {
                        webView.goBack()
                    } else {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                    }
                }
            }
        })
    }

    private fun hideCustomFullscreenView() {
        try {
            customFullscreenContainer?.let { container ->
                (window.decorView as? ViewGroup)?.removeView(container)
            }
            customFullscreenCallback?.onCustomViewHidden()
        } catch (_: Exception) {}
        customFullscreenView = null
        customFullscreenCallback = null
        customFullscreenContainer = null
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
        s.allowFileAccess = false
        s.allowContentAccess = true
        s.javaScriptCanOpenWindowsAutomatically = true
        @Suppress("DEPRECATION")
        s.allowFileAccessFromFileURLs = false
        @Suppress("DEPRECATION")
        s.allowUniversalAccessFromFileURLs = false

        // 允許即時視訊串流自動起播，無需使用者點擊
        s.mediaPlaybackRequiresUserGesture = false

        // 啟用智慧快取：讓本地 Assets、圖示、CSS/JS 庫秒速讀取，即時 API 則透過時間戳動態破除快取
        s.cacheMode = WebSettings.LOAD_DEFAULT
        @Suppress("DEPRECATION")
        s.setRenderPriority(WebSettings.RenderPriority.HIGH)

        // 支援混合內容以流暢播放各地交控中心 HTTP/HTTPS 監視器串流
        s.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW

        // 啟用地理定位支援 (附近即時生活圈)
        s.setGeolocationEnabled(true)

        // 啟用 Cookie 與第三方 Cookie，確保 YouTube 等內嵌官方直播於 HTTPS 虛擬來源下正常驗證播放
        try {
            val cookieManager = android.webkit.CookieManager.getInstance()
            cookieManager.setAcceptCookie(true)
            cookieManager.setAcceptThirdPartyCookies(wv, true)
        } catch (_: Exception) {}

        // 注入原生 JS 橋接器
        nativeBridge = AndroidNativeBridge(this, isTvDevice, wv)
        wv.addJavascriptInterface(nativeBridge, "AndroidBridge")

        // 支援網頁快照 (data:image/) 儲存與外部下載
        wv.setDownloadListener { url, _, _, _, _ ->
            if (url.startsWith("data:image/")) {
                nativeBridge.saveImageDataUrl(url, "cam_snapshot_${System.currentTimeMillis()}.jpg")
            } else if (url.startsWith("http://") || url.startsWith("https://")) {
                openExternalUri(url.toUri())
            }
        }

        wv.webChromeClient = object : WebChromeClient() {
            override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
                if (view == null) {
                    callback?.onCustomViewHidden()
                    return
                }
                if (customFullscreenView != null) {
                    hideCustomFullscreenView()
                }
                val container = FrameLayout(this@MainActivity).apply {
                    setBackgroundColor(Color.BLACK)
                    addView(
                        view,
                        FrameLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT
                        )
                    )
                }
                (window.decorView as? ViewGroup)?.addView(
                    container,
                    ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT
                    )
                )
                customFullscreenView = view
                customFullscreenCallback = callback
                customFullscreenContainer = container
            }

            override fun onHideCustomView() {
                hideCustomFullscreenView()
            }

            override fun onGeolocationPermissionsShowPrompt(
                origin: String?,
                callback: android.webkit.GeolocationPermissions.Callback?
            ) {
                if (androidx.core.content.ContextCompat.checkSelfPermission(
                        this@MainActivity,
                        android.Manifest.permission.ACCESS_FINE_LOCATION
                    ) == PackageManager.PERMISSION_GRANTED ||
                    androidx.core.content.ContextCompat.checkSelfPermission(
                        this@MainActivity,
                        android.Manifest.permission.ACCESS_COARSE_LOCATION
                    ) == PackageManager.PERMISSION_GRANTED
                ) {
                    callback?.invoke(origin, true, false)
                } else {
                    pendingLocationCallback = callback
                    pendingLocationOrigin = origin
                    locationPermissionLauncher.launch(
                        arrayOf(
                            android.Manifest.permission.ACCESS_FINE_LOCATION,
                            android.Manifest.permission.ACCESS_COARSE_LOCATION
                        )
                    )
                }
            }
        }

        wv.webViewClient = object : WebViewClient() {
            override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
                // 攔截 Chromium WebView 子進程崩潰，避免直接彈出顛倒 Android 機器人圖示
                try {
                    view?.let {
                        val parent = it.parent as? ViewGroup
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
                if (uri.scheme.equals("https", ignoreCase = true) &&
                    uri.host.equals("appassets.androidplatform.net", ignoreCase = true)
                ) {
                    return false
                }
                if (url.startsWith("https://www.google.com/maps") ||
                    url.startsWith("https://maps.google.com") ||
                    url.startsWith("http://maps.google.com") ||
                    url.startsWith("geo:")
                ) {
                    return openExternalUri(uri)
                }
                // 若為主框架主動點擊外部連結 (如地震報告、官方即時視窗)，交由系統瀏覽器開啟以免覆蓋監控頁面；子框架 (YouTube/BOTE iframe) 放行內嵌載入
                if (request.isForMainFrame && (url.startsWith("http://") || url.startsWith("https://"))) {
                    return openExternalUri(uri)
                }
                return false
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                // 自動依據設備注入樣式類別與初始化腳本
                val modeClass = if (isTvDevice) "native-tv-mode" else "native-mobile-mode"
                val initJs = """
                    (function() {
                        document.body.classList.add('$modeClass');
                        if ($isTvDevice) {
                            // 電視版：調大字體與電視牆卡片比重，最佳化 3 公尺客廳視距，並聚焦導航列起點支援 D-Pad 移動
                            document.documentElement.style.setProperty('--tv-zoom', '1.15');
                            if (!document.activeElement || document.activeElement === document.body) {
                                const firstFocus = document.querySelector('.center-btn.active') || document.querySelector('.center-btn');
                                if (firstFocus && typeof firstFocus.focus === 'function') firstFocus.focus();
                            }
                        } else {
                            // 手機版：僅於尚未自訂收合狀態時預設展開交通即時走廊
                            let savedCollapse = null;
                            try { savedCollapse = localStorage.getItem('dpu_transit_collapsed'); } catch (_e) {}
                            if (savedCollapse === null && window.transitMonitor && window.transitMonitor.isCollapsed) {
                                window.transitMonitor.isCollapsed = false;
                                window.transitMonitor.render();
                            }
                        }
                    })();
                """.trimIndent()
                wv.evaluateJavascript(initJs, null)
            }

            /**
             * 原生網路攔截直通：當 Web 請求外部 API 或串流時，透過原生直取並補齊 CORS 標頭
             */
            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?
            ): WebResourceResponse? {
                val uri = request?.url ?: return null
                val url = uri.toString()
                if (uri.scheme.equals("https", ignoreCase = true) &&
                    uri.host.equals("appassets.androidplatform.net", ignoreCase = true)
                ) {
                    return serveBundledAsset(uri)
                }
                if (url.startsWith("http://") || url.startsWith("https://")) {
                    val host = uri.host
                    val isBote = host.equals("hls.bote.gov.taipei", ignoreCase = true)
                    val isNativeApi = WebAssetRouting.isNativeInterceptHost(host)

                    if ((isBote || isNativeApi) && request.method.equals("OPTIONS", ignoreCase = true)) {
                        return WebResourceResponse(
                            "text/plain",
                            "utf-8",
                            204,
                            "No Content",
                            corsHeaders(),
                            ByteArrayInputStream(ByteArray(0))
                        )
                    }

                    if (isBote) {
                        try {
                            val method = if (request.method.equals("HEAD", ignoreCase = true)) "HEAD" else "GET"
                            val rangeHeader = request.requestHeaders?.entries?.firstOrNull {
                                it.key.equals("Range", ignoreCase = true)
                            }?.value
                            val boteRes = fetchNativeBoteUrl(url, method, rangeHeader)
                            if (boteRes != null) return boteRes
                        } catch (_: Exception) {}
                    } else if (isNativeApi) {
                        try {
                            val method = if (request.method.equals("HEAD", ignoreCase = true)) "HEAD" else "GET"
                            val nativeRes = fetchNativeUrl(url, method)
                            if (nativeRes != null) return nativeRes
                        } catch (_: Exception) {}
                    }
                }
                return super.shouldInterceptRequest(view, request)
            }
        }
    }

    private fun openExternalUri(uri: Uri): Boolean {
        return try {
            val intent = Intent(Intent.ACTION_VIEW, uri).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            startActivity(intent)
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun corsHeaders(): MutableMap<String, String> = mutableMapOf(
        "Access-Control-Allow-Origin" to "*",
        "Access-Control-Allow-Methods" to "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers" to "*"
    )

    /**
     * 自 APK assets 目錄直讀靜態檔案並以標準 HTTPS 虛擬來源回應（支援 Referrer-Policy 與二進位編碼隔離）
     */
    private fun serveBundledAsset(uri: Uri): WebResourceResponse {
        val relPath = WebAssetRouting.resolveAssetPath(uri.path)
            ?: return WebResourceResponse(
                "text/plain",
                "utf-8",
                403,
                "Forbidden",
                mapOf("Cache-Control" to "no-store"),
                ByteArrayInputStream(ByteArray(0))
            )

        val spec = WebAssetRouting.assetContentSpec(relPath)

        return try {
            val stream = assets.open(relPath)
            WebResourceResponse(
                spec.mimeType,
                if (spec.isBinary) null else "utf-8",
                200,
                "OK",
                spec.headers,
                stream
            )
        } catch (_: Exception) {
            WebResourceResponse(
                "text/plain",
                "utf-8",
                404,
                "Not Found",
                mapOf("Cache-Control" to "no-store"),
                ByteArrayInputStream(ByteArray(0))
            )
        }
    }

    private val boteCookies = ConcurrentHashMap<String, ConcurrentHashMap<String, String>>()
    private val boteHttpClient: OkHttpClient by lazy {
        nativeBridge.sharedHttpClient().newBuilder()
            .followRedirects(false)
            .followSslRedirects(false)
            .connectTimeout(5000, TimeUnit.MILLISECONDS)
            .readTimeout(10000, TimeUnit.MILLISECONDS)
            .build()
    }

    private fun extractBoteCamKey(urlString: String): String = WebAssetRouting.extractBoteCamKey(urlString)

    /**
     * 臺北市交通管制工程處 (hls.bote.gov.taipei) 專屬原生高速代理直透實作
     * 1. 複用 OkHttp HTTP/2 與 TLS Keep-Alive 連線池，手動跟隨 301~308 重新導向（依鏡頭 ID 獨立隔離 Cookie，上限 200 組防暴漲）
     * 2. 串流式轉發視訊切片 (.m3u8, .ts, .mp4, .m4s)，零全量 ByteArray 堆積，並將二進位媒體 encoding 設為 null
     * 3. 注入 Access-Control-Allow-Origin: * 消除 WebView 同源限制
     */
    private fun fetchNativeBoteUrl(
        urlString: String,
        method: String = "GET",
        rangeHeader: String? = null
    ): WebResourceResponse? {
        return try {
            var currentUrl = urlString
            var finalResp: okhttp3.Response? = null
            val camKey = extractBoteCamKey(urlString)
            if (boteCookies.size > 200 && !boteCookies.containsKey(camKey)) {
                boteCookies.clear()
            }
            val camCookies = boteCookies.computeIfAbsent(camKey) { ConcurrentHashMap() }

            for (hop in 0..4) {
                val reqBuilder = Request.Builder()
                    .url(currentUrl)
                    .header("Referer", "https://hls.bote.gov.taipei/live/index.html")
                    .header("Origin", "https://hls.bote.gov.taipei")
                    .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
                    .header("Accept", "*/*")
                if (!rangeHeader.isNullOrBlank()) {
                    reqBuilder.header("Range", rangeHeader)
                }
                if (camCookies.isNotEmpty()) {
                    val cookieHeader = camCookies.entries.joinToString("; ") { "${it.key}=${it.value}" }
                    reqBuilder.header("Cookie", cookieHeader)
                }
                if (method == "HEAD") reqBuilder.head() else reqBuilder.get()

                val attempt = boteHttpClient.newCall(reqBuilder.build()).execute()
                try {
                    for (raw in attempt.headers("Set-Cookie")) {
                        val pair = raw.substringBefore(';')
                        val eqIdx = pair.indexOf('=')
                        if (eqIdx > 0) {
                            val k = pair.substring(0, eqIdx).trim()
                            val v = pair.substring(eqIdx + 1).trim()
                            if (k.isNotEmpty()) camCookies[k] = v
                        }
                    }

                    val code = attempt.code
                    if (code == 401 || code == 403) {
                        camCookies.clear()
                    }
                    if (code in 300..399) {
                        val location = attempt.header("Location")
                        attempt.close()
                        if (location.isNullOrBlank()) return null
                        val nextUrl = URL(URL(currentUrl), location)
                        if (!nextUrl.host.equals("hls.bote.gov.taipei", ignoreCase = true)) return null
                        currentUrl = nextUrl.toString()
                        continue
                    }
                    finalResp = attempt
                    break
                } catch (e: Exception) {
                    attempt.close()
                    throw e
                }
            }

            val resp = finalResp ?: return null
            val code = resp.code
            if (code in 200..299) {
                val rawContentType = resp.header("Content-Type") ?: ""
                val cleanPath = currentUrl.substringBefore("?").lowercase(Locale.US)
                val isM3u8 = cleanPath.endsWith(".m3u8") || rawContentType.contains("mpegurl", ignoreCase = true)
                val isTs = cleanPath.endsWith(".ts")
                val isMp4 = cleanPath.endsWith(".mp4")
                val isM4s = cleanPath.endsWith(".m4s") || cleanPath.endsWith(".m4v") || cleanPath.endsWith(".m4a")
                val isBinary = isTs || isMp4 || isM4s || cleanPath.endsWith(".png") || cleanPath.endsWith(".jpg") || cleanPath.endsWith(".ico")

                val mimeType = when {
                    isM3u8 -> "application/vnd.apple.mpegurl"
                    isTs -> "video/mp2t"
                    isMp4 -> "video/mp4"
                    isM4s -> "video/iso.segment"
                    cleanPath.endsWith(".js") -> "application/javascript"
                    cleanPath.endsWith(".css") -> "text/css"
                    cleanPath.endsWith(".html") || (currentUrl.contains("/live/") && !cleanPath.substringAfterLast("/").contains(".")) -> "text/html"
                    rawContentType.isNotEmpty() -> rawContentType.split(";")[0].trim()
                    else -> "application/octet-stream"
                }

                // 針對二進位視訊切片 (.ts / .mp4 / .m4s) 與圖檔，encoding 必須傳入 null，避免 UTF-8 破壞位元組造成解碼失敗
                val encoding = if (isBinary) null else {
                    if (rawContentType.contains("charset=", ignoreCase = true)) {
                        rawContentType.substringAfter("charset=").substringBefore(";").trim().ifEmpty { "utf-8" }
                    } else {
                        "utf-8"
                    }
                }

                val contentRangeHeader = if (code == 206) resp.header("Content-Range") else null
                val contentLenHeader = resp.header("Content-Length")

                val headers = corsHeaders().apply {
                    put("Cache-Control", "no-cache, no-store, must-revalidate")
                    put("Accept-Ranges", "bytes")
                    if (!contentRangeHeader.isNullOrBlank()) {
                        put("Content-Range", contentRangeHeader)
                    }
                    if (method != "HEAD" && !contentLenHeader.isNullOrBlank()) {
                        put("Content-Length", contentLenHeader)
                    }
                }

                val bodyStream: InputStream = if (method == "HEAD") {
                    resp.close()
                    ByteArrayInputStream(ByteArray(0))
                } else {
                    val rawStream = resp.body?.byteStream() ?: ByteArrayInputStream(ByteArray(0))
                    object : FilterInputStream(rawStream) {
                        override fun close() {
                            try {
                                super.close()
                            } finally {
                                resp.close()
                            }
                        }
                    }
                }

                WebResourceResponse(
                    mimeType,
                    encoding,
                    code,
                    if (code == 206) "Partial Content" else "OK",
                    headers,
                    bodyStream
                )
            } else {
                resp.close()
                null
            }
        } catch (_: Exception) {
            null
        }
    }

    /**
     * 原生網路請求實作 (透過 OkHttp 連線池直取並附加 CORS 標頭，免除 WebView 跨網域阻擋與連線洩漏)
     */
    private fun fetchNativeUrl(urlString: String, method: String = "GET"): WebResourceResponse? {
        return try {
            val reqBuilder = Request.Builder()
                .url(urlString)
                .header("User-Agent", "TaiwanNeighborhoodMonitor-Android/1.0")
                .header("Accept", "application/json, text/plain, */*")
            if (method == "HEAD") reqBuilder.head() else reqBuilder.get()

            val response = nativeBridge.sharedHttpClient().newCall(reqBuilder.build()).execute()
            if (response.isSuccessful) {
                val contentType = response.header("Content-Type") ?: "application/json"
                val mimeType = contentType.split(";")[0].trim().ifEmpty { "application/json" }
                val isBinary = mimeType.startsWith("image/") || mimeType.startsWith("video/") || mimeType == "application/octet-stream"
                val encoding = if (isBinary) {
                    null
                } else if (contentType.contains("charset=", ignoreCase = true)) {
                    contentType.substringAfter("charset=").substringBefore(";").trim().ifEmpty { "utf-8" }
                } else {
                    "utf-8"
                }

                val headers = corsHeaders().apply {
                    put("Cache-Control", "no-store")
                }
                val rawStream = response.body?.byteStream() ?: ByteArrayInputStream(ByteArray(0))
                val closingStream: InputStream = object : FilterInputStream(rawStream) {
                    override fun close() {
                        try {
                            super.close()
                        } finally {
                            response.close()
                        }
                    }
                }
                WebResourceResponse(mimeType, encoding, response.code, "OK", headers, closingStream)
            } else {
                response.close()
                null
            }
        } catch (_: Exception) {
            null
        }
    }

    /**
     * 電視遙控器功能鍵支援 (方向鍵交由 WebView 原生空間焦點導航處理)
     */
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_MENU) {
            triggerForceRefreshAll(force = true)
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    /**
     * 強制全域立即刷新大眾運輸、車廂擁擠度與 YouBike 資料
     */
    private fun triggerForceRefreshAll(force: Boolean = false) {
        val now = System.currentTimeMillis()
        if (!force && now - lastTriggerRefreshMs < 4000L) return
        lastTriggerRefreshMs = now
        nativeBridge.forceRefreshAll()
        webView.evaluateJavascript(
            """
            (function() {
                if (window.weatherMonitor && typeof window.weatherMonitor.triggerAutoRefresh === 'function') {
                    window.weatherMonitor.triggerAutoRefresh(true);
                }
            })();
            """.trimIndent(),
            null
        )
    }

    internal fun applyNativeSystemBarTheme(isLight: Boolean) {
        try {
            val bg = if (isLight) "#f1f5f9".toColorInt() else "#05080f".toColorInt()
            rootLayoutRef?.setBackgroundColor(bg)
            if (::webView.isInitialized) {
                webView.setBackgroundColor(bg)
            }
            WindowCompat.getInsetsController(window, window.decorView).apply {
                isAppearanceLightStatusBars = isLight
                isAppearanceLightNavigationBars = isLight
            }
        } catch (_: Exception) {}
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        if (::webView.isInitialized) {
            val isSysLight = !isTvDevice &&
                (newConfig.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_NO
            webView.evaluateJavascript(
                "window.themeManager && typeof window.themeManager.onNativeSystemThemeChanged === 'function' && window.themeManager.onNativeSystemThemeChanged($isSysLight);",
                null
            )
        }
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        nativeBridge.setForegroundActive(true)
        // 前景喚醒時檢查節流後刷新最新資料 (避免剛啟動重複抓兩次)
        triggerForceRefreshAll(force = false)
    }

    override fun onPause() {
        nativeBridge.setForegroundActive(false)
        super.onPause()
        webView.onPause()
    }

    override fun onDestroy() {
        try {
            networkCallback?.let { cb ->
                val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
                cm?.unregisterNetworkCallback(cb)
            }
        } catch (_: Exception) {}
        networkCallback = null
        hideCustomFullscreenView()
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
    private val lastFetchTimes = ConcurrentHashMap<String, Long>()
    @Volatile
    private var isForegroundActive: Boolean = true

    fun setForegroundActive(active: Boolean) {
        isForegroundActive = active
    }

    fun isForeground(): Boolean = isForegroundActive

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

    @JavascriptInterface
    fun isSystemLightMode(): Boolean {
        if (isTv) return false
        val nightMask = activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
        return nightMask == Configuration.UI_MODE_NIGHT_NO
    }

    @JavascriptInterface
    fun syncThemeAppearance(isLight: Boolean) {
        activity.runOnUiThread {
            (activity as? MainActivity)?.applyNativeSystemBarTheme(isLight)
        }
    }

    /**
     * 行動版原生細膩觸覺微震動回饋（切換區域、網格、方向與下拉重新整理時觸發）
     */
    @JavascriptInterface
    fun performHapticFeedback() {
        if (isTv) return
        activity.runOnUiThread {
            try {
                webView.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
            } catch (_: Exception) {}
        }
    }

    /**
     * 原生呼叫外部 Intent 開啟地圖 (支援 Google 地圖 App 或系統瀏覽器)
     */
    @JavascriptInterface
    fun openExternalMap(url: String) {
        activity.runOnUiThread {
            try {
                val uri = url.toUri()
                val intent = Intent(Intent.ACTION_VIEW, uri).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK
                }
                activity.startActivity(intent)
            } catch (_: Exception) {}
        }
    }

    /**
     * 共用圖片位元組寫入裝置相簿／圖片目錄工具
     */
    private fun writeImageBytesToGallery(bytes: ByteArray, mimeType: String, fileName: String): String? {
        if (bytes.isEmpty()) return null
        val ext = when {
            mimeType.contains("png", ignoreCase = true) -> ".png"
            mimeType.contains("webp", ignoreCase = true) -> ".webp"
            else -> ".jpg"
        }
        val cleanBase = fileName.replace(Regex("[^A-Za-z0-9._-]"), "_").ifBlank {
            "snapshot_${System.currentTimeMillis()}$ext"
        }
        val safeName = if (cleanBase.contains('.')) cleanBase else "$cleanBase$ext"
        val resolvedMime = when {
            mimeType.contains("png", ignoreCase = true) -> "image/png"
            mimeType.contains("webp", ignoreCase = true) -> "image/webp"
            else -> "image/jpeg"
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Images.Media.DISPLAY_NAME, safeName)
                put(MediaStore.Images.Media.MIME_TYPE, resolvedMime)
                put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/TaiwanNeighborhoodMonitor")
            }
            val resolver = activity.contentResolver
            val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: return null
            resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: return null
        } else {
            val dir = activity.getExternalFilesDir(Environment.DIRECTORY_PICTURES) ?: activity.filesDir
            if (!dir.exists()) dir.mkdirs()
            File(dir, safeName).writeBytes(bytes)
        }
        return safeName
    }

    /**
     * 原生儲存 Canvas 截圖 (data:image/jpeg;base64,...) 至手機圖片庫 / App 相簿目錄
     */
    @JavascriptInterface
    fun saveImageDataUrl(dataUrl: String, fileName: String): Boolean {
        return try {
            val commaIdx = dataUrl.indexOf(',')
            if (commaIdx <= 0) return false
            val header = dataUrl.substring(0, commaIdx)
            val mimeType = header.substringAfter("data:", "image/jpeg").substringBefore(";").ifBlank { "image/jpeg" }
            val base64Part = dataUrl.substring(commaIdx + 1)
            val bytes = Base64.decode(base64Part, Base64.DEFAULT)
            val savedName = writeImageBytesToGallery(bytes, mimeType, fileName) ?: return false
            activity.runOnUiThread {
                Toast.makeText(activity, "截圖已儲存：$savedName", Toast.LENGTH_SHORT).show()
            }
            true
        } catch (_: Exception) {
            false
        }
    }

    /**
     * 原生非同步下載快照／MJPEG／YouTube 即時縮圖網址並儲存至圖片庫 (解決跨網域 Canvas Taint 無法匯出問題，並內建多解析度自動降級備援)
     */
    @JavascriptInterface
    fun saveImageFromUrl(imageUrl: String, fileName: String): Boolean {
        val candidates = WebAssetRouting.buildSnapshotFallbackUrls(imageUrl)
        if (candidates.isEmpty()) {
            return false
        }
        bridgeScope.launch {
            var savedName: String? = null
            for (candidateUrl in candidates) {
                try {
                    val request = Request.Builder()
                        .url(candidateUrl)
                        .header("User-Agent", "Mozilla/5.0 (Linux; Android 14; Mobile) TaiwanNeighborhoodMonitor/1.0")
                        .build()
                    okHttpClient.newCall(request).execute().use { response ->
                        if (response.isSuccessful) {
                            val contentType = response.header("Content-Type").orEmpty()
                            val isMultipart = contentType.contains("multipart/x-mixed-replace", ignoreCase = true)
                            response.body?.byteStream()?.use { stream ->
                                val extracted = if (isMultipart) {
                                    WebAssetRouting.extractFirstJpegFrame(stream)
                                } else {
                                    WebAssetRouting.readBoundedBytes(stream)
                                }
                                if (extracted != null && extracted.size > 512) {
                                    val mime = if (isMultipart || contentType.isBlank()) "image/jpeg" else contentType
                                    savedName = writeImageBytesToGallery(extracted, mime, fileName)
                                }
                            }
                        }
                    }
                    if (savedName != null) break
                } catch (_: Exception) {}
            }

            activity.runOnUiThread {
                val msg = if (savedName != null) "截圖已儲存：$savedName" else "無法下載攝影機影像進行儲存"
                Toast.makeText(activity, msg, Toast.LENGTH_SHORT).show()
            }
        }
        return true
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

    internal fun sharedHttpClient(): OkHttpClient = okHttpClient

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

    private fun formatTaipeiTime(date: Date, pattern: String): String {
        return SimpleDateFormat(pattern, Locale.TAIWAN).apply {
            timeZone = TimeZone.getTimeZone("Asia/Taipei")
        }.format(date)
    }

    private fun formatUtcIso(date: Date): String {
        return SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }.format(date)
    }

    /**
     * 背景非同步通知 WebView 前端最新資料已更新完成，僅讀取快取並平滑重繪 UI（不反過來觸發新一輪原生請求，徹底阻斷無限迴圈）
     */
    private fun notifyDataUpdated(dataType: String) {
        activity.runOnUiThread {
            val js = when (dataType) {
                "youbike" -> """
                    (function() {
                        if (window.weatherMonitor && typeof window.weatherMonitor.onNativeYouBikeUpdated === 'function') {
                            window.weatherMonitor.onNativeYouBikeUpdated();
                        }
                    })();
                """.trimIndent()
                "metro-live", "parking", "thsr", "tymetro" -> """
                    (function() {
                        if (window.transitMonitor && typeof window.transitMonitor.onNativeDataUpdated === 'function') {
                            window.transitMonitor.onNativeDataUpdated('$dataType');
                        }
                    })();
                """.trimIndent()
                else -> """
                    (function() {
                        if (window.transitMonitor && typeof window.transitMonitor.onNativeDataUpdated === 'function') {
                            window.transitMonitor.onNativeDataUpdated('all');
                        }
                        if (window.weatherMonitor && typeof window.weatherMonitor.onNativeYouBikeUpdated === 'function') {
                            window.weatherMonitor.onNativeYouBikeUpdated();
                        }
                    })();
                """.trimIndent()
            }
            webView.evaluateJavascript(js, null)
        }
    }

    /**
     * 前端 DOMContentLoaded 就緒雙向握手：打開 App 即刻主動推送最新資料，消除載入延遲
     */
    @JavascriptInterface
    fun onFrontendReady() {
        bridgeScope.launch(Dispatchers.Main) {
            notifyDataUpdated("ready")
        }
    }

    /**
     * 啟動時預熱靜態時刻表快照，並於背景非同步並行拉取全台交通即時最新動態 (0 阻塞、不注入過期即時倒數)
     */
    fun prewarmAllData() {
        bridgeScope.launch(Dispatchers.IO) {
            // 僅預熱時刻表／停車參考快照；即時 YouBike 與捷運倒數須等待即時網路資料，避免冷啟動閃現舊快照數字
            val prewarmKeys = listOf("parking", "thsr", "tymetro")
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

            // 常駐背景定時同步：捷運每 12 秒自動更新看板與擁擠度，YouBike 每 45 秒自動更新（背景暫停時休眠省電）
            launch {
                while (isActive) {
                    delay(12000)
                    if (!isForegroundActive) continue
                    try {
                        refreshMetroLiveAsync()
                    } catch (_: Exception) {}
                }
            }
            launch {
                while (isActive) {
                    delay(45000)
                    if (!isForegroundActive) continue
                    try {
                        refreshYouBikeAsync()
                    } catch (_: Exception) {}
                }
            }
        }
    }

    private fun shouldSkipByCooldown(key: String, force: Boolean, cooldownMs: Long): Boolean {
        if (force) return false
        val last = lastFetchTimes[key] ?: return false
        return (System.currentTimeMillis() - last) < cooldownMs
    }

    /**
     * 背景非同步拉取 YouBike 即時開放資料 (TDX / 新北官方 CSV + 桃園官方 JSON / GitHub 雲端備援)
     */
    private suspend fun refreshYouBikeAsync(force: Boolean = false) = withContext(Dispatchers.IO) {
        if (shouldSkipByCooldown("youbike", force, 10000L)) return@withContext
        if (isRefreshing.putIfAbsent("youbike", true) != null) return@withContext
        try {
            fun isNonEmptyJsonArray(raw: String?): Boolean {
                val trimmed = raw?.trim() ?: return false
                return trimmed.length > 2 && trimmed.startsWith("[") && trimmed.endsWith("]")
            }
            fun isNonEmptyJsonObject(raw: String?): Boolean {
                val trimmed = raw?.trim() ?: return false
                return trimmed.length > 2 && trimmed.startsWith("{") && trimmed.endsWith("}")
            }

            var resolvedNtpc: String? = null
            var resolvedTycg: String? = null

            // 1. 優先並行直打台灣 TDX 即時開放資料 API (opendata.vip，每分鐘動態更新)
            try {
                val ntpcDeferred = async { fetchHttp("https://www.opendata.vip/tdx/youbikeApi/NewTaipei", 3500) }
                val tycgDeferred = async { fetchHttp("https://www.opendata.vip/tdx/youbikeApi/Taoyuan", 3500) }
                val ntpcRaw = ntpcDeferred.await()
                val tycgRaw = tycgDeferred.await()
                if (isNonEmptyJsonArray(ntpcRaw)) resolvedNtpc = ntpcRaw
                if (isNonEmptyJsonArray(tycgRaw)) resolvedTycg = tycgRaw
            } catch (_: Exception) {}

            // 2. 針對單一縣市失敗時，精準補抓新北市政府官方開放 CSV 與桃園市政府官方 JSON（絕不將缺漏縣市直接覆寫為空陣列）
            if (resolvedNtpc == null || resolvedTycg == null) {
                try {
                    val ntpcCsvDeferred = if (resolvedNtpc == null) {
                        async { fetchHttp("https://data.ntpc.gov.tw/api/datasets/010E5B15-3823-4B20-B401-B1CF000550C5/csv/file", 4500) }
                    } else null
                    val tycgGovDeferred = if (resolvedTycg == null) {
                        async { fetchHttp("https://opendata.tycg.gov.tw/api/dataset/5ca2bfc7-9ace-4719-88ae-4034b9a5a55c/resource/08274d61-edbe-419d-8fcc-7a643831283d/download", 4500) }
                    } else null

                    val csvRaw = ntpcCsvDeferred?.await().orEmpty()
                    if (csvRaw.isNotBlank()) {
                        val parsedArr = TransitParsers.parseYouBikeCsv(csvRaw)
                        if (parsedArr.length() > 0) {
                            resolvedNtpc = parsedArr.toString()
                        }
                    }

                    val tycgDirect = tycgGovDeferred?.await().orEmpty()
                    if (isNonEmptyJsonArray(tycgDirect) || isNonEmptyJsonObject(tycgDirect)) {
                        resolvedTycg = tycgDirect
                    }
                } catch (_: Exception) {}
            }

            // 若其中一城成功而另一城暫時逾時，優先保留記憶體快取中既有該城陣列，避免單城車況被洗空
            if (resolvedNtpc != null || resolvedTycg != null) {
                val prevCached = dataMemoryCache["youbike"]
                if ((resolvedNtpc == null || resolvedTycg == null) && !prevCached.isNullOrBlank()) {
                    try {
                        val prevObj = JSONObject(prevCached)
                        if (resolvedNtpc == null) {
                            val prevNtpc = prevObj.optJSONArray("ntpc")
                            if (prevNtpc != null && prevNtpc.length() > 0) resolvedNtpc = prevNtpc.toString()
                        }
                        if (resolvedTycg == null) {
                            val prevTycgArr = prevObj.optJSONArray("tycg")
                            val prevTycgObj = prevObj.optJSONObject("tycg")
                            if (prevTycgArr != null && prevTycgArr.length() > 0) resolvedTycg = prevTycgArr.toString()
                            else if (prevTycgObj != null && prevTycgObj.length() > 0) resolvedTycg = prevTycgObj.toString()
                        }
                    } catch (_: Exception) {}
                }

                val nowDate = Date()
                val now = formatTaipeiTime(nowDate, "HH:mm")
                val iso = formatUtcIso(nowDate)
                val safeNtpc = resolvedNtpc ?: "[]"
                val safeTycg = resolvedTycg ?: "[]"
                val json = """{"success":true,"isDirectApi":true,"updatedAt":"$iso","updateTimeDisplay":"$now","ntpc":$safeNtpc,"tycg":$safeTycg}"""
                dataMemoryCache["youbike"] = json
                lastFetchTimes["youbike"] = System.currentTimeMillis()
                notifyDataUpdated("youbike")
                return@withContext
            }

            // 3. 備援 2：GitHub 雲端 Actions 資料庫
            val cloudUrls = listOf(
                "https://raw.githubusercontent.com/JaneDe0214/taiwan-neighborhood-monitor/main/data/youbike.json",
                "https://janede0214.github.io/taiwan-neighborhood-monitor/data/youbike.json"
            )
            for (url in cloudUrls) {
                val res = fetchHttp(url, 3500)
                if (res.isNotBlank() && res.trim().startsWith("{")) {
                    dataMemoryCache["youbike"] = res
                    lastFetchTimes["youbike"] = System.currentTimeMillis()
                    notifyDataUpdated("youbike")
                    return@withContext
                }
            }
        } finally {
            isRefreshing.remove("youbike")
        }
    }

    /**
     * 背景非同步拉取捷運到站看板與車廂擁擠度
     */
    private suspend fun refreshMetroLiveAsync(force: Boolean = false) = withContext(Dispatchers.IO) {
        if (shouldSkipByCooldown("metro-live", force, 8000L)) return@withContext
        if (isRefreshing.putIfAbsent("metro-live", true) != null) return@withContext
        try {
            // 1. 優先直接高速並行打 opendata.vip API
            try {
                val xpDepDeferred = async { fetchHttp("https://www.opendata.vip/metro/departure/%E6%96%B0%E5%9F%94", 3500) }
                val bqDepDeferred = async { fetchHttp("https://www.opendata.vip/metro/departure/%E6%9D%BF%E6%A9%8B", 3500) }
                val y20DepDeferred = async { fetchHttp("https://www.opendata.vip/metro/departure/%E6%96%B0%E5%8C%97%E7%94%A2%E6%A5%AD%E5%9C%92%E5%8D%80", 3500) }
                val bl08Deferred = async { fetchHttp("https://www.opendata.vip/metro/carWeight/BL/BL08", 3500) }
                val bl07Deferred = async { fetchHttp("https://www.opendata.vip/metro/carWeight/BL/BL07", 3500) }

                val xpDep = xpDepDeferred.await()
                val bqDep = bqDepDeferred.await()
                val y20Dep = y20DepDeferred.await()
                val bl08Html = bl08Deferred.await()
                val bl07Html = bl07Deferred.await()

                val allTrains = JSONArray()
                if (xpDep.isNotBlank()) {
                    TransitParsers.parseDepartureHtml(xpDep, "新埔站").forEach { allTrains.put(it) }
                }
                if (bqDep.isNotBlank()) {
                    TransitParsers.parseDepartureHtml(bqDep, "板橋站").forEach { allTrains.put(it) }
                }
                if (y20Dep.isNotBlank()) {
                    TransitParsers.parseDepartureHtml(y20Dep, "新北產業園區站").forEach { allTrains.put(it) }
                }

                val carWeightObj = JSONObject()
                if (bl08Html.isNotBlank()) {
                    carWeightObj.put("BL08", TransitParsers.parseCarWeightHtml(bl08Html, "新埔", "BL08"))
                }
                if (bl07Html.isNotBlank()) {
                    carWeightObj.put("BL07", TransitParsers.parseCarWeightHtml(bl07Html, "板橋", "BL07"))
                }

                if (allTrains.length() > 0 || carWeightObj.length() > 0) {
                    val now = Date()
                    val timeStr = formatTaipeiTime(now, "HH:mm")
                    val isoStr = formatUtcIso(now)

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
                    lastFetchTimes["metro-live"] = System.currentTimeMillis()
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
                    lastFetchTimes["metro-live"] = System.currentTimeMillis()
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
        if (shouldSkipByCooldown("parking", force, 15000L)) return@withContext
        if (isRefreshing.putIfAbsent("parking", true) != null) return@withContext
        try {
            // 1. 優先直接高速打 opendata.vip 高鐵即時停車位 API
            try {
                val html = fetchHttp("https://www.opendata.vip/tdx/parkingTHSR", 3500)
                if (html.isNotBlank()) {
                    val lotsArray = TransitParsers.parseParkingHtml(html)
                    if (lotsArray.length() > 0) {
                        val now = Date()
                        val timeStr = formatTaipeiTime(now, "HH:mm")
                        val isoStr = formatUtcIso(now)

                        val json = JSONObject().apply {
                            put("success", true)
                            put("isDirectApi", true)
                            put("updatedAt", isoStr)
                            put("updateTimeDisplay", timeStr)
                            put("count", lotsArray.length())
                            put("lots", lotsArray)
                        }.toString()

                        dataMemoryCache["parking"] = json
                        lastFetchTimes["parking"] = System.currentTimeMillis()
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
                    lastFetchTimes["parking"] = System.currentTimeMillis()
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
        if (shouldSkipByCooldown("thsr", force, 120000L)) return@withContext
        if (isRefreshing.putIfAbsent("thsr", true) != null) return@withContext
        try {
            val now = Date()
            val dateStr = formatTaipeiTime(now, "yyyy/MM/dd")
            try {
                val southPost = "SearchType=S&Lang=TW&StartStation=BanQiao&EndStation=TaoYuan&OutWardSearchDate=" +
                    java.net.URLEncoder.encode(dateStr, "UTF-8") + "&OutWardSearchTime=05%3A00&ReturnSearchDate=&ReturnSearchTime=&DiscountType="
                val northPost = "SearchType=S&Lang=TW&StartStation=TaoYuan&EndStation=BanQiao&OutWardSearchDate=" +
                    java.net.URLEncoder.encode(dateStr, "UTF-8") + "&OutWardSearchTime=05%3A00&ReturnSearchDate=&ReturnSearchTime=&DiscountType="

                val southDeferred = async { postHttp("https://www.thsrc.com.tw/TimeTable/Search", southPost, 6000) }
                val northDeferred = async { postHttp("https://www.thsrc.com.tw/TimeTable/Search", northPost, 6000) }

                val southRaw = southDeferred.await()
                val northRaw = northDeferred.await()

                val southTrains = TransitParsers.parseOfficialThsr(southRaw)
                val northTrains = TransitParsers.parseOfficialThsr(northRaw)

                if (southTrains.length() > 0 || northTrains.length() > 0) {
                    val isoStr = formatUtcIso(now)

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
                    lastFetchTimes["thsr"] = System.currentTimeMillis()
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
                    lastFetchTimes["thsr"] = System.currentTimeMillis()
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
        if (shouldSkipByCooldown("tymetro", force, 120000L)) return@withContext
        if (isRefreshing.putIfAbsent("tymetro", true) != null) return@withContext
        try {
            val now = Date()
            try {
                val southDeferred = async { fetchHttp("https://www.tymetro.com.tw/tymetro-new/tw/_pages/travel-guide/timetable.php?station=A3", 6000) }
                val northDeferred = async { fetchHttp("https://www.tymetro.com.tw/tymetro-new/tw/_pages/travel-guide/timetable.php?station=A18", 6000) }

                val southHtml = southDeferred.await()
                val northHtml = northDeferred.await()

                val southTrains = TransitParsers.parseOfficialTymetro(southHtml, true)
                val northTrains = TransitParsers.parseOfficialTymetro(northHtml, false)

                if (southTrains.length() > 0 || northTrains.length() > 0) {
                    val dateStr = formatTaipeiTime(now, "yyyy/MM/dd")
                    val isoStr = formatUtcIso(now)

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
                    lastFetchTimes["tymetro"] = System.currentTimeMillis()
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
                    lastFetchTimes["tymetro"] = System.currentTimeMillis()
                    notifyDataUpdated("tymetro")
                    return@withContext
                }
            }
        } finally {
            isRefreshing.remove("tymetro")
        }
    }

    /**
     * 純讀取目前原生記憶體快取（不觸發新網路請求，供原生推送後前端讀取用）
     */
    @JavascriptInterface
    fun getCachedData(dataType: String): String {
        val key = if (dataType == "metro") "metro-live" else dataType
        return dataMemoryCache[key] ?: ""
    }

    /**
     * 原生秒級即時 YouBike 直取 (優先回傳記憶體即時資料，背景自動非同步更新)
     */
    @JavascriptInterface
    fun getRealtimeYouBike(): String {
        bridgeScope.launch { refreshYouBikeAsync() }
        return dataMemoryCache["youbike"] ?: ""
    }

    /**
     * 原生秒級即時捷運看板與擁擠度直取 (優先回傳記憶體即時資料，背景自動非同步更新)
     */
    @JavascriptInterface
    fun getRealtimeMetroLive(): String {
        bridgeScope.launch { refreshMetroLiveAsync() }
        return dataMemoryCache["metro-live"] ?: ""
    }

    /**
     * 原生秒級即時高鐵停車位直取 (0 毫秒極速快取優先，背景自動非同步更新)
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
     * 原生秒級即時台灣高鐵官方班表直取 (0 毫秒極速快取優先，背景自動非同步更新)
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
     * 原生秒級即時機捷官方班表直取 (0 毫秒極速快取優先，背景自動非同步更新)
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
     * 原生整合獲取最新資料庫 (0 毫秒極速快取優先，全背景非同步並行更新)
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
            launch { refreshYouBikeAsync(force = true) }
            launch { refreshMetroLiveAsync(force = true) }
            launch { refreshParkingAsync(force = true) }
            launch { refreshThsrAsync(force = true) }
            launch { refreshTymetroAsync(force = true) }
        }
    }
}

/**
 * 大眾運輸 HTML / JSON 解析純 Kotlin 工具（供 AndroidNativeBridge 與單元測試共用）
 */
internal object TransitParsers {
    private val depRegex = Regex("""<div class="departStation">\s*([^<]+)\s*</div>[\s\S]*?<div class="destinationStation">\s*([^<]+)\s*</div>[\s\S]*?class="countDown"[^>]*data-start="([^"]+)"""")
    private val carRegex = Regex("""<span class="carNum">([^<]+)</span>[\s\S]*?<span class="carWeight">([\s\S]*?)</span>""", RegexOption.IGNORE_CASE)
    private val labelRegex = Regex("""class="label\s+([^"]+)"[^>]*>([^<]+)</label>""", RegexOption.IGNORE_CASE)
    private val trRegex = Regex("""<tr[^>]*>([\s\S]*?)</tr>""", RegexOption.IGNORE_CASE)
    private val tdRegex = Regex("""<td[^>]*>([\s\S]*?)</td>""", RegexOption.IGNORE_CASE)
    private val tagRegex = Regex("""<[^>]+>""")
    private val tableRegex = Regex("""<table[\s\S]*?</table>""", RegexOption.IGNORE_CASE)
    private val rowRegex = Regex("""<tr>([\s\S]*?)</tr>""", RegexOption.IGNORE_CASE)
    private val thRegex = Regex("""<th[^>]*scope="row"[^>]*>(\d{1,2})</th>""", RegexOption.IGNORE_CASE)
    private val minRegex = Regex("""<i>(\d{1,2})</i>""", RegexOption.IGNORE_CASE)

    fun parseDepartureHtml(html: String, defaultStation: String): List<JSONObject> {
        val list = mutableListOf<JSONObject>()
        for (m in depRegex.findAll(html)) {
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
                from.contains("民生") || from.contains("產業園區") -> "環狀線"
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

    fun parseCarWeightHtml(html: String, stationName: String, code: String): JSONObject {
        val carsArray = JSONArray()
        val seenCars = mutableSetOf<String>()

        for (cm in carRegex.findAll(html)) {
            val carNum = cm.groupValues[1].trim()
            if (seenCars.contains(carNum)) continue
            seenCars.add(carNum)

            val raw = cm.groupValues[2]
            val lm = labelRegex.find(raw)
            val status: String
            val level: Int
            if (lm != null) {
                status = lm.groupValues[2].trim()
                val cls = lm.groupValues[1].lowercase(Locale.US)
                level = when {
                    cls.contains("danger") -> 4
                    cls.contains("warning") -> 3
                    cls.contains("info") || cls.contains("primary") -> 2
                    else -> 1
                }
            } else {
                val clean = raw.replace(tagRegex, "").trim()
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

    fun parseParkingHtml(html: String): JSONArray {
        val lotsArray = JSONArray()
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

    fun parseOfficialThsr(jsonStr: String): JSONArray {
        val trainsArray = JSONArray()
        val items = mutableListOf<Pair<Int, JSONObject>>()
        try {
            val root = JSONObject(jsonStr)
            val data = root.optJSONObject("data") ?: return trainsArray
            val depTable = data.optJSONObject("DepartureTable") ?: return trainsArray
            val trainItem = depTable.optJSONArray("TrainItem") ?: return trainsArray

            for (i in 0 until trainItem.length()) {
                val t = trainItem.getJSONObject(i)
                val trainNo = t.optString("TrainNumber", "")
                val cleanNo = trainNo.trimStart('0')
                // 嚴格排除不停靠桃園站之 1xx / 11xx 直達台中車次（保留 16xx）
                if (cleanNo.startsWith("1") && cleanNo.length <= 4 && !cleanNo.startsWith("16")) {
                    continue
                }
                val depTime = t.optString("DepartureTime", "")
                val arrTime = t.optString("DestinationTime", "")
                if (depTime.isNotBlank() && arrTime.isNotBlank()) {
                    val depParts = depTime.split(":").mapNotNull { it.toIntOrNull() }
                    val arrParts = arrTime.split(":").mapNotNull { it.toIntOrNull() }
                    if (depParts.size >= 2 && arrParts.size >= 2) {
                        var duration = (arrParts[0] * 60 + arrParts[1]) - (depParts[0] * 60 + depParts[1])
                        if (duration < 0) duration += 1440
                        val isExpress = trainNo.startsWith("06") || trainNo.startsWith("6")
                        val depOpH = if (depParts[0] < 4) depParts[0] + 24 else depParts[0]
                        val depMinutes = depOpH * 60 + depParts[1]
                        val item = JSONObject().apply {
                            put("trainNo", trainNo)
                            put("depTime", depTime)
                            put("arrTime", arrTime)
                            put("duration", if (duration > 0) duration else 12)
                            put("isExpress", isExpress)
                            put("type", if (isExpress) "6xx特快" else "8xx全停")
                            put("stopsAtTaoyuan", true)
                            put("depMinutes", depMinutes)
                        }
                        items.add(depMinutes to item)
                    }
                }
            }
            items.sortedBy { it.first }.forEach { trainsArray.put(it.second) }
        } catch (_: Exception) {}
        return trainsArray
    }

    fun parseOfficialTymetro(html: String, isSouth: Boolean): JSONArray {
        val trainsArray = JSONArray()
        val items = mutableListOf<Pair<Int, JSONObject>>()
        try {
            val tables = tableRegex.findAll(html).map { it.value }.toList()
            val targetTableIndex = if (isSouth) 1 else 0
            val tbl = if (tables.size > targetTableIndex) tables[targetTableIndex] else return trainsArray

            for (rm in rowRegex.findAll(tbl)) {
                val row = rm.groupValues[1]
                val hm = thRegex.find(row) ?: continue
                val hInt = hm.groupValues[1].toIntOrNull() ?: continue
                val h = hInt.toString().padStart(2, '0')
                val opH = if (hInt < 4) hInt + 24 else hInt

                for (tdm in tdRegex.findAll(row)) {
                    val td = tdm.value
                    val mm = minRegex.find(td) ?: continue
                    val mInt = mm.groupValues[1].toIntOrNull() ?: continue
                    val m = mInt.toString().padStart(2, '0')

                    val isExp = td.contains("直達車")
                    val isPeakA18 = td.contains("停靠A18") || td.contains("尖峰增停直達車")
                    val stopsAtA18 = !isExp || isPeakA18

                    if (!stopsAtA18) continue

                    val depTime = "$h:$m"
                    val depMinutes = opH * 60 + mInt
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
                    items.add(depMinutes to item)
                }
            }
            items.sortedBy { it.first }.forEach { trainsArray.put(it.second) }
        } catch (_: Exception) {}
        return trainsArray
    }

    /**
     * 解析新北市政府資料開放平台官方 YouBike 2.0 CSV（支援 BOM 去除與雙引號內逗號轉義）
     */
    fun parseYouBikeCsv(csvStr: String): JSONArray {
        val result = JSONArray()
        if (csvStr.isBlank()) return result
        try {
            val clean = csvStr.trimStart('\uFEFF')
            val lines = clean.lines().filter { it.isNotBlank() }
            if (lines.size < 2) return result

            val headers = splitCsvLine(lines[0]).map { it.trim().trim('"') }
            if (headers.isEmpty()) return result

            val idxSno = headers.indexOf("sno")
            val idxSna = headers.indexOf("sna")
            if (idxSno < 0 && idxSna < 0) return result

            for (lineIdx in 1 until lines.size) {
                val cols = splitCsvLine(lines[lineIdx])
                if (cols.size < headers.size / 2) continue

                fun col(name: String): String {
                    val idx = headers.indexOf(name)
                    return if (idx in cols.indices) cols[idx].trim().trim('"') else ""
                }

                val act = col("act")
                if (act == "0") continue

                val sno = col("sno")
                val sna = col("sna")
                if (sno.isEmpty() && sna.isEmpty()) continue

                val sbiQty = col("sbi_quantity").ifEmpty { col("sbi") }
                val totQty = col("tot_quantity").ifEmpty { col("tot") }
                val bemp = col("bemp")
                val eybQty = col("eyb_quantity")
                val mday = col("mday")
                val lat = col("lat")
                val lng = col("lng")
                val ar = col("ar")

                val item = JSONObject().apply {
                    put("sno", sno)
                    put("sna", sna)
                    put("sbi_quantity", sbiQty.toIntOrNull() ?: 0)
                    put("tot_quantity", totQty.toIntOrNull() ?: 0)
                    put("bemp", bemp.toIntOrNull() ?: 0)
                    put("eyb_quantity", eybQty.toIntOrNull() ?: 0)
                    put("mday", mday)
                    lat.toDoubleOrNull()?.let { put("lat", it) }
                    lng.toDoubleOrNull()?.let { put("lng", it) }
                    if (ar.isNotEmpty()) put("ar", ar)
                    put("act", act.ifEmpty { "1" })
                }
                result.put(item)
            }
        } catch (_: Exception) {}
        return result
    }

    private fun splitCsvLine(line: String): List<String> {
        val out = ArrayList<String>(20)
        val sb = StringBuilder()
        var inQuotes = false
        var i = 0
        while (i < line.length) {
            val ch = line[i]
            when {
                ch == '"' -> {
                    if (inQuotes && i + 1 < line.length && line[i + 1] == '"') {
                        sb.append('"')
                        i++
                    } else {
                        inQuotes = !inQuotes
                    }
                }
                ch == ',' && !inQuotes -> {
                    out.add(sb.toString())
                    sb.setLength(0)
                }
                else -> sb.append(ch)
            }
            i++
        }
        out.add(sb.toString())
        return out
    }
}

internal data class AssetContentSpec(
    val mimeType: String,
    val isBinary: Boolean,
    val headers: Map<String, String>
)

/**
 * 靜態資源路徑解析、MIME 編碼判斷與 BOTE 攝影機隔離鍵工具（純 Kotlin 邏輯，供 MainActivity 與單元測試共用）
 */
internal object WebAssetRouting {
    private val boteCamKeyRegex = Regex("/(?:hls/|streamapi_)([0-9A-Za-z_-]+)")
    private val ytThumbRegex = Regex("^https?://i\\.ytimg\\.com/vi/([0-9A-Za-z_-]{6,20})/[^/?#]+", RegexOption.IGNORE_CASE)

    fun buildSnapshotFallbackUrls(rawUrl: String?): List<String> {
        val trimmed = rawUrl?.trim().orEmpty()
        if (!trimmed.startsWith("https://") && !trimmed.startsWith("http://")) {
            return emptyList()
        }
        val ytMatch = ytThumbRegex.find(trimmed)
        if (ytMatch != null) {
            val videoId = ytMatch.groupValues[1]
            return linkedSetOf(
                trimmed,
                "https://i.ytimg.com/vi/$videoId/maxresdefault_live.jpg",
                "https://i.ytimg.com/vi/$videoId/sddefault_live.jpg",
                "https://i.ytimg.com/vi/$videoId/hqdefault_live.jpg",
                "https://i.ytimg.com/vi/$videoId/maxresdefault.jpg",
                "https://i.ytimg.com/vi/$videoId/hqdefault.jpg"
            ).toList()
        }
        return listOf(trimmed)
    }
    private val nativeInterceptDomains = listOf(
        "raw.githubusercontent.com",
        "janede0214.github.io",
        "opendata.vip",
        "transportdata.tw",
        "nlsc.gov.tw",
        "data.ntpc.gov.tw",
        "opendata.tycg.gov.tw",
        "cwa.gov.tw",
        "cwaopendata.s3.ap-northeast-1.amazonaws.com",
        "thsrc.com.tw",
        "tymetro.com.tw",
        "earthquake.usgs.gov",
        "open-meteo.com",
        "api.met.no",
        "api.rainviewer.com",
        "transitous.org",
        "heartrails.com",
        "citybik.es",
        "bigdatacloud.net",
        "tfl.gov.uk",
        "opendata.ch"
    )

    fun isNativeInterceptHost(rawHost: String?): Boolean {
        val host = rawHost?.trim()?.lowercase(Locale.US)?.trimEnd('.') ?: return false
        if (host.isEmpty()) return false
        return nativeInterceptDomains.any { domain ->
            host == domain || host.endsWith(".$domain")
        }
    }

    fun resolveAssetPath(rawPath: String?): String? {
        var relPath = (rawPath ?: "/").trimStart('/')
        if (relPath.isEmpty() || relPath == "/") relPath = "index.html"
        if (relPath.startsWith("assets/")) relPath = relPath.removePrefix("assets/")
        if (relPath.isEmpty()) relPath = "index.html"
        if (relPath.contains("..")) return null
        return relPath
    }

    fun assetContentSpec(relPath: String): AssetContentSpec {
        val lower = relPath.lowercase(Locale.US)
        val isBinary = lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") ||
            lower.endsWith(".webp") || lower.endsWith(".ico") || lower.endsWith(".gif") ||
            lower.endsWith(".woff2") || lower.endsWith(".woff") || lower.endsWith(".ttf")

        val mimeType = when {
            lower.endsWith(".html") || lower.endsWith(".htm") -> "text/html"
            lower.endsWith(".js") -> "application/javascript"
            lower.endsWith(".css") -> "text/css"
            lower.endsWith(".webmanifest") -> "application/manifest+json"
            lower.endsWith(".json") -> "application/json"
            lower.endsWith(".svg") -> "image/svg+xml"
            lower.endsWith(".png") -> "image/png"
            lower.endsWith(".jpg") || lower.endsWith(".jpeg") -> "image/jpeg"
            lower.endsWith(".webp") -> "image/webp"
            lower.endsWith(".ico") -> "image/x-icon"
            else -> "application/octet-stream"
        }

        val headers = mutableMapOf(
            "Access-Control-Allow-Origin" to "*",
            "Cache-Control" to if (lower.endsWith(".json")) "no-store" else "public, max-age=3600"
        )
        if (lower.endsWith(".html") || lower.endsWith(".htm")) {
            headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        }

        return AssetContentSpec(
            mimeType = mimeType,
            isBinary = isBinary,
            headers = headers
        )
    }

    fun extractBoteCamKey(urlString: String): String {
        val m = boteCamKeyRegex.find(urlString)
        return m?.groupValues?.getOrNull(1) ?: "global"
    }

    /**
     * 從無盡 multipart/x-mixed-replace MJPEG 串流串流式擷取第一張完整 JPEG 畫格 (上限 8 MB 防溢位)
     */
    fun extractFirstJpegFrame(input: InputStream, maxScanBytes: Int = 8 * 1024 * 1024): ByteArray? {
        val out = ByteArrayOutputStream()
        var started = false
        var prev = -1
        var totalRead = 0
        val buf = ByteArray(4096)
        while (totalRead < maxScanBytes) {
            val n = input.read(buf)
            if (n <= 0) break
            totalRead += n
            for (i in 0 until n) {
                val b = buf[i].toInt() and 0xFF
                if (!started) {
                    if (prev == 0xFF && b == 0xD8) {
                        started = true
                        out.write(0xFF)
                        out.write(0xD8)
                    }
                } else {
                    out.write(b)
                    if (prev == 0xFF && b == 0xD9) {
                        return out.toByteArray()
                    }
                }
                prev = b
            }
        }
        return null
    }

    fun readBoundedBytes(input: InputStream, maxBytes: Int = 8 * 1024 * 1024): ByteArray? {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(8192)
        var totalRead = 0
        while (totalRead < maxBytes) {
            val toRead = minOf(buf.size, maxBytes - totalRead)
            val n = input.read(buf, 0, toRead)
            if (n <= 0) break
            out.write(buf, 0, n)
            totalRead += n
        }
        return if (out.size() > 0) out.toByteArray() else null
    }
}
