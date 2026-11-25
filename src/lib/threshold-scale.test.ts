/**
 * 距離しきい値スケールの予測制御の仕様固定テスト。
 *
 * ラダー生成の形状・検証、不正値、超過時の引き下げ（複数段・非単調・下限）、
 * 引き上げの冷却と間隔、予算なしの挙動、階段状予測での収束を確かめる。
 */
import { describe, expect, it, vi } from 'vitest';
import { buildScaleLadder, stepLodBudget, stepThresholdScale } from './threshold-scale.js';
import type {
  LodBudgetInput,
  LodBudgetState,
  ScaleControllerInput,
  ScaleControllerState,
} from './threshold-scale.js';
import type { AdaptiveThresholdScaleOptions } from './types.js';

/** 既定値を補った正規化済み調整値を作る。 */
function options(partial: Partial<Record<string, number>> = {}): Required<AdaptiveThresholdScaleOptions> {
  return {
    minScale: 0.05,
    maxScale: 1,
    stepsPerOctave: 4,
    raiseIntervalMs: 1000,
    raiseCooldownMs: 3000,
    raiseHeadroom: 0.9,
    ...partial,
  } as Required<AdaptiveThresholdScaleOptions>;
}

/** 制御状態を作る。 */
function state(
  index: number,
  lastLowerAt: number | null = null,
  lastRaiseCheckAt: number | null = null,
): ScaleControllerState {
  return { index, lastLowerAt, lastRaiseCheckAt };
}

/** 定数予測の入力を作る。 */
function input(
  predictValue: number,
  now = 0,
  budgetBytes: number | null = 100,
): ScaleControllerInput {
  return { now, budgetBytes, predict: () => predictValue };
}

describe('buildScaleLadder', () => {
  it('先頭=max・末尾=minちょうど・狭義降順・比2^(1/4)', () => {
    const ladder = buildScaleLadder(0.05, 1, 4);
    expect(ladder[0]).toBe(1);
    expect(ladder[ladder.length - 1]).toBe(0.05);
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i]).toBeLessThan(ladder[i - 1] as number);
    }
    // 末尾追加の1段を除き、段差は 2^(1/4) になる。
    const ratio = Math.pow(2, 1 / 4);
    for (let i = 1; i < ladder.length - 1; i++) {
      expect((ladder[i - 1] as number) / (ladder[i] as number)).toBeCloseTo(ratio, 12);
    }
  });

  it('min===max は1要素になる', () => {
    expect(buildScaleLadder(0.5, 0.5, 4)).toEqual([0.5]);
  });

  it('不正値では RangeError を投げる', () => {
    expect(() => buildScaleLadder(0, 1, 4)).toThrow(RangeError);
    expect(() => buildScaleLadder(-0.1, 1, 4)).toThrow(RangeError);
    expect(() => buildScaleLadder(2, 1, 4)).toThrow(RangeError);
    expect(() => buildScaleLadder(0.05, 1, 0)).toThrow(RangeError);
    expect(() => buildScaleLadder(0.05, 1, 1.5)).toThrow(RangeError);
    expect(() => buildScaleLadder(0.05, 1, NaN)).toThrow(RangeError);
    expect(() => buildScaleLadder(NaN, 1, 4)).toThrow(RangeError);
    expect(() => buildScaleLadder(0.05, Infinity, 4)).toThrow(RangeError);
  });

  it('stepsPerOctave の上限 64 を超えると RangeError、64 は許容する', () => {
    // ADR: 上限は毎フレーム走査の肥大化を抑えるため。64 は min=0.05/max=1 で約280段になる。
    expect(() => buildScaleLadder(0.05, 1, 65)).toThrow(RangeError);
    expect(() => buildScaleLadder(0.05, 1, 1000)).toThrow(RangeError);
    expect(() => buildScaleLadder(0.05, 1, 64)).not.toThrow();
    expect(() => buildScaleLadder(0.5, 0.5, 65)).toThrow(RangeError);
  });

  it('raiseHeadroom が (0,1] の外では RangeError を投げる', () => {
    const ladder = buildScaleLadder(0.05, 1, 4);
    const base = state(1, null, null);
    expect(() =>
      stepThresholdScale(ladder, base, input(0, 5000, 100), options({ raiseHeadroom: 0 })),
    ).toThrow(RangeError);
    expect(() =>
      stepThresholdScale(ladder, base, input(0, 5000, 100), options({ raiseHeadroom: -0.1 })),
    ).toThrow(RangeError);
    expect(() =>
      stepThresholdScale(ladder, base, input(0, 5000, 100), options({ raiseHeadroom: 1.1 })),
    ).toThrow(RangeError);
    // 境界 1 は許容する。
    expect(() =>
      stepThresholdScale(ladder, base, input(0, 5000, 100), options({ raiseHeadroom: 1 })),
    ).not.toThrow();
  });
});

