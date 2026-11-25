/**
 * 徘徊の状態機械を検証する。描画や three は使わない。
 */
import { describe, expect, it } from 'vitest';
import {
  WANDER_TUNING,
  applyWander,
  bobY,
  createWander,
  setHome,
  stepWander,
  type WanderState,
} from './wander.js';

/** テスト内の乱数源。分配を固定するため mulberry32 を使う。 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function snapshot(state: WanderState): number[] {
  return [
    state.homeX,
    state.homeZ,
    state.x,
    state.z,
    state.yaw,
    state.timer,
    state.tx,
    state.tz,
    state.targetYaw,
    state.speed,
    state.vmax,
    state.phase,
    state.rng,
  ];
}

describe('wander', () => {
  it('同じ種からは同じ軌跡になる', () => {
    const random = mulberry32(42);
    const dts = Array.from({ length: 2000 }, () => random() / 30);
    const first = createWander({ x: 1, z: -2 }, 123);
    const second = createWander({ x: 1, z: -2 }, 123);
    const firstModes: string[] = [];
    const secondModes: string[] = [];
    for (const dt of dts) {
      stepWander(first, dt);
      stepWander(second, dt);
      firstModes.push(first.mode);
      secondModes.push(second.mode);
    }
    expect(secondModes).toEqual(firstModes);
    expect(snapshot(second)).toEqual(snapshot(first));
    // 歩行も転回も起きること（決定性の確認が空振りでないことの裏付け）。
    expect(new Set(firstModes).size).toBeGreaterThan(1);
  });

  it('1万ステップでも NaN が出ず、円（+0.05）から外れない', () => {
    const random = mulberry32(7);
    const state = createWander({ x: 0, z: -5 }, 99);
    for (let i = 0; i < 10000; i++) {
      stepWander(state, random() / 30);
      for (const value of snapshot(state)) {
        expect(Number.isNaN(value)).toBe(false);
      }
      const off = Math.hypot(state.x - state.homeX, state.z - state.homeZ);
      expect(off).toBeLessThanOrEqual(WANDER_TUNING.radius + 0.05);
    }
  });

  it('十分な時間で目的地に到着して待機に戻る', () => {
    const state = createWander({ x: 0, z: 0 }, 5);
    let sawWalk = false;
    let backToIdle = false;
    for (let i = 0; i < 60 * 60 && !backToIdle; i++) {
      stepWander(state, 1 / 60);
      if (state.mode === 'walk') sawWalk = true;
      else if (sawWalk && state.mode === 'idle') backToIdle = true;
    }
    expect(sawWalk).toBe(true);
    expect(backToIdle).toBe(true);
    // 到着時は目的地の近傍にいる。
    expect(Math.hypot(state.tx - state.x, state.tz - state.z)).toBeLessThanOrEqual(0.5);
  });

  it('無効化では home に一致し正面を向く', () => {
    const state = createWander({ x: 0, z: 0 }, 11);
    for (let i = 0; i < 600; i++) stepWander(state, 1 / 60);
    setHome(state, { x: 3, z: -4 }, false);
    expect(state.x).toBe(3);
    expect(state.z).toBe(-4);
    expect(state.yaw).toBe(0);
    expect(state.mode).toBe('idle');
  });

  it('円の外からの有効化では瞬間移動せず、時間経過で新円内に入る', () => {
    const state = createWander({ x: 0, z: 0 }, 13);
    const before = { x: state.x, z: state.z };
    setHome(state, { x: 10, z: 10 }, true);
    // その場から歩行を始める（瞬間移動しない）。
    expect(state.x).toBe(before.x);
    expect(state.z).toBe(before.z);
    expect(state.mode).toBe('walk');
    let inside = false;
    for (let i = 0; i < 60 * 60 && !inside; i++) {
      stepWander(state, 1 / 60);
      inside = Math.hypot(state.x - 10, state.z - 10) <= WANDER_TUNING.radius;
    }
    expect(inside).toBe(true);
  });

  it('上下動は歩行中だけ 0〜bob になる', () => {
    const state = createWander({ x: 0, z: 0 }, 17);
    for (let i = 0; i < 60 * 30; i++) {
      stepWander(state, 1 / 60);
      const bob = bobY(state);
      expect(bob).toBeGreaterThanOrEqual(0);
      expect(bob).toBeLessThanOrEqual(WANDER_TUNING.bob);
      if (state.mode !== 'walk') expect(bob).toBe(0);
    }
  });

  it('applyWander は位置と baseYaw 込みの向きを反映する', () => {
    const state = createWander({ x: 1, z: 2 }, 19);
    state.yaw = 0.5;
    const positionCalls: number[][] = [];
    const root = {
      position: { set: (...values: number[]) => void positionCalls.push(values) },
      rotation: { y: 0 },
    };
    applyWander(state, root as never, Math.PI);
    expect(positionCalls).toEqual([[1, bobY(state), 2]]);
    expect(root.rotation.y).toBeCloseTo(Math.PI + 0.5, 10);
  });

  it('円外からの有効化では瞬間移動せず、速度×dt 以内で歩いて入る', () => {
    const state = createWander({ x: 0, z: 0 }, 23);
    setHome(state, { x: 2.4, z: 0 }, true);
    const dt = 1 / 60;
    const bound = (WANDER_TUNING.speedMax + WANDER_TUNING.accel * dt) * dt + 1e-9;
    let previous = { x: state.x, z: state.z };
    // 最初の1ステップで飛ばないこと（安全クランプの誤作動は 2m 超の移動になる）。
    stepWander(state, dt);
    expect(Math.hypot(state.x - previous.x, state.z - previous.z)).toBeLessThanOrEqual(0.02);
    previous = { x: state.x, z: state.z };
    let arrived = false;
    for (let i = 0; i < 60 * 10 && !arrived; i++) {
      stepWander(state, dt);
      const step = Math.hypot(state.x - previous.x, state.z - previous.z);
      expect(step).toBeLessThanOrEqual(bound);
      previous = { x: state.x, z: state.z };
      arrived = Math.hypot(state.x - 2.4, state.z) <= WANDER_TUNING.radius;
    }
    expect(arrived).toBe(true);
  });

  it('待機短縮は無効からの有効化のときだけ行う', () => {
    const state = createWander({ x: 0, z: 0 }, 29);
    expect(state.enabled).toBe(true);
    // 有効中の再設定ではタイマーを変えない（layout の連続呼び出しで短縮されない）。
    state.timer = 2;
    state.mode = 'idle';
    setHome(state, { x: 0, z: 0 }, true);
    expect(state.timer).toBe(2);
    // 無効化してから有効化すると待機が短縮される。
    setHome(state, { x: 0, z: 0 }, false);
    state.timer = 2;
    state.mode = 'idle';
    setHome(state, { x: 0, z: 0 }, true);
    expect(state.timer).toBeLessThanOrEqual(0.5);
  });
});
