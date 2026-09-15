'use strict';

/**
 * 托盘图标：用代码生成 PNG，不往仓库里放二进制图片
 * ------------------------------------------------------------------
 * 为什么自己画：
 *   托盘图标要表达四种状态（已联网/未认证/离线/已暂停/需处理），
 *   如果放图片文件就得塞 5×2 个二进制资源进仓库，还得维护它们；
 *   而图标本身只是一个带状态的圆点，程序生成更简单也更好改。
 *
 * 实现：手写最小 PNG 编码器（RGBA + zlib），并用 4 倍超采样做抗锯齿。
 *       只依赖 Node 内置的 zlib，没有第三方库。
 */

const zlib = require('zlib');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------------------------------------------------------------- CRC32

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * 把 RGBA 像素编码成 PNG。
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgba 长度必须是 width*height*4
 */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型 6 = RGBA
  ihdr[10] = 0; // 压缩方法
  ihdr[11] = 0; // 滤波方法
  ihdr[12] = 0; // 非隔行

  // 每行前面加一个滤波字节 0（None）
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- 画圆点

function parseColor(c) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(c).trim());
  if (!m) return { r: 0, g: 0, b: 0 };
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

/**
 * 画一个带描边的实心圆。
 * 用 SS 倍超采样（默认 4）来得到平滑边缘，避免锯齿在小尺寸下很难看。
 *
 * @param {number} size    输出边长（像素）
 * @param {string} fill    填充色 #rrggbb
 * @param {string} [ring]  描边色；不传则用填充色的深色版
 * @returns {Buffer} PNG 数据
 */
function renderCirclePng(size, fill, ring) {
  const SS = 4; // 超采样倍数
  const S = size * SS;
  const cx = (S - 1) / 2;
  const cy = (S - 1) / 2;
  const outer = S / 2 - SS * 0.5; // 留出一点边距，避免贴边被裁
  const inner = outer - Math.max(SS, S * 0.08);

  const fc = parseColor(fill);
  const rc = ring ? parseColor(ring) : {
    r: Math.round(fc.r * 0.55),
    g: Math.round(fc.g * 0.55),
    b: Math.round(fc.b * 0.55),
  };

  // 先在超采样分辨率上画，再降采样平均
  const acc = new Float32Array(size * size * 4);

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d = Math.hypot(x - cx, y - cy);
      let r = 0, g = 0, b = 0, a = 0;
      if (d <= inner) {
        r = fc.r; g = fc.g; b = fc.b; a = 255;
      } else if (d <= outer) {
        // 描边带
        const t = (d - inner) / Math.max(1e-6, outer - inner);
        r = Math.round(fc.r + (rc.r - fc.r) * t);
        g = Math.round(fc.g + (rc.g - fc.g) * t);
        b = Math.round(fc.b + (rc.b - fc.b) * t);
        a = 255;
      } else {
        // 边缘 1 像素内做线性淡出，进一步平滑
        const fade = 1 - Math.min(1, (d - outer) / SS);
        if (fade <= 0) continue;
        r = rc.r; g = rc.g; b = rc.b; a = Math.round(255 * fade);
      }
      const dx = Math.floor(x / SS);
      const dy = Math.floor(y / SS);
      const o = (dy * size + dx) * 4;
      acc[o] += r;
      acc[o + 1] += g;
      acc[o + 2] += b;
      acc[o + 3] += a;
    }
  }

  const n = SS * SS;
  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    const a = acc[o + 3] / n;
    if (a <= 0) continue;
    // 预乘还原：颜色按 alpha 加权平均后除以 a
    rgba[o] = Math.min(255, Math.round(acc[o] / n / (a / 255) || 0));
    rgba[o + 1] = Math.min(255, Math.round(acc[o + 1] / n / (a / 255) || 0));
    rgba[o + 2] = Math.min(255, Math.round(acc[o + 2] / n / (a / 255) || 0));
    rgba[o + 3] = Math.round(a);
  }

  return encodePng(size, size, rgba);
}

/**
 * 各种状态对应的图标配色。
 * 和界面上的状态点保持一致，一眼能对上。
 */
const STATE_COLORS = {
  online: ['#22a06b', '#166b46'], // 已联网
  portal: ['#d98b0b', '#8f5a06'], // 未认证
  offline: ['#9aa4b2', '#6b7280'], // 离线 / 未就绪
  paused: ['#2b6cb0', '#1d4c7d'], // 已暂停
  attention: ['#c0392b', '#7f261c'], // 需要人工处理
};

/**
 * 生成某状态、某尺寸的图标 PNG。
 * @param {string} state online|portal|offline|paused|attention
 * @param {number} size
 */
function iconPng(state, size = 16) {
  const c = STATE_COLORS[state] || STATE_COLORS.offline;
  return renderCirclePng(size, c[0], c[1]);
}

/** 生成 data URL，方便交给 nativeImage.createFromDataURL */
function iconDataUrl(state, size = 16) {
  return 'data:image/png;base64,' + iconPng(state, size).toString('base64');
}

module.exports = { encodePng, renderCirclePng, iconPng, iconDataUrl, crc32, STATE_COLORS, PNG_SIGNATURE };