describe('stepThresholdScale の引き下げ', () => {
  it('超過時は予算内に収まる最初の段へ移り lower', () => {
    const ladder = buildScaleLadder(0.125, 1, 1);
    expect(ladder).toEqual([1, 0.5, 0.25, 0.125]);
    const calls: number[] = [];
    const result = stepThresholdScale(
      ladder,
      state(0, null, null),
      { now: 0, budgetBytes: 200, predict: (s) => (calls.push(s), s === 1 ? 300 : 150) },
      options(),
    );
    expect(result.decision).toBe('lower');
    expect(result.state.index).toBe(1);
    expect(result.state.lastLowerAt).toBe(0);
    // 現在位置の予測の後、予算内に収まる最初の段で止まる。
    expect(calls).toEqual([1, 0.5]);
  });

  it('1回で複数段下がる', () => {
    const ladder = buildScaleLadder(0.125, 1, 1);
    const result = stepThresholdScale(
      ladder,
      state(0, null, null),
      { now: 0, budgetBytes: 200, predict: (s) => (s <= 0.25 ? 100 : 250) },
      options(),
    );
    expect(result.decision).toBe('lower');
    expect(result.state.index).toBe(2);
  });

  it('非単調な予測でも収まる最初の段を選ぶ', () => {
    // index2 は収まるが index3 は超過し、index5 は再び収まる場合、index2 を選ぶ。
    const ladder = buildScaleLadder(0.25, 2, 2);
    expect(ladder.length).toBeGreaterThanOrEqual(6);
    const table = new Map<number, number>([
      [0, 500],
      [1, 400],
      [2, 90],
      [3, 150],
      [4, 120],
      [5, 80],
    ]);
    const result = stepThresholdScale(
      ladder,
      state(0, null, null),
      { now: 0, budgetBytes: 100, predict: (s) => table.get(ladder.indexOf(s)) ?? 500 },
      options(),
    );
    expect(result.decision).toBe('lower');
    expect(result.state.index).toBe(2);
  });

  it('どこにも収まらなければ末尾へ floor し、連続呼び出しでも floor', () => {
    const ladder = buildScaleLadder(0.125, 1, 1);
    const over = { now: 0, budgetBytes: 10, predict: () => 500 };
    const first = stepThresholdScale(ladder, state(0, null, null), over, options());
    expect(first.decision).toBe('floor');
    expect(first.state.index).toBe(ladder.length - 1);
    expect(first.state.lastLowerAt).toBe(0);
    const second = stepThresholdScale(
      ladder,
      { ...first.state },
      { ...over, now: 16 },
      options(),
    );
    expect(second.decision).toBe('floor');
    expect(second.state.index).toBe(ladder.length - 1);
    expect(second.state.lastLowerAt).toBe(16);
  });

  it('predict==budget は非超過、budget+1 は超過になる', () => {
    const ladder = buildScaleLadder(0.5, 1, 1);
    const hold = stepThresholdScale(
      ladder,
      state(1, null, 0),
      { now: 100, budgetBytes: 200, predict: () => 200 },
      options(),
    );
    // 間隔内 (100 - 0 < 1000) のため引き上げ判定もなく hold になる。
    expect(hold.decision).toBe('hold');
    expect(hold.state.index).toBe(1);
    const over = stepThresholdScale(
      ladder,
      state(1, null, null),
      { now: 0, budgetBytes: 200, predict: () => 201 },
      options(),
    );
    expect(over.decision).toBe('floor');
    expect(over.state.index).toBe(1);
  });
});

