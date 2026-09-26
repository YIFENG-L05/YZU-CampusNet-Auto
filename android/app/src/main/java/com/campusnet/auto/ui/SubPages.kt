package com.campusnet.auto.ui

import android.text.InputType
import android.view.LayoutInflater
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.campusnet.auto.R
import com.campusnet.auto.core.CampusRuleInput
import com.campusnet.auto.core.CampusRuleKind
import com.campusnet.auto.core.CredentialStore
import com.campusnet.auto.platform.AndroidConfigStore
import com.campusnet.auto.platform.AndroidCredentialStore
import com.campusnet.auto.platform.AppFacts
import com.campusnet.auto.platform.AuthStateHolder
import com.campusnet.auto.platform.AutoAuthController
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 二级页面（网络状态 / 认证状态 / 权限管理 / 账号与认证）。
 *
 * ## 设计约束
 *   · **只读现有真实数据**：`AuthStateHolder`（服务写入）、`AppFacts`（配置事实）、
 *     `ReadinessProbe`（真实权限状态）、`LogStore`（真实日志）。页面自己不算业务、不造状态。
 *   · **写入只调用现有能力**：账号密码走 `AndroidCredentialStore`（Keystore），
 *     规则/服务走 `CampusConfigStore` + `CampusRuleInput`（与原有设置页**同一套**），
 *     保存后调 `AutoAuthController.notifyConfigChanged` 让服务立刻用新配置。
 *   · 没有数据就显示"暂无数据"，绝不编造（延迟这类没有测量的字段直接不显示）。
 *
 * 所有页面共用 `page_sub.xml` 外壳（返回头 + 标题 + 内容容器），内容在代码里组装，
 * 避免为每个页面再写一份几乎相同的 XML。
 */
object SubPages {

    // ⚠ 这里**不能**写 `const val CARD = R.drawable.bg_glass_card`：
    //   R 字段不是编译期常量，用 const 会把当时的数值**内联**进字节码，
    //   资源 id 变化后就会去查一个不存在的 id → Resources$NotFoundException: Resource ID #0x0
    //   （真机上"权限管理 / 账号与认证 一点就闪退"就是这个原因。）
    private val CARD = R.drawable.bg_glass_card
    private val INNER = R.drawable.bg_glass_inner

    // ────────────────────────────────────────────────────────────────
    // 通用构件
    // ────────────────────────────────────────────────────────────────

    fun create(activity: AppCompatActivity, titleRes: Int, onBack: () -> Unit): View {
        val view = LayoutInflater.from(activity).inflate(R.layout.page_sub, null, false)
        view.findViewById<TextView>(R.id.pageTitle).setText(titleRes)
        view.findViewById<View>(R.id.backHeader).setOnClickListener { onBack() }
        return view
    }

    private fun body(view: View): LinearLayout =
        view.findViewById<LinearLayout>(R.id.pageBody) as? LinearLayout
            ?: (view as? LinearLayout ?: LinearLayout(view.context))

