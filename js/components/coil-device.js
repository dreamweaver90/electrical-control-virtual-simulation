/**
 * 虚拟接线仿真系统 — 线圈器件（coil-device.js）
 *
 * CoilDeviceInstance：接触器/继电器/时间继电器/热继电器共一类（多线圈独立得电判定）。
 *   线圈得电判定（loads 条目两端 |U| 滞回比较器，逐条目独立）→ 各自状态键；
 *   线圈电气属性统一从器件级 params 读取（对器件内所有线圈条目生效）：
 *     params.coilVoltage  额定电压（未配/≤0 = 不判定得电）
 *     params.coilType     供电制式 'ac'/'dc'（配了才校验 ac/dc 岛；未配不校验）
 *     params.pickup/dropout 吸合/释放阈值比例（缺省 0.85/0.6）
 *     params.delayTime    通电/断电延时秒（未配/≤0 = 无延时）
 *   条目级字段（每条目独立）：
 *     state      得电状态键（必配；触点 when 引用）
 *     tonState/tofState 延时动作显示状态键（配了 delayTime 才需要；触点 when 引用）
 *     delayForceKey 延时计时动作源的强制信号键（仅计时用，不写 state）
 *   （条目级 voltage/voltageType/pickup/dropout/ton/tof 为旧设计残留，已废弃不生效——
 *     线圈电气属性一律写器件级 params，见上。）
 *   热继电器过载判定（逐 sensors 条目独立，条目级字段）：
 *     tripKey     该组过载闭锁写到哪个 params 键（缺省 'tripped'）
 *     setting     该组整定电流 A（数值字面量，或 params 键名引用；缺省回退 params.heaterSetting；仍无 → 不判定）
 *     tripDelay   该组动作延时 秒（数值字面量，或 params 键名引用；缺省回退 params.tripDelay；仍无 → 8s）
 *   （组间互不影响：各自整定/计时/输出/闭锁；共用同一 tripKey = 逻辑或；复位按 zone.state 逐组）
 *   触点闭合情况全部由配置 when/timing 驱动（基类求值器），本类不覆盖 closedContactPairs。
 */
import { ComponentInstance } from './component-base.js';
import { judgeCoilEntry } from './coil-judge.js';

export class CoilDeviceInstance extends ComponentInstance {
  constructor(def, rowIndex) {
    super(def, rowIndex);
    // 逐线圈状态（entryKey → 值）：多线圈独立得电/延时计时，互不干扰
    this._coilEnergized = new Map();   // entryKey → bool（该线圈当前得电状态）
    this._tonStart = new Map();        // entryKey → ms（通电延时计时起点；失电清零不累加）
    this._tofStart = new Map();        // entryKey → ms（断电延时复位计时起点）
    this._tonActive = new Map();       // entryKey → bool（通电延时动作：得电 && 计时满）
    this._tofActive = new Map();       // entryKey → bool（断电延时保持：得电立刻 true，失电计时满复位）
    this._ovStartMap = new Map();      // entryKey → ms（每组热元件独立的过载计时起点）
    this._nowMs = 0;                   // 本 tick 电气仿真时间（ctx.tickMs；延时/过载计时用，后台节流不失真）
  }

  /* ---- 参数解析（延时统一从 params 读取，针对器件内所有线圈生效） ---- */

  /** 延时毫秒数：params.delayTime（所有线圈共用；未配/≤0 → 0 无延时） */
  _delayMs() {
    const d = this.params && this.params.delayTime;
    return (d && d > 0) ? d * 1000 : 0;
  }

  /* ---- 每 tick 扫描 ---- */

  scan(G, ctx) {
    super.scan(G, ctx);   // 基类：when/timing 触点求值
    // 电气时序仿真时间基准（tick 计数 × 名义周期；机械积分/UI 告警计时用墙钟）
    this._nowMs = (ctx && ctx.tickMs) || Date.now();
    let changed = false;

    // 逐线圈独立判定（多线圈互不干扰；断路故障强制失电/数值层滞回判定 = 共享模块 judgeCoilEntry）
    for (const e of this.pairEntries.loads) {
      if (e.computed) continue;   // 计算型负载（电机绕组）不参与线圈判定
      const en = judgeCoilEntry(this, e, ctx);
      if (this._coilEnergized.get(e.key) !== en) changed = this._applyCoilEnergized(e, en) || changed;
      if (this._delayMs() > 0) {
        // 延时计时每 tick 驱动（含断路故障分支——TOF 复位计时不能冻结）；
        // 动作源：线圈得电 ∨ 条目 delayForceKey 引用的强制信号键（仅 ton/tof 计时用，不写 state）
        const act = en || (e.delayForceKey && !!this.params[e.delayForceKey]);
        changed = this._tickCoilDelay(e, act) || changed;
      }
    }

    // 热继电器过载判定（配置了 sensors 条目即启用；各组独立计时/闭锁，保持到逐组复位）
    if (this.pairEntries.sensors.length) changed = this._tickOverload(G, ctx) || changed;
    return changed;   // engine 按返回值集中 refreshDisplay
  }