describe('stepThresholdScale の引き上げ', () => {
  it('冷却中は上げ候補の predict を呼ばない', () => {
    const ladder = buildScaleLadder(0.25, 1, 2);
    const predict = vi.fn(() => 10);
    const result = stepThresholdScale(
      ladder,
      state(2, 0, null),
      { now: 100, budgetBytes: 1000, predict },
      options(),
    );
    // 現在位置の予測1回だけで、上げ候補 (ladder[1]) の予測は呼ばれない。
    expect(predict).toHaveBeenCalledTimes(1);
    expect(predict).toHaveBeenCalledWith(ladder[2]);
    expect(result.decision).toBe('hold');
    expect(result.state.index).toBe(2);
  });

  it('冷却と間隔を満たし predict(up)==0.9*budget で1段上げ、僅かに超えると hold', () => {
    const ladder = buildScaleLadder(0.25, 1, 2);
    const budget = 1000;
    const st = state(2, 0, 1000);
    const up = ladder[1] as number;
    const raise = stepThresholdScale(
      ladder,
      st,
      { now: 5000, budgetBytes: budget, predict: (s) => (s === up ? 0.9 * budget : 10) },
      options(),
    );
    expect(raise.decision).toBe('raise');
    expect(raise.state.index).toBe(1);
    expect(raise.state.lastRaiseCheckAt).toBe(5000);
    const hold = stepThresholdScale(
      ladder,
      st,
      {
        now: 5000,
        budgetBytes: budget,
        predict: (s) => (s === up ? 0.9 * budget + 1 : 10),
      },
      options(),
    );
    expect(hold.decision).toBe('hold');
    expect(hold.state.index).toBe(2);
    // 判定時刻は headroom 不足でも更新される。
    expect(hold.state.lastRaiseCheckAt).toBe(5000);
  });

  it('間隔内の連続呼び出しで上げは1回だけになる', () => {
    const ladder = buildScaleLadder(0.25, 1, 2);
    const opts = options();
    const first = stepThresholdScale(
      ladder,
      state(2, null, null),
      { now: 0, budgetBytes: 1000, predict: () => 10 },
      opts,
    );
    expect(first.decision).toBe('raise');
    expect(first.state.index).toBe(1);
    const second = stepThresholdScale(
      ladder,
      first.state,
      { now: 100, budgetBytes: 1000, predict: () => 10 },
      opts,
    );
    expect(second.decision).toBe('hold');
    expect(second.state.index).toBe(1);
  });

  it('index 0 では max を超えない', () => {
    const ladder = buildScaleLadder(0.05, 1, 4);
    const result = stepThresholdScale(
      ladder,
      state(0, null, null),
      { now: 10_000, budgetBytes: 1000, predict: () => 10 },
      options(),
    );
    expect(result.decision).toBe('hold');
    expect(result.state.index).toBe(0);
  });

  it('budget==null では predict を呼ばず間隔ごとに1段上げる', () => {
    const ladder = buildScaleLadder(0.25, 1, 2);
    const predict = vi.fn(() => 10_000);
    const opts = options();
    const first = stepThresholdScale(
      ladder,
      state(2, null, null),
      { now: 0, budgetBytes: null, predict },
      opts,
    );
    expect(first.decision).toBe('raise');
    expect(first.state.index).toBe(1);
    expect(predict).not.toHaveBeenCalled();
    const second = stepThresholdScale(
      ladder,
      first.state,
      { now: 500, budgetBytes: null, predict },
      opts,
    );
    expect(second.decision).toBe('hold');
    const third = stepThresholdScale(
      ladder,
      first.state,
      { now: 1000, budgetBytes: null, predict },
      opts,
    );
    expect(third.decision).toBe('raise');
    expect(third.state.index).toBe(0);
    expect(predict).not.toHaveBeenCalled();
  });
});

