/**
 * ヒステリシス付きのLODレベル判定（純粋関数）。
 *
 * @packageDocumentation
 */

/**
 * 現在距離からLODレベルを求める。
 *
 * 初回（`previous` が `null`）はヒステリシスなしで `d >= thresholds[i]` を満たす最大の `i` を返す。
 * 以降は上下のバンド端 `T[level+1]*(1+h)` / `T[level]*(1-h)` を越えた分だけ複数段まとめて移動する
 * （テレポート等の大きな距離変化に対応する）。
 *
 * @param previous - 現在のレベル。初回は `null`。`null` 以外は `0` 以上 `thresholds.length` 未満の整数であること。
 * @param distance - カメラからの距離（メートル）。有限であること。
 * @param thresholds - レベル境界の昇順配列。`thresholds[0] === 0`、長さ2以上を前提とする。
 * @param hysteresis - ヒステリシス幅。`0 <= h < 1` を前提とする。`0` は単調なしきい値判定になる。
 * @returns 選択されたレベル番号。
 * @throws `RangeError` — `distance` が非有限（`NaN`・無限大）の場合。
 * @throws `RangeError` — `previous` が `null` 以外で、整数でない・負・`thresholds` の範囲外の場合。
 */
export function selectLevel(
  previous: number | null,
  distance: number,
  thresholds: readonly number[],
  hysteresis: number,
): number {
  if (!Number.isFinite(distance)) {
    throw new RangeError(`distance は有限である必要があります: ${String(distance)}`);
  }
  const n = thresholds.length;
  // ADR: `previous` の検証は数回の比較に留め、毎フレーム呼ばれる判定の負荷を増やさない。
  // 範囲外のレベルで while を回すと想定外の段へ飛ぶため、入口で失敗させる。
  if (previous !== null && (!Number.isInteger(previous) || previous < 0 || previous >= n)) {
    throw new RangeError(`previous は null または 0 以上 ${n} 未満の整数である必要があります: ${String(previous)}`);
  }
  if (previous === null) {
    // ADR: 初回はヒステリシスなしの >= 判定にする。
    // 定義の「先頭レベル distance=0」と対応し、どの距離でも必ずいずれかのレベルに決まる。
    // 定常状態の厳密不等式（>/</<）とは境界値で1段ずれるが、境界値は測度0であり、
    // かつ一度決まった後は粘着的に安定するため発振は起きない。
    let level = 0;
    for (let i = 1; i < n; i++) {
      if (distance >= thresholds[i]) {
        level = i;
      }
    }
    return level;
  }
  let level = previous;
  // ADR: 上方向の判定を先に行う。
  // 遠ざかりと近づきの両方に1回の呼び出しで追従し、テレポートで複数段まとめて移動できる。
  // バンドが重ならない条件（set生成時に検証）があれば、上下の while は両方発火しない。
  while (level < n - 1 && distance > thresholds[level + 1] * (1 + hysteresis)) {
    level++;
  }
  while (level > 0 && distance < thresholds[level] * (1 - hysteresis)) {
    level--;
  }
  return level;
}