  /** 热继电器动作延时毫秒数（器件级缺省：params.tripDelay，未配/≤0 → 8 秒） */
  _tripDelayMs() {
    const d = this.params && this.params.tripDelay;
    return (d && d > 0) ? d * 1000 : 8000;
  }

  /**
   * 条目级数值解析（setting/tripDelay 通用）：
   *   number → 字面量；string → params 同名键引用；其余/引用缺失 → fallbackKey 指定的 params 键 → null。
   */
  _entryNum(e, field, fallbackKey) {
    const v = e[field];
    if (typeof v === 'number' && !Number.isNaN(v)) return v;
    if (typeof v === 'string') {
      const r = this.params[v];
      if (typeof r === 'number' && !Number.isNaN(r)) return r;
    }
    if (fallbackKey) {
      const f = this.params[fallbackKey];
      if (typeof f === 'number' && !Number.isNaN(f)) return f;
    }
    return null;
  }

  /** 该组整定电流 A：条目 setting（数值或 params 键名）→ params.heaterSetting → Infinity（不判定过载） */
  _entrySetting(e) {
    const v = this._entryNum(e, 'setting', 'heaterSetting');
    return v === null ? Infinity : v;
  }

  /** 该组动作延时 ms：条目 tripDelay（数值或 params 键名）→ params.tripDelay（缺省 8s） */
  _entryTripDelayMs(e) {
    const v = this._entryNum(e, 'tripDelay', null);
    return (v !== null && v > 0) ? v * 1000 : this._tripDelayMs();
  }

