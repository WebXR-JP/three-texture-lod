/**
 * 配置スロットの固定条件を検証する。描画や three は使わない。
 */
import { describe, expect, it } from 'vitest';
import { FIXED_SLOTS, WANDER_RADIUS, buildSlots } from './layout.js';

describe('buildSlots', () => {
  it('件数どおりに返し、先頭は固定スロットと一致する', () => {
    expect(buildSlots(0)).toEqual([]);
    expect(buildSlots(1)).toEqual([{ x: FIXED_SLOTS[0].x, z: FIXED_SLOTS[0].z }]);
    expect(buildSlots(3)).toEqual(
      FIXED_SLOTS.slice(0, 3).map((fixed) => ({ x: fixed.x, z: fixed.z })),
    );
    expect(buildSlots(Number.POSITIVE_INFINITY)).toEqual([]);
    const slots = buildSlots(100);
    expect(slots).toHaveLength(100);
    for (const [index, fixed] of FIXED_SLOTS.entries()) {
      expect(slots[index]).toEqual({ x: fixed.x, z: fixed.z });
    }
  });

  it('小数件数は切り捨てる', () => {
    expect(buildSlots(100.5)).toHaveLength(100);
    expect(buildSlots(100)).toHaveLength(100);
  });

  it('全スロットが重複せず、徘徊円どうしの隙間が 0.5m 以上ある', () => {
    const slots = buildSlots(100);
    const keys = new Set(slots.map((slot) => `${slot.x},${slot.z}`));
    expect(keys.size).toBe(slots.length);
    const minDistance = 2 * WANDER_RADIUS + 0.5;
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        const distance = Math.hypot(slots[i].x - slots[j].x, slots[i].z - slots[j].z);
        expect(distance).toBeGreaterThanOrEqual(minDistance);
      }
    }
  });

  it('5体目以降は視線レーン（|x|<3 かつ z>-12）を空ける', () => {
    for (const slot of buildSlots(100).slice(4)) {
      expect(Math.abs(slot.x) < 3 && slot.z > -12).toBe(false);
    }
  });

  it('最遠 z は -22 以内、全点が 90x90 の床に収まる', () => {
    const slots = buildSlots(100);
    const farthest = Math.min(...slots.map((slot) => slot.z));
    expect(farthest).toBeGreaterThanOrEqual(-22);
    for (const slot of slots) {
      expect(Math.abs(slot.x)).toBeLessThanOrEqual(45);
      expect(Math.abs(slot.z)).toBeLessThanOrEqual(45);
    }
  });
});
