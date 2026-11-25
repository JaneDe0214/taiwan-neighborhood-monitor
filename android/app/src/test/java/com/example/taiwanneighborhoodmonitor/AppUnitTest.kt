package com.example.taiwanneighborhoodmonitor

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream

class AppUnitTest {

    @Test
    fun resolveAssetPath_normalizesRootAndAssetsPrefix() {
        assertEquals("index.html", WebAssetRouting.resolveAssetPath(null))
        assertEquals("index.html", WebAssetRouting.resolveAssetPath("/"))
        assertEquals("index.html", WebAssetRouting.resolveAssetPath("/assets/"))
        assertEquals("data/thsr.json", WebAssetRouting.resolveAssetPath("/assets/data/thsr.json"))
        assertEquals("data/cameras/taipei.json", WebAssetRouting.resolveAssetPath("data/cameras/taipei.json"))
        assertEquals("data/cameras/taipei.json", WebAssetRouting.resolveAssetPath("\\assets//data\\\\cameras/taipei.json"))
    }

    @Test
    fun resolveAssetPath_rejectsDirectoryTraversal() {
        assertNull(WebAssetRouting.resolveAssetPath("/../secrets.txt"))
        assertNull(WebAssetRouting.resolveAssetPath("assets/../../etc/passwd"))
        assertNull(WebAssetRouting.resolveAssetPath("/.git/HEAD"))
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
        assertTrue(t1.getBoolean("isExpress"))
        assertEquals("16xx特快", t1.getString("type"))

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

    @Test
    fun extractFirstJpegFrame_extractsSingleFrameFromMultipartStream() {
        val header = "--myboundary\r\nContent-Type: image/jpeg\r\n\r\n".toByteArray()
        // 含 EXIF (APP1 FF E1) 內嵌假 FF D8 ... FF D9 縮圖，接著 SOS (FF DA) 主影像資料與最後真正的 FF D9
        val fakeJpeg = byteArrayOf(
            0xFF.toByte(), 0xD8.toByte(),
            0xFF.toByte(), 0xE1.toByte(), 0x00, 0x08, // APP1 length = 8 bytes (含2位元組長度+6位元組EXIF縮圖含假FFD9)
            0xFF.toByte(), 0xD8.toByte(), 0x11, 0x22, 0xFF.toByte(), 0xD9.toByte(),
            0xFF.toByte(), 0xDA.toByte(), 0x00, 0x04, 0x33, 0x44, // SOS header + entropy scan
            0x55, 0x66,
            0xFF.toByte(), 0xD9.toByte()
        )
        val secondChunk = "--myboundary\r\nEXTRA_IGNORED_DATA".toByteArray()
        val stream = ByteArrayInputStream(header + fakeJpeg + secondChunk)

        val extracted = WebAssetRouting.extractFirstJpegFrame(stream)
        assertArrayEquals(fakeJpeg, extracted)

        val brokenStream = ByteArrayInputStream(byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0x01, 0x02))
        assertNull(WebAssetRouting.extractFirstJpegFrame(brokenStream))
    }

    @Test
    fun readBoundedBytes_capsMaxReadAndHandlesEmpty() {
        val sample = ByteArray(100) { (it and 0xFF).toByte() }
        val capped = WebAssetRouting.readBoundedBytes(ByteArrayInputStream(sample), maxBytes = 32)
        assertArrayEquals(sample.copyOfRange(0, 32), capped)

        assertNull(WebAssetRouting.readBoundedBytes(ByteArrayInputStream(sample), maxBytes = 32, rejectOnOverflow = true))
        val exactFit = WebAssetRouting.readBoundedBytes(ByteArrayInputStream(sample), maxBytes = 100, rejectOnOverflow = true)
        assertArrayEquals(sample, exactFit)

        assertNull(WebAssetRouting.readBoundedBytes(ByteArrayInputStream(ByteArray(0))))
    }

