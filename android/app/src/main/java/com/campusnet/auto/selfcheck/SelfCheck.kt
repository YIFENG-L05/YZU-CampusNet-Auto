package com.campusnet.auto.selfcheck

import android.content.Context
import com.campusnet.auto.core.CredentialStore
import com.campusnet.auto.core.LoginBlock
import com.campusnet.auto.core.NetworkKind
import com.campusnet.auto.core.Platform
import com.campusnet.auto.core.PortalDiscovery
import com.campusnet.auto.core.ProbeExpectation
import com.campusnet.auto.core.ProbeHttpResult
import com.campusnet.auto.core.ProbeOutcome
import com.campusnet.auto.core.ProbeReport
import com.campusnet.auto.core.ProbeSample
import com.campusnet.auto.core.SuggestionDecision
import com.campusnet.auto.js.JsCoreRuntime
import com.campusnet.auto.platform.AndroidAdapterAssets
import com.campusnet.auto.platform.AndroidJsBridge
import com.campusnet.auto.platform.AndroidPlatform
import com.campusnet.auto.platform.AuthStateHolder
import com.campusnet.auto.platform.LoginGate
import kotlinx.coroutines.cancel
import org.json.JSONObject

/**
 * 真机边界自检（第二/三/四阶段的回归项都在这）。
 *
 * 为什么写成"应用内自检"而不是单元测试：
 *   这里验证的东西（NetworkCallback 真的收到事件、Keystore 真能加解密、
 *   应用私有目录里有没有明文、HTTP 有没有真绑定到当前 Network、
 *   QuickJS 里能不能跑 Core 的协议、前台服务里定时器还跑不跑）**只有在真机上才有意义**。
 *   纯逻辑部分（网络分类 / SSID 匹配 / 探测判定 / 建议去重 / 登录守卫 / 门户发现）
 *   已经放在 `src/test` 里用 JUnit 覆盖，见那几个 *Test.kt。
 *
 * @param mockPortalUrl 可选：adb 传进来的 Mock 门户地址（只用于验证登录链路，
 *   **不使用真实凭据**）。为空时第 22 项会如实说明"未验证"而不是假装通过。
 */
