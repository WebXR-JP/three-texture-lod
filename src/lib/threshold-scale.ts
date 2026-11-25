/**
 * 予算に応じた距離しきい値スケールの予測制御（純粋関数）。
 *
 * 背景: `maxResidentBytes` は未参照テクスチャの破棄しかできず、現用レベルを
 * 予算内に下げられない。そこで予測ベースでスケールを切り替え、
 * `selectLevel(group.level, distance / scale, ...)` の読み替えで現用レベル自体を落とす。
 * 常駐量のフィードバック（×0.8/×1.1）は1段の移動量（例: 213MiB）に対して往復するため採らない。
 *
 * @packageDocumentation
 */
import type { AdaptiveThresholdScaleOptions } from './types.js';

/** `adaptiveThresholdScale` を正規化した既定値。 */
export const DEFAULT_MIN_SCALE = 0.05;
export const DEFAULT_MAX_SCALE = 1;
export const DEFAULT_STEPS_PER_OCTAVE = 4;
/** `stepsPerOctave` の上限。ラダー肥大化による毎フレーム走査の増大を抑える。 */
export const MAX_STEPS_PER_OCTAVE = 64;
export const DEFAULT_RAISE_INTERVAL_MS = 1000;
export const DEFAULT_RAISE_COOLDOWN_MS = 3000;
export const DEFAULT_RAISE_HEADROOM = 0.9;

/**
 * ラダー上の制御位置。
 */
export interface ScaleControllerState {
  /** ラダー上の位置（`0 = maxScale` 側）。 */
  readonly index: number;
  /** 最後に引き下げた時刻。未引き下げなら `null`。 */
  readonly lastLowerAt: number | null;
  /** 最後に引き上げ可否を判定した時刻。未判定なら `null`。 */
  readonly lastRaiseCheckAt: number | null;
}

/**
 * 1回分の制御入力。
 */
export interface ScaleControllerInput {
  /** 現在時刻（`now()` 基準のミリ秒）。 */
  readonly now: number;
  /** 上限バイト数。未設定なら `null`。 */
  readonly budgetBytes: number | null;
  /**
   * 候補スケールでの予測常駐量を返す関数。
   *
   * 超過判定のために現在位置のスケールで必ず1回呼ばれ、
   * 超過時のみラダー走査のために追加で呼ばれる。
   * 冷却中・間隔内は引き上げ候補の呼び出しを省く。
   */
  readonly predict: (scale: number) => number;
}

/**
 * 1回の判定結果。
 *
 * - `hold`: 維持。
 * - `lower`: 予算内に収まる最初の段へ引き下げ。
 * - `raise`: 1段だけ引き上げ。
 * - `floor`: どこにも収まらないため末尾へ。
 */
export type ScaleDecision = 'hold' | 'lower' | 'raise' | 'floor';

/**
 * スケールのラダーを作る。
 *
 * `L[k] = max * 2^(-k/stepsPerOctave)` を `min` 未満になる手前で打ち切り、
 * 末尾に `min` をちょうど置く。狭義降順・先頭 `max`・末尾 `min` である。
 * `min === max` は1要素になる。
 *
 * @param min - 下限。`0` より大きく有限、`max` 以下であること。
 * @param max - 上限。有限であること。
 * @param stepsPerOctave - 1オクターブあたりの段数。`1` 以上 `64` 以下の整数であること。
 * @throws `RangeError` — 不正値の場合。
 */
