/**
 * Android 侧运行时胶水（**粘合代码，不是 Core**）—— 与业务无关的两件小事。
 *
 * 1. `__redact(text)`：走 Core 的 `src/shared/redact.js` 脱敏。
 *    ⚠ 关键在**失败时返回空串**而不是原文：脱敏一旦出错，
 *      宁可丢一条日志，也绝不能把可能含密码的原文写到 Logcat 里去。
 *      Kotlin 侧只需要 `js.evalToString("__redact(\"...\")")`，不必各自拼 require。
 *
 * 2. 定时器注册表：Core 的 `setTimer(fn, ms)` 由 JS 侧持有回调、
 *    Kotlin 侧只记 id 与延时，到点求值 `__fireTimer(id)`。
 *    （引擎装配在 android-engine.js，这里只放两边都要用的基础设施。）
 */
(function (g) {
  var G = g || this;

  /**
   * 极简 URL 垫片（**只在引擎没有 URL 时安装**）。
   *
   * 为什么需要：Core 里有些文件（例如 `src/shared/html-parse.js` 的
   * `extractRedirectCandidates`）会用 `new URL(v, base)` 解析跳转地址。
   * Node 有 URL，QuickJS **不保证**有 —— 不补的话这条复用路径会在真机上直接抛异常。
   *
   * 只实现 Core 实际用到的那部分：协议/主机/端口/路径/查询/哈希 + toString()，
   * 以及"相对地址 + base"的解析。**不假装**是完整的 WHATWG URL 实现（写清楚边界，
   * 免得以后有人以为它能干所有事）。
   */
  if (typeof G.URL === 'undefined') {
    var ABS = /^([a-zA-Z][a-zA-Z0-9+.-]*:)\/\/([^\/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/;

    G.URL = function (input, base) {
      var raw = String(input === null || input === undefined ? '' : input);
      var abs = null;

      if (ABS.test(raw)) {
        abs = raw;
      } else if (base !== undefined && base !== null) {
        var b = ABS.exec(String(base));
        if (!b) throw new TypeError('Invalid base URL: ' + base);
        var origin = b[1] + '//' + b[2];
        var basePath = b[3] || '/';
        if (raw.indexOf('//') === 0) {
          abs = b[1] + raw;
        } else if (raw.charAt(0) === '/') {
          abs = origin + raw;
        } else {
          var dir = basePath.replace(/[^\/]*$/, '');
          abs = origin + dir + raw;
        }
      }
      if (!abs) throw new TypeError('Invalid URL: ' + raw);

      var p = ABS.exec(abs);
      if (!p) throw new TypeError('Invalid URL: ' + raw);

      this.protocol = p[1];
      this.host = p[2];
      this.hostname = p[2].split(':')[0];
      this.port = p[2].indexOf(':') >= 0 ? p[2].split(':')[1] : '';
      this.pathname = p[3] || '/';
      this.search = p[4] || '';
      this.hash = p[5] || '';
      this.origin = this.protocol + '//' + this.host;
      this.href = this.origin + this.pathname + this.search + this.hash;
    };

    G.URL.prototype.toString = function () {
      return this.href;
    };
  }

  G.__redact = function (text) {
    try {
      var redact = __cjs.require('src/shared/redact');
      return String(redact.redactUrl(text));
    } catch (e) {
      return '';
    }
  };

  G.__engineTimers = G.__engineTimers || {};

  /** 认证追踪号计数（每次真实登录 +1，日志里表现为 AUTH-1、AUTH-2 …） */
  G.__authSeq = G.__authSeq || 0;

  /** Kotlin 到点后调用它：把 Core 排的那次 tick 跑起来 */
  G.__fireTimer = function (id) {
    var fn = G.__engineTimers[id];
    delete G.__engineTimers[id];
    if (typeof fn !== 'function') return null;
    // tick 是 async，返回 Promise；Kotlin 侧的 evaluate 会等它跑完
    return fn();
  };

  /**
   * 异步结果信箱。
   *
   * 为什么需要：Kotlin 侧 `evaluate` **不会**等待顶层 Promise
   * （实测：`evaluate("(async()=>'x')()")` 拿到的是 Promise 对象，`toString()` 是 "Promise"）。
   * 所以"由 Kotlin 主动发起一次异步 JS 调用"不能靠返回值，只能靠这个信箱：
   *   Kotlin: __runAsync(代码) → 轮询 __asyncResult → 拿到 {ok, value} 或 {ok:false, error}
   *
   * ⚠ 业务路径（Core 状态机）**不用**它：那边是 JS 自己 await，
   *   引擎内部由 QuickJS 的任务队列驱动，本来就没这个问题。
   *   这里只服务于自检/一次性验证这类"Kotlin 主动发起"的场景。
   */
  G.__asyncResult = null;

  G.__runAsync = function (code) {
    G.__asyncResult = null;
    try {
      Promise.resolve(eval(code)).then(
        function (v) {
          G.__asyncResult = JSON.stringify({ ok: true, value: v === undefined ? null : v });
        },
        function (e) {
          G.__asyncResult = JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) });
        }
      );
    } catch (e) {
      G.__asyncResult = JSON.stringify({ ok: false, error: String(e) });
    }
    return true;
  };

  return true;
})(typeof globalThis !== 'undefined' ? globalThis : this);
