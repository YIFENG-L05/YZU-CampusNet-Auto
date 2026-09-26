/**
 * Android 侧装配脚本（**粘合代码，不是 Core**）。
 *
 * ## 它做什么
 *   把 `src/core/auto-connect.js`（状态机）与 `src/core/eportal-protocol.js`（协议）
 *   接到 Android 注入的桥函数上：`__androidCheckConnectivity` / `__androidLoginContext`
 *   / `__androidPostForm` / `__androidAfterLogin` / `__androidLog` / `__androidNow`
 *   / `__androidSetTimer` / `__androidClearTimer` / `__androidOnState` / `__androidGetConfig`。
 *
 * ## 它故意**不**做什么
 *   · 不做任何业务判断 —— "什么时候该登录"完全由 Core 的状态机决定
 *   · 不实现协议 —— pageInfo / 选服务 / 表单字段 / 响应判定都在 Core 的
 *     eportal-protocol.js 里（Windows 用的是同一份文件）
 *   · 不碰凭据存储 —— 账号密码由 Kotlin 在"真要登录的那一刻"解密后传进来
 *
 * ## 为什么登录是 JS 驱动、而不是 Kotlin 驱动
 *   `loginAttempt` 里要"先问 Kotlin 拿上下文 → 用 Core 协议拼请求 → 让 Kotlin 发出去 →
 *   把响应交回 Core 判定 → 再让 Kotlin 复探一次确认"。这条链路天然是异步的，
 *   如果由 Kotlin 驱动，就得在 Kotlin 里重写一遍协议顺序 —— 那就成了第二份实现。
 *   所以由 JS 驱动，Kotlin 只提供两个原子能力：`postForm` 与"登录后复探"。
 *
 * ## 定时器为什么这么绕
 *   Core 的 `setTimer(fn, ms)` 要求返回一个 handle。Kotlin 侧只记住 id 与延时，
 *   **回调函数留在 JS 这边**（`__engineTimers`），到点 Kotlin 求值 `__fireTimer(id)`
 *   把 tick 跑起来。这样定时器仍然由 Android（前台服务的作用域）驱动，
 *   但状态机逻辑一行都没有搬出 Core。
 */