export function buildScaleLadder(min: number, max: number, stepsPerOctave: number): readonly number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    throw new RangeError(`min/max は有限である必要があります: min=${String(min)}, max=${String(max)}`);
  }
  if (!(min > 0)) {
    throw new RangeError(`min は 0 より大きい必要があります: ${String(min)}`);
  }
  if (!(min <= max)) {
    throw new RangeError(`min は max 以下である必要があります: min=${String(min)}, max=${String(max)}`);
  }
  if (
    !Number.isInteger(stepsPerOctave) ||
    stepsPerOctave < 1 ||
    stepsPerOctave > MAX_STEPS_PER_OCTAVE
  ) {
    throw new RangeError(
      `stepsPerOctave は 1 以上 ${String(MAX_STEPS_PER_OCTAVE)} 以下の整数である必要があります: ${String(stepsPerOctave)}`,
    );
  }
  if (min === max) {
    return [max];
  }
  const ladder: number[] = [];
  // ADR: `L[k] = max * 2^(-k/stepsPerOctave)` の等比であり、段差は `2^(1/stepsPerOctave)` になる。
  // `min` 未満は置かず、末尾に `min` をちょうど置くことで「末尾到達＝下限」の不変条件を保つ。
  for (let k = 0; ; k++) {
    const value = max * Math.pow(2, -k / stepsPerOctave);
    if (value < min) {
      break;
    }
    ladder.push(value);
    // ADR: 浮動小数点の丸めで `value === min` を素朴に回すと無限列になり得るため、
    // 到達したら打ち切る。末尾の重複置換は下の `push` 前検査で吸収する。
    if (value === min) {
      break;
    }
  }
  // ADR: 生成列の末尾が `min` と一致しない場合だけ追加する。
  // `stepsPerOctave` の刻みでちょうど落ちた場合は重複させず、狭義降順を保つ。
  if (ladder[ladder.length - 1] !== min) {
    ladder.push(min);
  }
  return ladder;
}

/**
 * 正規化済みオプションを検証する。
 *
 * @param options - 既定値で補完済みの調整値。
 * @throws `RangeError` — 不正値の場合。
 */
export function validateScaleOptions(options: Required<AdaptiveThresholdScaleOptions>): void {
  const { minScale, maxScale, stepsPerOctave, raiseIntervalMs, raiseCooldownMs, raiseHeadroom } =
    options;
  // ADR: ラダー生成と同じ検査を繰り返すのは、正規化後の値を直接受ける
  // `stepThresholdScale` 単体でも不正を弾くためである。判定側の前提（狭義降順・有限）を守る。
  buildScaleLadder(minScale, maxScale, stepsPerOctave);
  if (!Number.isFinite(raiseIntervalMs) || raiseIntervalMs < 0) {
    throw new RangeError(
      `raiseIntervalMs は 0 以上の有限値である必要があります: ${String(raiseIntervalMs)}`,
    );
  }
  if (!Number.isFinite(raiseCooldownMs) || raiseCooldownMs < 0) {
    throw new RangeError(
      `raiseCooldownMs は 0 以上の有限値である必要があります: ${String(raiseCooldownMs)}`,
    );
  }
  if (!(raiseHeadroom > 0 && raiseHeadroom <= 1)) {
    throw new RangeError(
      `raiseHeadroom は (0, 1] の範囲である必要があります: ${String(raiseHeadroom)}`,
    );
  }
  // ADR: `levelCap` は後方互換のため存在するときだけ検証する。
  // 既存のテスト器具は `levelCap` なしの `Required` キャストを渡すため、欠落では弾かない。
  if ('levelCap' in options && (options as { levelCap?: unknown }).levelCap !== undefined) {
    if (typeof (options as { levelCap?: unknown }).levelCap !== 'boolean') {
      throw new RangeError(
        `levelCap は boolean である必要があります: ${String((options as { levelCap?: unknown }).levelCap)}`,
      );
    }
  }
}

/**
 * 距離スケールとTier上限の2軸制御位置。
 */
export interface LodBudgetState {
  /** ラダー上の位置（`0 = maxScale` 側）。 */
  readonly index: number;
  /** 実効Tier上限（レベル番号。大きいほど粗い）。 */
  readonly cap: number;
  /** 最後に引き下げた時刻。未引き下げなら `null`。 */
  readonly lastLowerAt: number | null;
  /** 最後に引き上げ可否を判定した時刻。未判定なら `null`。 */
  readonly lastRaiseCheckAt: number | null;
}

/**
 * 2軸制御の1回分の入力。
 */
