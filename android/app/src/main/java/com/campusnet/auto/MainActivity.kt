package com.campusnet.auto

import android.content.Intent
import android.content.pm.ApplicationInfo
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.campusnet.auto.js.JsCoreRuntime
import com.campusnet.auto.platform.AndroidConfigStore
import com.campusnet.auto.platform.AndroidCredentialStore
import com.campusnet.auto.platform.AndroidPlatform
import com.campusnet.auto.platform.AppFacts
import com.campusnet.auto.platform.AuthStateHolder
import com.campusnet.auto.platform.AutoAuthController
import com.campusnet.auto.selfcheck.SelfCheck
import com.campusnet.auto.service.CampusAuthService
import com.campusnet.auto.ui.DocKind
import com.campusnet.auto.ui.Docs
import com.campusnet.auto.ui.LogCategory
import com.campusnet.auto.ui.LogStore
import com.campusnet.auto.ui.LogsPage
import com.campusnet.auto.ui.PermissionGate
import com.campusnet.auto.ui.ReadyAction
import com.campusnet.auto.ui.ReadyItem
import com.campusnet.auto.ui.RichText
import com.campusnet.auto.ui.SettingsCallbacks
import com.campusnet.auto.ui.SettingsPage
import com.campusnet.auto.ui.SubPages
import com.campusnet.auto.ui.SystemSettings
import com.campusnet.auto.ui.views.MaxHeightScrollView
import com.campusnet.auto.ui.views.PulseRingView
import com.campusnet.auto.ui.views.RingMode
import com.campusnet.auto.ui.views.TogglePill
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * 新一代 UI 的宿主 Activity（**Light UI + 信息架构收口**）。
 *
 * ## 结构
 *   · 一级页面只有两个：首页 / 设置（底部 Dock 固定两项，处理 navigation bar inset）
 *   · 二级页面：网络与认证状态 / 权限管理 / 连接说明 / 运行准备度 / 账号与认证 / 日志（压栈显示，返回键可退）
 *   · 覆盖层：文档 / 自检结果（**开启确认弹窗已按用户要求删除**：状态与说明都收进设置）
 *
 * ## 自动连接按钮
 *   · 点一下**直接生效**（不再弹三步流程）；开启前先过**必要权限闸门**：
 *     权限/账号不足 → 弹窗提示去设置开启，并终止自动连接，直到必要权限开启（[PermissionGate]）
 *
 * ## 硬约束（本阶段）
 *   · 不碰认证核心与状态机：状态只从 [AuthStateHolder] 读（服务写入）
 *   · 不新增依赖、不用 Compose/Material/WebView
 *   · 系统栏用 **WindowInsets** 处理（targetSdk 35+ 强制 edge-to-edge，不能用固定 margin）
 *   · 保留 adb 入口：`--ez runSelfCheck true`、`--es mockPortal "http://…"`
 */
class MainActivity : AppCompatActivity(), SettingsCallbacks {

    private val uiScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    private lateinit var overlayContainer: FrameLayout
    private lateinit var pageContainer: FrameLayout
    private lateinit var pageHome: View
    private lateinit var pageSettings: View
    private lateinit var settingsPage: SettingsPage
    private lateinit var logsPage: LogsPage
    private lateinit var logsPageView: View

    /** 二级页面栈 */
    private val subPageStack = ArrayDeque<View>()

    /** 授权后需要立刻重建的二级页（都支持"重建内容"） */
    private var readinessPageView: View? = null

    private lateinit var toggle: TogglePill
    private lateinit var ring: PulseRingView
    private lateinit var statusLabel: TextView
    private lateinit var statusDetail: TextView

    private var mockPortalUrl: String? = null
    private var currentPage = 0

    /** 首次启动说明是否正在显示（返回键要特殊处理：不能让用户绕过阅读） */
    private var firstLaunchVisible = false

    /** 首次启动说明是否被真正滚动过（用于区分"一屏放得下"与"布局还没算完"） */
    private var everScrolled = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        LogStore.init(applicationContext)
        mockPortalUrl = intent?.getStringExtra(EXTRA_MOCK_PORTAL)

