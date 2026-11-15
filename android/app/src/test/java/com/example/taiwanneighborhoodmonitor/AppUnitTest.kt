package com.example.taiwanneighborhoodmonitor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppUnitTest {
    @Test
    fun testAppNamespace() {
        assertEquals("com.example.taiwanneighborhoodmonitor", "com.example.taiwanneighborhoodmonitor")
    }

    @Test
    fun testDurationCalculation() {
        val depMinutes = 11 * 60 + 38 // 11:38
        val arrMinutes = 11 * 60 + 50 // 11:50
        val duration = arrMinutes - depMinutes
        assertEquals(12, duration)
    }

    @Test
    fun testOvernightDurationCalculation() {
        val depMinutes = 23 * 60 + 55
        val arrMinutes = 0 * 60 + 15
        var duration = arrMinutes - depMinutes
        if (duration < 0) duration += 1440
        assertEquals(20, duration)
    }

    @Test
    fun testWebAssetResolvePath() {
        assertEquals("index.html", WebAssetRouting.resolveAssetPath(null))
        assertEquals("index.html", WebAssetRouting.resolveAssetPath(""))
        assertEquals("index.html", WebAssetRouting.resolveAssetPath("/"))
        assertEquals("index.html", WebAssetRouting.resolveAssetPath("/index.html"))
        assertEquals("index.html", WebAssetRouting.resolveAssetPath("/assets/index.html"))
        assertEquals("index.html", WebAssetRouting.resolveAssetPath("/assets/"))
        assertEquals("data/youbike.json", WebAssetRouting.resolveAssetPath("/assets/data/youbike.json"))
        assertNull(WebAssetRouting.resolveAssetPath("../secret"))
        assertNull(WebAssetRouting.resolveAssetPath("/assets/../../etc/passwd"))
    }

    @Test
    fun testWebAssetContentSpecHtmlAndBinaryAndJson() {
        val htmlSpec = WebAssetRouting.assetContentSpec("index.html")
        assertEquals("text/html", htmlSpec.mimeType)
        assertFalse(htmlSpec.isBinary)
        assertEquals("strict-origin-when-cross-origin", htmlSpec.headers["Referrer-Policy"])
        assertEquals("*", htmlSpec.headers["Access-Control-Allow-Origin"])
        assertEquals("public, max-age=3600", htmlSpec.headers["Cache-Control"])

        val jpgSpec = WebAssetRouting.assetContentSpec("images/dpuLogo.JPG")
        assertEquals("image/jpeg", jpgSpec.mimeType)
        assertTrue(jpgSpec.isBinary)
        assertNull(jpgSpec.headers["Referrer-Policy"])

        val jsonSpec = WebAssetRouting.assetContentSpec("data/youbike.json")
        assertEquals("application/json", jsonSpec.mimeType)
        assertFalse(jsonSpec.isBinary)
        assertEquals("no-store", jsonSpec.headers["Cache-Control"])
    }

    @Test
    fun testExtractBoteCamKey() {
        assertEquals(
            "C000123",
            WebAssetRouting.extractBoteCamKey("https://hls.bote.gov.taipei/hls/C000123/index.m3u8")
        )
        assertEquals(
            "C000456",
            WebAssetRouting.extractBoteCamKey("https://hls.bote.gov.taipei/streamapi_C000456?token=abc")
        )
        assertEquals(
            "global",
            WebAssetRouting.extractBoteCamKey("https://hls.bote.gov.taipei/live/index.html")
        )
    }
}
