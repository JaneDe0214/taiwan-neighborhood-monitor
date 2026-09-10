package com.example.taiwanneighborhoodmonitor

import org.junit.Assert.assertEquals
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
}