describe('stepThresholdScale の収束', () => {
  it('階段状予測で収束し、収束後の下げはなく最終 s は 0.9*budget に収まる最大段', () => {
    const MB = 1024 * 1024;
    const budget = 256 * MB;
    const base = 100 * MB;
    const extra = 213 * MB;
    // 4096級の現用テクスチャが落ちる段差を模した階段状予測。s>=0.6 で +213MB。
    const predict = (s: number): number => base + (s >= 0.6 ? extra : 0);
    const ladder = buildScaleLadder(0.05, 1, 4);
    const opts = options();
    let st = state(0, null, null);
    let lowers = 0;
    let lowersAfter30s = 0;
    let now = 0;
    const steps = Math.floor(60_000 / 16);
    for (let i = 0; i < steps; i++) {
      const result = stepThresholdScale(ladder, st, { now, budgetBytes: budget, predict }, opts);
      st = result.state;
      if (result.decision === 'lower' || result.decision === 'floor') {
        lowers++;
        if (now >= 30_000) {
          lowersAfter30s++;
        }
      }
      now += 16;
    }
    // 引き下げで最初に収まる段に落ち、引き上げ余裕 (0.9*budget) では戻らないため安定する。
    expect(lowers).toBeGreaterThan(0);
    expect(lowersAfter30s).toBe(0);
    const expected = ladder.filter((s) => s < 0.6).reduce((a, b) => Math.max(a, b));
    expect(ladder[st.index]).toBe(expected);
    expect(predict(ladder[st.index] as number)).toBeLessThanOrEqual(0.9 * budget);
    const up = ladder[st.index - 1] as number;
    expect(predict(up)).toBeGreaterThan(0.9 * budget);
  });
});

