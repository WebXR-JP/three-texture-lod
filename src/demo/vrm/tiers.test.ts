/**
 * Tier純粋関数の固定テスト。分割数・丸め・スロット別の値を固定する。
 */
import { describe, expect, it } from 'vitest';
import { LOD_TIERS, levelTier, tierDivisor, tierIndexForResolution, tierLabel } from './tiers.js';

describe('tierDivisor', () => {
  it('4096幅は [1,2,4,8,16] に分割する', () => {
    expect(LOD_TIERS.map((tier) => tierDivisor(4096, tier))).toEqual([1, 2, 4, 8, 16]);
  });

  it('3000幅は [1,2,3,6,12] に分割する', () => {
    expect(LOD_TIERS.map((tier) => tierDivisor(3000, tier))).toEqual([1, 2, 3, 6, 12]);
  });

  it('1024幅は [1,1,1,2,4] に分割する', () => {
    expect(LOD_TIERS.map((tier) => tierDivisor(1024, tier))).toEqual([1, 1, 1, 2, 4]);
  });

  it('256幅は全て1（共有）になる', () => {
    expect(LOD_TIERS.map((tier) => tierDivisor(256, tier))).toEqual([1, 1, 1, 1, 1]);
  });

  it('長方形は長辺で決める', () => {
    expect(tierDivisor(Math.max(3000, 1500), 1024)).toBe(3);
    expect(tierDivisor(Math.max(1500, 3000), 1024)).toBe(3);
  });

  it('スロット別: map 4096 / normal 2048', () => {
    expect(LOD_TIERS.map((tier) => tierDivisor(4096, tier))).toEqual([1, 2, 4, 8, 16]);
    expect(LOD_TIERS.map((tier) => tierDivisor(2048, tier))).toEqual([1, 1, 2, 4, 8]);
  });

  it('分割数が同じTierは同じ値になる', () => {
    // 1024幅では 4096/2048/1024 の3段が divisor 1 で共有される。
    const divisors = LOD_TIERS.map((tier) => tierDivisor(1024, tier));
    expect(divisors[0]).toBe(divisors[1]);
    expect(divisors[1]).toBe(divisors[2]);
  });

  it('不正値は RangeError', () => {
    expect(() => tierDivisor(0, 1024)).toThrow(RangeError);
    expect(() => tierDivisor(-1, 1024)).toThrow(RangeError);
    expect(() => tierDivisor(Number.NaN, 1024)).toThrow(RangeError);
    expect(() => tierDivisor(1024, 0)).toThrow(RangeError);
    expect(() => tierDivisor(1024, -512)).toThrow(RangeError);
  });
});

describe('tierIndexForResolution', () => {
  it('境界と範囲外を丸める', () => {
    expect(tierIndexForResolution(4096)).toBe(0);
    expect(tierIndexForResolution(3000)).toBe(1);
    expect(tierIndexForResolution(1024)).toBe(2);
    expect(tierIndexForResolution(500)).toBe(4);
    expect(tierIndexForResolution(5000)).toBe(0);
    expect(tierIndexForResolution(100)).toBe(4);
  });
});

describe('levelTier', () => {
  it('レベル番号をTier値に変換し、範囲をクランプする', () => {
    expect(levelTier(0)).toBe(4096);
    expect(levelTier(4)).toBe(256);
    expect(levelTier(-1)).toBe(4096);
    expect(levelTier(99)).toBe(256);
  });

  it('tierLabel は幅を文字列にする', () => {
    expect(tierLabel(4096)).toBe('4096');
  });
});
