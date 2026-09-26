# 网络发现与检测（第三阶段）

本阶段只做一件事：**在没有界面参与的情况下，能不能可靠地知道"现在是什么网络、是不是校园 Wi-Fi、通不通"**。
做完这一层，第四阶段（后台机制）和第五阶段（真正的自动认证）才有地基。

本阶段**刻意没做**：门户登录、凭据提交、auto-connect 状态机、后台 Service、
开机自启、通知、WebView、Wi-Fi 自动切换。

---

## 一、新增 / 修改文件

### Core（纯逻辑，零平台依赖，`src/test` 用 JUnit 覆盖）

| 文件 | 作用 |
|---|---|
| `core/NetworkSnapshot.kt` | 网络快照 + `NetworkKind{NONE,WIFI,OTHER}` + `ValidationState{UNVERIFIED,VALIDATED,CAPTIVE}` + `classifyNetwork` |
| `core/CampusWifiMatcher.kt` | 校园 SSID 匹配（精确 / 前缀 / 正则），规则全部来自配置，**不硬编码任何学校** |
| `core/ProbeVerdict.kt` | 探测四档判定 `ONLINE / PORTAL / TRANSIENT_FAILURE / NETWORK_UNAVAILABLE` |
| `core/SuggestionPolicy.kt` | Wi-Fi 建议提交策略（去重 / 冷却 / 非法值） |
| `core/Connectivity.kt`、`NetworkProbe.kt`、`HttpTransport.kt` | 平台能力的接口面（Android 侧实现，Windows 侧将来可另实现） |
| `core/ConfigStore.kt` | 新增 `campusSsids` / `campusSsidPrefixes` / `campusSsidPatterns` / `autoAuthOnCampus` / `suggestCampusWifi` |

### Platform（Android 实现）

| 文件 | 作用 |
|---|---|
| `platform/AndroidNetworkMonitor.kt` | `NetworkCallback`（onAvailable / onCapabilitiesChanged / onLost）→ 每次重读 `activeNetwork` → 去重后才回调；同时把当前 `Network` 交给 `PortalNetworkProvider` |
| `platform/PortalNetworkProvider.kt` | 保存"当前网络"，供门户请求**绑定**（避免请求跑到移动数据上） |
| `platform/AndroidWifiState.kt` | 读 Wi-Fi 状态与 SSID（权限模型见第二节） |
| `platform/AndroidHttpTransport.kt` | OkHttp，`followRedirects(false)` + `socketFactory(network.socketFactory)` |
| `platform/AndroidNetworkProbe.kt` | 三个探测点（msftconnecttest / miui-204 / firefox-success） |
| `platform/AndroidWifiSuggester.kt` | 提交 Wi-Fi 建议（默认**不提交**，见第五节） |
| `platform/AndroidLogger.kt` | 队列 + 后台线程（避免在 JS 调度线程上等自己）；队列满丢弃并计数 |
| `platform/AndroidConfigStore.kt` / `AndroidCredentialStore.kt` | SharedPreferences（非敏感）/ Keystore AES-GCM（凭据） |
| `platform/AndroidPlatform.kt` | **唯一装配点**，额外暴露 `portalNetwork` / `wifi` / `wifiSuggester` |

删除：`platform/AndroidConnectivity.kt`（被 `AndroidNetworkMonitor` 取代，留着就是两套真值）。

---

## 二、真机实测结论①：SSID 到底要什么权限、走哪条路

**这是本阶段最重要的发现，跟官方文档不一致。**

真机：Android 17 / API 37，`targetSdk 36`。自检第 5 项把两条读取路径的原始返回值都打出来，可当场复现：

| 已授予的权限 | `NetworkCapabilities.transportInfo` | `WifiManager.connectionInfo` |
|---|---|---|
| `NEARBY_WIFI_DEVICES` | `<unknown ssid>` | `<unknown ssid>` |
| `NEARBY_WIFI_DEVICES` + `ACCESS_FINE_LOCATION` | `<unknown ssid>` | **`"YZU-WLAN"`（真实值）** |

