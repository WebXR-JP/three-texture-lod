/**
 * selectLevel の仕様固定テスト。
 *
 * 初回はヒステリシスなしの >= 判定、以降はバンド端の厳密不等式で複数段移動すること、
 * ヒステリシスが境界往復の発振を抑えること（h=0 では往復すること）を確かめる。
 */
import { describe, expect, it } from 'vitest';
import { selectLevel } from './select-level.js';

describe('selectLevel', () => {
  it('初回は d >= T[i] を満たす最大の i を返す（ヒステリシスなし）', () => {
    const thresholds = [0, 5, 10];
    expect(selectLevel(null, 0, thresholds, 0.1)).toBe(0);
    expect(selectLevel(null, 4.999, thresholds, 0.1)).toBe(0);
    expect(selectLevel(null, 5, thresholds, 0.1)).toBe(1);
    expect(selectLevel(null, 9.999, thresholds, 0.1)).toBe(1);
    expect(selectLevel(null, 10, thresholds, 0.1)).toBe(2);
    expect(selectLevel(null, 1000, thresholds, 0.1)).toBe(2);
  });

  it('初回はヒステリシス幅を無視する', () => {
    // h=0.5 でも初回は素直な >= 判定になる。
    expect(selectLevel(null, 9, [0, 10], 0.5)).toBe(0);
    expect(selectLevel(null, 10, [0, 10], 0.5)).toBe(1);
  });

  it('h=0 は単調なしきい値判定になる（上端は >、下端は <）', () => {
    const thresholds = [0, 10];
    expect(selectLevel(0, 9.999, thresholds, 0)).toBe(0);
    expect(selectLevel(0, 10, thresholds, 0)).toBe(0);
    expect(selectLevel(0, 10.001, thresholds, 0)).toBe(1);
    expect(selectLevel(1, 10, thresholds, 0)).toBe(1);
    expect(selectLevel(1, 10.001, thresholds, 0)).toBe(1);
    expect(selectLevel(1, 9.999, thresholds, 0)).toBe(0);
  });

  it('バンド内を往復してもレベルが変わらない（ヒステリシスの効果）', () => {
    // 上端 10*1.1=11、下端 10*0.9=9 のバンド。
    const thresholds = [0, 10];
    let level = 0;
    for (const d of [10.5, 9.5, 10.9, 9.1, 10, 10.5, 9.5]) {
      level = selectLevel(level, d, thresholds, 0.1);
    }
    expect(level).toBe(0);
    // 上側から入ってもバンド内では張り付く。
    level = selectLevel(0, 20, thresholds, 0.1);
    expect(level).toBe(1);
    for (const d of [9.5, 10.5, 9.1, 10.9, 10]) {
      level = selectLevel(level, d, thresholds, 0.1);
    }
    expect(level).toBe(1);
  });

  it('h=0 だと境界の往復でレベルが反転し続ける（ヒステリシスの必要性）', () => {
    const thresholds = [0, 10];
    let level = 0;
    const seen: number[] = [];
    for (const d of [10.1, 9.9, 10.1, 9.9]) {
      level = selectLevel(level, d, thresholds, 0);
      seen.push(level);
    }
    // ヒステリシスなしでは境界またぎのたびに切り替わる。
    expect(seen).toEqual([1, 0, 1, 0]);
  });

  it('テレポート級の変化で複数段まとめて移動する', () => {
    const thresholds = [0, 5, 10, 20];
    expect(selectLevel(0, 100, thresholds, 0.1)).toBe(3);
    expect(selectLevel(1, 100, thresholds, 0.1)).toBe(3);
    expect(selectLevel(3, 1, thresholds, 0.1)).toBe(0);
    expect(selectLevel(2, 1, thresholds, 0.1)).toBe(0);
  });

  it('非有限の距離で RangeError を投げる', () => {
    const thresholds = [0, 10];
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => selectLevel(null, bad, thresholds, 0.1)).toThrow(RangeError);
      expect(() => selectLevel(0, bad, thresholds, 0.1)).toThrow(RangeError);
    }
  });

  it.each([[-1], [2], [1.5], [Number.NaN]])('範囲外・非整数の previous=%s で RangeError を投げる', (previous) => {
    // 毎フレーム呼ばれる判定の入口で失敗させ、想定外の段への飛びを防ぐ。
    const thresholds = [0, 10];
    expect(() => selectLevel(previous, 5, thresholds, 0.1)).toThrow(RangeError);
  });
});