export interface LodBudgetInput {
  /** 現在時刻（`now()` 基準のミリ秒）。 */
  readonly now: number;
  /** 上限バイト数。未設定なら `null`。 */
  readonly budgetBytes: number | null;
  /**
   * 効果のある上限候補（昇順、先頭=手動下限、末尾=最粗）。
   *
   * `state.cap` を含む。効果のない段（前後で予測が変わらない上限）は入れない前提である。
   */
  readonly caps: readonly number[];
  /**
   * 候補スケールと上限での予測常駐量を返す関数。
   *
   * 超過判定のために現在位置で必ず1回呼ばれ、超過時のみ走査のために追加で呼ばれる。
   * 冷却中・間隔内は引き上げ候補の呼び出しを省く。
   */
  readonly predict: (scale: number, cap: number) => number;
}

/**
 * 2軸判定の結果。
 *
 * - `hold`: 維持。
 * - `lower`: スケールだけ引き下げ。
 * - `cap-lower`: 上限を粗くし、スケールを最良へ戻す側の引き下げ。
 * - `raise`: スケールだけ1段引き上げ。
 * - `cap-raise`: 上限だけ1段細かく戻す。
 * - `floor`: どこにも収まらないため最粗・末尾へ。
 */
export type LodBudgetDecision = 'hold' | 'lower' | 'cap-lower' | 'cap-raise' | 'raise' | 'floor';

/**
 * 効果のある上限候補を検証する。
 *
 * @param caps - 昇順の整数列であること。
 * @throws `RangeError` — 空・非整数・狭義昇順でない場合。
 */
function validateCaps(caps: readonly number[]): void {
  if (caps.length === 0) {
    throw new RangeError('caps は1件以上必要です');
  }
  for (const [i, c] of caps.entries()) {
    if (!Number.isInteger(c)) {
      throw new RangeError(`caps[${i}] は整数である必要があります: ${String(c)}`);
    }
    if (i > 0 && !(caps[i - 1] as number < c)) {
      throw new RangeError(`caps は狭義昇順である必要があります: [${caps.join(',')}]`);
    }
  }
}

/**
 * 予算に対するスケールとTier上限の2軸を1回だけ進める。
 *
 * 超過時（`B !== null && predict(L[index], cap) > B`）は、上限据え置き（`j > index`）と
 * 上限粗化（`j = 0` から）の各候補で最初に収まる段を探し、予測量が最大の候補を選ぶ。
 * 同点は `j` が小さい方、さらに同点は `cap` が小さい方である。
 * 下限状態（`cap` が最粗かつ `index` が末尾）では走査せず `floor` にする。
 * 収束時（予算内）は冷却と判定間隔が開いたときだけ1軸1段だけ上げる。
 * `budget === null` では予測なしでスケールを先頭へ戻してから上限を戻す。
 *
 * @param ladder - `buildScaleLadder` の戻り。狭義降順・先頭が最大・末尾が下限の前提。
 * @param state - 前回の位置（スケール段・上限）と時刻。
 * @param input - 時刻・予算・上限候補・予測関数。
 * @param options - 正規化済みの調整値。
 * @returns 次の状態と判定。
 * @throws `RangeError` — 調整値・上限候補が不正の場合。
 */