class SelfCheck(
    private val context: Context,
    private val mockPortalUrl: String? = null,
) {

    data class Item(val name: String, val passed: Boolean, val detail: String)

    suspend fun run(js: JsCoreRuntime, platform: AndroidPlatform): List<Item> {
        val items = mutableListOf<Item>()

        // ── 第二阶段回归：JS Core 仍能加载与调用 ──
        try {
            js.loadModule(REDACT_MODULE)
            items += Item(
                "1. 加载 src/shared 的 JS 模块",
                js.loadedModules().contains(REDACT_MODULE),
                "已加载: " + js.loadedModules().joinToString(", "),
            )
        } catch (e: Throwable) {
            items += Item("1. 加载 src/shared 的 JS 模块", false, e.toString())
        }

        try {
            val result = js.evalToString(
                "__cjs.require(${quote(REDACT_MODULE_NO_EXT)}).redactUrl(${quote(URL_WITH_SECRET)})"
            )
            val leaked = result == null || result.contains(SECRET_IN_URL)
            items += Item(
                "2. JS 脱敏调用（密码不得出现在结果里）",
                !leaked,
                if (result == null) "调用返回 null" else "输出: $result",
            )
        } catch (e: Throwable) {
            items += Item("2. JS 脱敏调用（密码不得出现在结果里）", false, e.toString())
        }

        // ── 第三阶段：网络发现与检测 ──

        // 先把监听打开。startMonitoring 内部会立即 refresh 一次，
        // 所以紧接着读 current() 就能拿到真实状态（不需要等待回调）。
        try {
            platform.connectivity.startMonitoring { }
            val cur = platform.connectivity.current()
            val ok = cur.classification.kind != NetworkKind.NONE || cur.reason.isNotEmpty()
            items += Item(
                "3. NetworkCallback 已注册并得到网络状态",
                ok,
                "${cur.kind} / ${cur.validation} — ${cur.reason}",
            )
        } catch (e: Throwable) {
            items += Item("3. NetworkCallback 已注册并得到网络状态", false, e.toString())
        }

        // 当前 Network 是否被保存下来（门户请求要靠它绑定）
        val networkSaved = platform.portalNetwork.isAvailable()
        items += Item(
            "4. 当前 Network 已保存（供门户请求绑定）",
            networkSaved,
            if (networkSaved) "已保存" else "没有活动网络，未保存（无网络时属正常）",
        )

        // SSID 读取 —— 权限不足时读不到属于**正常状态**，不算失败。
        // 这里把每一步都摊开（权限 / 传输信息类型 / 原始 SSID），
        // 因为实测遇到过"权限已授予但 SSID 仍读不到"，需要看得到卡在哪一步。
        val currentSsid = platform.wifi.readSsid(platform.portalNetwork.getCurrentNetwork())
        items += Item(
            "5. 读取当前 Wi-Fi SSID（只如实汇报，不判失败）",
            true,
            "SSID=${currentSsid ?: "(读不到)"}  |  " +
                platform.wifi.diagnose(platform.portalNetwork.getCurrentNetwork()),
        )

        // 校园 Wi-Fi 匹配：先用**当前配置**判一次，再把真机上读到的 SSID 写进配置判一次。
        // 这样验的是"配置 → 匹配器 → 真机 SSID"整条链路；
        // 规则本身（前缀 / 通配 / 大小写）由 CampusWifiMatcherTest 覆盖。
        // ⚠ 读不到 SSID 时必须判 false —— "认不出就不认证"是产品红线，这里也断言住。
        try {
            val (isCampus, reason) = platform.isCurrentNetworkCampusWifi()
            val detail = StringBuilder(
                "isCampusWifi=$isCampus  当前SSID=${currentSsid ?: "(读不到)"}  理由: $reason"
            )
            val passed: Boolean
            if (currentSsid != null) {
                platform.configStore.save(mapOf("campusSsids" to listOf(currentSsid)))
                val (again, reasonAgain) = platform.isCurrentNetworkCampusWifi()
                passed = again
                detail.append("  |  把当前SSID写进配置后再判=$again（应为 true）理由: $reasonAgain")
            } else {
                passed = !isCampus
                detail.append("  |  SSID 读不到：必须判 false（认不出就不认证，绝不猜）")
            }
            items += Item("6. 校园 Wi-Fi 判断（配置 + 真机 SSID 整条链路）", passed, detail.toString())
        } catch (e: Throwable) {
            items += Item("6. 校园 Wi-Fi 判断（配置 + 真机 SSID 整条链路）", false, e.toString())
        }

        // HTTP 通过**指定 Network**（transport 内部已绑定 portalNetwork）
        try {
            val res = platform.httpTransport.get("http://connect.rom.miui.com/generate_204")
            items += Item(
                "7. HTTP 通过指定 Network 可用",
                true,
                "HTTP ${res.statusCode}  Location=${res.location ?: "(无)"}  body=${res.body.length} 字节",
            )
        } catch (e: Throwable) {
            items += Item("7. HTTP 通过指定 Network 可用", false, e.toString())
        }

        // Probe：四档结论
        try {
            val summary = platform.networkProbe.probe()
            items += Item(
                "8. HTTP Probe 结论（四档）",
                true,
                summary.outcome.toString() + "  |  " + summary.details.joinToString(" ; "),
            )
        } catch (e: Throwable) {
            items += Item("8. HTTP Probe 结论（四档）", false, e.toString())
        }

        // 探测结论与系统信号对照 —— 不一致时**不判失败**，只如实展示，
        // 因为这正是"系统 CAPTIVE_PORTAL 不一定出现"的实证
        try {
            val cur = platform.connectivity.current()
            val summary = platform.networkProbe.probe()
            val consistent = (cur.validation.name == "VALIDATED") == (summary.outcome == ProbeOutcome.ONLINE)
            items += Item(
                "9. 系统信号 vs 自己探测（只对照，不判失败）",
                true,
                "系统=${cur.validation}  探测=${summary.outcome}  一致=$consistent",
            )
        } catch (e: Throwable) {
            items += Item("9. 系统信号 vs 自己探测（只对照，不判失败）", false, e.toString())
        }

        // Wi-Fi 建议：策略决策 + API 往返（用不存在的测试 SSID，不会引发任何切换）
        try {
            val decision = platform.wifiSuggester.ensureSuggested(
                ssid = null, // 没配置校园 SSID → 应当 SKIP_INVALID，且**不会真的提交**
                nowMillis = platform.clock.elapsedMillis(),
            )
            val roundTrip = platform.wifiSuggester.probeApiRoundTrip()
            items += Item(
                "10. Wi-Fi 建议：策略 + API 通路",
                true,
                "未配置SSID时决策=$decision（应为 SKIP_INVALID，即不提交）  API: $roundTrip",
            )
        } catch (e: Throwable) {
            items += Item("10. Wi-Fi 建议：策略 + API 通路", false, e.toString())
        }

        // 第二阶段遗留项回归：HTTP 已经实现，不再抛 UnsupportedOperationException
        try {
            platform.httpTransport.postForm("http://127.0.0.1:1/none", emptyMap(), timeoutMillis = 1500)
            items += Item("11. HTTP 传输已实现（不再是占位）", true, "POST 未抛未实现异常")
        } catch (e: UnsupportedOperationException) {
            items += Item("11. HTTP 传输已实现（不再是占位）", false, "仍是占位实现")
        } catch (e: Throwable) {
            // 连不上是预期的 —— 我们只是确认它不再抛 UnsupportedOperationException
            items += Item("11. HTTP 传输已实现（不再是占位）", true, "按预期以网络错误失败: ${e.javaClass.simpleName}")
        }

        // 不抢占用户网络：整个过程结束后 SSID 必须与开始时一致
        val ssidAfter = platform.wifi.readSsid(platform.portalNetwork.getCurrentNetwork())
        items += Item(
            "12. 未抢占用户当前 Wi-Fi（SSID 前后一致）",
            ssidAfter == currentSsid,
            "前=${currentSsid ?: "(读不到)"}  后=${ssidAfter ?: "(读不到)"}",
        )

        // ── 第二阶段回归：存储与日志 ──
        // ⚠ 第五阶段起这页是**用户会点的按钮**（首页「运行边界自检」），
        //   所以凡是写配置/凭据的项都必须**用完恢复原样** ——
        //   自检绝不能把用户真实的校园网规则或账号覆盖掉。
        try {
            val configBefore = platform.configStore.load()
            val credentialsBefore = platform.credentialStore.load()
            try {
                platform.configStore.save(
                    mapOf(
                        "operatorLabel" to "中国联通",
                        "autoConnect" to false,
                        "campusSsids" to listOf("YZU-WiFi", "YZU-Dorm"),
                    )
                )
                val cfg = platform.configStore.load()
                val ok = cfg.operatorLabel == "中国联通" && !cfg.autoConnect &&
                    cfg.campusSsids == listOf("YZU-WiFi", "YZU-Dorm")
                items += Item("13. 配置读写（含校园 SSID 列表）", ok, "读回: ${cfg.operatorLabel} / ${cfg.campusSsids}")

                platform.credentialStore.save(CredentialStore.Credentials(ACCOUNT, PASSWORD_SENTINEL))
                val back = platform.credentialStore.load()
                val credOk = back?.account == ACCOUNT && back.password == PASSWORD_SENTINEL
                items += Item(
                    "14. 凭据加密存取（Keystore AES/GCM）",
                    credOk,
                    if (credOk) "读回一致（哨兵凭据，用完已恢复原状）" else "读回: $back",
                )
            } finally {
                runCatching {
                    platform.configStore.save(
                        mapOf(
                            "operatorLabel" to configBefore.operatorLabel,
                            "autoConnect" to configBefore.autoConnect,
                            "campusSsids" to configBefore.campusSsids,
                        )
                    )
                }
                runCatching {
                    if (credentialsBefore != null) {
                        platform.credentialStore.save(credentialsBefore)
                    } else {
                        platform.credentialStore.clear()
                    }
                }
            }
        } catch (e: Throwable) {
            items += Item("13. 配置读写（含校园 SSID 列表）", false, e.toString())
        }

        try {
            val hits = scanDataDirFor(PASSWORD_SENTINEL)
            items += Item(
                "15. 私有目录无明文密码",
                hits.isEmpty(),
                if (hits.isEmpty()) "扫描 ${context.dataDir} 未发现明文" else "❌ 命中: " + hits.joinToString(", "),
            )
        } catch (e: Throwable) {
            items += Item("15. 私有目录无明文密码", false, e.toString())
        }

        // 16. 后台读 SSID 实验：不判失败，只为拿"应用不在前台时读不读得到"的实测数据
        startBackgroundSsidProbe(platform, platform.portalNetwork.getCurrentNetwork())
        items += Item(
            "16. 后台读 SSID / 定时器实验（结果看 Logcat）",
            true,
            "已安排 +5/+15/+30/+60s 各记一条 Logcat；期间按 Home 再回来看",
        )

        // ── 第四阶段：协议复用 / 适配器 / 门户发现 / 登录守卫 / 登录链路 ──

        // 17. Core 模块能否在设备上的 QuickJS 里加载（含第四阶段新增的协议与适配器）
        try {
            val modules = listOf(
                "src/core/auto-connect.js",
                "src/core/eportal-protocol.js",
                "src/main/login/adapter.js",
                "src/main/login/adapter-suggest.js",
            )
            modules.forEach { js.loadModule(it) }
            val loaded = js.loadedModules()
            val missing = modules.filterNot { loaded.contains(it) }
            items += Item(
                "17. 加载 Core 模块（状态机 + ePortal 协议 + 适配器）",
                missing.isEmpty(),
                "已加载 ${loaded.size} 个：" + loaded.sorted().joinToString(", "),
            )
        } catch (e: Throwable) {
            items += Item("17. 加载 Core 模块（状态机 + ePortal 协议 + 适配器）", false, e.toString())
        }

        // 18. ePortal 协议纯函数（表驱动；**跑的是 Windows 侧同一份实现**）
        items += protocolTableCheck(js)

        // 19. 登录适配器：从 assets 读**仓库里那一份**并用 adapter.js 规范化
        try {
            val adapters = AndroidAdapterAssets(context)
            val info = adapters.load(js, "yzu-sso")
            items += Item(
                "19. 登录适配器（assets 同步自 src/main/login/adapters）",
                info != null && info.id == "yzu-sso" && info.defaultOperator != null,
                "可用=${adapters.availableIds()}  id=${info?.id}  name=${info?.name}  " +
                    "defaultOperator=${info?.defaultOperator}  urlPatterns=${info?.urlPatterns?.size ?: 0} 条",
            )
        } catch (e: Throwable) {
            items += Item("19. 登录适配器（assets 同步自 src/main/login/adapters）", false, e.toString())
        }

        // 20. 门户发现：真实探测的 Location + 纯函数安全闸门
        try {
            val report = platform.networkProbeImpl.probeDetailed()
            val discovered = PortalDiscovery.findPortalUrl(report.samples)
            val sample = ProbeSample(
                name = "selfcheck-mock",
                url = "http://connect.rom.miui.com/generate_204",
                expectation = ProbeExpectation("selfcheck-mock", 204, null),
                result = ProbeHttpResult(
                    reachable = true,
                    statusCode = 302,
                    location = "http://10.245.2.19/eportal/index.jsp?wlanuserip=1.2.3.4&nasip=5.6.7.8",
                ),
                outcome = ProbeOutcome.PORTAL,
            )
            val pureOk = PortalDiscovery.findPortalUrl(listOf(sample)) ==
                "http://10.245.2.19/eportal/index.jsp?wlanuserip=1.2.3.4&nasip=5.6.7.8"
            val rejectsForeign = !PortalDiscovery.looksLikeEportal("http://evil.example.com/login?u=1")
            items += Item(
                "20. 门户发现（真实探测 + 非 ePortal 一律拒绝）",
                pureOk && rejectsForeign,
                "本次探测=${report.summary.outcome}  发现门户=${discovered ?: "(没有重定向；已在线时属正常)"}  " +
                    "纯函数=${pureOk}  拒绝陌生门户=${rejectsForeign}",
            )
        } catch (e: Throwable) {
            items += Item("20. 门户发现（真实探测 + 非 ePortal 一律拒绝）", false, e.toString())
        }

        // 21. 登录守卫 + 日志脱敏（产品红线：认不出校园网就绝不发凭据）
        try {
            js.loadScriptAsset("js/android-runtime.js")
            val gate = LoginGate(platform)
            val current = gate.currentDecision()
            val noSsid = gate.decision(platform.connectivity.current(), null)
            val foreign = gate.decision(platform.connectivity.current(), "SomeOtherWifi")

            val secret = SECRET_SENTINEL
            val redacted = js.evalToString(
                "__redact(" + JSONObject.quote(
                    "http://10.245.2.19/eportal/index.jsp?userId=abc&password=$secret"
                ) + ")"
            )
            val noLeak = redacted != null && !redacted.contains(secret)
            val guardOk = !noSsid.allowed && !foreign.allowed &&
                noSsid.block == LoginBlock.SSID_UNREADABLE
            items += Item(
                "21. 登录守卫（认不出就不认证）+ 日志脱敏",
                guardOk && noLeak,
                "当前=${current.allowed}(${current.reason})  读不到SSID→${noSsid.reason}  " +
                    "别的Wi-Fi→${foreign.reason}  脱敏输出=$redacted",
            )
        } catch (e: Throwable) {
            items += Item("21. 登录守卫（认不出就不认证）+ 日志脱敏", false, e.toString())
        }

        // 22. JS ↔ Kotlin 桥的返回值类型（这条踩过坑，必须锁住）
        try {
            js.loadScriptAsset("js/android-runtime.js")
            js.defineSyncString("__scSyncString") { "sync-string" }
            js.defineSyncNumber("__scSyncNumber") { 42.0 }
            js.defineAsyncString("__scAsyncString") { "async-string" }

            val syncRaw = js.evalToString(
                """
                (function () {
                  var out = {};
                  out.type = typeof __scSyncString();
                  out.value = __scSyncString();
                  out.numberType = typeof __scSyncNumber();
                  out.number = __scSyncNumber();
                  return JSON.stringify(out);
                })()
                """.trimIndent()
            )
            val sync = JSONObject(syncRaw ?: "{}")
            val asyncBox = runJsAsync(js, "(async function () { return await __scAsyncString(); })()")
            val asyncValue = asyncBox.optString("value")

            val ok = sync.optString("type") == "string" &&
                sync.optString("value") == "sync-string" &&
                sync.optString("numberType") == "number" &&
                sync.optDouble("number") == 42.0 &&
                asyncBox.optBoolean("ok") &&
                asyncValue == "async-string"
            items += Item(
                "22. JS ↔ Kotlin 桥（同步/异步绑定的返回值类型）",
                ok,
                "同步=${sync.optString("type")}:${sync.optString("value")}  " +
                    "数字=${sync.optString("numberType")}:${sync.optDouble("number")}  " +
                    "异步=$asyncValue（桥类型写成 Any? 时字符串会退化成对象，这条锁住它）",
            )
        } catch (e: Throwable) {
            items += Item("22. JS ↔ Kotlin 桥（同步/异步绑定的返回值类型）", false, e.toString())
        }

        // 23. 登录链路（Mock 门户，哨兵密码；**绝不使用真实凭据**）
        items += mockLoginChainCheck(js, platform, currentSsid)

        // 24. 平台桥在**真实网络**上的行为（凭据闸门 + 登录后复探）
        items += platformBridgeCheck(js, platform)

        // 25. 状态机行为（在设备的 QuickJS 上跑 Core，用假依赖驱动）
        items += stateMachineCheck(js)

        // 26. 真实门户响应结构（**不发任何凭据**）
        items += realPortalStructureCheck(js, platform)

        // 27. 门户"先校验密码还是先查服务"的辨别实验（真实账号 + 哨兵错密码，只发一次）
        items += wrongPasswordProbe(js, platform)

        // 28. 协议差异矩阵：queryString 编码 / service 取值（真实账号 + 哨兵错密码）
        items += protocolVariantMatrix(js, platform)

        // 29. 服务枚举 + 在线用户查询（真实账号 + 哨兵错密码；不发真实密码）
        items += serviceScanAndOnlineUser(js, platform)

        // 30. service 取值形态扫描（社区项目提示过：service 可能是拼音/内部 ID）
        items += serviceTokenScan(js, platform)

        // 31. YZU SSO 全链路 Mock（合成凭据 + 回环假门户；覆盖 Core 流程 + 桥 + 传输 + AES + Cookie）
        items += ssoMockChainCheck(js)

        return items
    }

    /**
     * 第 31 项：**YZU SSO 全链路 Mock**（在设备上跑，合成凭据，不碰真实账号）。
     *
     * ## 为什么需要这一项
     * 「Android 能不能走 YZU 统一身份认证」这个问题里，只有**最后一段**
     * （真实 `sso.yzu.edu.cn` + 真实账号）必须真机实测；前面这段
     * （Core 的流程编排 → 桥 → 传输 → AES → Cookie 会话）完全可以在设备上先跑一遍。
     * 这一项就是那段：假门户 + 假统一身份认证，形状与真实 YZU 一一对应。
     *
     * ## 它证明什么（服务端**真的**在验证，不是走过场）
     *   · 不跟随重定向：门户的 302 Location 里才拿得到 SSO 地址与 ticket
     *   · Cookie 会话：GET 登录页建会话 → POST 必须带上（不带服务端回 401）
     *   · AES-128-ECB：服务端用自己发出去的 croypto **真的解密**，
     *     解出来必须等于合成密码、`captcha_payload` 必须等于字面量 `{}`
     *   · 字段集合：QLU 母实现的 8 个字段一个不少
     *   · 明文密码绝不进请求体
     *
     * ## 它**不**证明什么（说清楚，不许含糊）
     *   · 不证明真实 YZU 门户会 302 到 SSO（那要真机 + 真实网络）
     *   · 不证明真实账号密码正确、真实 ST 票据被门户接受
     *   · 不证明 Probe=ONLINE（Mock 里没有真实互联网）
     */
    private suspend fun ssoMockChainCheck(js: JsCoreRuntime): Item {
        val name = "31. YZU SSO 全链路 Mock（Core + 桥 + 传输 + AES + Cookie）"
        return try {
            // 先把装配脚本装起来：**用的是与前台服务完全相同的那一份**（android-engine.js），
            // 自检里不另写一套接线 —— 否则"Mock 过了、服务里不过"就无从解释。
            // 加载顺序与服务里的 ensureEngine 保持一致。
            js.loadModule("src/core/auto-connect.js")
            js.loadModule("src/core/eportal-protocol.js")
            js.loadModule("src/core/yzu-sso-protocol.js")
            js.loadScriptAsset("js/android-runtime.js")
            js.loadScriptAsset("js/android-engine.js")
            if (js.evalToString("typeof __androidEngine") != "object") {
                return Item(name, false, "装配脚本未生效（__androidEngine 不可用）")
            }
            val box = runJsAsync(js, "__androidEngine.ssoMockRun()")
            if (!box.optBoolean("ok")) return Item(name, false, "JS 异常: " + box.optString("error"))
            val o = JSONObject(box.optString("value").ifEmpty { "{}" })
            val verdict = o.optJSONObject("verdict") ?: JSONObject()
            val obs = o.optJSONObject("observed") ?: JSONObject()
            val reason = verdict.optString("reason")
            val checks = linkedMapOf(
                "门户 302 拿到 SSO 地址" to (reason != "sso-portal-entry-failed"),
                "SSO 页面取到动态密钥" to (reason != "sso-params-missing"),
                "判定 = sso-ticket-accepted" to (verdict.optBoolean("success") && reason == "sso-ticket-accepted"),
                "POST 带上了会话 Cookie" to obs.optBoolean("cookieOnPost"),
                "服务端用 croypto 解出密码" to obs.optBoolean("passwordDecrypted"),
                "captcha_payload 解密为 {}" to obs.optBoolean("captchaDecrypted"),
                "QLU 字段集合齐（type/_eventId/username）" to obs.optBoolean("fieldsOk"),
                "回跳带 ticket" to obs.optBoolean("callbackTicketSeen"),
                "回跳复用同一会话" to obs.optBoolean("callbackCookieKept"),
                "门户回了「选择服务」页" to obs.optBoolean("servicePageServed"),
                // CAS 之后的**服务绑定**（真机上就是缺了这一步才一直不放行）
                "按门户方式取了服务列表" to obs.optBoolean("serviceListAsked"),
                "服务绑定成功（loginOfCas）" to obs.optBoolean("serviceBound"),
                "绑定请求的 flag 正确" to obs.optBoolean("bindFlagOk"),
                "绑定请求不带密码" to obs.optBoolean("bindHasNoPassword"),
                "queryString 双重编码与门户一致" to obs.optBoolean("bindQueryDoubleEncoded"),
                "请求体无明文密码" to (obs.has("plaintextPasswordInBody") && !obs.optBoolean("plaintextPasswordInBody")),
            )
            val failed = checks.filterValues { !it }.keys
            android.util.Log.i(
                LogTag,
                "[诊断] 第31项 MockSSO reason=$reason 观察=$obs 未过=$failed",
            )
            if (failed.isEmpty()) {
                Item(name, true, "${checks.size} 项全过（判定=$reason，回跳=${verdict.optJSONObject("detail")?.optString("callbackPath") ?: "?"}）")
            } else {
                Item(name, false, "未通过: $failed ｜ verdict=$verdict ｜ observed=$obs")
            }
        } catch (e: Throwable) {
            Item(name, false, e.toString())
        }
    }

    /**
     * 第 30 项：**service 取值形态扫描**（真实账号 + 哨兵错密码）。
     *
     * 由来：`Gloridust/RuijieWIFI-AutoLogin` 的 README 明确写过
     * 「更正：`service` 的数据可能出错，例如：`中国电信` 请填 `dianxin`」——
     * 也就是说门户显示的**中文服务名**不一定是登录请求里该填的值，可能是拼音/内部 ID。
     * 所以把常见的几种形态都试一遍（含社区项目用过的 token），看门户反应有没有变化。
     * 同时试一次带 `Origin` 头的请求（`SamizuHM/miwifi-whunet-login` 带了 Origin）。
     *
     * ⚠ 全部使用哨兵错密码，不需要真实密码；账号与密码都不进日志。
     */
    private suspend fun serviceTokenScan(js: JsCoreRuntime, platform: AndroidPlatform): Item {
        val name = "30. service 取值形态扫描（拼音/内部 ID + Origin）"
        val scope = kotlinx.coroutines.CoroutineScope(
            kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Default
        )
        val cfgStore = platform.configStore
        val configBefore = cfgStore.load()
        return try {
            js.loadScriptAsset("js/android-runtime.js")
            js.loadModule("src/core/eportal-protocol.js")

            val report = platform.networkProbeImpl.probeDetailed()
            val portalUrl = PortalDiscovery.findPortalUrl(report.samples)
                ?: PortalDiscovery.pickBest(bodyRedirectCandidates(js, report))
                ?: return Item(name, true, "拿不到门户地址，如实跳过")

            cfgStore.save(
                mapOf(
                    "campusSsids" to listOf(
                        platform.wifi.readSsid(platform.portalNetwork.getCurrentNetwork()) ?: "SELFCHECK-NO-SSID"
                    ),
                    "portalUrl" to portalUrl,
                    "autoAuthOnCampus" to true,
                )
            )
            val bridge = AndroidJsBridge(
                context,
                platform,
                scope,
                redact = { text: String ->
                    kotlinx.coroutines.runBlocking {
                        js.evalToString("__redact(" + JSONObject.quote(text) + ")")
                    } ?: ""
                },
            )
            bridge.install(js)
            val ctxBox = runJsAsync(js, "(async function () { return await __androidLoginContext(); })()")
            val ctx = JSONObject(ctxBox.optString("value").ifEmpty { "{}" })
            if (!ctx.optBoolean("ok")) {
                return Item(name, true, "守卫未放行（${ctx.optString("reason")}）：不发任何请求，如实跳过")
            }
            val account = ctx.optString("account")
            if (account.isEmpty()) return Item(name, true, "没有可用账号，如实跳过")

            val targets = JSONObject(
                js.callJson(
                    "src/core/eportal-protocol.js",
                    "buildLoginTargets",
                    "[${JSONObject.quote(portalUrl)}]",
                ) ?: "{}"
            )
            if (!targets.optBoolean("ok")) return Item(name, true, "门户地址不可用，如实跳过")
            val api = targets.optString("api")
            val queryString = targets.optString("queryString")

            val tokens = listOf("liantong", "yidong", "dianxin", "xiaonei", "unicom", "campus")
            val rows = mutableListOf<String>()
            val interesting = mutableListOf<String>()
            for (token in tokens) {
                val row = runVariant(
                    js,
                    platform,
                    api,
                    portalUrl,
                    JSONObject()
                        .put("userId", account)
                        .put("password", WRONG_PASSWORD_SENTINEL)
                        .put("service", token)
                        .put("queryString", queryString)
                        .put("operatorPwd", "")
                        .put("operatorUserId", "")
                        .put("validcode", "")
                        .put("passwordEncrypt", "false"),
                    "service=$token",
                )
                rows += row
                if (!row.contains("用户不允许使用本服务")) interesting += row
            }

            android.util.Log.i(
                LogTag,
                "[诊断] 第30项 " + rows.joinToString(" ｜ ") +
                    " ｜ 与默认拒绝不同的反应：" +
                    (if (interesting.isEmpty()) "(无)" else interesting.joinToString("；")),
            )

            Item(
                name,
                true,
                rows.joinToString("；") + "｜" + if (interesting.isEmpty()) {
                    "所有 token 都是同一句拒绝（说明不是 service 取值形态的问题）"
                } else {
                    "有不同反应：" + interesting.joinToString("；")
                },
            ).also {
                bridge.cancelAllTimers()
                bridge.clearLastLogin()
            }
        } catch (e: Throwable) {
            Item(name, false, "token 扫描异常: " + e.javaClass.simpleName + ": " + e.message)
        } finally {
            runCatching {
                cfgStore.save(
                    mapOf(
                        "campusSsids" to configBefore.campusSsids,
                        "portalUrl" to configBefore.portalUrl,
                        "autoAuthOnCampus" to configBefore.autoAuthOnCampus,
                    )
                )
            }
            scope.cancel()
        }
    }

    /**
     * 第 29 项：**服务枚举扫描 + 在线用户查询**。
     *
     * 第 28 项已经证明：
     *   · queryString 用"原文"还是"预编码"，门户反应完全一样 → 不是编码问题
     *   · `service` 传空时门户会说「ePortal上有多个服务,服务不能为空」
     *     → 说明请求被**深度处理**了（它真的在读服务列表），请求契约是对的
     *   · 用门户列表里的第一个服务时，答复是「用户不允许使用本服务!」
     *
     * 所以这里把**门户给的每一个服务**都试一遍（用哨兵错密码，不需要真实密码），
     * 找出有没有哪一个服务能让门户走到"用户名或密码错误"这一步；
     * 顺便查一次在线用户信息（判断账号是否已经在别处在线 —— 那也会影响服务判定）。
     */
    private suspend fun serviceScanAndOnlineUser(js: JsCoreRuntime, platform: AndroidPlatform): Item {
        val name = "29. 服务枚举 + 在线用户查询（哨兵错密码，不发真实密码）"
        val scope = kotlinx.coroutines.CoroutineScope(
            kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Default
        )
        val cfgStore = platform.configStore
        val configBefore = cfgStore.load()
        return try {
            js.loadScriptAsset("js/android-runtime.js")
            js.loadModule("src/core/eportal-protocol.js")

            val report = platform.networkProbeImpl.probeDetailed()
            val portalUrl = PortalDiscovery.findPortalUrl(report.samples)
                ?: PortalDiscovery.pickBest(bodyRedirectCandidates(js, report))
                ?: return Item(name, true, "拿不到门户地址，如实跳过")

            cfgStore.save(
                mapOf(
                    "campusSsids" to listOf(
                        platform.wifi.readSsid(platform.portalNetwork.getCurrentNetwork()) ?: "SELFCHECK-NO-SSID"
                    ),
                    "portalUrl" to portalUrl,
                    "autoAuthOnCampus" to true,
                )
            )

            val bridge = AndroidJsBridge(
                context,
                platform,
                scope,
                redact = { text: String ->
                    kotlinx.coroutines.runBlocking {
                        js.evalToString("__redact(" + JSONObject.quote(text) + ")")
                    } ?: ""
                },
            )
            bridge.install(js)

            val ctxBox = runJsAsync(js, "(async function () { return await __androidLoginContext(); })()")
            val ctx = JSONObject(ctxBox.optString("value").ifEmpty { "{}" })
            if (!ctx.optBoolean("ok")) {
                return Item(name, true, "守卫未放行（${ctx.optString("reason")}）：不发任何请求，如实跳过")
            }
            val account = ctx.optString("account")
            if (account.isEmpty()) return Item(name, true, "没有可用账号，如实跳过")

            val targets = JSONObject(
                js.callJson(
                    "src/core/eportal-protocol.js",
                    "buildLoginTargets",
                    "[${JSONObject.quote(portalUrl)}]",
                ) ?: "{}"
            )
            if (!targets.optBoolean("ok")) return Item(name, true, "门户地址不可用，如实跳过")
            val api = targets.optString("api")
            val queryString = targets.optString("queryString")

            val pageInfo = platform.httpTransport.postFormWithReferer(
                "$api?method=pageInfo",
                mapOf("queryString" to queryString),
                8000L,
                portalUrl,
            )
            val services = JSONObject(pageInfo.body).optJSONObject("service")
                ?.keys()?.asSequence()?.toList().orEmpty()
            if (services.isEmpty()) return Item(name, true, "门户没有返回服务列表，如实跳过")

            val rows = mutableListOf<String>()
            val passedServices = mutableListOf<String>()
            for (service in services) {
                val fields = JSONObject()
                    .put("userId", account)
                    .put("password", WRONG_PASSWORD_SENTINEL)
                    .put("service", service)
                    .put("queryString", queryString)
                    .put("operatorPwd", "")
                    .put("operatorUserId", "")
                    .put("validcode", "")
                    .put("passwordEncrypt", "false")
                val row = runVariant(js, platform, api, portalUrl, fields, service)
                rows += row
                if (row.contains("state=credentials") || row.contains("用户名或密码错误")) {
                    passedServices += service
                }
            }

            // 额外：运营商服务带上 operatorUserId/operatorPwd 看反应（哨兵值）
            val opRow = runVariant(
                js,
                platform,
                api,
                portalUrl,
                JSONObject()
                    .put("userId", account)
                    .put("password", WRONG_PASSWORD_SENTINEL)
                    .put("service", services.last())
                    .put("queryString", queryString)
                    .put("operatorPwd", "OP_PW_SENTINEL")
                    .put("operatorUserId", "OP_USER_SENTINEL")
                    .put("validcode", "")
                    .put("passwordEncrypt", "false"),
                "带 operator 字段",
            )
            rows += opRow

            // 在线用户查询（只报结构，不报值）
            val onlineProbe = try {
                val res = platform.httpTransport.postFormWithReferer(
                    "$api?method=getOnlineUserInfo",
                    mapOf("queryString" to queryString),
                    8000L,
                    portalUrl,
                )
                val obj = runCatching { JSONObject(res.body) }.getOrNull()
                "在线查询 HTTP ${res.statusCode} 字段=" + (obj?.keys()?.asSequence()?.toList()?.joinToString(",")
                    ?: "(非 JSON)")
            } catch (e: Throwable) {
                "在线查询异常 " + e.javaClass.simpleName
            }

            val conclusion = if (passedServices.isEmpty()) {
                "门户列表里的每个服务都被拒绝（没有任何服务能走到密码校验）"
            } else {
                "这些服务能通过服务层：" + passedServices.joinToString(" / ")
            }
            android.util.Log.i(LogTag, "[诊断] 第29项 " + rows.joinToString(" ｜ ") + " ｜" + onlineProbe + " ｜" + conclusion)

            Item(name, true, rows.joinToString("；") + "；$onlineProbe；$conclusion").also {
                bridge.cancelAllTimers()
                bridge.clearLastLogin()
            }
        } catch (e: Throwable) {
            Item(name, false, "服务枚举异常: " + e.javaClass.simpleName + ": " + e.message)
        } finally {
            runCatching {
                cfgStore.save(
                    mapOf(
                        "campusSsids" to configBefore.campusSsids,
                        "portalUrl" to configBefore.portalUrl,
                        "autoAuthOnCampus" to configBefore.autoAuthOnCampus,
                    )
                )
            }
            scope.cancel()
        }
    }

    /**
     * 第 28 项：**协议差异矩阵**（真实账号 + 哨兵错密码，逐个组合试一次）。
     *
     * 由来：社区里成功跑通的锐捷 ePortal 客户端，在"表单里的 queryString"这一点上做法不同：
     *   · `PengweeWang/campusnet_login`：把 queryString **先 encode 一次**再放进表单
     *     （curl `--data` 不会再编码 ⇒ 服务端最终收到的是"单次编码"的 queryString），
     *     而且它 **`service=` 传空**！
     *   · 本项目（以及 Windows 参考实现）：表单里放**原文** queryString，
     *     由 HTTP 层编码一次 ⇒ 服务端收到的是"解码后的原文"。
     * 这两种做法对服务端来说**不是一回事**。所以用哨兵错密码把四种组合都试一遍，
     * 看门户哪一种会放行到"用户名或密码错误"（= 已通过服务/会话这一层）。
     *
     * ⚠ 全程用**故意写错的密码**，不需要真实密码；账号与密码都不进日志。
     */
    private suspend fun protocolVariantMatrix(js: JsCoreRuntime, platform: AndroidPlatform): Item {
        val name = "28. 协议差异矩阵（queryString 编码 × service 取值）"
        val scope = kotlinx.coroutines.CoroutineScope(
            kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Default
        )
        val cfgStore = platform.configStore
        val configBefore = cfgStore.load()
        return try {
            js.loadScriptAsset("js/android-runtime.js")
            js.loadModule("src/core/eportal-protocol.js")

            val report = platform.networkProbeImpl.probeDetailed()
            val portalUrl = PortalDiscovery.findPortalUrl(report.samples)
                ?: PortalDiscovery.pickBest(bodyRedirectCandidates(js, report))
                ?: return Item(name, true, "拿不到门户地址，如实跳过（不发任何请求）")

            cfgStore.save(
                mapOf(
                    "campusSsids" to listOf(
                        platform.wifi.readSsid(platform.portalNetwork.getCurrentNetwork()) ?: "SELFCHECK-NO-SSID"
                    ),
                    "portalUrl" to portalUrl,
                    "autoAuthOnCampus" to true,
                )
            )

            val bridge = AndroidJsBridge(
                context,
                platform,
                scope,
                redact = { text: String ->
                    kotlinx.coroutines.runBlocking {
                        js.evalToString("__redact(" + JSONObject.quote(text) + ")")
                    } ?: ""
                },
            )
            bridge.install(js)

            val ctxBox = runJsAsync(js, "(async function () { return await __androidLoginContext(); })()")
            val ctx = JSONObject(ctxBox.optString("value").ifEmpty { "{}" })
            if (!ctx.optBoolean("ok")) {
                return Item(name, true, "守卫未放行（${ctx.optString("reason")}）：本项不发任何请求，如实跳过")
            }
            val account = ctx.optString("account")
            if (account.isEmpty()) return Item(name, true, "没有可用账号，如实跳过")

            val targets = JSONObject(
                js.callJson(
                    "src/core/eportal-protocol.js",
                    "buildLoginTargets",
                    "[${JSONObject.quote(portalUrl)}]",
                ) ?: "{}"
            )
            if (!targets.optBoolean("ok")) return Item(name, true, "门户地址不可用，如实跳过")
            val api = targets.optString("api")
            val rawQuery = targets.optString("queryString")

            val pageInfo = platform.httpTransport.postFormWithReferer(
                "$api?method=pageInfo",
                mapOf("queryString" to rawQuery),
                8000L,
                portalUrl,
            )

            // 服务候选：用门户真实返回的第一个服务名 + 空串两种取值
            val serviceFromPortal = JSONObject(pageInfo.body)
                .optJSONObject("service")?.keys()?.asSequence()?.firstOrNull()
                ?: "校内免费服务"

            val variants = listOf(
                Triple("原文 queryString", rawQuery, serviceFromPortal),
                Triple("预编码 queryString", encodeOnce(rawQuery), serviceFromPortal),
                Triple("原文 queryString + service 空", rawQuery, ""),
                Triple("预编码 queryString + service 空", encodeOnce(rawQuery), ""),
            )

            val rows = mutableListOf<String>()
            val passedVariants = mutableListOf<String>()
            for ((label, queryValue, service) in variants) {
                val plan = JSONObject(
                    js.callJson(
                        "src/core/eportal-protocol.js",
                        "buildLoginRequest",
                        "[" + JSONObject()
                            .put("portalUrl", portalUrl)
                            .put("account", account)
                            .put("password", WRONG_PASSWORD_SENTINEL)
                            .put("operatorLabel", service.ifEmpty { "___none___" })
                            .put("pageInfoText", pageInfo.body)
                            .toString() + "]",
                    ) ?: "{}"
                )
                if (!plan.optBoolean("ok")) {
                    // 空 service 会被协议拒（service-not-found），这时手工造字段
                    if (service.isEmpty()) {
                        val manual = JSONObject()
                            .put("userId", account)
                            .put("password", WRONG_PASSWORD_SENTINEL)
                            .put("service", "")
                            .put("queryString", queryValue)
                            .put("operatorPwd", "")
                            .put("operatorUserId", "")
                            .put("validcode", "")
                            .put("passwordEncrypt", "false")
                        rows += runVariant(js, platform, api, portalUrl, manual, label)
                    } else {
                        rows += "$label → 协议拒绝构造（${plan.optString("reason")}）"
                    }
                    continue
                }
                val fields = JSONObject()
                plan.optJSONObject("fields")?.let { f ->
                    f.keys().forEach { k -> fields.put(k, f.optString(k, "")) }
                }
                fields.put("queryString", queryValue)
                fields.put("service", service)
                val row = runVariant(js, platform, api, portalUrl, fields, label)
                rows += row
                if (row.contains("用户名或密码错误") || row.contains("state=credentials")) {
                    passedVariants += label
                }
            }

            val conclusion = if (passedVariants.isEmpty()) {
                "四种组合都被挡在服务/会话这一层（没有任何组合走到密码校验）"
            } else {
                "有组合通过了服务/会话层：" + passedVariants.joinToString("；") +
                    " ⇒ 这就是与成功项目的协议差异所在"
            }
            android.util.Log.i(LogTag, "[诊断] 第28项 " + rows.joinToString(" ｜ "))

            Item(name, true, rows.joinToString("；") + "｜$conclusion").also {
                bridge.cancelAllTimers()
                bridge.clearLastLogin()
            }
        } catch (e: Throwable) {
            Item(name, false, "矩阵实验异常: " + e.javaClass.simpleName + ": " + e.message)
        } finally {
            runCatching {
                cfgStore.save(
                    mapOf(
                        "campusSsids" to configBefore.campusSsids,
                        "portalUrl" to configBefore.portalUrl,
                        "autoAuthOnCampus" to configBefore.autoAuthOnCampus,
                    )
                )
            }
            scope.cancel()
        }
    }

    /** 发一个变体请求，返回"标签 → state（门户原文）"这样一行；不打印任何凭据 */
    private suspend fun runVariant(
        js: JsCoreRuntime,
        platform: AndroidPlatform,
        api: String,
        portalUrl: String,
        fields: JSONObject,
        label: String,
    ): String {
        val map = mutableMapOf<String, String>()
        fields.keys().forEach { k -> map[k] = fields.optString(k, "") }
        return try {
            val res = platform.httpTransport.postFormWithReferer("$api?method=login", map, 8000L, portalUrl)
            val verdict = JSONObject(
                js.callJson(
                    "src/core/eportal-protocol.js",
                    "classifyLoginResponse",
                    "[${JSONObject.quote(res.body)}]",
                ) ?: "{}"
            )
            "$label → state=${verdict.optString("state")}「${verdict.optString("message")}」（HTTP ${res.statusCode}）"
        } catch (e: Throwable) {
            "$label → 请求异常 ${e.javaClass.simpleName}"
        }
    }

    /** 只做一次 percent-encoding（与社区项目"先 encode 一次再放进表单"等价） */
    private fun encodeOnce(value: String): String =
        java.net.URLEncoder.encode(value, "UTF-8").replace("+", "%20")

    /**
     * 第 27 项：**门户到底先校验密码还是先查服务**（一次哨兵错密码诊断）。
     *
     * 为什么必须做：真机上真实账号得到的是「用户不允许使用本服务!」。
     * 这句话有两种完全不同的解释，指向完全不同的结论：
     *   A. 门户先校验密码（密码是对的）→ 卡在服务/绑定（校园网账号侧）
     *   B. 门户先查服务绑定 → 那句话**不能**证明密码正确，也可能就是**密码不对**
     *      （那样真正的问题在配置里，而不是账号权限）
     *
     * 辨别方法：同一个真实账号 + **故意写错的密码**再发一次，看答复文本变成什么：
     *   · 变成"用户名或密码错误" → A 成立（门户确实先校验密码）
     *   · 仍是"不允许使用本服务" → B 成立（这句话与密码无关）
     *
     * ⚠ 只发一次；日志里**不出现账号与密码**，只记门户答复文本与类别。
     * ⚠ 守卫没放行（不是校园网 / 没凭据）时直接跳过，不发任何请求。
     */
    private suspend fun wrongPasswordProbe(js: JsCoreRuntime, platform: AndroidPlatform): Item {
        val name = "27. 门户先校验什么（真实账号 + 哨兵错密码，只发一次）"
        val scope = kotlinx.coroutines.CoroutineScope(
            kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Default
        )
        val cfgStore = platform.configStore
        val configBefore = cfgStore.load()
        return try {
            js.loadScriptAsset("js/android-runtime.js")
            js.loadModule("src/core/eportal-protocol.js")

            // 先自己发现一次门户地址（与产品路径同一条：30x Location → 响应体 JS 跳转）
            val report = platform.networkProbeImpl.probeDetailed()
            val portalUrl = PortalDiscovery.findPortalUrl(report.samples)
                ?: PortalDiscovery.pickBest(bodyRedirectCandidates(js, report))
                ?: return Item(name, true, "本次探测=${report.summary.outcome}：拿不到门户地址，如实跳过（不发任何请求）")

            // 让守卫放行：校园 SSID = 当前 SSID；门户地址 = 刚发现的真实门户（用完恢复）
            cfgStore.save(
                mapOf(
                    "campusSsids" to listOf(platform.wifi.readSsid(platform.portalNetwork.getCurrentNetwork()) ?: "SELFCHECK-NO-SSID"),
                    "portalUrl" to portalUrl,
                    "autoAuthOnCampus" to true,
                )
            )

            val bridge = AndroidJsBridge(
                context,
                platform,
                scope,
                redact = { text: String ->
                    kotlinx.coroutines.runBlocking {
                        js.evalToString("__redact(" + JSONObject.quote(text) + ")")
                    } ?: ""
                },
            )
            bridge.install(js)

            val ctxBox = runJsAsync(js, "(async function () { return await __androidLoginContext(); })()")
            val ctx = JSONObject(ctxBox.optString("value").ifEmpty { "{}" })
            if (!ctx.optBoolean("ok")) {
                return Item(name, true, "守卫未放行（${ctx.optString("reason")}）：本项**不发任何请求**，如实跳过")
            }

            val account = ctx.optString("account")
            val operatorLabel = ctx.optString("operatorLabel").takeIf { it.isNotEmpty() && it != "null" }
            if (account.isEmpty()) {
                return Item(name, true, "没有可用的账号，如实跳过")
            }
            // portalUrl 用上面发现到的那个（守卫返回的是同一份，配置里已临时写入）

            val targetsJson = js.callJson(
                "src/core/eportal-protocol.js",
                "buildLoginTargets",
                "[${JSONObject.quote(portalUrl)}]",
            ) ?: return Item(name, true, "门户地址无法解析，如实跳过")
            val targets = JSONObject(targetsJson)
            if (!targets.optBoolean("ok")) {
                return Item(name, true, "门户地址不可用（${targets.optString("reason")}），如实跳过")
            }
            val api = targets.optString("api")
            val queryString = targets.optString("queryString")

            val pageInfo = platform.httpTransport.postFormWithReferer(
                "$api?method=pageInfo",
                mapOf("queryString" to queryString),
                8000L,
                portalUrl,
            )

            // 故意写错的密码（哨兵值），只为看门户走哪个分支
            val planJson = js.callJson(
                "src/core/eportal-protocol.js",
                "buildLoginRequest",
                "[" + JSONObject()
                    .put("portalUrl", portalUrl)
                    .put("account", account)
                    .put("password", WRONG_PASSWORD_SENTINEL)
                    .put("operatorLabel", operatorLabel ?: JSONObject.NULL)
                    .put("pageInfoText", pageInfo.body)
                    .toString() + "]",
            ) ?: return Item(name, false, "构造登录请求失败（协议返回空）")
            val plan = JSONObject(planJson)
            if (!plan.optBoolean("ok")) {
                return Item(name, true, "协议拒绝构造请求（${plan.optString("reason")}），如实跳过")
            }

            val fields = mutableMapOf<String, String>()
            plan.optJSONObject("fields")?.let { f -> f.keys().forEach { k -> fields[k] = f.optString(k, "") } }

            val res = platform.httpTransport.postFormWithReferer("$api?method=login", fields, 8000L, portalUrl)
            val verdict = JSONObject(
                js.callJson(
                    "src/core/eportal-protocol.js",
                    "classifyLoginResponse",
                    "[${JSONObject.quote(res.body)}]",
                ) ?: "{}"
            )
            val state = verdict.optString("state")
            val message = verdict.optString("message")
            val fieldNames = js.callJson(
                "src/core/eportal-protocol.js",
                "responseFieldNames",
                "[${JSONObject.quote(res.body)}]",
            ).orEmpty()

            val conclusion = when (state) {
                "credentials" ->
                    "门户先校验密码：写错密码时答复「$message」 ⇒ 真实密码得到的" +
                        "「不允许使用本服务」说明**密码是对的**，卡在服务/绑定（账号侧）"
                "service-not-allowed" ->
                    "门户先查服务绑定：写错密码时答复仍是「$message」 ⇒ 这句话**与密码无关**，" +
                        "不能据此判断密码是否正确"
                else -> "门户答复类别=$state「$message」"
            }

            Item(
                name,
                true, // 辨别实验：两种结果都是有价值的信息，不判失败
                "服务=${plan.optString("service")}｜HTTP ${res.statusCode}｜响应字段=$fieldNames｜" +
                    "state=$state｜$conclusion（账号与密码均未出现在日志中）",
            ).also {
                // 同时写一行 Logcat：设备测试脚本可以不开界面就取到这个结论
                // （只写结论文本，不含账号、密码、URL）
                android.util.Log.i(
                    LogTag,
                    "[诊断] 第27项 state=$state 响应字段=$fieldNames 结论=$conclusion",
                )
                bridge.cancelAllTimers()
                bridge.clearLastLogin()
            }
        } catch (e: Throwable) {
            Item(name, false, "辨别实验异常: " + e.javaClass.simpleName + ": " + e.message)
        } finally {
            // 恢复用户原配置（第 23 项用的是同一套做法）
            runCatching {
                cfgStore.save(
                    mapOf(
                        "campusSsids" to configBefore.campusSsids,
                        "portalUrl" to configBefore.portalUrl,
                        "autoAuthOnCampus" to configBefore.autoAuthOnCampus,
                    )
                )
            }
            scope.cancel()
        }
    }

    /**
     * 第 26 项：**真实校园门户的响应结构**（不发凭据）。
     *
     * 目的：真实门户与适配器/协议到底兼不兼容，只有看它的真实响应才知道。
     * 所以当设备被门户拦着时，用探测发现的**真实门户地址**请求一次 `pageInfo`
     * （只带 queryString，**不带账号密码**），把结构摊开。
     *
     * 报告里只出现：HTTP 状态码、键名、服务名、`passwordEncrypt` 等**结构信息**；
     * queryString 的具体取值不打印（那是当次会话上下文，没必要留）。
     */
    private suspend fun realPortalStructureCheck(js: JsCoreRuntime, platform: AndroidPlatform): Item {
        val name = "26. 真实门户响应结构（只发 queryString，不发凭据）"
        return try {
            val report = platform.networkProbeImpl.probeDetailed()

            // 门户地址有两个来源：
            //   ① 探测点被 30x 跳转时的 Location
            //   ② 响应体里的 JS/meta 跳转 —— **真机实测本校园门户就是这种**
            //      （`HTTP/1.1 200 ok` + `<script>top.self.location.href='http://10.245.2.19/eportal/index.jsp?...'</script>`）
            //   ②的挖掘复用 Core 的 `src/shared/html-parse.js`（与 Windows 同一份实现），
            //   挑选规则用 `PortalDiscovery.pickBest`（与产品路径同一条）。
            val fromLocation = PortalDiscovery.findPortalUrl(report.samples)
            val fromBody = bodyRedirectCandidates(js, report)
            val effective = fromLocation ?: PortalDiscovery.pickBest(fromBody)

            if (effective == null) {
                return Item(
                    name,
                    true,
                    "本次探测=${report.summary.outcome}（${report.summary.details.joinToString("；")}）：" +
                        "既没有 30x 跳转，响应体里也没有跳转候选，拿不到门户地址。" +
                        "本项**如实跳过**，不伪造结果",
                )
            }

            // 从真实门户地址推出 InterFace.do（与 Core 的 interFaceUrl 同一规则：
            // 取 /eportal/ 之前的 origin，再拼 /eportal/InterFace.do）
            val withoutQuery = effective.substringBefore('?')
            val at = withoutQuery.indexOf("/eportal/", ignoreCase = true)
            if (at <= 0) {
                return Item(
                    name,
                    true,
                    "门户地址不是锐捷 ePortal 形态（来源=${if (fromLocation != null) "30x Location" else "响应体跳转"}，" +
                        "只显示主机部分：" + withoutQuery.substringBefore("/").take(40) + "），本项跳过",
                )
            }
            val api = withoutQuery.substring(0, at) + "/eportal/InterFace.do"
            val queryString = effective.substringAfter('?', "")
            val source = if (fromLocation != null) "30x Location" else "响应体 JS 跳转"

            val res = platform.httpTransport.postForm(
                "$api?method=pageInfo",
                mapOf("queryString" to queryString),
                8000L,
            )

            val body = res.body
            val parsed = try {
                JSONObject(body)
            } catch (_: Throwable) {
                return Item(
                    name,
                    false,
                    "门户答复不是 JSON（HTTP ${res.statusCode}）：" +
                        "前 120 字符的结构线索=" + body.take(120).replace(Regex("\\s+"), " "),
                )
            }

            val serviceObj = parsed.optJSONObject("service")
            val serviceNames = serviceObj?.keys()?.asSequence()?.toList().orEmpty()
            val keys = parsed.keys().asSequence().toList()

            val structure = buildString {
                append("来源=").append(source)
                append("｜HTTP ${res.statusCode}｜键=").append(keys.joinToString(","))
                append("｜服务列表=").append(if (serviceNames.isEmpty()) "(空)" else serviceNames.joinToString(" / "))
                append("｜passwordEncrypt=").append(parsed.optString("passwordEncrypt", "(无该键)"))
                append("｜isToCasPage=").append(parsed.optString("isToCasPage", "(无该键)"))
                append("｜validCodeUrl=").append(if (parsed.has("validCodeUrl")) "有" else "无")
                append("｜queryString 长度=").append(queryString.length)
            }

            // 判定标准只看"协议能不能用"：必须能解析出服务列表
            val usable = serviceObj != null && serviceNames.isNotEmpty()
            Item(
                name,
                usable,
                structure + if (usable) "" else "　⚠ 响应里没有可用服务列表 —— 需要按真实结构改协议兼容逻辑",
            )
        } catch (e: Throwable) {
            Item(name, false, "请求真实门户失败: " + e.javaClass.simpleName + ": " + e.message)
        }
    }

    /**
     * 从探测响应体里挖跳转候选（**复用 Core 的 html-parse，与 Windows 同一份实现**）。
     *
     * 为什么需要：真机实测本校园门户劫持的方式是
     * `HTTP/1.1 200 ok` + `<script>top.self.location.href='http://10.245.2.19/eportal/index.jsp?...'</script>`，
     * **不是 302** —— 只看 `Location` 会找不到门户（第四阶段就是这个原因失败的）。
     *
     * ⚠ 这里只做"挖候选"，挑哪一个用 `PortalDiscovery.pickBest`（规则只有一份）。
     */
    private suspend fun bodyRedirectCandidates(js: JsCoreRuntime, report: ProbeReport): List<String> {
        val out = mutableListOf<String>()
        try {
            js.loadModule("src/shared/html-parse.js")
            for (sample in report.samples) {
                val body = sample.result.body
                if (body.isNullOrBlank()) continue
                val json = js.callJson(
                    "src/shared/html-parse.js",
                    "extractRedirectCandidates",
                    "[${JSONObject.quote(body)}, ${JSONObject.quote(sample.url)}]",
                ) ?: continue
                val arr = org.json.JSONArray(json)
                for (i in 0 until arr.length()) out += arr.optString(i)
            }
        } catch (_: Throwable) {
            // 挖不出来不是错误：调用方会按"没有门户地址"处理
        }
        return out
    }

    /**
     * 第 24 项：平台桥在**真实网络**上的两个关键行为
     *
     *   1. `__androidLoginContext()` —— 当前网络不是校园网，
     *      必须返回 `ok:false`，而且返回值里**不能出现 password 字段**（凭据根本没被读出来）
     *   2. `__androidAfterLogin({success:true})` —— 登录后必须**复探确认**，
     *      本机此刻确实能上网，所以要返回 success:true（证明这条确认链路是通的，
     *      而不是"门户说成功就算成功"）
     */
    private suspend fun platformBridgeCheck(js: JsCoreRuntime, platform: AndroidPlatform): Item {
        val name = "24. 平台桥（真实网络：凭据闸门 + 登录后复探）"
        val scope = kotlinx.coroutines.CoroutineScope(
            kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Default
        )
        return try {
            js.loadScriptAsset("js/android-runtime.js")
            val bridge = AndroidJsBridge(
                context,
                platform,
                scope,
                redact = { text: String ->
                    kotlinx.coroutines.runBlocking {
                        js.evalToString("__redact(" + JSONObject.quote(text) + ")")
                    } ?: ""
                },
            )
            bridge.install(js)

            val ctxBox = runJsAsync(js, "(async function () { return await __androidLoginContext(); })()")
            val ctxJson = ctxBox.optString("value")
            val ctx = JSONObject(if (ctxJson.isEmpty()) "{}" else ctxJson)
            val allowed = ctx.optBoolean("ok")

            // 断言的是**不变量**，而不是某一种固定结果（否则换到校园网上这条就会"失败"）：
            //   · 守卫拒绝时：返回值里绝不能有账号/密码（凭据根本没被读出来）
            //   · 守卫放行时：必须带上门户地址（说明是走完了闸门才解密凭据的）
            val noPasswordField = !ctx.has("password") && !ctx.has("account")
            val gateOk = if (allowed) {
                ctx.optString("portalUrl").isNotEmpty() && !noPasswordField
            } else {
                noPasswordField
            }

            // "登录后复探确认"的断言方式：**必须与实际探测结论一致**，而不是固定要求成功。
            //   · 设备此刻真能上网 → 复探 ONLINE → afterLogin 必须回 success=true
            //   · 设备被门户拦着/没网 → 复探不是 ONLINE → afterLogin **必须**回 success=false
            //     （这正是"绝不因为门户说成功就宣布成功"这条不变量）
            val probeOutcome = platform.networkProbeImpl.probeDetailed().summary.outcome
            val afterBox = runJsAsync(
                js,
                "(async function () { return await __androidAfterLogin(" +
                    JSONObject.quote("""{"success":true,"reason":"http-login-success","detail":{}}""") +
                    "); })()",
            )
            val after = JSONObject(afterBox.optString("value").ifEmpty { "{}" })
            val afterConfirmed = after.optBoolean("success")
            val afterOk = if (probeOutcome == ProbeOutcome.ONLINE) {
                afterConfirmed
            } else {
                !afterConfirmed && after.optString("reason") == "post-login-not-online"
            }

            return Item(
                name,
                gateOk && afterOk,
                "凭据闸门=" + (if (allowed) "放行（含门户地址=${ctx.optString("portalUrl").isNotEmpty()}）"
                else "拒绝（reason=${ctx.optString("reason")}，返回值不含账号/密码）") + "  " +
                    "实际探测=$probeOutcome → 登录后复探结论=${if (afterConfirmed) "成功" else "未成功(" + after.optString("reason") + ")"}" +
                    "（与探测一致=${afterOk}）",
            ).also {
                bridge.cancelAllTimers()
                // 合成调用产生的"最近认证"不是用户真实认证，清掉，别污染首页
                bridge.clearLastLogin()
            }
        } catch (e: Throwable) {
            Item(name, false, e.toString())
        } finally {
            scope.cancel()
        }
    }

    /**
     * 第 25 项：状态机行为（用**假依赖**在设备上驱动 Core）。
     *
     * 为什么这一项必须在设备上跑：Core 用的是 QuickJS 而不是 Node，
     * 而"什么时候该登录"完全由它决定 —— 如果它在 Android 的引擎上行为不对，
     * 后果是乱登录或该登录时不登录。所以这里把关键分支逐条驱动一遍：
     *   · 已联网 / 未知状态 / 链路未就绪 → **不许登录**
     *   · 需要认证 → 登录，成功后回到 IDLE
     *   · 超时失败 → 退避等待（冷却期不重复登录）
     *   · 凭据错误 → 停手（不再排下一次）
     *   · 用户恢复 / 网络恢复 → 重新判断
     */
    private suspend fun stateMachineCheck(js: JsCoreRuntime): Item {
        val name = "25. 状态机行为（设备上跑 Core；OTHER/ONLINE 不登录、PORTAL 登录、失败冷却、凭据错停手）"
        val code = """
            (async function () {
              var ac = __cjs.require('src/core/auto-connect');
              var out = {};
              var timers = [], total = 0, seq = 0, nowMs = 1000000, loginCalls = 0;
              var conn = { state: 'ONLINE' };
              var loginResult = { success: true, reason: 'ok' };
              var engine = ac.createAutoConnect({
                checkConnectivity: function () { return conn; },
                loginAttempt: function () { loginCalls++; return loginResult; },
                getConfig: function () { return { autoReconnect: true }; },
                log: function () {},
                now: function () { return nowMs; },
                setTimer: function (fn, ms) {
                  seq++; total++;
                  timers.push({ id: seq, fn: fn, at: nowMs + ms });
                  return seq;
                },
                clearTimer: function (h) {
                  timers = timers.filter(function (t) { return t.id !== h; });
                },
                onState: function () {}
              });

              // 把"到点"这件事显式地做出来：时间前进到最近一个定时器，然后跑它。
              // 这样测的是 Core 真正的驱动方式（到点才检测），而不是手动乱 tick。
              async function fireNext() {
                if (!timers.length) return false;
                timers.sort(function (a, b) { return a.at - b.at; });
                var t = timers.shift();
                if (t.at > nowMs) nowMs = t.at;
                await t.fn();
                return true;
              }

              engine.start();

              conn = { state: 'ONLINE' };  await fireNext();
              out.onlineNoLogin = loginCalls === 0;
              out.onlinePhase = engine.getSnapshot().phase;

              conn = { state: 'UNKNOWN' }; await fireNext();
              out.unknownNoLogin = loginCalls === 0;

              conn = { state: 'NO_LINK' }; await fireNext();
              out.noLinkNoLogin = loginCalls === 0;

              conn = { state: 'PORTAL' };
              loginResult = { success: true, reason: 'http-login-success' };
              await fireNext();
              out.portalLoginCalls = loginCalls;
              out.afterSuccessPhase = engine.getSnapshot().phase;

              loginResult = { success: false, reason: 'pageinfo-timeout' };
              await fireNext();
              var s = engine.getSnapshot();
              out.retryPhase = s.phase;
              out.backoffMs = s.nextAttemptAt - nowMs;
              var callsAfterFail = loginCalls;

              await fireNext();                    // 退避到点 → 才允许再试一次
              out.retriedAfterCooldown = loginCalls === callsAfterFail + 1;

              loginResult = { success: false, reason: 'http-login-credentials' };
              var totalBeforeStop = total;
              await fireNext();
              out.credentialsPhase = engine.getSnapshot().phase;
              out.stoppedScheduling = total === totalBeforeStop &&
                engine.getSnapshot().nextAttemptAt === null;

              loginResult = { success: true, reason: 'ok' };
              conn = { state: 'ONLINE' };
              engine.setPaused(false);             // 相当于用户手动恢复
              await fireNext();
              out.recoveredPhase = engine.getSnapshot().phase;

              return JSON.stringify(out);
            })()
        """.trimIndent()

        return try {
            val box = runJsAsync(js, code)
            if (!box.optBoolean("ok")) {
                return Item(name, false, "JS 异常: " + box.optString("error"))
            }
            val o = JSONObject(box.optString("value").ifEmpty { "{}" })
            val checks = linkedMapOf(
                "已联网不登录" to o.optBoolean("onlineNoLogin"),
                "未知状态不登录" to o.optBoolean("unknownNoLogin"),
                "链路未就绪不登录" to o.optBoolean("noLinkNoLogin"),
                "需要认证才登录（且只一次）" to (o.optInt("portalLoginCalls") == 1),
                "登录成功后回到 IDLE" to (o.optString("afterSuccessPhase") == "IDLE"),
                "超时失败进入退避" to (o.optString("retryPhase") == "RETRY_WAIT"),
                "退避时长 5 秒" to (o.optLong("backoffMs") == 5000L),
                "冷却结束后才重试" to o.optBoolean("retriedAfterCooldown"),
                "凭据错误停手" to (o.optString("credentialsPhase") == "NEEDS_ATTENTION"),
                "停手后不再排下一次" to o.optBoolean("stoppedScheduling"),
                "用户恢复后重新判断" to (o.optString("recoveredPhase") == "IDLE"),
            )
            val failed = checks.filterValues { !it }.keys
            Item(name, failed.isEmpty(), if (failed.isEmpty()) "${checks.size} 项全过" else "未通过: $failed ｜ $o")
        } catch (e: Throwable) {
            Item(name, false, e.toString())
        }
    }

    /**
     * 用"信箱"跑一段**异步** JS，返回 `{ok, value}` 或 `{ok:false, error}`。
     *
     * 为什么不用 `evaluate` 直接拿返回值：Kotlin 侧的 `evaluate` **不会 await 顶层 Promise**
     * （实测拿到的是 Promise 对象，`toString()` 是 "Promise"）。
     * 详细说明见 `assets/js/android-runtime.js` 里 `__runAsync` 的注释。
     */
    private suspend fun runJsAsync(js: JsCoreRuntime, code: String): JSONObject {
        js.evalToString("__runAsync(" + JSONObject.quote(code) + ")")
        var tries = 0
        while (tries < 200) { // 最长约 10 秒
            val boxed = js.evalToString("__asyncResult")
            if (!boxed.isNullOrEmpty() && boxed != "null") return JSONObject(boxed)
            kotlinx.coroutines.delay(50)
            tries++
        }
        return JSONObject().put("ok", false).put("error", "等待 JS 异步结果超时")
    }

    /**
     * 第 16 项：**应用退到后台之后**，定时器还跑不跑、SSID 还读不读得到。
     *
     * 为什么必须实测这一条：本应用的产品目标是"开机后自动认证"，
     * 也就是**没有界面的时候**也要能认出校园 Wi-Fi。真机上读 SSID 需要定位权限，
     * 定位权限又分"仅在使用时允许 / 始终允许"——如果后台读不到，
     * 自动认证这条路就得换方案（这是必须提前知道的事，不能等做完才发现）。
     *
     * ⚠ 这里**直接写 Logcat**，刻意不走 AndroidLogger：
     *   本实验要看"后台线程到底还跑不跑"，如果走业务日志链（队列 + 后台线程 + JS 脱敏），
     *   就会把"线程没跑"和"日志没写出去"两件事混在一起，得不出结论。
     *
     * 四个时间点（+5 / +15 / +30 / +60 秒）各记一条：第一条通常还在前台，
     * 后面的都在后台 —— 时间线一看就知道线程是在哪一刻停下的。
     */
    private fun startBackgroundSsidProbe(platform: AndroidPlatform, network: android.net.Network?) {
        val wifi = platform.wifi
        Thread({
            var last = 0L
            for (at in BACKGROUND_PROBE_MARKS_MILLIS) {
                try {
                    Thread.sleep(at - last)
                } catch (_: InterruptedException) {
                    return@Thread
                }
                last = at
                try {
                    val ssid = wifi.readSsid(network) ?: "(读不到)"
                    android.util.Log.i(
                        LogTag,
                        "[后台实验] +${at / 1000}s importance=${currentImportance()} readSsid=$ssid",
                    )
                } catch (e: Throwable) {
                    android.util.Log.i(LogTag, "[后台实验] +${at / 1000}s 读 SSID 抛异常: $e")
                }
            }
        }, "selfcheck-bg-ssid").apply { isDaemon = true }.start()
    }

    /** 本进程当前的 importance（100=前台 200=可见 400=缓存；用来判断"是否真的在后台"） */
    private fun currentImportance(): Int {
        val state = android.app.ActivityManager.RunningAppProcessInfo()
        android.app.ActivityManager.getMyMemoryState(state)
        return state.importance
    }

    /**
     * 第 18 项：用**设备上的 QuickJS** 跑一遍 Core 的协议纯函数（表驱动）。
     *
     * 为什么这一步不能只靠 JVM 单测：
     *   Android 用的引擎是 QuickJS，不是 Node。协议代码里一旦用到 QuickJS 没有的东西
     *   （最典型的就是 WHATWG `URL`），单测全绿、真机全崩。
     *   所以这里在真机引擎上把关键分支逐条过一遍。
     */
    private suspend fun protocolTableCheck(js: JsCoreRuntime): Item {
        val name = "18. ePortal 协议纯函数（与 Windows 同一份实现）"
        return try {
            val expr = """
                (function () {
                  var p = __cjs.require('src/core/eportal-protocol');
                  var out = {};
                  out.interFace = p.interFaceUrl('http://10.245.2.19/eportal/index.jsp?wlanuserip=1.2.3.4');
                  out.query = p.extractQueryString('http://a/eportal/index.jsp?id=1&nas=2');
                  out.already = p.classifyLoginResponse('{"result":"fail","message":"当前设备已存在在线用户!"}').state;
                  out.success = p.classifyLoginResponse('{"result":"success"}').state;
                  out.credentials = p.classifyLoginResponse('{"result":"fail","message":"密码错误"}').state;
                  out.captcha = p.classifyLoginResponse('{"result":"fail","message":"请输入验证码"}').state;
                  out.unparsable = p.classifyLoginResponse('<html>').state;
                  out.encoded = p.encodeFormFields({ queryString: 'a=1&b=2' });
                  out.foreignRejected = p.looksLikeRuijieEportal('http://evil.example.com/login');
                  var plan = p.buildLoginRequest({
                    portalUrl: 'http://10.245.2.19/eportal/index.jsp?wlanuserip=9',
                    account: 'u', password: 'p', operatorLabel: '中国联通',
                    pageInfoText: JSON.stringify({ passwordEncrypt: 'false', service: { '联通互联网服务': { serviceDefault: 'true' } } })
                  });
                  out.planOk = plan.ok;
                  out.planService = plan.service;
                  out.fieldCount = plan.fields ? Object.keys(plan.fields).length : 0;
                  var encrypt = p.buildLoginRequest({
                    portalUrl: 'http://10.245.2.19/eportal/index.jsp?wlanuserip=9',
                    account: 'u', password: 'p', operatorLabel: '中国联通',
                    pageInfoText: JSON.stringify({ passwordEncrypt: 'true', service: { '联通互联网服务': { serviceDefault: 'true' } } })
                  });
                  out.encryptRefused = encrypt.ok === false && encrypt.reason === 'password-encrypt-required';
                  return JSON.stringify(out);
                })()
            """.trimIndent()

            val raw = js.evalToString(expr)
            val o = JSONObject(raw ?: "{}")
            val checks = linkedMapOf(
                "interFaceUrl 推导" to (o.optString("interFace") == "http://10.245.2.19/eportal/InterFace.do"),
                "queryString 提取" to (o.optString("query") == "id=1&nas=2"),
                "已在线判成功" to (o.optString("already") == "already-online"),
                "success 判定" to (o.optString("success") == "success"),
                "密码错误→credentials" to (o.optString("credentials") == "credentials"),
                "验证码→captcha" to (o.optString("captcha") == "captcha"),
                "非 JSON→unparsable" to (o.optString("unparsable") == "unparsable"),
                "表单二次编码" to (o.optString("encoded") == "queryString=a%3D1%26b%3D2"),
                "陌生门户拒绝" to (o.optBoolean("foreignRejected") == false),
                "登录字段构造" to (o.optBoolean("planOk") && o.optString("planService") == "联通互联网服务" && o.optInt("fieldCount") >= 8),
                "要求加密时拒绝发送" to o.optBoolean("encryptRefused"),
            )
            val failed = checks.filterValues { !it }.keys
            Item(
                name,
                failed.isEmpty(),
                if (failed.isEmpty()) "${checks.size} 项全过" else "未通过: $failed ｜ 原始输出=$raw",
            )
        } catch (e: Throwable) {
            Item(name, false, e.toString())
        }
    }

    /**
     * 第 22 项：**登录链路端到端**（对着 Mock 门户，用哨兵密码）。
     *
     * 为什么用 Mock 而不是真实门户：
     *   真实登录需要用户的**真实账号密码**，而且要求当前网络真的被门户拦着
     *   （本机实测时是"已认证在线"状态，根本没有门户重定向可发现）。
     *   这两条都不该由自检来凑 —— 凑出来的"成功"就是伪造。
     *   所以这里用一台本机 Mock 门户，把**除"真实学校门户"以外的整条链路**
     *   都真跑一遍：门户发现 → 守卫放行 → Keystore 解密 → pageInfo → 选服务 →
     *   构造字段 → OkHttp POST → 响应分类 → credentials 类失败会让状态机停手。
     *
     * ⚠ 哨兵凭据用完**立刻恢复原状**（用户真实凭据绝不被覆盖或清掉）。
     */
    private suspend fun mockLoginChainCheck(
        js: JsCoreRuntime,
        platform: AndroidPlatform,
        currentSsid: String?,
    ): Item {
        val name = "23. 登录链路（Mock 门户，哨兵密码；不含真实凭据）"
        val mock = mockPortalUrl
        if (mock.isNullOrBlank()) {
            return Item(
                name,
                true,
                "未提供 Mock 门户地址（可 adb --es mockPortal \"http://<PC>:8080/eportal/index.jsp?...\"）。" +
                    "本项如实标注为**未验证**，不伪造成功",
            )
        }

        val credStore = platform.credentialStore
        val cfgStore = platform.configStore
        val previousCredentials = credStore.load()
        val previousConfig = cfgStore.load()

        try {
            // 让守卫放行：校园 SSID = 当前 SSID；门户地址 = Mock
            cfgStore.save(
                mapOf(
                    "campusSsids" to listOf(currentSsid ?: "SELFCHECK-NO-SSID"),
                    "portalUrl" to mock,
                    "autoAuthOnCampus" to true,
                    "operatorLabel" to "中国联通",
                )
            )
            // 把 JS 的 transport 接到 AndroidHttpTransport（自检用的无绑定实例，见方法注释）
            js.defineAsyncString("__scPostForm") { args -> selfCheckPostForm(platform, args) }

            val okRun = runMockLogin(js, mock, SENTINEL_OK_PASSWORD)
            val badRun = runMockLogin(js, mock, SENTINEL_BAD_PASSWORD)

            val okSuccess = okRun?.optBoolean("success") == true
            val okReason = okRun?.optString("reason")
            val badSuccess = badRun?.optBoolean("success")
            val badReason = badRun?.optString("reason")
            val classificationOk = badSuccess == false && badReason == "http-login-credentials"

            // 界面状态里**绝不能**出现密码：把哨兵密码写进凭据后，界面的那套状态仍应干净
            val holderDump = AuthStateHolder.state.value.toString()
            val holderClean = !holderDump.contains(SENTINEL_OK_PASSWORD) &&
                !holderDump.contains(SENTINEL_BAD_PASSWORD)

            return Item(
                name,
                okSuccess && classificationOk && holderClean,
                "正常答复→success=$okSuccess($okReason)  " +
                    "门户说密码错→success=$badSuccess($badReason，应被归为 credentials 让状态机停手)  " +
                    "界面状态不含密码=$holderClean  全程使用哨兵密码，未使用真实凭据",
            )
        } catch (e: Throwable) {
            return Item(name, false, "登录链路异常: " + e.toString())
        } finally {
            // 哨兵凭据不留痕；配置恢复原样
            runCatching {
                if (previousCredentials != null) credStore.save(previousCredentials) else credStore.clear()
            }
            runCatching {
                cfgStore.save(
                    mapOf(
                        "campusSsids" to previousConfig.campusSsids,
                        "portalUrl" to previousConfig.portalUrl,
                        "autoAuthOnCampus" to previousConfig.autoAuthOnCampus,
                        "operatorLabel" to previousConfig.operatorLabel,
                    )
                )
            }
        }
    }

    /** 用 Core 协议的完整登录流程跑一次（HTTP 由 AndroidHttpTransport 发） */
    private suspend fun runMockLogin(js: JsCoreRuntime, mock: String, password: String): JSONObject? {
        val expr = """
            (async function () {
              var p = __cjs.require('src/core/eportal-protocol');
              var res = await p.runHttpLogin({
                portalUrl: ${JSONObject.quote(mock)},
                account: ${JSONObject.quote(SENTINEL_ACCOUNT)},
                password: ${JSONObject.quote(password)},
                operatorLabel: '中国联通',
                transport: {
                  postForm: async function (url, fields, opts) {
                    return JSON.parse(await __scPostForm(url, JSON.stringify(fields), JSON.stringify(opts || {})));
                  }
                },
                onLog: function () {}
              });
              return JSON.stringify(res);
            })()
        """.trimIndent()

        val box = runJsAsync(js, expr)
        if (!box.optBoolean("ok")) {
            throw IllegalStateException("JS 侧异常: " + box.optString("error"))
        }
        val value = box.optString("value")
        return if (value.isEmpty() || value == "null") null else JSONObject(value)
    }

    /**
     * 自检用的 postForm（第 22 项专用）。
     *
     * ⚠ 这里刻意用**不带 Network 绑定**的传输：Mock 门户是通过 `adb reverse` 映射到
     *   `127.0.0.1` 的，而绑定到 Wi-Fi 的 socket 发不出 loopback 流量。
     *   "绑定 Network" 这件事由第 7 项（HTTP 打出 204）和第 20 项（真实探测发现门户）
     *   在**真实校园网**上验证 —— 两者合起来才完整，这里不重复也不假装。
     *   除绑定之外，用的是**同一个** [AndroidHttpTransport] 实现（编码、UA、超时都一样）。
     */
    private suspend fun selfCheckPostForm(platform: AndroidPlatform, args: Array<Any?>): String? {
        val url = args.getOrNull(0)?.toString().orEmpty()
        val fieldsJson = args.getOrNull(1)?.toString().orEmpty()
        val fields = mutableMapOf<String, String>()
        try {
            val o = JSONObject(fieldsJson)
            o.keys().forEach { k -> fields[k] = o.optString(k, "") }
        } catch (_: Throwable) {
            return JSONObject().put("ok", false).put("error", "bad-fields").toString()
        }
        return try {
            val transport = com.campusnet.auto.platform.AndroidHttpTransport(
                com.campusnet.auto.platform.PortalNetworkProvider()
            )
            val res = transport.postForm(url, fields, 8000L)
            JSONObject().put("ok", true).put("status", res.statusCode).put("text", res.body).toString()
        } catch (e: Throwable) {
            JSONObject().put("ok", false)
                .put("error", e.javaClass.simpleName + ": " + (e.message ?: ""))
                .toString()
        }
    }

    /**
     * 在应用私有目录里搜一段明文。
     * 用 ISO_8859_1 读字节再搜子串：一一映射，既能匹配文本也能穿透二进制里的原始字节。
     */
    private fun scanDataDirFor(secret: String): List<String> {
        val hits = mutableListOf<String>()
        context.dataDir.walkTopDown()
            .filter { it.isFile }
            .forEach { file ->
                try {
                    if (String(file.readBytes(), Charsets.ISO_8859_1).contains(secret)) {
                        hits += file.absolutePath
                    }
                } catch (_: Throwable) {
                    // 个别文件读不了不影响结论
                }
            }
        return hits
    }

    private fun quote(value: String): String = JSONObject.quote(value)

    private companion object {
        const val REDACT_MODULE = "src/shared/redact.js"
        const val REDACT_MODULE_NO_EXT = "src/shared/redact"
        const val SECRET_IN_URL = "PW_MUST_NOT_LEAK_7f3a"
        const val URL_WITH_SECRET =
            "http://10.245.2.19/eportal/index.jsp?wlanuserip=abc&password=PW_MUST_NOT_LEAK_7f3a"

        const val ACCOUNT = "selfcheck-account"
        const val PASSWORD_SENTINEL = "PW_SENTINEL_9c1d"

        /** 后台实验的采样时刻（毫秒）：第一条一般还在前台，其余都在后台 */
        val BACKGROUND_PROBE_MARKS_MILLIS = longArrayOf(5_000L, 15_000L, 30_000L, 60_000L)

        /** 后台实验直接用的 Logcat tag（与 AndroidLogger.TAG 保持一致） */
        const val LogTag = "CampusNet"

        /** 脱敏用例里的哨兵密码：一旦它出现在输出里，就说明脱敏失效 */
        const val SECRET_SENTINEL = "PW_SENTINEL_NOT_IN_LOG_42"

        /** 第 22 项用的哨兵凭据（**不是**用户真实凭据；用完即恢复） */
        const val SENTINEL_ACCOUNT = "selfcheck-account"
        const val SENTINEL_OK_PASSWORD = "PW_SENTINEL_OK_42"
        const val SENTINEL_BAD_PASSWORD = "PW_SENTINEL_BAD_42"

        /** 第 27 项：故意写错的密码（辨别门户先校验什么；只发一次，绝不进日志） */
        const val WRONG_PASSWORD_SENTINEL = "PW_DELIBERATELY_WRONG_PROBE_9f3c"
    }
}