  /**
   * 热继电器过载判定（每 tick，数值层电流，**逐 sensors 条目独立**）：
   * 该组任一对 |I| > 该组整定值 → 该组过载持续计时 → 该组 tripDelay 秒后 params[tripKey] = true（闭锁）。
   * 组间互不影响；共用同一 tripKey 时即逻辑或（任一置真）。sensors 接在哪就测哪（物理量），无电机匹配启发式。
   */
  _tickOverload(G, ctx) {
    const solve = ctx && ctx.solve;
    if (!solve) return false;
    const now = this._nowMs;   // 仿真时间（tick 计数，后台节流不失真）
    let changed = false;
    for (const e of this.pairEntries.sensors) {
      const key = e.tripKey || 'tripped';
      const delayMs = this._entryTripDelayMs(e);
      let overloaded = false;
      if (delayMs > 0 && !this.params[key]) {   // 已闭锁的组不再计时（等复位）
        const setting = this._entrySetting(e);
        for (let i = 0; i < e.pairs.length; i++) {
          const cur = solve.currentOf(this, 'sensor:' + e.key + ':' + i);
          if (cur && Math.hypot(cur.re, cur.im) > setting) { overloaded = true; break; }
        }
      }
      if (!overloaded) { this._ovStartMap.delete(e.key); continue; }   // 不过载 / 已闭锁 / 无延时 → 计时清零
      if (!this._ovStartMap.has(e.key)) this._ovStartMap.set(e.key, now);
      if (now - this._ovStartMap.get(e.key) >= delayMs) {
        this.params[key] = true;   // 该组热触点动作（保持到逐组复位）
        this._ovStartMap.delete(e.key);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * 热继电器复位（zones action="reset" 点击）：**按 zone.state 逐组复位**——
   *   zone.state = 某组 tripKey → 只复位该组（该键置 false + 该组过载计时清零）；
   *   未配 state（旧配置）→ 兼容回退：复位全部组的 tripKey + 缺省键 'tripped'，并清全部计时。
   */
  handleZoneAction(id, action, phase) {
    super.handleZoneAction(id, action, phase);   // 基类通用 zone.state 绑定（强制热区 toggle 等）
    if (action !== 'reset' || phase !== 'down') return;
    const z = this.definition.zones && this.definition.zones.find(z => z.id === id);
    const state = (z && z.state) ? z.state : null;
    const groups = this.pairEntries.sensors;
    let changed = false;
    if (state) {
      if (this.params[state]) { this.params[state] = false; changed = true; }   // 只复位该组
      for (const e of groups) if ((e.tripKey || 'tripped') === state) this._ovStartMap.delete(e.key);
    } else {
      const keys = new Set(groups.map(e => e.tripKey || 'tripped'));
      keys.add('tripped');   // 旧配置缺省键
      for (const k of keys) if (this.params[k]) { this.params[k] = false; changed = true; }
      this._ovStartMap.clear();
    }
    if (changed) this.refreshDisplay();
  }

  /** 应用单线圈得电状态（按条目 state 键写；上升沿：ton 计时开始 + tof 立刻动作；下降沿：ton 立刻复位 + tof 开始复位计时） */
  _applyCoilEnergized(e, energized) {
    const key = e.state || 'energized';
    this._coilEnergized.set(e.key, energized);
    this.params[key] = energized;   // 参数容器（显示键驱动图层显隐/触点 when）
    const now = this._nowMs;   // 仿真时间（tick 计数，后台节流不失真）
    if (energized) {
      this._tonStart.set(e.key, now);      // ton 开始计时（重新计时，不累加）
      this._tofStart.delete(e.key);        // 复位计时中断
    } else {
      this._tonActive.set(e.key, false);   // ton 立刻复位
      this._tonStart.delete(e.key);        // 计时清零（提前失电不累加）
      this._tofStart.set(e.key, now);      // tof 开始复位计时
    }
    return true;
  }

  /**
   * 每 tick 单线圈延时计时（params.delayTime > 0 时调用，所有线圈共用同一延时值；更新动作状态与显示状态键 tonState/tofState）。
   * act = 动作源（线圈得电 ∨ 强制）：ton 在 act 上升沿开始计时、act=false 立即复位；
   * tof 在 act=true 立即动作（保持）、act=false 开始复位计时、计时满复位。
   */
  _tickCoilDelay(e, act) {
    const delayMs = this._delayMs();
    if (delayMs <= 0) return false;
    const now = this._nowMs;   // 仿真时间（tick 计数，后台节流不失真）
    let changed = false;
    if (act) {
      if (this._tonStart.get(e.key) === undefined) this._tonStart.set(e.key, now);   // 参数重置后补起点
      if (!this._tonActive.get(e.key) && now - this._tonStart.get(e.key) >= delayMs) {
        this._tonActive.set(e.key, true);
        changed = true;
      }
      if (!this._tofActive.get(e.key)) { this._tofActive.set(e.key, true); changed = true; }   // tof 立即动作（保持）
      this._tofStart.delete(e.key);
    } else {
      if (this._tonActive.get(e.key)) { this._tonActive.set(e.key, false); changed = true; }   // ton 立即复位
      this._tonStart.delete(e.key);
      if (this._tofStart.get(e.key) === undefined) this._tofStart.set(e.key, now);
      if (this._tofActive.get(e.key) && now - this._tofStart.get(e.key) >= delayMs) {
        this._tofActive.set(e.key, false);
        changed = true;
      }
    }
    // 显示状态键：条目 tonState/tofState（配置必配；无 bind/when 引用的键不写）
    const keys = this.definition.bindKeys();
    const tonKey = (e.tonState && keys.includes(e.tonState)) ? e.tonState : null;
    const tofKey = (e.tofState && keys.includes(e.tofState)) ? e.tofState : null;
    if (tonKey) {
      const v = act && !!this._tonActive.get(e.key);   // ton_delayed：动作源计时满 true；动作源消失立即 false
      if (this.params[tonKey] !== v) { this.params[tonKey] = v; changed = true; }
    }
    if (tofKey) {
      const v = !!this._tofActive.get(e.key);          // tof_delayed：保持状态本身（动作源在/保持期内 true，计时满 false）
      if (this.params[tofKey] !== v) { this.params[tofKey] = v; changed = true; }
    }
    return changed;
  }

  /** 参数更新回调：延时/电压参数变化 → 重置全部线圈计时（下次得电重新计时） */
  onParamsChanged() {
    for (const e of this.pairEntries.loads) {
      this._tonStart.delete(e.key);
      this._tofStart.delete(e.key);
      this._tonActive.delete(e.key);
      this._tofActive.delete(e.key);
    }
    this._ovStartMap.clear();   // 过载计时清零（整定/延时参数变化）
    const keys = this.definition.bindKeys();
    for (const e of this.pairEntries.loads) {
      if (e.tonState && keys.includes(e.tonState)) this.params[e.tonState] = false;
      if (e.tofState && keys.includes(e.tofState)) this.params[e.tofState] = false;
    }
  }
}