export function stepLodBudget(
  ladder: readonly number[],
  state: LodBudgetState,
  input: LodBudgetInput,
  options: Required<AdaptiveThresholdScaleOptions>,
): { state: LodBudgetState; decision: LodBudgetDecision } {
  // ADR: 毎フレームの呼び出しでラダーを作り直さないよう、数値比較だけの検査に留める。
  // 形状の検証と生成は `buildScaleLadder` が担い、マネージャの生成時に済ませる。
  if (!Number.isFinite(options.raiseIntervalMs) || options.raiseIntervalMs < 0) {
    throw new RangeError(
      `raiseIntervalMs は 0 以上の有限値である必要があります: ${String(options.raiseIntervalMs)}`,
    );
  }
  if (!Number.isFinite(options.raiseCooldownMs) || options.raiseCooldownMs < 0) {
    throw new RangeError(
      `raiseCooldownMs は 0 以上の有限値である必要があります: ${String(options.raiseCooldownMs)}`,
    );
  }
  if (!(options.raiseHeadroom > 0 && options.raiseHeadroom <= 1)) {
    throw new RangeError(
      `raiseHeadroom は (0, 1] の範囲である必要があります: ${String(options.raiseHeadroom)}`,
    );
  }
  validateCaps(input.caps);
  if (ladder.length === 0) {
    throw new RangeError('ladder は1件以上必要です');
  }
  const budget = input.budgetBytes;
  const now = input.now;
  // ADR: 呼び出し側の丸めずれに備え、`index` は範囲に収め、`cap` は候補以下で最大へ寄せる。
  // `cap` が先頭より細いときは先頭に吸着し、手動下限より細い上限を作らない。
  let rawIndex = state.index;
  if (!Number.isFinite(rawIndex)) {
    rawIndex = 0;
  }
  let index = Math.trunc(rawIndex);
  if (index < 0) {
    index = 0;
  } else if (index > ladder.length - 1) {
    index = ladder.length - 1;
  }
  const caps = input.caps;
  let cap = caps[0] as number;
  const rawCap = state.cap;
  if (Number.isFinite(rawCap)) {
    for (const c of caps) {
      if (c <= rawCap) {
        cap = c;
      } else {
        break;
      }
    }
  }
  let lastLowerAt = state.lastLowerAt;
  let lastRaiseCheckAt = state.lastRaiseCheckAt;

  const capPosOf = (value: number): number => {
    const found = caps.indexOf(value);
    return found < 0 ? 0 : found;
  };

  // ADR: 超過判定の `predict` は毎回1回だけ呼ぶ。下限状態では走査を省き、
  // 連続 `floor` でも毎フレーム全走査の `predict` を回さない。
  if (budget !== null && input.predict(ladder[index] as number, cap) > budget) {
    if (cap === caps[caps.length - 1] && index === ladder.length - 1) {
      lastLowerAt = now;
      return { state: { index, cap, lastLowerAt, lastRaiseCheckAt }, decision: 'floor' };
    }
    const capPos = capPosOf(cap);
    let best: { c: number; j: number; need: number } | null = null;
    for (let k = capPos; k < caps.length; k++) {
      const c = caps[k] as number;
      const startJ = k === capPos ? index + 1 : 0;
      for (let j = startJ; j < ladder.length; j++) {
        const need = input.predict(ladder[j] as number, c);
        if (need <= budget) {
          if (
            best === null ||
            need > best.need ||
            (need === best.need && (j < best.j || (j === best.j && c < best.c)))
          ) {
            best = { c, j, need };
          }
          break;
        }
      }
    }
    lastLowerAt = now;
    if (best === null) {
      const lastCap = caps[caps.length - 1] as number;
      const lastIndex = ladder.length - 1;
      return {
        state: { index: lastIndex, cap: lastCap, lastLowerAt, lastRaiseCheckAt },
        decision: 'floor',
      };
    }
    const decision: LodBudgetDecision = best.c !== cap ? 'cap-lower' : 'lower';
    return {
      state: { index: best.j, cap: best.c, lastLowerAt, lastRaiseCheckAt },
      decision,
    };
  }
  const capPos = capPosOf(cap);
  const hasS = index > 0;
  const hasC = capPos > 0;
  if (!hasS && !hasC) {
    return { state: { index, cap, lastLowerAt, lastRaiseCheckAt }, decision: 'hold' };
  }
  // ADR: 引き下げ直後の揺り戻しを抑えるため、冷却と判定間隔の両方が開くまで上げない。
  // 冷却中・間隔内は引き上げ候補の `predict` を呼ばず、予測コストを抑える。
  // 冷却はスケール下げと上限下げで共有し、どちらの引き下げ直後も上げない。
  const cooled = lastLowerAt === null || now - lastLowerAt >= options.raiseCooldownMs;
  const due = lastRaiseCheckAt === null || now - lastRaiseCheckAt >= options.raiseIntervalMs;
  if (!cooled || !due) {
    return { state: { index, cap, lastLowerAt, lastRaiseCheckAt }, decision: 'hold' };
  }
  lastRaiseCheckAt = now;
  if (budget === null) {
    // ADR: 予算なしでは予測なしで段階的に最大へ戻す。見え方への影響が大きい
    // スケールを先頭へ戻してから上限を戻し、粗い上限のまま細部が戻らない順序を保つ。
    if (hasS) {
      return { state: { index: index - 1, cap, lastLowerAt, lastRaiseCheckAt }, decision: 'raise' };
    }
    const prev = caps[capPos - 1] as number;
    return { state: { index, cap: prev, lastLowerAt, lastRaiseCheckAt }, decision: 'cap-raise' };
  }
  let scaleNeed: number | null = null;
  let capNeed: number | null = null;
  let scaleOk = false;
  let capOk = false;
  if (hasS) {
    scaleNeed = input.predict(ladder[index - 1] as number, cap);
    scaleOk = scaleNeed <= options.raiseHeadroom * budget;
  }
  if (hasC) {
    const prev = caps[capPos - 1] as number;
    capNeed = input.predict(ladder[index] as number, prev);
    capOk = capNeed <= options.raiseHeadroom * budget;
  }
  // ADR: 1回は1軸1段だけ動かす。両方が余裕内のときは予測量が大きい方を選び、
  // 同点はスケールを優先して見え方の戻りを先にする。
  if (scaleOk && capOk) {
    if ((capNeed as number) > (scaleNeed as number)) {
      const prev = caps[capPos - 1] as number;
      return { state: { index, cap: prev, lastLowerAt, lastRaiseCheckAt }, decision: 'cap-raise' };
    }
    return { state: { index: index - 1, cap, lastLowerAt, lastRaiseCheckAt }, decision: 'raise' };
  }
  if (scaleOk) {
    return { state: { index: index - 1, cap, lastLowerAt, lastRaiseCheckAt }, decision: 'raise' };
  }
  if (capOk) {
    const prev = caps[capPos - 1] as number;
    return { state: { index, cap: prev, lastLowerAt, lastRaiseCheckAt }, decision: 'cap-raise' };
  }
  return { state: { index, cap, lastLowerAt, lastRaiseCheckAt }, decision: 'hold' };
}