结论：

1. **只给 `NEARBY_WIFI_DEVICES` 读不到 SSID**（文档说 API 33+ 给这个就够，实测不够）。
2. 真实值**必须有 `ACCESS_FINE_LOCATION`** —— 所以清单里**不能**给 `ACCESS_FINE_LOCATION` 写
   `maxSdkVersion="32"`（早期版本这么写过，Android 13+ 直接读不到）。
3. `transportInfo` 这条"官方推荐路径"在本机被脱敏，反而**已废弃**的
   `WifiManager.connectionInfo` 给真实值 → 代码里**两条路都试，谁给真实值用谁**，
   刻意不按版本号写死分支（各家 ROM 脱敏行为不一致）。
4. `neverForLocation` **已删除**：它的语义是"我保证不拿 Wi-Fi 推导位置"，而本应用恰恰要靠
   SSID 判断校园网、且实测 SSID 必须要定位权限，声明它既不符合事实也拿不到值。

隐私代价（产品取舍，不是技术顺手）：读 SSID 需要用户授予**定位权限**，对话框会明写"定位"。
用户拒绝的后果是**无法识别校园 Wi-Fi**。此时**绝不能**退化成"连上任意 Wi-Fi 都去探测门户"——
那有把凭据发给陌生门户的风险。正确行为是：明确告知 + 停止自动认证（第四/五阶段实现）。

---

## 三、真机实测结论②：应用退到后台后，**裸线程的定时器不按预期跑**

第四阶段要做"开机后无感认证"，前提是**应用不可见时**代码还能跑、还能读到 SSID。
所以本阶段顺手做了这个实验（自检第 16 项）：后台线程在 +5/+15/+30/+60 秒各记一条 Logcat
（**直接写 Logcat，不走业务日志链**，否则会把"线程没跑"和"日志没写出去"混在一起）。

实测（同一台机器）：

| 观测 | 结果 |
|---|---|
| 应用启动后按 Home（+15s 应出第一条日志） | 45 秒内**一条都没有** |
| 把应用拉回前台的那一刻 | 日志立刻补出，且 `importance=100`（前台） |
| 屏幕保持常亮再来一次（`svc power stayon true`，`mWakefulness=Awake`、`mStayOn=true`） | 后台 45 秒仍然**没有**日志 |
| 采样改成 +5/+15/+30/+60 四点 | 后台期间四点**全部未落盘** |
| `/sys/fs/cgroup/apps/uid_10297/cgroup.freeze` | `0`（**不是** cgroup 冻结） |
| `dumpsys activity processes`（本进程） | `isFrozen=false`、`curProcState=15`、`cached=false` |

**已经能确定的**：在应用不可见时，裸后台线程/定时器**不可靠**；
而且这不是 cgroup 冻结、也不是屏幕熄灭造成的（两者都排除了）。

**还没定位的**：真正机制（系统对缓存进程的调度/冻结策略的具体触发点）没查清。
**但这不影响设计结论**：第四阶段必须用**前台服务**（带常驻通知）或 WorkManager/AlarmManager
这类系统认可的机制，不能指望裸线程；并且**第四阶段要用前台服务把同一个实验再跑一遍**，
确认那时"定时器能跑 + SSID 读得到"。

> 这条如果反过来（前台服务下也读不到 SSID），Android 端的识别策略就要改（例如改成
> 用门户指纹识别而不是 SSID），所以必须在第四阶段开头就验证，不能拖到最后。

---

## 四、自检（真机 16/16）