        overlayContainer = findViewById(R.id.overlayContainer)
        pageContainer = findViewById(R.id.pageContainer)

        // ★ 系统栏 inset（edge-to-edge 下必须显式处理；不写死 margin）
        applyWindowInsets()

        val inflater = LayoutInflater.from(this)
        pageHome = inflater.inflate(R.layout.page_home, pageContainer, false)
        pageSettings = inflater.inflate(R.layout.page_settings, pageContainer, false)
        pageContainer.addView(pageHome)
        pageContainer.addView(pageSettings)

        bindHome()
        settingsPage = SettingsPage(this, pageSettings, this)
        logsPageView = inflater.inflate(R.layout.page_logs, pageContainer, false)
        logsPageView.findViewById<View>(R.id.backHeader).setOnClickListener { popSubPage() }
        logsPage = LogsPage(this, logsPageView)

        bindNav()
        showPage(0, animate = false)

        uiScope.launch { AuthStateHolder.state.collect { renderHome(it) } }

        if (intent?.getBooleanExtra(EXTRA_RUN_SELFCHECK, false) == true) runSelfCheck()

        // ★ 首次启动说明：只在第一次打开时显示（读完并点确认后才置位，见 showFirstLaunchGuide）
        maybeShowFirstLaunchGuide()
    }

    override fun onResume() {
        super.onResume()
        // ★ 权限闸门兜底：已经开着自动连接、但必要条件后来没了（权限被撤销 / 定位被关）
        //   → 终止自动连接 + 提示去设置，直到必要权限开启
        if (AutoAuthController.isEnabled(this)) PermissionGate.enforce(this, ::goFixBlocking)
        refreshAll()
        refreshAttachedSubPages()
        // 自动认证开着且凭据齐全时，服务就该在跑（幂等）
        AutoAuthController.syncWithPolicy(this)
    }

    override fun onDestroy() {
        uiScope.cancel()
        super.onDestroy()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        refreshAll()
        // 授权回来后，正开着的权限页 / 准备度页要立刻反映真实状态
        refreshAttachedSubPages()
    }

    /** 二级页面是"重建内容"式的（幂等），所以刷新 = 再 bind 一次 */
    private fun refreshAttachedSubPages() {
        readinessPageView?.let { if (it.parent != null) SubPages.bindReadiness(this, it, ::handleReadyAction) }
    }

    // ────────────────────────────────────────────────────────────────
    // 系统栏 / 导航 / 二级页面
    // ────────────────────────────────────────────────────────────────

    private fun applyWindowInsets() {
        val root = findViewById<View>(R.id.root)
        val content = findViewById<View>(R.id.pageContainer)
        val nav = findViewById<View>(R.id.bottomNav)
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val top = insets.getSystemWindowInsetTop()
            val bottom = insets.getSystemWindowInsetBottom()
            content.setPadding(0, top, 0, 0)
            // 覆盖层也一样：文档弹窗与首次启动说明都不能被系统栏压住
            overlayContainer.setPadding(0, top, 0, bottom)
            // ★ Dock：系统导航栏的 inset **加到 Dock 自身高度上**，内容高度恒定不变。
            //   早先是"固定 58dp + 把 inset 作为底部 padding"：inset 一大（三键导航 / 手势条高的机型），
            //   可用内容高度就被挤到只剩几 dp，图标和文字被裁掉 —— 用户报的"字符展示不全"。
            val lp = nav.layoutParams
            val targetHeight = dp(DOCK_BASE_DP) + bottom
            if (lp.height != targetHeight) {
                lp.height = targetHeight
                nav.layoutParams = lp
            }
            nav.setPadding(nav.paddingLeft, nav.paddingTop, nav.paddingRight, bottom)
            insets
        }
        androidx.core.view.ViewCompat.requestApplyInsets(root)
    }

    private fun bindNav() {
        findViewById<View>(R.id.navHome).setOnClickListener { popAllSubPages(); showPage(0) }
        findViewById<View>(R.id.navSettings).setOnClickListener { popAllSubPages(); showPage(1) }
    }

    private fun showPage(index: Int, animate: Boolean = true) {
        val pages = listOf(pageHome, pageSettings)
        val ids = listOf(R.id.navHome to R.id.navHomeIcon, R.id.navSettings to R.id.navSettingsIcon)
        val labels = listOf(R.id.navHomeText, R.id.navSettingsText)
        pages.forEachIndexed { i, page ->
            val visible = i == index
            page.visibility = if (visible) View.VISIBLE else View.GONE
            val icon = findViewById<ImageView>(ids[i].second)
            val label = findViewById<TextView>(labels[i])
            val color = ContextCompat.getColor(this, if (visible) R.color.nav_selected else R.color.nav_unselected)
            icon.setColorFilter(color)
            label.setTextColor(color)
            findViewById<View>(ids[i].first)
                .setBackgroundResource(if (visible) R.drawable.bg_nav_selected else R.drawable.bg_row)
        }
        if (animate) {
            pages[index].apply {
                alpha = 0f
                translationY = 10f * resources.displayMetrics.density
                animate().alpha(1f).translationY(0f).setDuration(250).start()
            }
        }
        currentPage = index
        if (index == 1) settingsPage.refresh()
    }

    private fun pushSubPage(view: View) {
        subPageStack.addLast(view)
        pageContainer.addView(view)
        view.alpha = 0f
        view.animate().alpha(1f).setDuration(220).start()
        setDockVisible(false)
    }

    private fun popSubPage() {
        val top = subPageStack.removeLastOrNull() ?: return
        if (top === readinessPageView) readinessPageView = null
        pageContainer.removeView(top)
        if (subPageStack.isEmpty()) setDockVisible(true)
    }

    private fun popAllSubPages() {
        while (subPageStack.isNotEmpty()) popSubPage()
    }

    private fun setDockVisible(visible: Boolean) {
        val v = if (visible) View.VISIBLE else View.GONE
        findViewById<View>(R.id.bottomNav).visibility = v
        findViewById<View>(R.id.navDivider).visibility = v
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        when {
            // ⚠ 首次启动说明没读完时：允许返回（把应用退到后台），但**不完成引导**
            //   —— 下次打开还会出现，不能用返回键绕过阅读
            firstLaunchVisible -> moveTaskToBack(true)
            overlayContainer.visibility == View.VISIBLE -> hideOverlay()
            subPageStack.isNotEmpty() -> popSubPage()
            else -> super.onBackPressed()
        }
    }

    private fun openSubPage(titleRes: Int, layoutRes: Int = R.layout.page_sub, bind: (View) -> Unit) {
        val view = LayoutInflater.from(this).inflate(layoutRes, pageContainer, false)
        view.findViewById<View>(R.id.backHeader).setOnClickListener { popSubPage() }
        view.findViewById<TextView>(R.id.pageTitle).setText(titleRes)
        bind(view)
        pushSubPage(view)
    }

    // ────────────────────────────────────────────────────────────────
    // 首页
    // ────────────────────────────────────────────────────────────────

    private fun bindHome() {
        toggle = pageHome.findViewById(R.id.toggleAutoAuth)
        ring = pageHome.findViewById(R.id.pulseRing)
        statusLabel = pageHome.findViewById(R.id.statusLabel)
        statusDetail = pageHome.findViewById(R.id.statusDetail)

        // 只上报意图，真正的启用/关闭都在下面这套逻辑里（含必要权限闸门）
        toggle.onToggleRequest = { desired -> onToggleRequested(desired) }
        // 按钮文字按要求统一为"自动连接"
        toggle.onText = getString(R.string.ui_toggle_label)
        toggle.offText = getString(R.string.ui_toggle_label)
        // ⚠ 定位语与提示句已按用户要求删掉：首页只有"应用名 + 状态 + 按钮"
    }

    private fun refreshAll() {
        val facts = AppFacts(this).collect()
        AuthStateHolder.refreshStaticFacts(
            autoAuthEnabled = facts.autoAuthEnabled,
            hasCredentials = facts.hasCredentials,
            hasCampusRule = facts.hasCampusRule,
            ssid = facts.ssid,
            ssidPermissionGranted = facts.ssidPermissionGranted,
            isCampusWifi = facts.isCampusWifi,
            networkKind = if (facts.networkAvailable) "WIFI" else "NONE",
            validation = "UNVERIFIED",
            netState = AuthStateHolder.state.value.netState,
            blockMessage = AuthStateHolder.state.value.blockMessage,
        )
        renderHome(AuthStateHolder.state.value)
        if (currentPage == 1) settingsPage.refresh()
    }

    private data class VisualState(
        val labelRes: Int,
        val descRes: Int,
        val ring: RingMode,
        val colorRes: Int,
    )

    /** 首页状态只做**映射**：事实全部来自服务写入的真实状态 */
    private fun visualFor(ui: AuthStateHolder.UiState): VisualState {
        val phase = ui.phase
        return when {
            ui.serviceRunning && phase == "STOPPED" ->
                VisualState(R.string.ui_state_service_error, R.string.ui_state_service_error_desc, RingMode.ATTENTION, R.color.danger)

            !ui.serviceRunning ->
                VisualState(R.string.ui_state_service_stopped, R.string.ui_state_service_stopped_desc, RingMode.STOPPED, R.color.text_secondary)

            !ui.ssidPermissionGranted ->
                VisualState(R.string.ui_state_permission, R.string.ui_state_permission_desc, RingMode.ATTENTION, R.color.warn)

            !ui.hasCredentials ->
                VisualState(R.string.ui_state_no_credentials, R.string.ui_state_no_credentials_desc, RingMode.ATTENTION, R.color.warn)

            phase == "NEEDS_ATTENTION" ->
                VisualState(R.string.ui_state_auth_failed, R.string.ui_state_auth_failed_desc, RingMode.ATTENTION, R.color.danger)

            ui.netState == "NO_LINK" ->
                VisualState(R.string.ui_state_waiting_network, R.string.ui_state_waiting_network_desc, RingMode.WAITING, R.color.text_secondary)

            phase == "CONNECTING" ->
                VisualState(R.string.ui_state_authenticating, R.string.ui_state_authenticating_desc, RingMode.AUTHENTICATING, R.color.accent)

            phase == "CHECKING" ->
                VisualState(R.string.ui_state_checking, R.string.ui_state_checking_desc, RingMode.CHECKING, R.color.accent)

            ui.netState == "ONLINE" && ui.lastLoginSuccess == true ->
                VisualState(R.string.ui_state_authenticated, R.string.ui_state_authenticated_desc, RingMode.AUTHENTICATED, R.color.ok)

            ui.netState == "ONLINE" ->
                VisualState(R.string.ui_state_online, R.string.ui_state_online_desc, RingMode.ONLINE, R.color.ok)

            ui.netState == "PORTAL" && ui.isCampusWifi ->
                VisualState(R.string.ui_state_campus_detected, R.string.ui_state_campus_detected_desc, RingMode.CHECKING, R.color.accent)

            ui.hasCampusRule && !ui.isCampusWifi && ui.networkKind == "WIFI" ->
                VisualState(R.string.ui_state_not_campus, R.string.ui_state_not_campus_desc, RingMode.WAITING, R.color.text_secondary)

            phase == "PAUSED" || phase == "RETRY_WAIT" ->
                VisualState(R.string.ui_state_auth_failed, R.string.ui_state_auth_failed_desc, RingMode.ATTENTION, R.color.warn)

            else ->
                VisualState(R.string.ui_state_waiting_network, R.string.ui_state_waiting_network_desc, RingMode.WAITING, R.color.text_secondary)
        }
    }

    private fun renderHome(ui: AuthStateHolder.UiState) {
        val visual = visualFor(ui)
        statusLabel.setText(visual.labelRes)
        statusLabel.setTextColor(ContextCompat.getColor(this, visual.colorRes))
        ring.mode = visual.ring
        // ⚠ **…** 要真的加粗（RichText），否则界面上会直接显示星号（用户报的 bug）
        statusDetail.text = RichText.bold(buildString {
            append(getString(visual.descRes))
            ui.blockMessage?.let { append("\n").append(it) }
        })
        toggle.setChecked(ui.autoAuthEnabled)
    }

    // ────────────────────────────────────────────────────────────────
    // 开关 → 直接生效（**不再弹三步流程**，用户要求删掉弹出说明）
    // ────────────────────────────────────────────────────────────────

    private fun onToggleRequested(desired: Boolean) {
        val facts = AppFacts(this).collect()
        if (facts.autoAuthEnabled == desired) {
            toggle.setChecked(desired)
            return
        }
        if (desired) enableAutoConnect() else disableAutoConnect()
    }

    /**
     * 开启自动连接。
     *
     * ★ 开启前的**必要权限闸门**（用户要求）：
     *   权限/账号不足时**不开**，弹窗提示去设置开启，并**终止自动连接**，
     *   直到必要权限开启（闸门在 [PermissionGate] 里统一实现，onResume 也会兜一次）。
     */
    private fun enableAutoConnect() {
        if (!PermissionGate.enforce(this, ::goFixBlocking)) {
            toggle.setChecked(false) // 闸门没过：开关留在关闭
            refreshAll()
            return
        }
        val policy = AutoAuthController.setEnabled(this, true)
        LogStore.append(LogCategory.SERVICE, "用户开启自动连接", policy.message)
        toggle.setChecked(true)
        refreshAll()
        toast(policy.message)
    }

    private fun disableAutoConnect() {
        val policy = AutoAuthController.setEnabled(this, false)
        LogStore.append(LogCategory.SERVICE, "已关闭自动连接", policy.message)
        toggle.setChecked(false)
        refreshAll()
        toast(getString(R.string.ui_toggle_off))
    }

    /** 闸门提示里点了「去设置开启」/「去填写账号」 */
    private fun goFixBlocking(items: List<ReadyItem>) {
        // 权限管理页已删除：权限就在「运行准备度」里处理（必需项 + 建议项都在那一页）
        if (PermissionGate.onlyAccountMissing(items)) onGoAccountForm() else onOpenReadinessPage()
    }

    /**
     * 「运行准备度」页里的动作按钮 → 真实系统页面。
     * （说明与准备度都移到设置里了，所以这里只剩"去处理"这一件事。）
     */
    private fun handleReadyAction(action: ReadyAction) {
        when (action) {
            ReadyAction.ACCOUNT -> onGoAccountForm()
            ReadyAction.AUTOSTART -> {
                if (SystemSettings.autostart(this) == null) {
                    toast(getString(R.string.ui_ready_no_page))
                    SystemSettings.appDetails(this)
                }
            }

            else -> com.campusnet.auto.ui.PermissionsActions.handle(this, action)
        }
    }

    // ────────────────────────────────────────────────────────────────
    // 首次启动说明（只在第一次打开时显示；读完才能继续）
    // ────────────────────────────────────────────────────────────────

    private fun maybeShowFirstLaunchGuide() {
        val store = AndroidConfigStore(this, AndroidCredentialStore(this))
        if (store.isFirstLaunchCompleted()) return
        showFirstLaunchGuide(store)
    }

    /**
     * 显示首次启动说明。
     *
     * 约束（用户要求，逐条实现）：
     *   · **只在第一次**：`firstLaunchCompleted` 为 true 就永不显示（Activity 重建、Service 重启、
     *     后台恢复都不会重复出现；清除应用数据/重装后重新出现）
     *   · **必须读完**：正文滚到底之前按钮是 disabled 的「请阅读完整内容」
     *   · **不能绕过**：点空白无效（无点击监听）、返回键只把应用退到后台且**不置位**、
     *     没有延时自动完成、没有默认勾选
     */
    private fun showFirstLaunchGuide(store: AndroidConfigStore) {
        val view = LayoutInflater.from(this).inflate(R.layout.view_first_launch, overlayContainer, false)
        overlayContainer.removeAllViews()
        overlayContainer.addView(view)
        overlayContainer.visibility = View.VISIBLE
        overlayContainer.alpha = 0f
        overlayContainer.animate().alpha(1f).setDuration(200).start()
        firstLaunchVisible = true

        // 文案里的 **…** 渲染成真正的加粗（与首页状态、文档正文一致）
        view.findViewById<TextView>(R.id.firstLaunchBodyYes).text =
            RichText.bold(getString(R.string.ui_first_when_yes_body))
        view.findViewById<TextView>(R.id.firstLaunchBodyNo).text =
            RichText.bold(getString(R.string.ui_first_when_no_body))
        view.findViewById<TextView>(R.id.firstLaunchNever).text =
            RichText.bold(getString(R.string.ui_first_never))
        view.findViewById<TextView>(R.id.firstLaunchBodySteps).text =
            RichText.bold(getString(R.string.ui_first_steps_body))
        view.findViewById<TextView>(R.id.firstLaunchBodyStates).text =
            RichText.bold(getString(R.string.ui_first_states_body))

        val scroll = view.findViewById<MaxHeightScrollView>(R.id.firstLaunchScroll)
        // 高度上限 = 屏高的 45%：小屏（360dp 宽、约 640dp 高）也不会把底部按钮挤出屏幕，
        // 同时保证正文一定需要滚动（"必须滚到底"才有意义）
        scroll.maxHeightPx = (resources.displayMetrics.heightPixels * 0.45f).toInt()

        val button = view.findViewById<Button>(R.id.firstLaunchContinue)

        /** 单次测量是否"内容本来就一屏放得下"（值必须 > 0，避免量到 0 的中间态） */
        fun contentFitsWithoutScrolling(): Boolean {
            val content = scroll.getChildAt(0)?.height ?: return false
            if (content <= 0 || scroll.height <= 0) return false
            // 高度上限没生效 = 卡片比上限矮 = 内容确实装得下；
            // 上限生效（height == maxHeightPx）时即使这一刻量到的 content 偏小也不算数
            return content <= scroll.height && scroll.height < scroll.maxHeightPx
        }

        /** 一刻的判定结果；必须**连续两次**（间隔 ≥300ms）都成立才放行 */
        fun verdictNow(): Boolean {
            if (scroll.height <= 0) return false
            if (scroll.getChildAt(0)?.height?.let { it > 0 } != true) return false
            // 还能往下滚 = 没读完
            if (scroll.canScrollVertically(1)) return false
            // 没滚过又不是"本来装得下" = 布局中间态，不算读完
            return everScrolled || contentFitsWithoutScrolling()
        }

        var lastVerdictAt = 0L
        val evaluate = object : Runnable {
            override fun run() {
                if (button.isEnabled) return
                if (!verdictNow()) {
                    lastVerdictAt = 0L
                    return
                }
                val now = android.os.SystemClock.uptimeMillis()
                if (lastVerdictAt == 0L || now - lastVerdictAt < 300L) {
                    // 第一次成立：等布局/测量稳定后再确认一次，防止一次瞬态测量把按钮放开
                    lastVerdictAt = now
                    scroll.postDelayed(this, 320L)
                    return
                }
                button.isEnabled = true
                button.setText(R.string.ui_first_read_done)
                button.setTextColor(android.graphics.Color.WHITE)
                button.contentDescription = getString(R.string.ui_first_read_done)
            }
        }

        fun scheduleEvaluate(delayMs: Long) {
            scroll.removeCallbacks(evaluate)
            scroll.postDelayed(evaluate, delayMs)
        }

        scroll.setOnScrollChangeListener { _, _, _, _, _ ->
            everScrolled = true
            scheduleEvaluate(0L)
        }
        // ⚠ 不能只看一次测量：
        //   · 用 scroll.post 时布局还没算完，canScrollVertically(1) 会返回 false（按钮一进来就可点）
        //   · 重排/息屏亮屏等瞬态里子 View 高度可能短暂偏小，单次判定同样会误放行
        //   所以：全局布局变化 → 延迟复核 → 连续两次成立才解禁。
        scroll.viewTreeObserver.addOnGlobalLayoutListener(object :
            android.view.ViewTreeObserver.OnGlobalLayoutListener {
            override fun onGlobalLayout() {
                scheduleEvaluate(120L)
                if (button.isEnabled) {
                    runCatching { scroll.viewTreeObserver.removeOnGlobalLayoutListener(this) }
                }
            }
        })

        button.setOnClickListener {
            if (!button.isEnabled) return@setOnClickListener
            store.setFirstLaunchCompleted(true)
            firstLaunchVisible = false
            LogStore.append(LogCategory.SERVICE, "已阅读首次启动说明")
            hideOverlay()
        }
    }

    // ────────────────────────────────────────────────────────────────
    // 覆盖层（文档 / 自检）
    // ────────────────────────────────────────────────────────────────

    private fun showDoc(kind: DocKind) {
        val version = runCatching {
            packageManager.getPackageInfo(packageName, 0).versionName ?: "?"
        }.getOrDefault("?")
        val view = LayoutInflater.from(this).inflate(R.layout.view_doc, overlayContainer, false)
        overlayContainer.removeAllViews()
        overlayContainer.addView(view)
        overlayContainer.visibility = View.VISIBLE

        // ★ 弹窗高度压到屏幕的 45%（用户反馈：上下太长）——内容短就按内容高，长就内部滚动
        view.findViewById<MaxHeightScrollView>(R.id.docScroll).maxHeightPx =
            (resources.displayMetrics.heightPixels * 0.45f).toInt()

        val debugBuild = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        view.findViewById<TextView>(R.id.docTitle).setText(
            when (kind) {
                DocKind.PRIVACY -> R.string.ui_doc_privacy_title
                DocKind.TERMS -> R.string.ui_doc_terms_title
                DocKind.SDK -> R.string.ui_doc_sdk_title
                DocKind.OPEN_SOURCE -> R.string.ui_doc_opensource_title
                DocKind.ABOUT -> R.string.ui_doc_about_title
            }
        )
        // ★ **…** 渲染成真正的加粗（否则界面上会直接显示星号）
        val body = when (kind) {
            DocKind.PRIVACY -> Docs.privacy(this, version)
            DocKind.TERMS -> Docs.terms(this)
            DocKind.SDK -> Docs.sdkDisclosure(this)
            DocKind.OPEN_SOURCE -> Docs.openSource(this)
            DocKind.ABOUT -> Docs.about(this, version, debugBuild)
        }
        view.findViewById<TextView>(R.id.docBody).text = RichText.bold(body)
        view.findViewById<Button>(R.id.docClose).setOnClickListener { hideOverlay() }
    }

    private fun showModal(title: String, body: String) {
        val view = LayoutInflater.from(this).inflate(R.layout.view_modal_text, overlayContainer, false)
        overlayContainer.removeAllViews()
        overlayContainer.addView(view)
        overlayContainer.visibility = View.VISIBLE
        view.findViewById<TextView>(R.id.modalTitle).text = title
        view.findViewById<TextView>(R.id.modalBody).text = body
        view.findViewById<Button>(R.id.modalClose).setOnClickListener { hideOverlay() }
    }

    private fun hideOverlay() {
        val view = overlayContainer.getChildAt(0)
        if (view == null) {
            overlayContainer.visibility = View.GONE
            return
        }
        view.animate().alpha(0f).setDuration(160).withEndAction {
            overlayContainer.removeAllViews()
            overlayContainer.visibility = View.GONE
        }.start()
    }

    /** 自检：保留原能力（adb 入口 + 界面展示），不参与日常 UI */
    private fun runSelfCheck() {
        showModal("运行自检", "自检运行中…（31 项）")
        Thread {
            val lines = mutableListOf<String>()
            val js = JsCoreRuntime(applicationContext)
            val platform = AndroidPlatform(applicationContext) { text -> redactViaJs(js, text) }
            try {
                val items = kotlinx.coroutines.runBlocking {
                    SelfCheck(applicationContext, mockPortalUrl).run(js, platform)
                }
                var pass = 0
                for (item in items) {
                    if (item.passed) pass++
                    lines += (if (item.passed) "✅ " else "❌ ") + item.name
                    lines += "     " + item.detail
                    android.util.Log.i(
                        "CampusNet",
                        "[自检] " + (if (item.passed) "PASS " else "FAIL ") + item.name + " ｜ " + item.detail,
                    )
                }
                lines += ""
                lines += "通过 $pass / ${items.size}"
                LogStore.append(LogCategory.SERVICE, "自检完成：通过 $pass / ${items.size}")
                android.util.Log.i("CampusNet", "[自检] 汇总：通过 $pass / ${items.size}")
            } catch (e: Throwable) {
                lines += "❌ 自检异常: $e"
            } finally {
                runCatching { platform.connectivity.stopMonitoring() }
                runCatching { js.close() }
            }
            runOnUiThread {
                overlayContainer.findViewById<TextView>(R.id.modalBody)?.text = lines.joinToString("\n")
            }
        }.start()
    }

    private fun redactViaJs(js: JsCoreRuntime, text: String): String = try {
        kotlinx.coroutines.runBlocking {
            js.loadModule("src/shared/redact.js")
            if (js.evalToString("typeof __redact") != "function") {
                js.loadScriptAsset("js/android-runtime.js")
            }
            js.evalToString("__redact(${JSONObject.quote(text)})")
        } ?: ""
    } catch (e: Throwable) {
        ""
    }

    // ────────────────────────────────────────────────────────────────
    // SettingsCallbacks
    // ────────────────────────────────────────────────────────────────

    /** ★ 网络与认证状态：从首页移进设置的**独立一项**（两个状态合成一页） */
    override fun onOpenStatusPage() {
        openSubPage(R.string.ui_page_status) { SubPages.bindStatus(this, it) }
    }

    /** ★ 连接说明：原来点自动连接按钮时弹出来的第一步，现在只在设置里 */
    override fun onOpenEnableNotes() {
        openSubPage(R.string.ui_settings_enable_notes) { SubPages.bindEnableNotes(this, it) }
    }

    /** ★ 运行准备度：原来在开启弹窗的第二步，现在只在设置里 */
    override fun onOpenReadinessPage() {
        readinessPageView = null
        openSubPage(R.string.ui_enable_readiness) { view ->
            SubPages.bindReadiness(this, view, ::handleReadyAction)
            readinessPageView = view
        }
    }

    /** 准备度页里点「账号与密码」→ 回设置页并直接展开账号表单 */
    override fun onGoAccountForm() {
        popAllSubPages()
        showPage(1)
        settingsPage.openAccountForm()
        toast(getString(R.string.ui_gate_account_toast))
    }

    override fun onOpenLogs() {
        logsPage.refresh()
        // 日志页现在是二级页面：压栈显示（同一个实例，避免重复 inflate）
        pushSubPage(logsPageView)
    }

    override fun onOpenDoc(kind: DocKind) {
        // 声明类文档直接以覆盖层打开（"关于"这一层已按需求去掉，设置页里直接平铺）
        showDoc(kind)
    }

    // ────────────────────────────────────────────────────────────────

    private fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_SHORT).show()

    private fun dp(v: Float): Int = (v * resources.displayMetrics.density).toInt()

    private companion object {
        const val EXTRA_MOCK_PORTAL = "mockPortal"
        const val EXTRA_RUN_SELFCHECK = "runSelfCheck"

        /** 底部 Dock 的**基准**高度（dp）：必须与 activity_main.xml 里 bottomNav 的高度一致 */
        const val DOCK_BASE_DP = 68f
    }
}