/**
 * 予算に対するスケールを1回だけ進める。
 *
 * `stepLodBudget` の薄いラッパであり、単一上限での従来挙動を保つ。
 * 毎 `update` の呼び出し側が `predict` を閉包で渡し、戻りの `state` を次回に引き継ぐ。
 * 引き下げに間隔制限はなく、超過時は予算内に収まる最初の段へまとめて下がる。
 * 予測が非単調でも全走査するため二分探索しない。`predict == budget` は超過ではない。
 *
 * @param ladder - `buildScaleLadder` の戻り。狭義降順・先頭が最大・末尾が下限の前提。
 * @param state - 前回の位置と時刻。
 * @param input - 時刻・予算・予測関数。
 * @param options - 正規化済みの調整値。
 * @returns 次の状態と判定。
 * @throws `RangeError` — 調整値が不正の場合。
 */
export function stepThresholdScale(
  ladder: readonly number[],
  state: ScaleControllerState,
  input: ScaleControllerInput,
  options: Required<AdaptiveThresholdScaleOptions>,
): { state: ScaleControllerState; decision: ScaleDecision } {
  // ADR: 2軸版への委譲で二重実装を避ける。単一上限では `cap-lower`/`cap-raise` が
  // 発生せず、呼び出し回数・状態遷移は従来と同一になる。`state` に `cap` があれば拾うが、
  // 旧形状では `0` として単一候補にする。
  const capValue = (state as unknown as { cap?: unknown }).cap;
  const cap = typeof capValue === 'number' && Number.isFinite(capValue) ? capValue : 0;
  const result = stepLodBudget(
    ladder,
    { index: state.index, cap, lastLowerAt: state.lastLowerAt, lastRaiseCheckAt: state.lastRaiseCheckAt },
    {
      now: input.now,
      budgetBytes: input.budgetBytes,
      caps: [cap],
      predict: (scale: number) => input.predict(scale),
    },
    options,
  );
  const decision = result.decision as ScaleDecision;
  return {
    state: {
      index: result.state.index,
      lastLowerAt: result.state.lastLowerAt,
      lastRaiseCheckAt: result.state.lastRaiseCheckAt,
    },
    decision,
  };
}
