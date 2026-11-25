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
}

/**
 * 予算に対するスケールを1回だけ進める。
 *
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
  // ADR: 毎フレームの呼び出しでラダーを作り直さないよう、ここでは数値比較だけの検査に留める。
  // ラダー形状（狭義降順・先頭最大・末尾下限）の検証と生成は `buildScaleLadder` が担い、
  // `TextureLodManager` のコンストラクタ時に済ませる。呼び出し側が渡した `ladder` をそのまま使う。
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
  const budget = input.budgetBytes;
  const now = input.now;
  let index = state.index;
  let lastLowerAt = state.lastLowerAt;
  let lastRaiseCheckAt = state.lastRaiseCheckAt;

  const scale = ladder[index];
  // ADR: 超過判定の `predict` は毎回1回だけ呼ぶ。下振れ予測の単調性を仮定せず、
  // 超過時の走査は全段をなめる（1段213MiB級の移動では二分探索の前提が崩れるため）。
  if (budget !== null && input.predict(scale as number) > budget) {
    let found = -1;
    // ADR: 既に末尾なら走査しても見つからないため、再走査を省いて即 `floor` にする。
    // 連続 floor でも毎フレーム全段の `predict` を回さないための措置である。
    if (index < ladder.length - 1) {
      for (let j = index + 1; j < ladder.length; j++) {
        if (input.predict(ladder[j] as number) <= budget) {
          found = j;
          break;
        }
      }
    }
    lastLowerAt = now;
    if (found === -1) {
      index = ladder.length - 1;
      return { state: { index, lastLowerAt, lastRaiseCheckAt }, decision: 'floor' };
    }
    index = found;
    return { state: { index, lastLowerAt, lastRaiseCheckAt }, decision: 'lower' };
  }
  // ADR: 引き下げ直後の揺り戻しを抑えるため、冷却と判定間隔の両方が開くまで上げない。
  // 冷却中・間隔内は引き上げ候補の `predict` を呼ばず、予測コストを抑える。
  const cooled = lastLowerAt === null || now - lastLowerAt >= options.raiseCooldownMs;
  const due = lastRaiseCheckAt === null || now - lastRaiseCheckAt >= options.raiseIntervalMs;
  if (index > 0 && cooled && due) {
    lastRaiseCheckAt = now;
    // ADR: 予算未設定時は予測なしで段階的に最大へ戻す。予算ありでも余裕（headroom）があるときだけ上げる。
    // `== budget` ちょうどの引き上げは、下振れ余地がなく直後に再引き下げとなるため headroom で抑止する。
    if (budget === null || input.predict(ladder[index - 1] as number) <= options.raiseHeadroom * budget) {
      index = index - 1;
      return { state: { index, lastLowerAt, lastRaiseCheckAt }, decision: 'raise' };
    }
  }
  return { state: { index, lastLowerAt, lastRaiseCheckAt }, decision: 'hold' };
}
