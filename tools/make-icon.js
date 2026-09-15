#!/usr/bin/env node
'use strict';

/**
 * 生成应用图标（assets/icon.png + assets/icon.ico）。
 *
 * 为什么自己画而不用现成素材：
 *   - 不能用扬州大学校徽或任何官方 Logo —— 本项目与学校**没有隶属或授权关系**，
 *     用校徽会造成"官方客户端"的误认。
 *   - 不想为了一个图标引入 sharp / png-to-ico 之类的依赖。
 *
 * 所以复用项目已有的 PNG 编码器（src/main/tray-icons.js 的 encodePng），
 * 自己画一个通用图形：圆角方块 + 三根信号柱。
 * 16px 下也能看清，且不指向任何具体机构。
 *
 * 用法：node tools/make-icon.js
 */

const fs = require('fs');
const path = require('path');
const { encodePng } = require(path.join(__dirname, '..', 'src', 'main', 'tray-icons.js'));

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'assets');

// 品牌色：干净的蓝，深色背景上也够亮
const BG = [31, 111, 235];
const FG = [255, 255, 255];

const AA = 4; // 超采样倍数，用于抗锯齿

/**
 * 画一张图标。
 * @param {number} size 目标边长
 * @returns {Buffer} RGBA 像素
 */
function render(size) {
  const S = size * AA;
  const rgba = Buffer.alloc(S * S * 4, 0);

  const radius = S * 0.22;

  // 圆角方块的"有符号距离"：<=0 表示在内部
  function insideRoundedSquare(x, y) {
    const cx = Math.abs(x - S / 2) - (S / 2 - radius);
    const cy = Math.abs(y - S / 2) - (S / 2 - radius);
    const dx = Math.max(cx, 0);
    const dy = Math.max(cy, 0);
    const outside = Math.sqrt(dx * dx + dy * dy);
    const inside = Math.min(Math.max(cx, cy), 0);
    return outside + inside - radius;
  }

  // 三根信号柱
  const barW = S * 0.14;
  const gap = S * 0.09;
  const totalW = barW * 3 + gap * 2;
  const left = (S - totalW) / 2;
  const baseline = S * 0.77;
  const heights = [S * 0.3, S * 0.46, S * 0.62];
  const bars = heights.map((h, i) => ({ x0: left + i * (barW + gap), x1: left + i * (barW + gap) + barW, y0: baseline - h, y1: baseline }));

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = x + 0.5;
      const py = y + 0.5;

      // 背景：圆角方块
      if (insideRoundedSquare(px, py) > 0) continue;

      let color = BG;

      // 前景：信号柱
      for (const b of bars) {
        if (px >= b.x0 && px <= b.x1 && py >= b.y0 && py <= b.y1) {
          color = FG;
          break;
        }
      }

      const o = (y * S + x) * 4;
      rgba[o] = color[0];
      rgba[o + 1] = color[1];
      rgba[o + 2] = color[2];
      rgba[o + 3] = 255;
    }
  }

  // 降采样（盒式滤波）到目标尺寸
  if (AA === 1) return rgba;
  const out = Buffer.alloc(size * size * 4);
  const n = AA * AA;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let dy = 0; dy < AA; dy++) {
        for (let dx = 0; dx < AA; dx++) {
          const o = ((y * AA + dy) * S + (x * AA + dx)) * 4;
          const al = rgba[o + 3] / 255;
          r += rgba[o] * al;
          g += rgba[o + 1] * al;
          b += rgba[o + 2] * al;
          a += rgba[o + 3];
        }
      }
      const o = (y * size + x) * 4;
      const aAvg = a / n;
      const wsum = a / 255 || 1;
      out[o] = Math.round(r / wsum);
      out[o + 1] = Math.round(g / wsum);
      out[o + 2] = Math.round(b / wsum);
      out[o + 3] = Math.round(aAvg);
    }
  }
  return out;
}

/** 把多张 PNG 打包成 .ico（Vista+ 支持 PNG 压缩的图标项） */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + 16 * entries.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o); // 256 记作 0
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1);
    dir.writeUInt8(0, o + 2); // 调色板数
    dir.writeUInt8(0, o + 3); // reserved
    dir.writeUInt16LE(1, o + 4); // 色平面
    dir.writeUInt16LE(32, o + 6); // 位深
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

// ── 执行 ──
fs.mkdirSync(OUT_DIR, { recursive: true });

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const entries = [];

for (const size of ICO_SIZES) {
  const png = encodePng(size, size, render(size));
  entries.push({ size, png });
}

// ICO
const ico = buildIco(entries);
const icoPath = path.join(OUT_DIR, 'icon.ico');
fs.writeFileSync(icoPath, ico);

// PNG：electron-builder 对 Windows 会自己把 PNG 转成 ico，
// 这里额外给一张 512 的大图（README、商店等场合用得上）
const big = encodePng(512, 512, render(512));
const pngPath = path.join(OUT_DIR, 'icon.png');
fs.writeFileSync(pngPath, big);

console.log('已生成:');
console.log('  ' + icoPath + '  (' + ico.length + ' 字节, 含 ' + ICO_SIZES.join('/') + ' 共 ' + ICO_SIZES.length + ' 个尺寸)');
console.log('  ' + pngPath + '  (' + big.length + ' 字节, 512x512)');