(function (g) {
  var G = g || this;

  function jparse(s) {
    try {
      return JSON.parse(s);
    } catch (e) {
      return null;
    }
  }

  G.__androidEngine = (function () {
    // ⚠ 装配脚本可能因为"服务又被启动了一次"而被再次求值。
    //   若旧引擎还活着，就会同时存在**两个状态机**（各自排定时器、各自 loginAttempt）——
    //   这正是本阶段明令禁止的"重复认证"。所以重装前先把旧引擎停掉。
    if (G.__androidEngine && typeof G.__androidEngine.stop === 'function') {
      try {
        G.__androidEngine.stop();
        if (typeof __androidLog === 'function') {
          __androidLog('warn', '[glue] 检测到重复装配：旧状态机已停止（同一时间只允许一个）', 'null');
        }
      } catch (e) {
        /* 停不掉也要继续装新的，不能因为一句日志把装配搞挂 */
      }
    }

    var createAutoConnect = __cjs.require('src/core/auto-connect').createAutoConnect;
    var protocol = __cjs.require('src/core/eportal-protocol');

    /**
     * YZU 统一身份认证（SSO）通道 —— 协议全部在 Core，这里只是把 Android 的三样能力接上去：
     *   · 不跟随重定向的 GET/POST（CAS 的 ticket 就在 302 的 Location 里）
     *   · 内存 Cookie 会话（GET 建会话 → POST 带同一个 Cookie）
     *   · AES-128-ECB（croypto 作密钥；加密密码与字面量 "{}"）
     * ⚠ 不在这里做任何协议判断（不看状态码、不看 Location、不提取 ticket）——那些都是 Core 的事。
     */
    async function trySsoLogin(ctx, requestId) {
      try {
        var sso = __cjs.require('src/core/yzu-sso-protocol');
        __androidResetSsoCookies(); // 一次认证一个干净会话
        return await sso.runSsoLogin({
          serviceUrl: ctx.portalUrl,
          account: ctx.account,
          password: ctx.password,
          // 用户在设置里选的运营商名（如「联通互联网服务」）：
          // CAS 之后门户会要求"选择服务"，用它去门户的服务列表里挑一项
          operatorLabel: ctx.operatorLabel,
          transport: ssoTransport(),
          aesEncryptBase64: function (keyB64, plaintext) {
            return __androidAesEncrypt(keyB64, plaintext);
          },
          log: function (m) {
            __androidLog('info', '[SSO] ' + requestId + ' ' + m, 'null');
          },
        });
      } catch (e) {
        __androidLog('warn', '[SSO] ' + requestId + ' 异常: ' + (e && e.message ? e.message : e), 'null');
        return { success: false, reason: 'sso-transport-error' };
      }
    }

    /**
     * SSO 用的传输适配器（Core 只认这三个方法，HTTP 全在 Kotlin 侧）。
     * 真实认证与自检 Mock 走的是**同一份**接线 —— 否则"Mook 过了、真机不过"就无解了。
     */
    function ssoTransport() {
      return {
        getNoRedirect: async function (url, opts) {
          return jparse(await __androidSsoGet(url, JSON.stringify(opts || {})));
        },
        get: async function (url, opts) {
          return jparse(await __androidSsoGet(url, JSON.stringify(opts || {})));
        },
        postForm: async function (url, fields, opts) {
          return jparse(await __androidSsoPost(url, JSON.stringify(fields), JSON.stringify(opts || {})));
        },
      };
    }

    /**
     * **自检专用**：在设备上把 SSO 全链路对着本地 Mock 跑一遍。
     *
     * 覆盖：Core 的流程编排（门户 302 → SSO 页面解析 → AES → 表单字段 → ticket → 回跳）
     *      + 桥（__androidSsoGet/__androidSsoPost/__androidAesEncrypt）
     *      + 传输（不跟随重定向、Cookie 会话）
     * 不覆盖：真实 sso.yzu.edu.cn 与真实账号 —— 那必须真机实测，Mock 不能替代。
     *
     * 服务端（MockSsoServer）会**真的**用自己发出去的 croypto 解密密码、**真的**校验会话 Cookie，
     * 所以那两件事做错了这里一定是红的。
     */
    async function ssoMockRun() {
      var started = jparse(await __androidMockSsoStart());
      if (!started || !started.ok) {
        return { ok: false, error: (started && started.error) || 'mock-start-failed' };
      }
      var verdict = null;
      var error = null;
      try {
        var sso = __cjs.require('src/core/yzu-sso-protocol');
        __androidResetSsoCookies();
        verdict = await sso.runSsoLogin({
          serviceUrl: started.serviceUrl,
          account: started.account,
          password: started.password,
          transport: ssoTransport(),
          aesEncryptBase64: function (keyB64, plaintext) {
            return __androidAesEncrypt(keyB64, plaintext);
          },
          log: function (m) {
            __androidLog('info', '[MockSSO] ' + m, 'null');
          },
        });
      } catch (e) {
        error = e && e.message ? String(e.message) : String(e);
      }
      // 无论成败都要停服务器（否则回环端口会一直开着）
      var stopped = jparse(await __androidMockSsoStop());
      if (error) return { ok: false, error: error };
      return {
        ok: true,
        verdict: verdict,
        observed: (stopped && stopped.observed) || {},
      };
    }

    var engine = createAutoConnect({
      // Kotlin 侧已经把"当前网络 + 探测结论 + 校园网判定"算好并翻译成 Core 的四态。
      // ⚠ 必须 async + await：__androidCheckConnectivity 是**异步绑定**，
      //   直接 JSON.parse(它) 会拿到 Promise，报 "unexpected token: 'object'"。
      //
      // 顺带在这里完成**门户地址发现**（真机实测：门户劫持不一定是 302，
      // 常常是 200 + `<script>location.href='http://10.x.x.x/eportal/index.jsp?...'</script>`）：
      //   · 30x 的 Location 由 Kotlin 侧给出（最可靠）
      //   · 响应体里的 JS/meta 跳转用 Core 的 html-parse 挖（与 Windows 同一份实现）
      //   · 候选交给 Kotlin 侧按统一规则挑一个（规则只有一份，见 PortalDiscovery.pickBest）
      checkConnectivity: async function () {
        var r = JSON.parse(await __androidCheckConnectivity());

        if (r.portalFromLocation) {
          __androidSetPortalCandidates(JSON.stringify([r.portalFromLocation]));
        } else if (r.probeBodies && r.probeBodies.length) {
          // ⚠ 整段包在 try 里：门户地址挖不出来只是"这次不认证"，
          //   不能让一次提取失败把整个状态机 tick 打断（踩过这个坑）
          try {
            var html = __cjs.require('src/shared/html-parse');
            var all = [];
            for (var i = 0; i < r.probeBodies.length; i++) {
              var s = r.probeBodies[i];
              try {
                var cands = html.extractRedirectCandidates(String(s.body || ''), s.url);
                for (var j = 0; j < cands.length; j++) {
                  if (all.indexOf(cands[j]) === -1) all.push(cands[j]);
                }
              } catch (e) {
                /* 单个探测点挖不出来不影响其它 */
              }
            }
            __androidSetPortalCandidates(JSON.stringify(all));
          } catch (e) {
            __androidLog('warn', '[glue] 从响应体提取门户地址失败（本次不认证）', 'null');
          }
        }

        return { state: r.state, stateReason: r.stateReason };
      },

      // 一次登录尝试：先走 YZU SSO（统一身份认证）通道，不适用/未通过再回退到 ePortal 通道。
      // ⚠ 两条通道都由 **Core** 决定流程：
      //    · SSO  → src/core/yzu-sso-protocol.js（移植自 qlu-campus-autologin，Windows 已真实跑通）
      //    · ePortal → src/core/eportal-protocol.js（原有通道，保持原样，一行未改）
      //   Android 只提供能力：不跟随重定向的 GET/POST、内存 Cookie 会话、AES-128-ECB。
      loginAttempt: async function () {
        var ctx = jparse(await __androidLoginContext());
        if (!ctx || !ctx.ok) {
          return { success: false, reason: (ctx && ctx.reason) || 'no-login-context' };
        }

        var requestId = 'AUTH-' + String(++G.__authSeq);
        // ★ 记下这次认证属于哪一代网络。整个尝试期间网络一旦换人，
        //   这次结果就作废（绝不让旧 Network 的认证结果落到新 Network 上）。
        var networkToken = __androidNetworkToken();
        __androidLog('info', '[EPortal] ==== 开始认证 ' + requestId + ' (net=' + networkToken + ') ====', 'null');

        // ① YZU SSO 通道
        var sso = await trySsoLogin(ctx, requestId);
        if (sso && sso.success) {
          if (__androidNetworkToken() !== networkToken) {
            __androidLog('warn', '[SSO] ' + requestId + ' 认证期间网络已切换，丢弃这次结果（不在新网络上复探）', 'null');
            return { success: false, reason: 'network-changed', detail: { attemptToken: networkToken } };
          }
          // 登录后必须复探确认（不看 HTTP 302 / 不看拿到 ticket）
          return jparse(await __androidAfterLogin(JSON.stringify({
            success: true,
            reason: sso.reason,
            detail: sso.detail || {},
            networkToken: networkToken,
          })));
        }

        // ② 只有"这条门户不走 SSO / 会话层拿不到"才回退到 ePortal 本地登录通道。
        //    凭据错误、需要验证码这类**真实答复**绝不回退 —— 回退只会多打一次无效请求。
        var NOT_APPLICABLE = {
          'sso-portal-entry-failed': 1,
          'sso-params-missing': 1,
          'sso-transport-error': 1,
          'no-transport': 1,
        };
        var reason = (sso && sso.reason) || 'sso-unknown';
        if (!NOT_APPLICABLE[reason]) {
          __androidLog('warn', '[SSO] ' + requestId + ' 判定=' + reason + '，按失败上报（不回退）', 'null');
          return { success: false, reason: reason, detail: sso ? sso.detail : null };
        }

        __androidLog('warn', '[SSO] ' + requestId + ' 不适用(' + reason + ')，回退 ePortal 通道', 'null');
        var result = await protocol.runHttpLogin({
          portalUrl: ctx.portalUrl,
          account: ctx.account,
          password: ctx.password,
          operatorLabel: ctx.operatorLabel,
          requestId: requestId,
          transport: {
            postForm: async function (url, fields, opts) {
              return jparse(await __androidPostForm(url, JSON.stringify(fields), JSON.stringify(opts || {})));
            },
          },
          onLog: function (m) {
            __androidLog('info', '[EPortal] ' + m, 'null');
          },
        });

        // ⚠ 绝不因为"HTTP 200 / result:success"就宣布成功 —— 必须再探测一次确认真的能上网
        //   同样带上网络代际号：ePortal 通道走完时网络若已换人，这次结果同样作废。
        return jparse(await __androidAfterLogin(JSON.stringify({
          success: result.success,
          reason: result.reason,
          detail: result.detail || {},
          networkToken: networkToken,
        })));
      },

      getConfig: function () {
        return JSON.parse(__androidGetConfig());
      },

      log: function (level, message, meta) {
        __androidLog(
          String(level || 'info'),
          String(message === null || message === undefined ? '' : message),
          JSON.stringify(meta === null || meta === undefined ? null : meta)
        );
      },

      now: function () {
        return __androidNow();
      },

      setTimer: function (fn, ms) {
        var id = __androidSetTimer(ms);
        G.__engineTimers[id] = fn;
        return id;
      },

      clearTimer: function (handle) {
        if (handle !== null && handle !== undefined) delete G.__engineTimers[handle];
        __androidClearTimer(handle);
      },

      onState: function (snapshot) {
        __androidOnState(JSON.stringify(snapshot));
      },
    });

    // 自检入口（不在正常状态机路径上；只有自检会调用它）
    engine.ssoMockRun = ssoMockRun;

    return engine;
  })();

  return true;
})(typeof globalThis !== 'undefined' ? globalThis : this);
