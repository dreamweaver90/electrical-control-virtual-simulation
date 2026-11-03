/**
 * 虚拟接线仿真系统 — 导线
 *
 * 每根导线连接两个端子，存储路径点数组和渲染属性。
 */

import { G } from './globals.js';

let _wireSeq = 0;

/**
 * 手动敷设导线的拐点圆角半径（px）：主配置 `wiring.electrical.cornerRadius`（缺省 18）。
 * 渲染 / 悬停命中 / 线标贴线三处共用同一取值入口，改配置即时生效（不在 Wire 上冻结）。
 */
export function wireCornerRadius() {
  const e = (G.config && G.config.wiring && G.config.wiring.electrical) || {};
  const v = Number(e.cornerRadius);
  return Number.isFinite(v) && v >= 0 ? v : 18;
}

export class Wire {
  /**
   * @param {Terminal} t1  源端子
   * @param {Terminal} t2  目标端子
   * @param {string} color  导线颜色
   * @param {number} thickness  线宽 (px)
   * @param {string} mode  "manual" | "auto"
   * @param {string} media  "electrical" | "pneumatic"（图构建/渲染按介质分支）
   */
  constructor(t1, t2, color, thickness, mode, media = 'electrical') {
    this.id = 'w_' + Date.now().toString(36) + '_' + (++_wireSeq);
    this.t1 = t1;
    this.t2 = t2;
    this.color = color;
    this.thickness = thickness;
    this.mode = mode;
    this.media = media;

    /** 路径点数组（面板坐标系）。
     *  manual = **拐点原始坐标**（端子起终点 + 用户逐个点下的拐点），渲染/命中/线标时用
     *           utils.roundCorners 按 wiring.electrical.cornerRadius 现场圆角化；
     *  auto   = 线槽路由折线 / 悬链线 4 点贝塞尔控制点。 */
    this.path = [];

    /** 45° 出线偏移方向（仅自动有槽模式使用） */
    this.offset1 = null;
    this.offset2 = null;

    /** 线标（右键导线配置，显示在导线末端，白底黑字顺向）；null/空 = 不显示 */
    this.label = null;

    /** 线标显示位置：'both'（两端，缺省）/ 'start'（仅起点侧）/ 'end'（仅终点侧） */
    this.labelSide = 'both';

    /** 创建时刻的面板宽度（窗口缩放时 manual 导线中间点按宽度比例重映射，保持与线槽相对位置） */
    this.widthAtDraw = 0;
  }
}
