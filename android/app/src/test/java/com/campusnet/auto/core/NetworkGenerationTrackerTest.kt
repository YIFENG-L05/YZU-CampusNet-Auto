package com.campusnet.auto.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 网络代际计数器测试。
 *
 * 锁的是一条**并发安全不变量**（本阶段审计问题 R2/R3）：
 *   "认证任务属于某一个 Network；网络换人之后，旧任务的结果必须作废。"
 * 判断"换人"的唯一依据就是这里的代际号，所以它必须**只在真的换人时才变**：
 *   · 同一个网络被反复读到（Android 每次 refresh 都会重设一次）→ **不能**变
 *   · 换了网络 / 断网（null）→ **必须**变
 */
class NetworkGenerationTrackerTest {

    @Test
    fun `初始代际为 0`() {
        assertEquals(0, NetworkGenerationTracker().current())
    }

    @Test
    fun `同一个网络重复上报不会推进代际`() {
        val tracker = NetworkGenerationTracker()
        val a = "NET-A"
        assertTrue("第一次赋值算换人", tracker.update(a))
        assertEquals(1, tracker.current())
        assertFalse("同一个网络再报一次不该算换人", tracker.update(a))
        assertFalse(tracker.update(a))
        assertEquals("代际必须保持不变", 1, tracker.current())
    }

    @Test
    fun `换成另一个网络会推进代际`() {
        val tracker = NetworkGenerationTracker()
        tracker.update("NET-A")
        assertTrue(tracker.update("NET-B"))
        assertEquals(2, tracker.current())
    }

    @Test
    fun `断网（null）也算换人 —— 旧任务必须作废`() {
        val tracker = NetworkGenerationTracker()
        tracker.update("NET-A")
        assertTrue("网络断开 → 代际推进", tracker.update(null))
        assertEquals(2, tracker.current())
        assertFalse("已经是 null 再报 null 不推进", tracker.update(null))
    }

    @Test
    fun `断开后重连同一个网络仍然是新的一代`() {
        val tracker = NetworkGenerationTracker()
        tracker.update("NET-A")
        tracker.update(null)
        assertTrue("A → 断 → A：对认证任务来说这是新的一代", tracker.update("NET-A"))
        assertEquals(3, tracker.current())
    }

    @Test
    fun `相等但不同实例的网络标识按 equals 判断（不会误判成换人）`() {
        val tracker = NetworkGenerationTracker()
        // Android 的 Network.equals 按 netId 比较：不同实例代表同一个网络时必须算"没换"
        assertEquals("NET-A", String(StringBuilder("NET-A")))
        tracker.update("NET-A")
        assertFalse(tracker.update("NET-A"))
        assertEquals(1, tracker.current())
    }

    @Test
    fun `认证任务可以在中途用它判断自己是否过期`() {
        val tracker = NetworkGenerationTracker()
        tracker.update("NET-A")
        val attemptToken = tracker.current()
        tracker.update("NET-B") // 认证还没跑完，网络换人了
        assertTrue("结果必须被丢弃", attemptToken != tracker.current())
    }
}