    /** 一个白卡容器（防御式：任何一步拿不到都不应让页面崩） */
    private fun card(activity: AppCompatActivity, body: LinearLayout): LinearLayout {
        val c = LinearLayout(activity)
        c.orientation = LinearLayout.VERTICAL
        ContextCompat.getDrawable(activity, CARD)?.let { drawable -> c.background = drawable }
        val pad = dp(activity, 6)
        c.setPadding(0, pad, 0, pad)
        val lp = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        )
        lp.bottomMargin = dp(activity, 14)
        body.addView(c, lp)
        return c
    }

    /** "标签 —— 值"信息行（不可点击） */
    private fun infoRow(activity: AppCompatActivity, parent: LinearLayout, label: String, value: String) {
        val row = LayoutInflater.from(activity).inflate(R.layout.item_setting_row, parent, false)
        row.findViewById<TextView>(R.id.rowTitle).text = label
        row.findViewById<TextView>(R.id.rowValue).text = value
        row.findViewById<ImageView>(R.id.rowChevron).visibility = View.INVISIBLE
        row.isClickable = false
        row.isFocusable = false
        parent.addView(row)
    }

    /**
     * 竖排"标签 + 长文本"行。
     *
     * ⚠ 为什么需要它（真机复验发现）：[infoRow] 是"标题 + 右侧值"的横排布局，
     *   值一长（例如一整句判断原因）就会把标题那一列挤成 0 宽 —— 标题直接看不见。
     *   长句一律用这个竖排布局。
     */
    private fun stackedRow(
        activity: AppCompatActivity,
        parent: LinearLayout,
        label: String,
        value: String,
    ) {
        val box = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(activity, 14), dp(activity, 10), dp(activity, 14), dp(activity, 10))
        }
        box.addView(TextView(activity).apply {
            text = label
            setTextColor(ContextCompat.getColor(activity, R.color.text_secondary))
            textSize = 13f
        })
        box.addView(TextView(activity).apply {
            text = value
            setTextColor(ContextCompat.getColor(activity, R.color.text_tertiary))
            textSize = 12f
            setPadding(0, dp(activity, 2), 0, 0)
        })
        parent.addView(box, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ))
    }

    private fun sectionTitle(activity: AppCompatActivity, body: LinearLayout, text: String) {
        body.addView(TextView(activity).apply {
            this.text = text
            setTextColor(ContextCompat.getColor(activity, R.color.text_tertiary))
            textSize = 12f
            setPadding(dp(activity, 4), dp(activity, 4), 0, dp(activity, 6))
        })
    }

    private fun dp(activity: AppCompatActivity, v: Int): Int =
        (v * activity.resources.displayMetrics.density).toInt()

    private fun timeText(at: Long?): String =
        if (at == null) "" else SimpleDateFormat("MM-dd HH:mm", Locale.US).format(Date(at))

    // ────────────────────────────────────────────────────────────────
    // 网络与认证状态（本轮从首页移进设置，**独立成设置里的单独一项**）
    // ────────────────────────────────────────────────────────────────

    /**
     * 网络状态 + 认证状态**合成一个页面**（设置里的一项「网络与认证状态」）。
     *
     * 之所以合成一页：用户要的是"在设置里有一个独立的地方看状态"，
     * 而不是把首页那两个入口原样搬到设置里、再分成两跳。
     */
    fun bindStatus(activity: AppCompatActivity, view: View) {
        val root = body(view)
        root.removeAllViews()

        sectionTitle(activity, root, activity.getString(R.string.ui_page_network))
        val netCard = card(activity, root)
        netCard.removeAllViews()
        fillNetworkStatus(activity, netCard)

        sectionTitle(activity, root, activity.getString(R.string.ui_page_auth))
        val authCard = card(activity, root)
        authCard.removeAllViews()
        fillAuthStatus(activity, authCard)
    }

    // ────────────────────────────────────────────────────────────────
    // 网络状态
    // ────────────────────────────────────────────────────────────────

    fun bindNetworkStatus(activity: AppCompatActivity, view: View) {
        val parent = card(activity, body(view).also { it.removeAllViews() })
        parent.removeAllViews()
        fillNetworkStatus(activity, parent)
    }

    private fun fillNetworkStatus(activity: AppCompatActivity, parent: LinearLayout) {
        val ui = AuthStateHolder.state.value
        val facts = AppFacts(activity).collect()

        infoRow(activity, parent, activity.getString(R.string.ui_net_wifi_label),
            ui.ssid ?: facts.ssid ?: activity.getString(R.string.ui_net_unavailable))
        infoRow(activity, parent, activity.getString(R.string.ui_net_campus_label), when {
            !facts.hasCampusRule -> activity.getString(R.string.ui_value_not_configured)
            ui.isCampusWifi -> activity.getString(R.string.ui_net_campus_yes)
            else -> activity.getString(R.string.ui_net_campus_no)
        })
        infoRow(activity, parent, activity.getString(R.string.ui_net_portal_label), when (ui.netState) {
            "PORTAL" -> activity.getString(R.string.ui_net_portal_needed)
            "ONLINE" -> activity.getString(R.string.ui_net_portal_passed)
            else -> activity.getString(R.string.ui_net_unavailable)
        })
        infoRow(activity, parent, activity.getString(R.string.ui_net_internet_label), when (ui.netState) {
            "ONLINE" -> activity.getString(R.string.ui_net_internet_online)
            "PORTAL", "NO_LINK" -> activity.getString(R.string.ui_net_internet_offline)
            else -> activity.getString(R.string.ui_net_unavailable)
        })
        // 最近检查时间来自真实状态（服务每次检测都会更新）
        infoRow(
            activity, parent, activity.getString(R.string.ui_net_last_check),
            ui.lastCheckAt?.let { timeText(it) } ?: activity.getString(R.string.ui_net_unavailable),
        )
        // ⚠ 不显示延迟：当前探测只判定通/不通，没有 RTT 数据（用户要求 §5）
    }

    // ────────────────────────────────────────────────────────────────
    // 认证状态
    // ────────────────────────────────────────────────────────────────

    fun bindAuthStatus(activity: AppCompatActivity, view: View) {
        val parent = card(activity, body(view).also { it.removeAllViews() })
        parent.removeAllViews()
        fillAuthStatus(activity, parent)
    }

    private fun fillAuthStatus(activity: AppCompatActivity, parent: LinearLayout) {
        val ui = AuthStateHolder.state.value
        val facts = AppFacts(activity).collect()

        infoRow(activity, parent, activity.getString(R.string.ui_auth_account_label),
            facts.account ?: activity.getString(R.string.ui_auth_masked))
        infoRow(activity, parent, activity.getString(R.string.ui_auth_service_label),
            facts.operatorLabel ?: activity.getString(R.string.ui_value_unknown))
        infoRow(activity, parent, activity.getString(R.string.ui_auth_last_label),
            timeText(ui.lastLoginAt).ifEmpty { activity.getString(R.string.ui_net_unavailable) })
        infoRow(activity, parent, activity.getString(R.string.ui_auth_result_label), when (ui.lastLoginSuccess) {
            true -> activity.getString(R.string.ui_auth_result_ok)
            false -> activity.getString(R.string.ui_auth_result_fail)
            null -> activity.getString(R.string.ui_net_unavailable)
        })
        infoRow(activity, parent, activity.getString(R.string.ui_auth_error_label),
            ui.lastError ?: activity.getString(R.string.ui_auth_no_error))
    }

    // ────────────────────────────────────────────────────────────────
    // 连接说明（本轮从「点击自动连接」的弹窗里移出来）
    // ────────────────────────────────────────────────────────────────

    /**
     * **使用规则**（设置 → 使用规则）：完整版说明。
     *
     * 与首次启动说明的分工（用户要求，不要重复）：
     *   · 首次启动弹窗：只讲「什么时候会连 / 不会连 / 怎么用」（精简）
     *   · 这一页：完整规则 —— 自动连接逻辑、自动认证逻辑、Wi-Fi 切换规则、Android 限制、
     *     校园网兼容性、排查步骤
     */
    fun bindEnableNotes(activity: AppCompatActivity, view: View) {
        val root = body(view)
        root.removeAllViews()

        // ── 一、自动连接逻辑：什么时候会连 / 什么时候不会（保留原有清单）──
        sectionTitle(activity, root, activity.getString(R.string.ui_rules_sec_connect))
        val connectCard = card(activity, root)
        connectCard.setPadding(dp(activity, 14), dp(activity, 14), dp(activity, 14), dp(activity, 14))
        connectCard.addView(TextView(activity).apply {
            text = activity.getString(R.string.ui_enable_intro)
            setTextColor(ContextCompat.getColor(activity, R.color.text_secondary))
            textSize = 13f
        })
        noteLines(
            activity, connectCard,
            listOf(
                R.string.ui_enable_yes_1, R.string.ui_enable_yes_2, R.string.ui_enable_yes_3,
                R.string.ui_enable_yes_4, R.string.ui_enable_yes_5,
            ),
            "✓", R.color.ok,
        )
        connectCard.addView(TextView(activity).apply {
            text = activity.getString(R.string.ui_enable_no_title)
            setTextColor(ContextCompat.getColor(activity, R.color.text_secondary))
            textSize = 13f
            setPadding(0, dp(activity, 12), 0, 0)
        })
        noteLines(
            activity, connectCard,
            listOf(
                R.string.ui_enable_no_1, R.string.ui_enable_no_2, R.string.ui_enable_no_3,
                R.string.ui_enable_no_4, R.string.ui_enable_no_5, R.string.ui_enable_no_6,
            ),
            "×", R.color.text_tertiary,
        )

        // ── 二 ~ 六：其余规则（每段一张卡）──
        ruleSection(activity, root, R.string.ui_rules_sec_auth, R.string.ui_rules_auth_body)
        ruleSection(activity, root, R.string.ui_rules_sec_switch, R.string.ui_rules_switch_body)
        ruleSection(activity, root, R.string.ui_rules_sec_android, R.string.ui_rules_android_body)
        ruleSection(activity, root, R.string.ui_rules_sec_compat, R.string.ui_rules_compat_body)
        ruleSection(activity, root, R.string.ui_rules_sec_trouble, R.string.ui_rules_trouble_body)
    }

    /** 使用规则页里的一个小节：小标题 + 一段正文（正文里的 **…** 会渲染成加粗） */
    private fun ruleSection(
        activity: AppCompatActivity,
        root: LinearLayout,
        titleRes: Int,
        bodyRes: Int,
    ) {
        sectionTitle(activity, root, activity.getString(titleRes))
        val c = card(activity, root)
        c.setPadding(dp(activity, 14), dp(activity, 14), dp(activity, 14), dp(activity, 14))
        c.addView(TextView(activity).apply {
            text = RichText.bold(activity.getString(bodyRes))
            setTextColor(ContextCompat.getColor(activity, R.color.text_secondary))
            textSize = 13f
            setLineSpacing(dp(activity, 4).toFloat(), 1f)
        })
    }

    private fun noteLines(
        activity: AppCompatActivity,
        parent: LinearLayout,
        resIds: List<Int>,
        mark: String,
        colorRes: Int,
    ) {
        val box = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(activity, 4), 0, 0)
        }
        resIds.forEach { id ->
            val row = LayoutInflater.from(activity).inflate(R.layout.item_enable_line, box, false)
            row.findViewById<TextView>(R.id.lineMark).text = mark
            row.findViewById<TextView>(R.id.lineMark)
                .setTextColor(ContextCompat.getColor(activity, colorRes))
            row.findViewById<TextView>(R.id.lineText).text = activity.getString(id)
            box.addView(row)
        }
        parent.addView(box)
    }

    // ────────────────────────────────────────────────────────────────
    // 运行准备度（本轮从开启弹窗里移到设置；权限闸门也用它）
    // ────────────────────────────────────────────────────────────────

    /**
     * 运行准备度页：真实百分比 + **必需**项 + **建议**项，每项都有真实状态与动作按钮。
     *
     * 两段的分工（用户要求：权限管理页删掉，"防止后台被杀"移到这里作为建议）：
     *   · 必需（wifi / location / account）：缺了就不能自动认证，也**会拦住开启按钮**
     *     （拦住这件事由 [PermissionGate] 实现，判定与这里同一套）
     *   · 建议（后台运行 / 不受电池优化限制 / 自启动）：不拦认证，只影响后台能不能长期跑稳
     *
     * ⚠ 百分比只按**系统能查到**的项算（见 [Readiness]），查不到的项标"需要你自己确认"。
     *
     * @param onAction 点「去授权 / 去设置」时的处理；默认走 [PermissionsActions]。
     *                 账号缺失这类需要页面跳转的动作由 Activity 传入。
     */
    fun bindReadiness(
        activity: AppCompatActivity,
        view: View,
        onAction: ((ReadyAction) -> Unit)? = null,
    ) {
        val handle: (ReadyAction) -> Unit = onAction ?: { PermissionsActions.handle(activity, it) }
        val root = body(view)
        root.removeAllViews()

        val items = ReadinessProbe(activity).items()
        val percent = Readiness.percent(items)
        val required = items.filter { it.key in REQUIRED_KEYS }
        val advisory = items.filter { it.key in ADVISORY_KEYS }
        val blocking = Readiness.blocking(items)

        // ── 百分比 ──
        val head = card(activity, root)
        head.setPadding(dp(activity, 16), dp(activity, 16), dp(activity, 16), dp(activity, 16))

        val headRow = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
        }
        val meter = com.campusnet.auto.ui.views.MeterView(activity).apply {
            layoutParams = LinearLayout.LayoutParams(0, dp(activity, 8), 1f)
            setFraction(percent / 100f)
        }
        headRow.addView(meter)
        headRow.addView(TextView(activity).apply {
            text = "$percent%"
            setTextColor(ContextCompat.getColor(activity, R.color.text_primary))
            textSize = 15f
        }, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply { marginStart = dp(activity, 12) })
        head.addView(headRow)

        if (blocking.isNotEmpty()) {
            head.addView(TextView(activity).apply {
                text = activity.getString(R.string.ui_enable_need_more) +
                    " " + blocking.joinToString("、") { it.title }
                setTextColor(ContextCompat.getColor(activity, R.color.warn))
                textSize = 12f
                setPadding(0, dp(activity, 8), 0, 0)
            })
        }

        // ── 校园 Wi-Fi 自动连接（本阶段新增；「权限管理」页已删，所以放这里）──
        campusWifiCard(activity, root, view, onAction)

        // ── 必需 ──
        sectionTitle(activity, root, activity.getString(R.string.ui_ready_section_required))
        val requiredCard = card(activity, root)
        requiredCard.setPadding(dp(activity, 12), dp(activity, 12), dp(activity, 12), dp(activity, 12))
        required.forEach { readyCard(activity, requiredCard, it, handle) }

        // ── 建议（原「防止后台被杀」）──
        sectionTitle(activity, root, activity.getString(R.string.ui_ready_section_advisory))
        val advisoryCard = card(activity, root)
        advisoryCard.setPadding(dp(activity, 12), dp(activity, 12), dp(activity, 12), dp(activity, 12))
        advisory.forEach { readyCard(activity, advisoryCard, it, handle) }
        infoRow(
            activity, advisoryCard,
            activity.getString(R.string.ui_ready_service_row),
            if (com.campusnet.auto.service.CampusAuthService.running) {
                activity.getString(R.string.ui_settings_running)
            } else {
                activity.getString(R.string.ui_settings_stopped)
            },
        )
    }

    // ────────────────────────────────────────────────────────────────
    // 校园 Wi-Fi 自动连接（本阶段新增）
    // ────────────────────────────────────────────────────────────────

    /**
     * 「校园 Wi-Fi 自动连接」卡片。
     *
     * 为什么放在「运行准备度」：独立的「权限管理」页已按用户要求删除，
     * 权限与连接条件现在都收在这一页。
     *
     * ⚠ 界面必须**如实区分**三件事（用户明确要求，不许混为一谈）：
     *   1. 用户有没有允许这个功能（读配置，权威）；
     *   2. 我们有没有把校园 SSID **建议给系统**（不等于连上）；
     *   3. 当前是不是**已经连着校园 Wi-Fi**。
     *   系统若拒绝建议（状态码非 0），直接显示"系统未允许本应用建议网络"+ 去系统设置的入口，
     *   **绝不显示成"已允许"**。
     */
    private fun campusWifiCard(
        activity: AppCompatActivity,
        root: LinearLayout,
        view: View,
        onAction: ((ReadyAction) -> Unit)?,
    ) {
        val credStore = AndroidCredentialStore(activity)
        val configStore = AndroidConfigStore(activity, credStore)
        val cfg = configStore.load()
        val state = com.campusnet.auto.platform.CampusWifiDiscoveryState

        sectionTitle(activity, root, activity.getString(R.string.ui_campus_wifi_title))
        val c = card(activity, root)
        c.setPadding(dp(activity, 14), dp(activity, 14), dp(activity, 14), dp(activity, 14))

        // ① 当前状态（用户要求的五种状态之一；查不到就如实说"系统状态未知"）
        infoRow(
            activity, c,
            activity.getString(R.string.ui_campus_wifi_state_now),
            campusWifiCurrentState(activity, cfg.suggestCampusWifi, state),
        )

        // ② 用户是否允许
        infoRow(
            activity, c,
            activity.getString(R.string.ui_campus_wifi_state),
            activity.getString(
                if (cfg.suggestCampusWifi) R.string.ui_campus_wifi_allowed
                else R.string.ui_campus_wifi_not_allowed
            ),
        )

        // ② 允许 / 关闭（写配置 → 让服务立刻按新配置重算）
        val toggle = Button(activity).apply {
            setText(
                if (cfg.suggestCampusWifi) R.string.ui_campus_wifi_disable
                else R.string.ui_campus_wifi_allow
            )
            background = ContextCompat.getDrawable(
                activity,
                if (cfg.suggestCampusWifi) R.drawable.bg_btn_ghost else R.drawable.bg_btn_primary,
            )
            setTextColor(
                if (cfg.suggestCampusWifi) ContextCompat.getColor(activity, R.color.text_primary)
                else android.graphics.Color.WHITE
            )
            textSize = 14f
            isAllCaps = false
            setOnClickListener {
                val next = !cfg.suggestCampusWifi
                configStore.save(mapOf("suggestCampusWifi" to next))
                // 走既有路径：让服务读到新配置并立刻重算（服务会在 reload 时执行一次发现决策）
                AutoAuthController.notifyConfigChanged(activity)
                Toast.makeText(
                    activity,
                    activity.getString(
                        if (next) R.string.ui_campus_wifi_on_toast else R.string.ui_campus_wifi_off_toast
                    ),
                    Toast.LENGTH_SHORT,
                ).show()
                // 重新画一遍这一页（状态要立刻反映真实配置）
                bindReadiness(activity, view, onAction)
            }
        }
        c.addView(toggle, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, dp(activity, 42),
        ).apply { topMargin = dp(activity, 8) })

        // ③ 已向系统建议（≠ 已连接）
        infoRow(
            activity, c,
            activity.getString(R.string.ui_campus_wifi_row_suggested),
            state.suggestedSsids.joinToString("、").ifEmpty {
                activity.getString(R.string.ui_campus_wifi_not_suggested)
            },
        )

        // ④ 已连接校园 Wi-Fi（这才是"连上了"）
        infoRow(
            activity, c,
            activity.getString(R.string.ui_campus_wifi_row_connected),
            state.connectedCampusSsid ?: activity.getString(R.string.ui_campus_wifi_none),
        )

        // ④′ 最近一次判断的原因：让"为什么没有动作"也能被看见（不是黑箱）
        //    ⚠ 这里刻意**不用** infoRow：原因是长句，infoRow 是"标题 + 右侧值"的横排布局，
        //      值一长就会把标题那一列挤成 0 宽 —— 标题直接看不见（真机截图级复验发现）。
        stackedRow(
            activity, c,
            activity.getString(R.string.ui_campus_wifi_row_last_decision),
            state.lastDecisionReason.ifBlank { activity.getString(R.string.ui_campus_wifi_not_run) },
        )

        // ⑤ 系统拒绝建议时，如实提示并给入口（不伪造状态）
        if (state.osDisallowed) {
            val blocked = TextView(activity).apply {
                text = activity.getString(R.string.ui_campus_wifi_os_blocked)
                setTextColor(ContextCompat.getColor(activity, R.color.warn))
                textSize = 12f
                setPadding(0, dp(activity, 8), 0, 0)
            }
            c.addView(blocked)
            c.addView(Button(activity).apply {
                setText(R.string.ui_campus_wifi_go_system)
                background = ContextCompat.getDrawable(activity, R.drawable.bg_btn_ghost)
                setTextColor(ContextCompat.getColor(activity, R.color.text_primary))
                textSize = 13f
                isAllCaps = false
                setOnClickListener { SystemSettings.wifiNetworkSuggestions(activity) }
            }, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(activity, 42),
            ).apply { topMargin = dp(activity, 8) })
        }

        // ⑥ 规则不是精确匹配时如实告知（本轮只支持 exact，不做主动扫描）
        val onlyPrefixOrRegex = cfg.campusSsids.isEmpty() &&
            (cfg.campusSsidPrefixes.isNotEmpty() || cfg.campusSsidPatterns.isNotEmpty())
        if (onlyPrefixOrRegex) {
            c.addView(TextView(activity).apply {
                text = activity.getString(R.string.ui_campus_wifi_rule_only_exact)
                setTextColor(ContextCompat.getColor(activity, R.color.warn))
                textSize = 12f
                setPadding(0, dp(activity, 8), 0, 0)
            })
        }

        // ⑦ 一句短说明（不重复首次启动弹窗的长篇规则；完整规则在「使用规则」里）
        c.addView(TextView(activity).apply {
            text = RichText.bold(activity.getString(R.string.ui_campus_wifi_note_short))
            setTextColor(ContextCompat.getColor(activity, R.color.text_tertiary))
            textSize = 12f
            setPadding(0, dp(activity, 10), 0, 0)
        })
    }

    /**
     * 「校园 Wi-Fi 自动连接」当前状态：只在这五种里选一个，**全部来自真实事实**：
     *   · 未允许 —— 用户没开这个功能
     *   · 已连接校园 Wi-Fi —— 当前 Wi-Fi 命中校园规则
     *   · 等待系统连接 —— 已把校园网建议给系统，等系统决定（≠ 已连接）
     *   · 系统状态未知 —— 系统明确不允许本应用建议网络，或本次进程还没跑过判断
     *   · 已允许（当前条件不满足）—— 允许了，但当前不满足请求连接的条件（连着别的 Wi-Fi / Wi-Fi 关着 / 缺权限等）
     */
    private fun campusWifiCurrentState(
        activity: AppCompatActivity,
        allowed: Boolean,
        state: com.campusnet.auto.platform.CampusWifiDiscoveryState,
    ): String = when {
        !allowed -> activity.getString(R.string.ui_campus_wifi_not_allowed)
        state.connectedCampusSsid != null -> activity.getString(R.string.ui_campus_wifi_row_connected)
        state.osDisallowed -> activity.getString(R.string.ui_campus_wifi_state_unknown)
        state.suggestedSsids.isNotEmpty() -> activity.getString(R.string.ui_campus_wifi_waiting_system)
        state.lastDecisionReason.isBlank() -> activity.getString(R.string.ui_campus_wifi_state_unknown)
        else -> activity.getString(R.string.ui_campus_wifi_allowed_idle)
    }

    // ────────────────────────────────────────────────────────────────
    // 权限项渲染（运行准备度页里用；「权限管理」独立页已按用户要求删除）
    // ────────────────────────────────────────────────────────────────

    /** 必需项：缺了就**不能**自动认证（与 [Readiness.blocking] 同一套判定） */
    private val REQUIRED_KEYS = setOf("wifi", "location", "account")

    /** 建议项：不影响本次连接，只影响后台能不能长期跑稳（原「防止后台被杀」） */
    private val ADVISORY_KEYS = setOf("fgs", "battery", "autostart")

    /** 一张权限/准备度卡片：状态标记 + 标题 + 原因 + 一个真实动作按钮 */
    private fun readyCard(
        activity: AppCompatActivity,
        parent: LinearLayout,
        item: ReadyItem,
        handle: (ReadyAction) -> Unit,
    ) {
        val cardView = LayoutInflater.from(activity).inflate(R.layout.item_permission, parent, false)
        cardView.findViewById<TextView>(R.id.permTitle).text = item.title
        cardView.findViewById<TextView>(R.id.permWhy).text = item.why
        val mark = cardView.findViewById<TextView>(R.id.permMark)
        mark.text = when (item.status) {
            ReadyStatus.OK -> "✓"
            ReadyStatus.MISSING -> "!"
            ReadyStatus.UNKNOWN -> "?"
        }
        mark.setTextColor(ContextCompat.getColor(activity, when (item.status) {
            ReadyStatus.OK -> R.color.ok
            ReadyStatus.MISSING -> R.color.warn
            ReadyStatus.UNKNOWN -> R.color.text_tertiary
        }))
        val note = cardView.findViewById<TextView>(R.id.permNote)
        if (item.status == ReadyStatus.UNKNOWN) {
            note.visibility = View.VISIBLE
            note.text = activity.getString(R.string.ui_ready_unverifiable)
        } else {
            note.visibility = View.GONE
        }
        val action = cardView.findViewById<Button>(R.id.permAction)
        action.text = when {
            item.status == ReadyStatus.OK && item.action != ReadyAction.AUTOSTART ->
                activity.getString(R.string.ui_ready_allow)
            item.status == ReadyStatus.UNKNOWN -> activity.getString(R.string.ui_ready_go_settings)
            else -> activity.getString(R.string.ui_ready_grant)
        }
        action.setOnClickListener { handle(item.action) }
        parent.addView(cardView)
    }

    // ────────────────────────────────────────────────────────────────
    // 账号与认证
    // ────────────────────────────────────────────────────────────────

    /**
     * **账号与认证的内联表单**（本轮：从设置页"账号与认证"一行下方展开）。
     *
     * 内容：账号 / 密码（默认隐藏可切换）/ 认证服务（**四选一**：学校·联通·移动·电信）/
     *       校园 Wi-Fi 规则（保留原有配置能力，避免功能丢失）+ 保存。
     *
     * ⚠ 保存只调用**现有能力**：`AndroidCredentialStore`（Keystore 加密存储）
     *   + `AndroidConfigStore` + `CampusRuleInput` + `AutoAuthController.notifyConfigChanged`。
     *   界面上密码不回显、不进日志、保存后立即清空输入框。
     *
     * @param onSaved 保存成功后回调（设置页据此收回表单）
     */
    fun buildAccountForm(activity: AppCompatActivity, onSaved: (String) -> Unit): View {
        val credStore = AndroidCredentialStore(activity)
        val configStore = AndroidConfigStore(activity, credStore)
        val facts = AppFacts(activity).collect()

        val container = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(activity, 16), dp(activity, 4), dp(activity, 16), dp(activity, 16))
        }

        // ── 账号 ──
        container.addView(fieldLabel(activity, activity.getString(R.string.ui_account_label)))
        val accountInput = EditText(activity).apply {
            hint = activity.getString(R.string.ui_account_hint)
            background = ContextCompat.getDrawable(activity, INNER)
            setPadding(dp(activity, 12), dp(activity, 10), dp(activity, 12), dp(activity, 10))
            setTextColor(ContextCompat.getColor(activity, R.color.text_primary))
            inputType = InputType.TYPE_CLASS_TEXT
            maxLines = 1
            setText(facts.account ?: "")
        }
        container.addView(accountInput)

        // ── 密码（默认隐藏 + 可切换显示）──
        container.addView(fieldLabel(activity, activity.getString(R.string.ui_password_label)))
        val passwordInput = EditText(activity).apply {
            hint = activity.getString(R.string.ui_password_hint)
            background = ContextCompat.getDrawable(activity, INNER)
            setPadding(dp(activity, 12), dp(activity, 10), dp(activity, 12), dp(activity, 10))
            setTextColor(ContextCompat.getColor(activity, R.color.text_primary))
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            maxLines = 1
        }
        container.addView(passwordInput)
        val pwdState = TextView(activity).apply {
            text = activity.getString(R.string.ui_password_hidden)
            setTextColor(ContextCompat.getColor(activity, R.color.text_tertiary))
            textSize = 12f
            setPadding(0, dp(activity, 6), 0, 0)
            isClickable = true
            setOnClickListener {
                val showing = passwordInput.inputType ==
                    (InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD)
                passwordInput.inputType = if (showing) {
                    InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
                } else {
                    InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
                }
                passwordInput.setSelection(passwordInput.text?.length ?: 0)
                text = activity.getString(
                    if (showing) R.string.ui_password_hidden else R.string.ui_password_shown
                )
            }
        }
        container.addView(pwdState)
        container.addView(smallNote(activity, activity.getString(
            if (facts.hasCredentials) R.string.ui_account_credentials_present
            else R.string.ui_account_credentials_missing
        )))

        // ── 认证服务：四选一（学校 / 联通 / 移动 / 电信）──
        container.addView(fieldLabel(activity, activity.getString(R.string.ui_service_section)))
        val serviceOptions = SERVICE_OPTIONS
        var selectedService = facts.operatorLabel?.let { current ->
            serviceOptions.firstOrNull { it.second == current }?.second
        } ?: serviceOptions.first().second
        val chipsRow = LinearLayout(activity).apply { orientation = LinearLayout.HORIZONTAL }
        val chips = mutableListOf<TextView>()
        serviceOptions.forEachIndexed { index, (labelRes, serviceName) ->
            val chip = TextView(activity).apply {
                setText(labelRes)
                textSize = 13f
                setPadding(dp(activity, 16), dp(activity, 9), dp(activity, 16), dp(activity, 9))
                isClickable = true
                isFocusable = true
                setOnClickListener {
                    selectedService = serviceName
                    chips.forEachIndexed { i, c ->
                        val on = i == index
                        c.setBackgroundResource(if (on) R.drawable.bg_chip_selected else R.drawable.bg_chip)
                        c.setTextColor(ContextCompat.getColor(
                            activity, if (on) R.color.accent else R.color.text_secondary,
                        ))
                    }
                }
            }
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            )
            if (index > 0) lp.marginStart = dp(activity, 8)
            chipsRow.addView(chip, lp)
            chips.add(chip)
        }
        container.addView(chipsRow)
        // 初始选中态
        chips.forEachIndexed { i, c ->
            val on = serviceOptions[i].second == selectedService
            c.setBackgroundResource(if (on) R.drawable.bg_chip_selected else R.drawable.bg_chip)
            c.setTextColor(ContextCompat.getColor(activity, if (on) R.color.accent else R.color.text_secondary))
        }
        container.addView(smallNote(activity, activity.getString(R.string.ui_service_auto_note)))

        // ── 校园 Wi-Fi 规则（保留原有配置能力）──
        container.addView(fieldLabel(activity, activity.getString(R.string.ui_rule_section)))
        val ruleKinds = listOf(
            CampusRuleKind.EXACT to R.string.ui_rule_exact,
            CampusRuleKind.PREFIX to R.string.ui_rule_prefix,
            CampusRuleKind.REGEX to R.string.ui_rule_regex,
        )
        var selectedKind = facts.campusRule.kind
        val kindRow = LinearLayout(activity).apply { orientation = LinearLayout.HORIZONTAL }
        val kindChips = mutableListOf<TextView>()
        ruleKinds.forEachIndexed { index, (kind, labelRes) ->
            val chip = TextView(activity).apply {
                setText(labelRes)
                textSize = 13f
                setPadding(dp(activity, 14), dp(activity, 8), dp(activity, 14), dp(activity, 8))
                isClickable = true
                setOnClickListener {
                    selectedKind = kind
                    kindChips.forEachIndexed { i, c ->
                        val on = i == index
                        c.setBackgroundResource(if (on) R.drawable.bg_chip_selected else R.drawable.bg_chip)
                        c.setTextColor(ContextCompat.getColor(
                            activity, if (on) R.color.accent else R.color.text_secondary,
                        ))
                    }
                }
            }
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            )
            if (index > 0) lp.marginStart = dp(activity, 8)
            kindRow.addView(chip, lp)
            kindChips.add(chip)
        }
        container.addView(kindRow)
        kindChips.forEachIndexed { i, c ->
            val on = ruleKinds[i].first == selectedKind
            c.setBackgroundResource(if (on) R.drawable.bg_chip_selected else R.drawable.bg_chip)
            c.setTextColor(ContextCompat.getColor(activity, if (on) R.color.accent else R.color.text_secondary))
        }
        val ruleValue = EditText(activity).apply {
            hint = activity.getString(R.string.ui_rule_value_hint)
            background = ContextCompat.getDrawable(activity, INNER)
            setPadding(dp(activity, 12), dp(activity, 10), dp(activity, 12), dp(activity, 10))
            setTextColor(ContextCompat.getColor(activity, R.color.text_primary))
            inputType = InputType.TYPE_CLASS_TEXT
            maxLines = 1
            setText(facts.campusRule.value)
        }
        val ruleLp = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT,
        )
        ruleLp.topMargin = dp(activity, 8)
        container.addView(ruleValue, ruleLp)
        container.addView(TextView(activity).apply {
            setText(R.string.ui_rule_use_current)
            setTextColor(ContextCompat.getColor(activity, R.color.accent))
            textSize = 13f
            setPadding(0, dp(activity, 8), 0, 0)
            isClickable = true
            setOnClickListener {
                val ssid = AppFacts(activity).collect().ssid
                if (ssid.isNullOrBlank()) ruleValue.setText("") else ruleValue.setText(ssid)
            }
        })

        // ── 保存 ──
        val saveButton = Button(activity).apply {
            setText(R.string.ui_account_save)
            background = ContextCompat.getDrawable(activity, R.drawable.bg_btn_primary)
            setTextColor(0xFFFFFFFF.toInt())
            textSize = 15f
            isAllCaps = false
        }
        val saveLp = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, dp(activity, 48),
        )
        saveLp.topMargin = dp(activity, 14)
        container.addView(saveButton, saveLp)

        val resultView = TextView(activity).apply {
            setTextColor(ContextCompat.getColor(activity, R.color.text_secondary))
            textSize = 13f
            setPadding(0, dp(activity, 8), 0, 0)
        }
        container.addView(resultView)

        saveButton.setOnClickListener {
            val ruleText = ruleValue.text.toString().trim()
            CampusRuleInput.validate(selectedKind, ruleText)?.let {
                resultView.text = "未保存：$it"
                return@setOnClickListener
            }
            val account = accountInput.text.toString().trim()
            if (account.isEmpty()) {
                resultView.text = "未保存：请填写账号"
                return@setOnClickListener
            }
            val typed = passwordInput.text.toString()
            val existing = credStore.load()
            when {
                typed.isNotEmpty() -> credStore.save(CredentialStore.Credentials(account, typed))
                existing != null -> credStore.save(CredentialStore.Credentials(account, existing.password))
                else -> {
                    resultView.text = "未保存：请填写密码"
                    return@setOnClickListener
                }
            }
            passwordInput.setText("") // 立刻清掉
            configStore.save(CampusRuleInput.toConfigPatch(selectedKind, ruleText))
            configStore.save(mapOf("operatorLabel" to selectedService))
            AutoAuthController.notifyConfigChanged(activity)
            onSaved(activity.getString(R.string.ui_account_saved))
        }

        return container
    }

    private fun fieldLabel(activity: AppCompatActivity, text: String): TextView = TextView(activity).apply {
        this.text = text
        setTextColor(ContextCompat.getColor(activity, R.color.text_secondary))
        textSize = 13f
        setPadding(0, dp(activity, 12), 0, dp(activity, 6))
    }

    private fun smallNote(activity: AppCompatActivity, text: String): TextView = TextView(activity).apply {
        this.text = text
        setTextColor(ContextCompat.getColor(activity, R.color.text_tertiary))
        textSize = 12f
        setPadding(0, dp(activity, 6), 0, 0)
    }

    /** 认证服务四选一 → 门户真实使用的服务名（与设备实测到的服务列表一致） */
    private val SERVICE_OPTIONS = listOf(
        R.string.ui_service_school to "学校互联网服务",
        R.string.ui_service_unicom to "联通互联网服务",
        R.string.ui_service_mobile to "移动互联网服务",
        R.string.ui_service_telecom to "电信互联网服务",
    )

}

