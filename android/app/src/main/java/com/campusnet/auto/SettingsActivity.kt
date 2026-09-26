package com.campusnet.auto

import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.RadioButton
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.campusnet.auto.core.CampusRuleInput
import com.campusnet.auto.core.CampusRuleKind
import com.campusnet.auto.core.CredentialStore
import com.campusnet.auto.platform.AndroidConfigStore
import com.campusnet.auto.platform.AndroidCredentialStore
import com.campusnet.auto.platform.AppFacts
import com.campusnet.auto.platform.AuthStateHolder
import com.campusnet.auto.platform.AutoAuthController
import com.campusnet.auto.service.CampusAuthService

/**
 * 设置页（第五阶段）：校园 Wi-Fi 规则 + 账号 + 密码 + 自动认证开关 + 手动操作。
 *
 * ## 密码纪律（这一页是唯一碰密码的地方）
 *   · 密码只在 `AndroidCredentialStore`（Keystore AES/GCM）里，**不进普通配置**
 *   · 密码框保存后**立刻清空**，界面永不回显；回显的只有账号
 *   · 不改密码时（密码框留空）用已存凭据**重新加密一遍**，只更新账号 ——
 *     这样不会因为"账号改了、密码没填"把密码写成空串
 *   · 全程不打印任何输入内容（日志里没有账号也没有密码）
 *
 * ## 规则只存一种
 *   用户选精确/前缀/正则之一，保存时只写对应的那个配置键，另外两个清空 ——
 *   避免出现"配置里有两种规则，到底按哪个判"的歧义。
 */
class SettingsActivity : AppCompatActivity() {

    private lateinit var ruleExact: RadioButton
    private lateinit var rulePrefix: RadioButton
    private lateinit var ruleRegex: RadioButton
    private lateinit var ruleValue: EditText
    private lateinit var ruleHint: TextView
    private lateinit var currentSsidLine: TextView
    private lateinit var accountInput: EditText
    private lateinit var passwordInput: EditText
    private lateinit var credentialState: TextView
    private lateinit var switchAutoAuth: Switch
    private lateinit var saveResult: TextView
    private lateinit var serviceInput: EditText
    private lateinit var serviceListLine: TextView

    private var suppressSwitchCallback = false

    private val configStore by lazy { AndroidConfigStore(this, AndroidCredentialStore(this)) }
    private val credentialStore by lazy { AndroidCredentialStore(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)

        ruleExact = findViewById(R.id.ruleExact)
        rulePrefix = findViewById(R.id.rulePrefix)
        ruleRegex = findViewById(R.id.ruleRegex)
        ruleValue = findViewById(R.id.ruleValue)
        ruleHint = findViewById(R.id.ruleHint)
        currentSsidLine = findViewById(R.id.currentSsidLine)
        accountInput = findViewById(R.id.accountInput)
        passwordInput = findViewById(R.id.passwordInput)
        credentialState = findViewById(R.id.credentialState)
        switchAutoAuth = findViewById(R.id.switchAutoAuth)
        saveResult = findViewById(R.id.saveResult)
        serviceInput = findViewById(R.id.serviceInput)
        serviceListLine = findViewById(R.id.serviceListLine)

        ruleExact.isChecked = true
        ruleHint.text = CampusRuleInput.hint(CampusRuleKind.EXACT)
        (findViewById<android.widget.RadioGroup>(R.id.ruleGroup)).setOnCheckedChangeListener { _, _ ->
            ruleHint.text = CampusRuleInput.hint(selectedKind())
        }

        findViewById<Button>(R.id.btnUseCurrentSsid).setOnClickListener {
            val ssid = AppFacts(this).collect().ssid
            if (ssid == null) {
                Toast.makeText(this, "现在读不到 Wi-Fi 名称（缺权限或没连 Wi-Fi）", Toast.LENGTH_LONG).show()
            } else {
                ruleValue.setText(ssid)
            }
        }

        switchAutoAuth.setOnCheckedChangeListener { _, checked ->
            if (suppressSwitchCallback) return@setOnCheckedChangeListener
            val policy = AutoAuthController.setEnabled(this, checked)
            saveResult.text = policy.message
        }

        findViewById<Button>(R.id.btnSave).setOnClickListener { save() }

        // 密码默认隐藏；这里只切换**显示方式**，不读、不打印、不改存储（用户要求 §19）
        val toggleRow = findViewById<android.view.View>(R.id.passwordToggleRow)
        val toggleState = findViewById<android.widget.TextView>(R.id.passwordToggleState)
        toggleRow.setOnClickListener {
            val showing = passwordInput.inputType ==
                (android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD)
            passwordInput.inputType = if (showing) {
                android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
            } else {
                android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
            }
            // 光标保持在末尾，避免切换后跳到开头
            passwordInput.setSelection(passwordInput.text?.length ?: 0)
            toggleState.text = if (showing) "已隐藏" else "已显示"
        }
        findViewById<Button>(R.id.btnFetchServices).setOnClickListener {
            CampusAuthService.fetchServices(this)
            serviceListLine.text = "正在读取门户服务列表（不发账号密码）…"
        }
        findViewById<Button>(R.id.btnCheck).setOnClickListener {
            CampusAuthService.checkOnce(this)
            Toast.makeText(this, "正在检查网络…", Toast.LENGTH_SHORT).show()
        }
        findViewById<Button>(R.id.btnAuth).setOnClickListener {
            // 与首页同一个入口：仍然要过 LoginGuard 的三个条件
            CampusAuthService.authNow(this)
            Toast.makeText(this, "已触发一次认证检查", Toast.LENGTH_SHORT).show()
        }
        findViewById<Button>(R.id.btnStop).setOnClickListener {
            CampusAuthService.stop(this)
            Toast.makeText(this, "已停止自动认证", Toast.LENGTH_SHORT).show()
        }

        loadIntoForm()
    }

