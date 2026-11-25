/**
 * 100体までのアバター配置スロット。
 *
 * 先頭4体は従来の固定位置（初期構図で L0/L1/L2/L3 が同時に見える配置）を保ち、
 * 5体目以降は中央の視線レーン（`|x| < 3.0` かつ `z > -12`）を空けたグリッドに置く。
 * 徘徊半径との隙間が 0.5m 以上になるよう、間隔は `2.4`（`2.4 - 2*0.7 = 1.0`）とする。
 */
export const FIXED_SLOTS = [
  { x: 0.9, z: 4.2 },
  { x: -1.3, z: 1.6 },
  { x: 1.7, z: -4.0 },
  { x: -1.5, z: -9.5 },
] as const;

/** 徘徊の移動半径（メートル）。配置間隔との隙間計算の基準になる。 */
export const WANDER_RADIUS = 0.7;

/** 5体目以降のグリッド間隔。 */
const SPACING = 2.4;
/** グリッドの列数。`x = (c - 5.5) * SPACING` で `-13.2`〜`13.2` になる。 */
const COLUMNS = 12;
/** 最前列の z。行ごとに `SPACING` だけ奥へ下げる。 */
const FRONT_Z = -1.0;
/** 視線レーンの半幅。この内側はカメラの視線を遮らないよう空ける。 */
const LANE_HALF_WIDTH = 3.0;
/** 視線レーンを空ける z の上限。この奥ではレーンを使ってもよい。 */
const LANE_Z_LIMIT = -12;

/**
 * 指定体数ぶんの配置スロットを作る。
 *
 * @param capacity - 必要な体数。0 以下では空配列を返す。
 * @returns 先頭から `capacity` 件の `{ x, z }`。先頭4件は {@link FIXED_SLOTS} と一致する。
 * @remarks
 * 各行の x は `|x|` 昇順（中央から、等距離では左を先）に並べ、レーン内は除外する。
 * 行を埋めても足りなければ次の奥の行へ進むため、最遠 z は体数とともに伸びる。
 */
export function buildSlots(capacity: number): { x: number; z: number }[] {
  const slots: { x: number; z: number }[] = [];
  // 非有限・非正では空配列を返す。NaN や無限大で無限ループしないための境界である。
  if (!Number.isFinite(capacity) || capacity <= 0) return slots;
  capacity = Math.floor(capacity);
  for (const fixed of FIXED_SLOTS) {
    if (slots.length >= capacity) return slots;
    slots.push({ x: fixed.x, z: fixed.z });
  }
  // 列の x を中央から外側へ（等距離は左優先）並べた順序。行ごとに使い回す。
  const columnOrder = Array.from({ length: COLUMNS }, (_, c) => (c - (COLUMNS - 1) / 2) * SPACING).sort(
    (a, b) => Math.abs(a) - Math.abs(b) || a - b,
  );
  let row = 0;
  while (slots.length < capacity) {
    const z = FRONT_Z - row * SPACING;
    const laneOpen = z <= LANE_Z_LIMIT;
    for (const x of columnOrder) {
      if (slots.length >= capacity) break;
      if (!laneOpen && Math.abs(x) < LANE_HALF_WIDTH) continue;
      slots.push({ x, z });
    }
    row++;
  }
  return slots;
}
