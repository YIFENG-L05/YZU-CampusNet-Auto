'use strict';

/**
 * 锐捷 ePortal 的纯 HTTP 登录通道 —— **Node 侧的 transport + 协议转发**。
 *
 * ────────────────────────────────────────────────────────────────────
 * 这个文件现在只做两件事：
 *   1. 提供 Node 的 socket 实现 `postForm`（node:http/https + agent:false）
 *   2. 把 `src/core/eportal-protocol.js` 的**协议纯函数**原样再导出
 *
 * 协议逻辑本身（pageInfo → 选服务 → 构造字段 → 判定响应，以及
 * queryString 编码、interFaceUrl 推导、classifyLoginResponse）**全部在 Core 里**，
 * Android 用的是同一个文件，不是另一份实现。
 * 拆分原因与约束见 eportal-protocol.js 头部注释。
 * ────────────────────────────────────────────────────────────────────
 *
 * 为什么保留这条纯 HTTP 通道（2026-09-15，调研社区同类项目后的结论）
 * 原方案是"隐藏 BrowserWindow + 让门户页面自己登录"。它的致命弱点是
 * **依赖页面渲染时序**：门户是 Angular SPA，必须等 JS 渲染出表单才能填。
 * 用户真实反馈的故障正是这个 —— 拔掉网线切 WiFi 后，链路刚起来那一次
 * 页面没加载完，程序等满 20 秒超时、判失败、退避重试，而设备其实没事。
 *
 * 调研了四个同类项目（含两个生产可用、一个同为 Electron + 锐捷）：
 *   Georgeupup/szu-network-guardian  纯 HTTP
 *   evin546/SCUNETAssistant           纯 HTTP
 *   Barabama/RuijieEportal            纯 HTTP
 *   LFWQSP2641/scu_net_auto_login     纯 HTTP
 *   ZYYO666/ruijie-electron           纯 HTTP（同栈同厂商，主进程直接请求）
 * **没有一个用浏览器自动化。**
 *
 * 本项目实测确认（不是推测）：
 *   - `POST InterFace.do?method=pageInfo` 在扬大可用，返回完整配置
 *   - 门户自己声明：`isToCasPage=false`（网页跳 CAS 只是页面的行为，
 *     接口本身不需要）、`passwordEncrypt=false`（密码不用加密）、
 *     `validCodeUrl=""`（无验证码）、`isCheckSmsAuth=false`
 *   - 用**假账号**发登录请求，接口回复
 *     `{"result":"fail","message":"当前设备已存在在线用户!"}`
 *     —— 即它认我们的字段格式，只是因为设备已在线才拒绝
 *
 * 于是登录从"启动浏览器 + 等 SPA 渲染 + 猜表单结构"变成 2 个 HTTP 请求。
 * 链路抖动时重试只是几毫秒的事，不再需要拉起一个 Chromium。
 *
 * 浏览器方案**保留为兜底**：接口一旦改版（或者哪天学校真的把
 * passwordEncrypt 打开），自动退回原路径，不会整个工具失效。
 * ────────────────────────────────────────────────────────────────────
 */

const protocol = require('../../core/eportal-protocol');

const { DEFAULT_TIMEOUT_MS, encodeFormFields } = protocol;

/**
 * 发一个 application/x-www-form-urlencoded 的 POST。
 *
 * ⚠ 刻意**不用全局 fetch**，改用 node:http/https + `agent: false`。
 *   原因：切网卡之后，连接池里残留的 socket 绑的是已经失效的源 IP，
 *   复用它会把请求打到旧链路上。而 `fetch`/undici 会把 `Connection` 当成
 *   禁止设置的请求头**静默丢弃**（实测：不报错、但也没生效），
 *   拿不到"每次新建连接"的语义。
 *   社区项目 AutoLogin-CQU 在 Windows（`WINHTTP_DISABLE_KEEP_ALIVE`）
 *   和 Linux（`CURLOPT_FRESH_CONNECT`/`FORBID_REUSE`）两端都显式关掉了
 *   keep-alive，正是为了这个 —— 这是"网络切换瞬间"最实际的一条对策。
 *
 * @param {string} url
 * @param {object} fields
 * @param {{timeoutMs?:number, referer?:string}} [opts]
 * @returns {Promise<{ok:boolean, status?:number, text?:string, error?:string}>}
 */
function postForm(url, fields, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const body = encodeFormFields(fields);

  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      resolve({ ok: false, error: 'bad-url: ' + e.message });
      return;
    }

    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? require('node:https') : require('node:http');

    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Content-Length': Buffer.byteLength(body),
      // 配合 agent:false，明确告诉对端用完就关
      Connection: 'close',
      // 伪装成普通浏览器：有些门户会对非浏览器 UA 直接断连
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
    };
    if (opts.referer) headers.Referer = opts.referer;

    // 防止 'error' 与 'end' 都触发导致 resolve 两次
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };

    let req;
    try {
      req = mod.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || (isHttps ? 443 : 80),
          path: u.pathname + u.search,
          method: 'POST',
          agent: false, // ← 每次新建连接，不复用连接池
          headers,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            done({ ok: true, status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') })
          );
          res.on('error', (e) => done({ ok: false, error: 'response: ' + e.message }));
        }
      );
    } catch (e) {
      done({ ok: false, error: 'request: ' + e.message });
      return;
    }

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (e) => done({ ok: false, error: e.message === 'timeout' ? 'timeout' : e.message }));
    req.end(body);
  });
}

/** Node 侧的 transport，供 Core 的 runHttpLogin 使用 */
const nodeTransport = { postForm };

/**
 * 执行一次纯 HTTP 登录（Windows 侧入口：默认用 Node transport）。
 * @param {object} opts 见 eportal-protocol.runHttpLogin
 */
function runHttpLogin(opts) {
  return protocol.runHttpLogin({ ...(opts || {}), transport: (opts && opts.transport) || nodeTransport });
}

module.exports = {
  ...protocol,
  postForm,
  nodeTransport,
  runHttpLogin,
};
