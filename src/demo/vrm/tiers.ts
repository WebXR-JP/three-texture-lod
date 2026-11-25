/**
 * VRMデモの絶対解像度Tier定義。
 *
 * level 0 が最細。Tier値はテクスチャ長辺の上限であり、
 * 256/512といった2の冪以外のソース幅でもTier以下に収まるよう
 * 整数分割で切り詰める（案Y）。
 *
 * @packageDocumentation
 */

/** Tierの絶対解像度（px）。level 0 が最細。 */
export const LOD_TIERS = [4096, 2048, 1024, 512, 256] as const;

/** Tierごとの距離境界（surface距離、メートル）。 */
export const LOD_DISTANCES = [0, 3, 6, 12, 24] as const;

/**
 * Tierに収めるための整数分割数を求める。
 *
 * Tierを超えない最大の整数分割であり、非2冪の幅でも結果の長辺が
 * Tier以下になる（`floor(maxDim / divisor) <= tier`）。
 *
 * @param maxDim - テクスチャの長辺（px）。有限正数。
 * @param tier - Tier値（px）。正数。
 * @returns `max(1, ceil(maxDim / tier))`。
 * @throws `RangeError` — `maxDim` が有限正数でない、または `tier` が正数でない場合。
 */
export function tierDivisor(maxDim: number, tier: number): number {
  if (!Number.isFinite(maxDim) || maxDim <= 0) {
    throw new RangeError(`maxDim は有限正数である必要があります: ${String(maxDim)}`);
  }
  if (!Number.isFinite(tier) || tier <= 0) {
    throw new RangeError(`tier は正数である必要があります: ${String(tier)}`);
  }
  return Math.max(1, Math.ceil(maxDim / tier));
}

/**
 * 解像度値以下で最大のTierのindexを求める。
 *
 * `?top` の丸めに使う。範囲外は端にクランプする。
 *
 * @param resolution - 解像度値（px）。有限数。
 * @returns その値以下で最大のTierのindex。範囲外は端（4096超→0、256未満→4）。
 * @throws `RangeError` — `resolution` が有限数でない場合。
 */
export function tierIndexForResolution(resolution: number): number {
  if (!Number.isFinite(resolution)) {
    throw new RangeError(`resolution は有限数である必要があります: ${String(resolution)}`);
  }
  for (let index = 0; index < LOD_TIERS.length; index++) {
    if (resolution >= LOD_TIERS[index]) return index;
  }
  return LOD_TIERS.length - 1;
}

/**
 * レベル番号に対応するTier値を返す。
 *
 * @param level - レベル番号。範囲外は端にクランプする。
 * @returns `LOD_TIERS` の対応値。
 */
export function levelTier(level: number): number {
  if (!Number.isFinite(level)) return LOD_TIERS[LOD_TIERS.length - 1];
  const clamped = Math.min(LOD_TIERS.length - 1, Math.max(0, Math.floor(level)));
  return LOD_TIERS[clamped];
}

/**
 * テクスチャ幅の表示ラベルを作る。
 *
 * @param width - テクスチャ幅（px）。
 * @returns 例 `"4096"`。
 */
export function tierLabel(width: number): string {
  return `${Math.round(width)}`;
}