describe('stepLodBudget の2軸制御', () => {
  /** 2軸用の既定オプションを作る。 */
  function budgetOptions(
    partial: Partial<Record<string, number | boolean>> = {},
  ): Required<AdaptiveThresholdScaleOptions> {
    return {
      minScale: 0.05,
      maxScale: 1,
      stepsPerOctave: 4,
      raiseIntervalMs: 1000,
      raiseCooldownMs: 3000,
      raiseHeadroom: 0.9,
      levelCap: true,
      ...partial,
    } as Required<AdaptiveThresholdScaleOptions>;
  }

  /** 2軸の状態を作る。 */
  function budgetState(
    index: number,
    cap: number,
    lastLowerAt: number | null = null,
    lastRaiseCheckAt: number | null = null,
  ): LodBudgetState {
    return { index, cap, lastLowerAt, lastRaiseCheckAt };
  }

  /** 2軸の入力を作る。 */
  function budgetInput(
    caps: readonly number[],
    predict: (scale: number, cap: number) => number,
    now = 0,
    budgetBytes: number | null = 100,
  ): LodBudgetInput {
    return { now, budgetBytes, caps, predict };
  }

  it('caps の不正（空・非整数・非昇順）では RangeError を投げる', () => {
    const ladder = buildScaleLadder(0.125, 1, 1);
    const opts = budgetOptions();
    const base = budgetState(0, 0);
    expect(() =>
      stepLodBudget(ladder, base, budgetInput([], () => 0), opts),
    ).toThrow(RangeError);
    expect(() =>
      stepLodBudget(ladder, base, budgetInput([0, 0.5], () => 0), opts),
    ).toThrow(RangeError);
    expect(() =>
      stepLodBudget(ladder, base, budgetInput([1, 0], () => 0), opts),
    ).toThrow(RangeError);
    expect(() =>
      stepLodBudget(ladder, base, budgetInput([0, 0], () => 0), opts),
    ).toThrow(RangeError);
  });

  it('state.cap は候補以下で最大に正規化し、index は範囲に収める', () => {
    const ladder = buildScaleLadder(0.5, 1, 1);
    expect(ladder).toEqual([1, 0.5]);
    const opts = budgetOptions();
    // cap=2 は [0,3,4] の以下で最大が 0 になる。
    const normalized = stepLodBudget(
      ladder,
      budgetState(0, 2),
      budgetInput([0, 3, 4], () => 0, 5000, 1000),
      opts,
    );
    expect(normalized.state.cap).toBe(0);
    // index のクランプ（負は 0・超過は末尾）。
    const clampedLow = stepLodBudget(
      ladder,
      budgetState(-5, 0),
      budgetInput([0], () => 0, 5000, 1000),
      opts,
    );
    expect(clampedLow.state.index).toBe(0);
    // 冷却中で上げが起きない条件にして、末尾へのクランプだけを確かめる。
    const clampedHigh = stepLodBudget(
      ladder,
      budgetState(99, 0, 0, null),
      budgetInput([0], () => 0, 100, 1000),
      opts,
    );
    expect(clampedHigh.state.index).toBe(1);
  });

  it('スケールを下げても収まらず cap-lower になり、スケールが先頭に戻る', () => {
    // 同一内容の重複を除いた caps の想定で、スケールだけでは収まらない場合の確認。
    const ladder = [1, 0.5, 0.25];
    const opts = budgetOptions();
    const predict = (s: number, c: number): number => {
      if (c === 0) {
        return 200;
      }
      // cap=1 では先頭から収まる。
      return s === 1 ? 90 : 80;
    };
    const result = stepLodBudget(
      ladder,
      budgetState(0, 0),
      budgetInput([0, 1], predict, 0, 100),
      opts,
    );
    expect(result.decision).toBe('cap-lower');
    expect(result.state.cap).toBe(1);
    expect(result.state.index).toBe(0);
    expect(result.state.lastLowerAt).toBe(0);
  });

  it('共有シナリオで (cap+1, scale=1) が深い下げより大きく cap-lower が選ばれる', () => {
    // 1ソースの近接1体だけが重い場合の想定で、上限を1段粗くして最良スケールへ戻す方が
    // スケールを深く下げるより予算を多く使えることの確認。
    const ladder = [1, 0.5, 0.25, 0.125];
    const opts = budgetOptions();
    const predict = (s: number, c: number): number => {
      if (c === 0) {
        if (s === 1) {
          return 150;
        }
        if (s === 0.5) {
          return 90;
        }
        return 80;
      }
      // cap=1 の先頭は深い下げより大きい。
      if (s === 1) {
        return 95;
      }
      return 40;
    };
    const result = stepLodBudget(
      ladder,
      budgetState(0, 0),
      budgetInput([0, 1], predict, 0, 100),
      opts,
    );
    expect(result.decision).toBe('cap-lower');
    expect(result.state).toMatchObject({ index: 0, cap: 1 });
  });

  it('共有なし群衆で少しだけ超えるときは lower が選ばれる', () => {
    // 少しの超過でスケールを1段下げれば収まり、上限を粗くすると使い過ぎるほど減る場合の確認。
    const ladder = [1, 0.5, 0.25];
    const opts = budgetOptions();
    const predict = (s: number, c: number): number => {
      if (c === 0) {
        if (s === 1) {
          return 105;
        }
        return 95;
      }
      return 50;
    };
    const result = stepLodBudget(
      ladder,
      budgetState(0, 0),
      budgetInput([0, 1], predict, 0, 100),
      opts,
    );
    expect(result.decision).toBe('lower');
    expect(result.state).toMatchObject({ index: 1, cap: 0 });
  });

  it('予測が同点ならスケールが大きい方、さらに同点なら cap が細かい方', () => {
    const ladder = [1, 0.5, 0.25];
    const opts = budgetOptions();
    // j の小さい方（スケール大）を優先する。
    const tieScale = stepLodBudget(
      ladder,
      budgetState(0, 0),
      budgetInput([0, 1], (s, c) => (c === 0 && s === 0.5 ? 90 : c === 1 && s === 1 ? 90 : 200), 0, 100),
      opts,
    );
    expect(tieScale.decision).toBe('cap-lower');
    expect(tieScale.state).toMatchObject({ index: 0, cap: 1 });
    // j が同じなら cap の小さい方（細かい方）を選ぶ。
    const tieCap = stepLodBudget(
      ladder,
      budgetState(1, 0),
      budgetInput(
        [0, 1, 2],
        (s, c) => {
          if (c === 0) {
            return 200;
          }
          // どちらも j=0 で同点になる。
          if (s === 1 && (c === 1 || c === 2)) {
            return 90;
          }
          return 200;
        },
        0,
        100,
      ),
      opts,
    );
    expect(tieCap.decision).toBe('cap-lower');
    expect(tieCap.state).toMatchObject({ index: 0, cap: 1 });
  });

  it('上げは1軸1段で同点はスケール、冷却・間隔は共有する', () => {
    const ladder = [1, 0.5, 0.25];
    const opts = budgetOptions();
    // 両候補が余裕内で同点ならスケールを優先する。
    const both = stepLodBudget(
      ladder,
      budgetState(1, 1, null, null),
      budgetInput([0, 1], () => 50, 5000, 100),
      opts,
    );
    expect(both.decision).toBe('raise');
    expect(both.state).toMatchObject({ index: 0, cap: 1 });
    // cap 下げ直後3秒は cap も上げない（冷却の共有）。
    const cooled = stepLodBudget(
      ladder,
      budgetState(0, 1, 0, null),
      budgetInput([0, 1], () => 10, 100, 1000),
      opts,
    );
    expect(cooled.decision).toBe('hold');
    expect(cooled.state.lastRaiseCheckAt).toBeNull();
    // 間隔内の連続判定では上げない。
    const interval = stepLodBudget(
      ladder,
      budgetState(1, 0, null, 0),
      budgetInput([0], () => 10, 100, 1000),
      opts,
    );
    expect(interval.decision).toBe('hold');
  });

  it('下限状態は predict を1回だけ呼ぶ', () => {
    const ladder = [1, 0.5];
    const opts = budgetOptions();
    const predict = vi.fn(() => 500);
    const result = stepLodBudget(
      ladder,
      budgetState(1, 2),
      budgetInput([0, 2], predict, 16, 100),
      opts,
    );
    expect(result.decision).toBe('floor');
    expect(result.state).toMatchObject({ index: 1, cap: 2, lastLowerAt: 16 });
    expect(predict).toHaveBeenCalledTimes(1);
  });

  it('caps に効果のない値が入らない前提で cap 上げが次へ進む', () => {
    // [0,3,4] のように飛ぶ caps で、上限の上げが直前の有効段へ進むことの確認。
    // スケールは先頭のため S 候補がなく、C だけが評価される。
    const ladder = [1, 0.5];
    const opts = budgetOptions();
    const result = stepLodBudget(
      ladder,
      budgetState(0, 4, null, null),
      budgetInput([0, 3, 4], (s) => (s === 1 ? 10 : 10), 5000, 1000),
      opts,
    );
    expect(result.decision).toBe('cap-raise');
    expect(result.state.cap).toBe(3);
    expect(result.state.index).toBe(0);
  });

  it('budget null はスケールを先頭へ戻してから cap を戻す', () => {
    const ladder = [1, 0.5, 0.25];
    const opts = budgetOptions();
    const predict = vi.fn(() => 10_000);
    const first = stepLodBudget(
      ladder,
      budgetState(2, 1, null, null),
      budgetInput([0, 1], predict, 0, null),
      opts,
    );
    expect(first.decision).toBe('raise');
    expect(first.state).toMatchObject({ index: 1, cap: 1 });
    expect(predict).not.toHaveBeenCalled();
    const second = stepLodBudget(
      ladder,
      { ...first.state, lastLowerAt: null, lastRaiseCheckAt: null },
      budgetInput([0, 1], predict, 1000, null),
      opts,
    );
    expect(second.decision).toBe('raise');
    expect(second.state).toMatchObject({ index: 0, cap: 1 });
    const third = stepLodBudget(
      ladder,
      { ...second.state, lastLowerAt: null, lastRaiseCheckAt: null },
      budgetInput([0, 1], predict, 2000, null),
      opts,
    );
    expect(third.decision).toBe('cap-raise');
    expect(third.state).toMatchObject({ index: 0, cap: 0 });
  });
});