    @Test
    fun parseOfficialThsr_classifies5xxAnd15xxCommuterAndFilters2xxExpress() {
        val json = """
            {
              "data": {
                "DepartureTable": {
                  "TrainItem": [
                    { "TrainNumber": "0502", "DepartureTime": "06:34", "DestinationTime": "06:47" },
                    { "TrainNumber": "1504", "DepartureTime": "07:05", "DestinationTime": "07:18" },
                    { "TrainNumber": "0205", "DepartureTime": "08:10", "DestinationTime": "08:22" }
                  ]
                }
              }
            }
        """.trimIndent()
        val trains = TransitParsers.parseOfficialThsr(json)
        assertEquals(2, trains.length())
        assertEquals("5xx區間", trains.getJSONObject(0).getString("type"))
        assertEquals("15xx區間", trains.getJSONObject(1).getString("type"))
    }

    @Test
    fun parseYouBikeCsv_handlesBomQuotedCommasAndFiltersInactive() {
        val csv = "\uFEFFsno,sna,tot,sbi,sarea,mday,lat,lng,ar,bemp,act,sbi_quantity,eyb_quantity,tot_quantity\n" +
            "500201001,\"YouBike2.0_捷運新埔站(3號出口)\",20,9,板橋區,20261118080000,25.02247,121.46868,\"民生路二段232號,近3號出口\",11,1,9,3,20\n" +
            "500201002,YouBike2.0_暫停營運站,30,0,板橋區,20261118080000,25.02000,121.46000,文化路一段,30,0,0,0,30\n"

        val arr = TransitParsers.parseYouBikeCsv(csv)
        assertEquals(1, arr.length())
        val st = arr.getJSONObject(0)
        assertEquals("500201001", st.getString("sno"))
        assertEquals("YouBike2.0_捷運新埔站(3號出口)", st.getString("sna"))
        assertEquals(9, st.getInt("sbi_quantity"))
        assertEquals(3, st.getInt("eyb_quantity"))
        assertEquals(11, st.getInt("bemp"))
        assertEquals(20, st.getInt("tot_quantity"))
        assertEquals("民生路二段232號,近3號出口", st.getString("ar"))
        assertEquals(25.02247, st.getDouble("lat"), 1e-5)
        assertEquals(121.46868, st.getDouble("lng"), 1e-5)

        assertEquals(0, TransitParsers.parseYouBikeCsv("").length())
        assertEquals(0, TransitParsers.parseYouBikeCsv("invalid,header\n1,2").length())
    }