    override fun onResume() {
        super.onResume()
        loadIntoForm()
        AutoAuthController.syncWithPolicy(this)
    }

    // ────────────────────────────────────────────────────────────────

    private fun selectedKind(): CampusRuleKind = when {
        rulePrefix.isChecked -> CampusRuleKind.PREFIX
        ruleRegex.isChecked -> CampusRuleKind.REGEX
        else -> CampusRuleKind.EXACT
    }

    private fun loadIntoForm() {
        val facts = AppFacts(this).collect()

        when (facts.campusRule.kind) {
            CampusRuleKind.EXACT -> ruleExact.isChecked = true
            CampusRuleKind.PREFIX -> rulePrefix.isChecked = true
            CampusRuleKind.REGEX -> ruleRegex.isChecked = true
        }
        ruleValue.setText(facts.campusRule.value)
        ruleHint.text = CampusRuleInput.hint(facts.campusRule.kind)

        // 账号可以回显（它不是秘密）；**密码永远不回显**
        accountInput.setText(facts.account ?: "")
        passwordInput.setText("")

        credentialState.text = when {
            facts.hasCredentials ->
                "已保存账号：${facts.account ?: "（读不出来）"}　密码：已加密保存在 Keystore（不显示）"
            else -> "还没有保存账号密码"
        }

        currentSsidLine.text = when {
            facts.ssid == null -> "当前 Wi-Fi 名称：读不到（缺权限或没连 Wi-Fi）"
            else -> "当前 Wi-Fi 名称：${facts.ssid}（${if (facts.isCampusWifi) "符合校园网规则" else "不符合校园网规则"}）"
        }

        if (switchAutoAuth.isChecked != facts.autoAuthEnabled) {
            suppressSwitchCallback = true
            switchAutoAuth.isChecked = facts.autoAuthEnabled
            suppressSwitchCallback = false
        }

        // 服务/运营商 + 门户真实服务列表（只在用户点过"读取"之后才有内容）
        if (serviceInput.text.isNullOrBlank()) {
            serviceInput.setText(facts.operatorLabel ?: "")
        }
        val ui = AuthStateHolder.state.value
        serviceListLine.text = when {
            ui.portalServices.isNotEmpty() ->
                "门户服务列表：${ui.portalServices.joinToString(" / ")}（点上方输入框右侧选中复制，或直接输入其中一个）"
            ui.portalServicesNote != null -> ui.portalServicesNote
            else -> ""
        }
    }

    private fun save() {
        val kind = selectedKind()
        val value = ruleValue.text.toString()

        CampusRuleInput.validate(kind, value)?.let {
            saveResult.text = "未保存：$it"
            return
        }

        val account = accountInput.text.toString().trim()
        if (account.isEmpty()) {
            saveResult.text = "未保存：请填写账号"
            return
        }

        val typedPassword = passwordInput.text.toString()
        val existing = credentialStore.load()
        when {
            typedPassword.isNotEmpty() ->
                credentialStore.save(CredentialStore.Credentials(account, typedPassword))
            existing != null ->
                // 只改账号：用已存凭据重新加密一遍（密码从 Keystore 解出来、立刻再写回去）
                credentialStore.save(CredentialStore.Credentials(account, existing.password))
            else -> {
                saveResult.text = "未保存：请填写密码"
                return
            }
        }
        // 界面上立刻清掉密码，绝不留在输入框里
        passwordInput.setText("")

        configStore.save(CampusRuleInput.toConfigPatch(kind, value))

        // 服务/运营商（留空 = 自动按运营商关键词从门户服务列表里挑）
        val service = serviceInput.text.toString().trim()
        configStore.save(mapOf("operatorLabel" to service.ifEmpty { null }))

        // 让正在跑的服务立刻用新配置（§10：不能"界面新、服务旧"）
        AutoAuthController.notifyConfigChanged(this)

        val policy = AutoAuthController.syncWithPolicy(this)
        saveResult.text = buildString {
            append("已保存：规则=")
            append(CampusRuleInput.kindLabel(kind))
            append("「").append(value.trim()).append("」")
            append("；服务=").append(service.ifEmpty { "自动" })
            append("；账号已加密保存（密码不回显）。")
            append("\n").append(policy.message)
        }
        loadIntoForm()
    }
}
