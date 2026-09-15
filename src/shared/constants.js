'use strict';

/**
 * 全局常量：状态枚举、默认探测点、厂商指纹、关键字
 * main / renderer / tools 共用，避免各处重复定义。
 */

/** 网络状态四态。注意：必须严格区分「需要认证」和「链路没起来」，处理逻辑完全不同。 */
const NET_STATE = {
  ONLINE: 'ONLINE', // 已联网
  PORTAL: 'PORTAL', // 需要门户认证
  NO_LINK: 'NO_LINK', // 链路/DHCP/DNS 未就绪
  UNKNOWN: 'UNKNOWN',
};

/** 单个探测点的判定结果 */
const PROBE_VERDICT = {
  ONLINE: 'online',
  PORTAL_REDIRECT: 'portal-redirect', // 被 30x 跳转
  HIJACKED: 'hijacked', // 200 但内容被替换
  UNREACHABLE: 'unreachable',
};

/** 自动连接状态机（Phase 3 使用，Phase 1 只用到 IDLE/CONNECTING） */
const CONNECT_STATE = {
  IDLE: 'IDLE',
  CHECKING: 'CHECKING',
  CONNECTING: 'CONNECTING',
  PAUSED: 'PAUSED',
  NEEDS_ATTENTION: 'NEEDS_ATTENTION', // 凭证错误等需要人工处理
};

/** 浏览器 UA。部分门户按 UA 返回不同页面，可被配置覆盖。 */
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 连通性探测点。
 * 设计要点：
 *  - 全部走 HTTP(80)，因为门户劫持的就是 80 端口的明文请求；
 *  - 任一探测点返回期望内容即判定为已联网（避免某个站点被墙就误判为断网）；
 *  - 使用 Windows NCSI 自己的地址，门户白名单通常对它放行，行为最接近系统判断。
 */
const DEFAULT_PROBES = [
  {
    name: 'Windows NCSI',
    url: 'http://www.msftconnecttest.com/connecttest.txt',
    kind: 'body',
    expect: 'Microsoft Connect Test',
  },
  { name: 'MIUI generate_204', url: 'http://connect.rom.miui.com/generate_204', kind: '204' },
  {
    name: 'Firefox detectportal',
    url: 'http://detectportal.firefox.com/success.txt',
    kind: 'body',
    expect: 'success',
  },
];

/** 门户 URL 兜底发现入口（Windows / Firefox 官方用来索取门户地址的端点） */
const PORTAL_DISCOVERY_ENDPOINTS = [
  { name: 'Windows NCSI redirect', url: 'http://www.msftconnecttest.com/redirect' },
  { name: 'Firefox captive portal', url: 'http://detectportal.firefox.com/canonical.html' },
];

/** 门户厂商指纹，用于给出适配器建议 */
const VENDOR_FINGERPRINTS = [
  { vendor: '深澜 Srun', re: /srun|get_challenge|深澜|srun_portal|\bac_id\b|index\.js\?v=/i },
  { vendor: 'Dr.COM 城市热点', re: /drcom|dr1003|wlanuserip|wlanacname|\b0\.htm\b|城市热点/i },
  { vendor: '锐捷 Ruijie ePortal', re: /eportal|ruijie|锐捷|portal\/login|\.portal\./i },
  { vendor: '华为 Huawei', re: /hwportal|huawei|agile\s*controller|\bportal\.do\b/i },
  { vendor: 'H3C', re: /h3c|华三|newportal|portal\/login\.html/i },
  { vendor: 'IPortal/城市热点', re: /iportal|\bcityhot\b/i },
];

/** 值得关注的关键字：出现 get_challenge 基本可断定是深澜系 JS 加密登录 */
const KEYWORDS = [
  'get_challenge', 'challenge', 'callback', 'encrypt', 'Encrypt', 'AES', 'aes',
  'md5', 'MD5', 'sha1', 'SHA1', 'base64', 'encodeURIComponent',
  'password', 'pwd', 'passwd', 'username', 'user_name', 'userId', 'account',
  'ac_id', 'wlanuserip', 'wlanacname', 'nasip', 'nasid', 'ssid', 'mac',
  'domain', 'operator', 'isp', 'service', 'nettype', 'serviceType',
  '校园网', '运营商', '中国移动', '中国联通', '中国电信', '移动', '联通', '电信',
  '登录', '登陆', '密码', '账号', '帐号',
];

