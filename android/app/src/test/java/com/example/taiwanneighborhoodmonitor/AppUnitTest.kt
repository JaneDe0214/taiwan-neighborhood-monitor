package com.example.taiwanneighborhoodmonitor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppUnitTest {

    @Test
    fun resolveAssetPath_normalizesRootAndAssetsPrefix() {
        assertEquals("index.html", WebAssetRouting.resolveAssetPath(null))
        assertEquals("index.html", WebAssetRouting.resolveAssetPath("/"))
        assertEquals("index.html", WebAssetRouting.resolveAssetPath("/assets/"))
        assertEquals("data/thsr.json", WebAssetRouting.resolveAssetPath("/assets/data/thsr.json"))
        assertEquals("data/cameras/taipei.json", WebAssetRouting.resolveAssetPath("data/cameras/taipei.json"))
    }

    @Test
    fun resolveAssetPath_rejectsDirectoryTraversal() {
        assertNull(WebAssetRouting.resolveAssetPath("/../secrets.txt"))
        assertNull(WebAssetRouting.resolveAssetPath("assets/../../etc/passwd"))
    }

    @Test
    fun assetContentSpec_returnsExpectedMimeBinaryAndCacheHeaders() {
        val htmlSpec = WebAssetRouting.assetContentSpec("index.html")
        assertEquals("text/html", htmlSpec.mimeType)
        assertFalse(htmlSpec.isBinary)
        assertEquals("*", htmlSpec.headers["Access-Control-Allow-Origin"])
        assertEquals("strict-origin-when-cross-origin", htmlSpec.headers["Referrer-Policy"])
        assertEquals("public, max-age=3600", htmlSpec.headers["Cache-Control"])

        val jsonSpec = WebAssetRouting.assetContentSpec("data/youbike.json")
        assertEquals("application/json", jsonSpec.mimeType)
        assertFalse(jsonSpec.isBinary)
        assertEquals("no-store", jsonSpec.headers["Cache-Control"])

        val pngSpec = WebAssetRouting.assetContentSpec("icon.png")
        assertEquals("image/png", pngSpec.mimeType)
        assertTrue(pngSpec.isBinary)
    }

    @Test
    fun extractBoteCamKey_isolatesDifferentCameras() {
        assertEquals("132", WebAssetRouting.extractBoteCamKey("https://hls.bote.gov.taipei/hls/132/live.m3u8"))
        assertEquals("142", WebAssetRouting.extractBoteCamKey("https://hls.bote.gov.taipei/streamapi_142/playlist.m3u8"))
        assertEquals("global", WebAssetRouting.extractBoteCamKey("https://hls.bote.gov.taipei/favicon.ico"))
    }

    @Test
    fun parseDepartureHtml_extractsStationDestLineAndCountdownSeconds() {
        val html = """
            <div class="row">
                <div class="departStation">新埔</div>
                <div class="destinationStation">頂埔</div>
                <span class="countDown" data-start="02:35">02:35</span>
            </div>
            <div class="row">
                <div class="departStation">新埔民生</div>
                <div class="destinationStation">新北產業園區</div>
                <span class="countDown" data-start="進站中">進站中</span>
            </div>
        """.trimIndent()

        val result = TransitParsers.parseDepartureHtml(html, "板橋")
        assertEquals(2, result.size)

        assertEquals("新埔", result[0].getString("station"))
        assertEquals("頂埔", result[0].getString("dest"))
        assertEquals("板南線", result[0].getString("line"))
        assertEquals(155, result[0].getInt("remainSec"))

        assertEquals("新埔民生", result[1].getString("station"))
        assertEquals("新北產業園區", result[1].getString("dest"))
        assertEquals("環狀線", result[1].getString("line"))
        assertEquals(20, result[1].getInt("remainSec"))
    }

    @Test
    fun parseCarWeightHtml_extractsUniqueCarsAndEmptyFallback() {
        val html = """
            <div><span class="carNum">1車</span><span class="carWeight"><label class="label label-success">舒適</label></span></div>
            <div><span class="carNum">1車</span><span class="carWeight"><label class="label label-danger">擁擠</label></span></div>
            <div><span class="carNum">2車</span><span class="carWeight"><label class="label label-warning">略擠</label></span></div>
        """.trimIndent()

        val parsed = TransitParsers.parseCarWeightHtml(html, "新埔站", "BL08")
        assertTrue(parsed.getBoolean("hasData"))
        val cars = parsed.getJSONArray("cars")
        assertEquals(2, cars.length())
        assertEquals("1車", cars.getJSONObject(0).getString("carNum"))
        assertEquals(1, cars.getJSONObject(0).getInt("level"))
        assertEquals("2車", cars.getJSONObject(1).getString("carNum"))
        assertEquals(3, cars.getJSONObject(1).getInt("level"))

        val fallback = TransitParsers.parseCarWeightHtml("<div>營運時間已過</div>", "新埔站", "BL08")
        assertFalse(fallback.getBoolean("hasData"))
        assertEquals("營運時間已過", fallback.getString("message"))
        assertEquals(6, fallback.getJSONArray("cars").length())
    }

    @Test
    fun parseParkingHtml_extractsTaoyuanAndBanqiaoLotsAndCounts() {
        val html = """
            <table>
              <tr><td>桃園高鐵 P1停車場</td><td>128 / 450</td><td>80元/時</td><td>尚有車位</td></tr>
              <tr><td>台中站停車場</td><td>10 / 100</td><td>60元/時</td><td>車位充足</td></tr>
            </table>
        """.trimIndent()

        val lots = TransitParsers.parseParkingHtml(html)
        assertEquals(1, lots.length())
        val lot = lots.getJSONObject(0)
        assertEquals("桃園高鐵 P1停車場", lot.getString("name"))
        assertEquals(128, lot.getInt("available"))
        assertEquals(450, lot.getInt("total"))
        assertEquals("尚有車位", lot.getString("status"))
    }

    @Test
    fun parseOfficialThsr_parsesTrainsAndDurationAndExpressFlag() {
        val json = """
            {
              "data": {
                "DepartureTable": {
                  "TrainItem": [
                    { "TrainNumber": "0837", "DepartureTime": "00:02", "DestinationTime": "00:15" },
                    { "TrainNumber": "0109", "DepartureTime": "15:10", "DestinationTime": "15:22" },
                    { "TrainNumber": "0657", "DepartureTime": "16:20", "DestinationTime": "16:32" },
                    { "TrainNumber": "1609", "DepartureTime": "17:10", "DestinationTime": "17:23" }
                  ]
                }
              }
            }
        """.trimIndent()

        val trains = TransitParsers.parseOfficialThsr(json)
        // 必須排除不停桃園之 0109（保留 1609），並依營運日分鐘數遞增排序（00:02 在最後）
        assertEquals(3, trains.length())

        val t0 = trains.getJSONObject(0)
        assertEquals("0657", t0.getString("trainNo"))
        assertEquals(12, t0.getInt("duration"))
        assertTrue(t0.getBoolean("isExpress"))
        assertEquals(16 * 60 + 20, t0.getInt("depMinutes"))

        val t1 = trains.getJSONObject(1)
        assertEquals("1609", t1.getString("trainNo"))

        val t2 = trains.getJSONObject(2)
        assertEquals("0837", t2.getString("trainNo"))
        assertEquals(13, t2.getInt("duration"))
        assertFalse(t2.getBoolean("isExpress"))
        assertEquals(24 * 60 + 2, t2.getInt("depMinutes"))
    }

    @Test
    fun parseOfficialTymetro_placesMidnightTrainLastWithOperatingMinutes() {
        val html = """
            <table><tr><th scope="row">0</th><td><span class="commuter"><i>04</i></span></td></tr></table>
            <table>
              <tr><th scope="row">0</th><td><span><i>04</i></span></td></tr>
              <tr><th scope="row">6</th><td><span title="直達車">直達車 <i>15</i></span></td><td><span title="停靠A18直達車">直達車 停靠A18 <i>30</i></span></td></tr>
              <tr><th scope="row">23</th><td><span><i>49</i></span></td></tr>
            </table>
        """.trimIndent()

        val southTrains = TransitParsers.parseOfficialTymetro(html, isSouth = true)
        assertEquals(3, southTrains.length())

        // 第一班應為 06:30（普通車/增停A18直達車，而未停A18的一般直達車 06:15 必須被過濾）
        val first = southTrains.getJSONObject(0)
        assertEquals("06:30", first.getString("depTime"))
        assertEquals(6 * 60 + 30, first.getInt("depMinutes"))
        assertTrue(first.getBoolean("isExpress"))

        val second = southTrains.getJSONObject(1)
        assertEquals("23:49", second.getString("depTime"))
        assertEquals(23 * 60 + 49, second.getInt("depMinutes"))

        // 跨日 00:04 末班車必須計算為 1444 分鐘並排在 23:49 之後
        val last = southTrains.getJSONObject(2)
        assertEquals("00:04", last.getString("depTime"))
        assertEquals(1444, last.getInt("depMinutes"))
        assertEquals("00:42", last.getString("arrTime"))
        assertFalse(last.getBoolean("isExpress"))
    }
}