| # | 项目 | 结果 |
|---|---|---|
| 1–2 | JS Core 加载与脱敏调用（第二阶段回归） | ✅ |
| 3 | `NetworkCallback` 收到事件并正确分类 | ✅ `WIFI / VALIDATED ssid=YZU-WLAN` |
| 4 | 当前 `Network` 已保存（门户请求绑定用） | ✅ |
| 5 | 读 SSID（两条路径都如实汇报） | ✅ `transportInfo=<unknown ssid>` / `旧接口="YZU-WLAN"` |
| 6 | 校园 Wi-Fi 判断（**配置 → 匹配器 → 真机 SSID 整条链路**） | ✅ 写进配置前 false、写进后 true；读不到 SSID 时必须 false |
| 7 | HTTP 通过指定 Network 可用 | ✅ `HTTP 204`（修掉了 cleartext 被拦的问题） |
| 8 | Probe 四档结论 | ✅ 三个探测点全部 `ONLINE` |
| 9 | 系统信号 vs 自己探测（只对照） | ✅ 两者一致 |
| 10 | Wi-Fi 建议：策略 + API 通路 | ✅ 未配置时 `SKIP_INVALID`，API 往返 `add=0 remove=0` |
| 11 | HTTP 传输已实现（不再是占位） | ✅ |
| 12 | **未抢占用户当前 Wi-Fi**（前后 SSID 一致） | ✅ |
| 13–15 | 配置读写 / Keystore 凭据 / 私有目录无明文（第二阶段回归） | ✅ |
| 16 | 后台调度实验（结果在 Logcat） | 见第三节 |

`NEARBY_WIFI_DEVICES` 与 `ACCESS_FINE_LOCATION` 都必须**同时**授予（第三节的表格）。

---

## 五、产品约束落在哪儿

| 产品约束 | 代码落点 |
|---|---|
| Wi-Fi 关了就什么都不做 | `classifyNetwork` → `NetworkKind.NONE`，上层不动作 |
| 用户连的是别的 Wi-Fi → **绝不抢占** | 只做判断、不做连接：`AndroidPlatform.isCurrentNetworkCampusWifi()`；自检第 12 项锁住"前后 SSID 一致" |
| 读不到 SSID → 不猜、不认证 | `AndroidWifiState.readSsid` 返回 `null`；匹配器判 false；自检第 6 项断言 |
| 用户拒绝 → 不反复骚扰 | 权限只申请一次；`SuggestionPolicy` 冷却 10 分钟 |
| 低占用 / 事件驱动 | 只有 `NetworkCallback` 事件驱动，**没有**任何固定间隔轮询 |

`suggestCampusWifi` 默认 **false**：向系统提交建议有可能让系统从用户当前的 Wi-Fi 切走，
违反"不抢占"，所以必须用户显式打开才会提交。

---

## 六、本阶段明确没做（留给后续）

1. 门户登录 / 凭据提交 / auto-connect 状态机 —— 第五阶段
2. 后台机制（前台服务 / 通知 / 开机自启）—— 第四阶段，且要先复测第三节的实验
3. `AndroidClock` 的 `postDelayed` 在 Doze 下不可靠，长等待要用 WorkManager —— 第四阶段
4. `eportal-http.js` 里纯协议函数与 `node:http` 混在一起（拆分会动 Core，故意延后）
5. AGP 10 会移除 `builtInKotlin`，届时构建配置要重新解决

---

## 七、复现命令

```powershell
# 构建（JBR 是 Java 25）
$env:JAVA_HOME = "D:\Android Studio\jbr"; $env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
cd android; .\gradlew.bat assembleDebug

# 单测（43 项纯逻辑用例）
.\gradlew.bat test

# 真机自检
adb install -r app\build\outputs\apk\debug\app-debug.apk
adb shell pm grant com.campusnet.auto android.permission.NEARBY_WIFI_DEVICES
adb shell pm grant com.campusnet.auto android.permission.ACCESS_FINE_LOCATION
adb shell am start -n com.campusnet.auto/.MainActivity
adb shell uiautomator dump /sdcard/ui.xml; adb shell cat /sdcard/ui.xml
adb logcat -d -s CampusNet     # 后台实验的结果在这里
```