/**
 * 已知的"正常互联网主机"。
 * 不处于门户状态时，探测端点会 30x 跳到这些地址（例如 Windows NCSI 跳到 go.microsoft.com），
 * 必须排除，否则会被误当成门户登录页。
 *
 * 另外把系统/浏览器的探测主机也一并排除：它们本身是"用来探测网络"的，
 * 永远不可能是门户登录页，出现在候选里一定是误判。
 */
const NON_PORTAL_HOST_RE =
  /(^|\.)(microsoft\.com|msn\.com|live\.com|windows\.com|office\.com|bing\.com|firefox\.com|mozilla\.org|mozilla\.net|gstatic\.com|google\.com|googleapis\.com|gvt1\.com|apple\.com|icloud\.com|miui\.com|xiaomi\.com|baidu\.com|qq\.com|taobao\.com|alibaba\.com|amazon\.com|akamai\.net|cloudflare\.com|ubuntu\.com|debian\.org|archlinux\.org|fedoraproject\.org|msftncsi\.com|msftconnecttest\.com|detectportal\.firefox\.com|connect\.rom\.miui\.com|connectivitycheck\.[a-z.]+)$/i;

/**
 * 管理/后台登录页的特征。
 *
 * 为什么要单独识别：锐捷 RG-SAM+ 这类设备除了学生认证门户，还挂了一个**管理员登录页**
 * （实测 http://10.245.2.19/eportal/ 就是，action="./admin.do?method=login"，还带校验码）。
 * 如果门户发现环节误选了它，程序会把学生的校园网账号密码填进管理员登录框 —— 这是必须避免的。
 * 命中这些特征时必须**拒绝使用**，绝不上报任何凭证。
 */
const ADMIN_PAGE_RE =
  /(admin\.do|RG-SAM|网络访问门户系统|管理后台|后台管理|系统管理|管理员登录|设备管理|维护管理)/i;

/** 默认轮询间隔（毫秒）——刻意低频，避免产生不必要的网络流量 */
const POLL_INTERVAL = {
  ONLINE: 45000, // 已联网：45 秒一次
  PORTAL: 5000, // 需要认证：5 秒一次（正在处理，需要及时反应）
  NO_LINK: 5000, // 链路未就绪：5 秒一次
  IDLE_AFTER: 30000,
};

/** 失败退避序列：5s → 10s → 30s → 之后进入暂停 */
const RETRY_BACKOFF_MS = [5000, 10000, 30000];
/** 首次暂停时长 */
const RETRY_PAUSE_MS = 5 * 60 * 1000;
/**
 * 暂停时长上限。
 *
 * 为什么暂停要逐次翻倍：暂停结束后退避阶梯会重新开始（见 auto-connect.js），
 * 这样短暂波动能很快恢复（最多等一次暂停），但如果是门户真的挂了，
 * 每轮"3 次快速重试 + 一次暂停"里的快速重试就不该一直保持 5 分钟一轮 ——
 * 否则既会反复打开隐藏浏览器（不必要的流量），又拖长了恢复时间。
 * 5 → 10 → 20 → 30(封顶) 分钟，兼顾两者。
 */
const RETRY_PAUSE_MAX_MS = 30 * 60 * 1000;

module.exports = {
  NET_STATE,
  PROBE_VERDICT,
  CONNECT_STATE,
  DEFAULT_UA,
  DEFAULT_PROBES,
  PORTAL_DISCOVERY_ENDPOINTS,
  VENDOR_FINGERPRINTS,
  KEYWORDS,
  NON_PORTAL_HOST_RE,
  ADMIN_PAGE_RE,
  POLL_INTERVAL,
  RETRY_BACKOFF_MS,
  RETRY_PAUSE_MS,
  RETRY_PAUSE_MAX_MS,
};