/** 权限动作 → 真实系统页面（复用 [SystemSettings]，不另写一套跳转） */
object PermissionsActions {
    fun handle(activity: AppCompatActivity, action: ReadyAction) {
        when (action) {
            ReadyAction.NOTIFICATION -> SystemSettings.notification(activity)
            ReadyAction.WIFI_PERMISSION -> {
                val missing = com.campusnet.auto.platform.AndroidWifiState(activity)
                    .requiredPermissions()
                    .filter {
                        activity.checkSelfPermission(it) !=
                            android.content.pm.PackageManager.PERMISSION_GRANTED
                    }
                if (missing.isEmpty()) {
                    SystemSettings.appDetails(activity)
                } else {
                    androidx.core.app.ActivityCompat.requestPermissions(
                        activity, missing.toTypedArray(), 1001,
                    )
                }
            }

            ReadyAction.LOCATION_SERVICE -> SystemSettings.location(activity)
            ReadyAction.BATTERY_OPTIMIZATION -> SystemSettings.batteryOptimization(activity)
            ReadyAction.AUTOSTART -> {
                val opened = SystemSettings.autostart(activity)
                if (opened == null) SystemSettings.appDetails(activity)
            }

            ReadyAction.ACCOUNT, ReadyAction.NONE -> Unit
        }
    }
}