    @Test
    fun isNativeInterceptHost_matchesAllowedSubdomainsAndRejectsSpoofedHosts() {
        assertTrue(WebAssetRouting.isNativeInterceptHost("www.opendata.vip"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("api.nlsc.gov.tw"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("api.transitous.org"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("express.heartrails.com"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("api.citybik.es"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("api.bigdatacloud.net"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("api.tfl.gov.uk"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("transport.opendata.ch"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("tcgbusfs.blob.core.windows.net"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("open.er-api.com"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("services.swpc.noaa.gov"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("www.tymetro.com.tw"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("api.rainviewer.com"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("tilecache.rainviewer.com"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("tile.openstreetmap.org"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("server.arcgisonline.com"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("cctvtraffic.tycg.gov.tw"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("air-quality-api.open-meteo.com"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("api.met.no"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("cwaopendata.s3.ap-northeast-1.amazonaws.com"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("apis.youbike.com.tw"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("cdn.star.nesdis.noaa.gov"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("panodata.panomax.com"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("www.foto-webcam.eu"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("lotus.stingray.com"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("pb-ehs1glsha1juy.akamaized.net"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("dqga3jatxofgx.cloudfront.net"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("iptv.peer.biz"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("media-tyo.hls.nhkworld.jp"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("data-cloud.flightradar24.com"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("opendata.adsb.fi"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("api.adsbdb.com"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("marine-api.open-meteo.com"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("de1.api.radio-browser.info"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("zh.wikipedia.org"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("date.nager.at"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("api.wheretheiss.at"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("news.google.com"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("linear-1224.frequency.stream"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("directes-tv-int.3catdirectes.cat"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("53ff3982.wurl.com"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("volcanoes.usgs.gov"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("weather.cs.uit.no"))
        assertTrue(WebAssetRouting.isNativeInterceptHost("pixelcaster.com"))

        assertFalse(WebAssetRouting.isNativeInterceptHost("www.youtube.com"))
        assertFalse(WebAssetRouting.isNativeInterceptHost("evil-opendata.vip"))
        assertFalse(WebAssetRouting.isNativeInterceptHost("opendata.vip.attacker.com"))
        assertFalse(WebAssetRouting.isNativeInterceptHost(null))
        assertFalse(WebAssetRouting.isNativeInterceptHost(""))

        val manifestSpec = WebAssetRouting.assetContentSpec("manifest.webmanifest")
        assertEquals("application/manifest+json", manifestSpec.mimeType)
        assertFalse(manifestSpec.isBinary)
    }

    @Test
    fun buildSnapshotFallbackUrls_generatesYoutubeMultiResolutionChainAndRejectsInvalidSchemes() {
        val ytChain = WebAssetRouting.buildSnapshotFallbackUrls("https://i.ytimg.com/vi/5gVrWGRZo9s/maxresdefault_live.jpg")
        assertEquals(5, ytChain.size)
        assertEquals("https://i.ytimg.com/vi/5gVrWGRZo9s/maxresdefault_live.jpg", ytChain.first())
        assertEquals("https://i.ytimg.com/vi/5gVrWGRZo9s/hqdefault.jpg", ytChain.last())

        val regularUrl = WebAssetRouting.buildSnapshotFallbackUrls("https://cctv.freeway.gov.tw/abs2mjpg/bmjpg?camera=100")
        assertEquals(listOf("https://cctv.freeway.gov.tw/abs2mjpg/bmjpg?camera=100"), regularUrl)

        assertTrue(WebAssetRouting.buildSnapshotFallbackUrls("javascript:alert(1)").isEmpty())
        assertTrue(WebAssetRouting.buildSnapshotFallbackUrls(null).isEmpty())
    }

    @Test
    fun extractFirstJpegFrame_handlesLargeMultiChunkFrameZeroCopy() {
        val prefix = ByteArray(4095) { 0x2D } // 刻意讓 FF D8 跨 4096-byte 讀取邊界
        val sosHeader = byteArrayOf(
            0xFF.toByte(), 0xD8.toByte(),
            0xFF.toByte(), 0xDA.toByte(), 0x00, 0x04, 0x11, 0x22
        )
        val entropyPayload = ByteArray(20000) { idx -> if (idx % 97 == 0) 0x55 else 0x33 }
        val eoi = byteArrayOf(0xFF.toByte(), 0xD9.toByte())
        val trailing = "--boundary\r\nNEXT_FRAME".toByteArray()
        val expected = sosHeader + entropyPayload + eoi

        val extracted = WebAssetRouting.extractFirstJpegFrame(ByteArrayInputStream(prefix + expected + trailing))
        assertArrayEquals(expected, extracted)
    }

    @Test
    fun gentleVoiceSelector_prefersTaiwanAndJapanGentleFemaleVoicesOverMale() {
        val twCandidates = listOf(
            GentleVoiceSelector.VoiceCandidate("cmn-tw-x-ctd-local", "zh-TW", 400, false), // 男聲
            GentleVoiceSelector.VoiceCandidate("cmn-cn-x-ccc-local", "zh-CN", 500, false), // 非台灣區域
            GentleVoiceSelector.VoiceCandidate("cmn-tw-x-ctc-local", "zh-TW", 400, false)  // 台灣溫柔女聲
        )
        assertEquals(2, GentleVoiceSelector.pickBestVoiceIndex(twCandidates, "zh-TW"))

        val jpCandidates = listOf(
            GentleVoiceSelector.VoiceCandidate("ja-jp-x-jad-local", "ja-JP", 400, false), // 男聲
            GentleVoiceSelector.VoiceCandidate("ja-jp-x-jab-local", "ja-JP", 400, false)  // 日本女聲
        )
        assertEquals(1, GentleVoiceSelector.pickBestVoiceIndex(jpCandidates, "ja-JP"))

        val enCandidates = listOf(
            GentleVoiceSelector.VoiceCandidate("en-us-x-iom-local", "en-US", 500, false), // 男聲
            GentleVoiceSelector.VoiceCandidate("en-us-x-tpf-local", "en-US", 400, false)  // 溫柔英文女聲
        )
        assertEquals(1, GentleVoiceSelector.pickBestVoiceIndex(enCandidates, "en-US"))

        val (rate, pitch) = GentleVoiceSelector.acousticParams("phrase")
        assertTrue(rate in 0.85f..0.95f)
        assertTrue(pitch in 1.04f..1.12f)
    }
}
