/**
 * WASD 移動 + Pointer Lock 視点の一人称カメラの純粋ロジック。
 *
 * three には依存せず、座標系だけを three に合わせる。描画側
 * （`main.ts`）はここで更新した状態をカメラへ書き戻す。
 * 座標系の前提は `three` と同じ右手系（+y が上）である。
 */

/** 一人称操作の調整値。単位は SI（メートル・秒・ラジアン）。 */
export const FIRST_PERSON_TUNING = {
  /** 目線の高さ（m）。アバターの目線と揃える。 */
  eyeHeight: 1.55,
  /** 移動速度（m/s）。 */
  speed: 2.6,
  /** ダッシュ時の移動速度（m/s。Shift 押下）。 */
  sprintSpeed: 5.2,
  /** 速度の指数追従の速さ（1/s）。目標速度へ `1 - exp(-accel*dt)` で近づく。 */
  accel: 12,
  /** マウス感度（rad/px）。視点の yaw・pitch 両方に使う。 */
  mouseSensitivity: 0.0022,
  /** 視点の上下限（rad）。真上・真下の特異点と床の裏側を見ないための余裕。 */
  maxPitch: (85 * Math.PI) / 180,
  /** 移動範囲の下限・上限（m）。90m 四方の床（±45m）からはみ出さない余裕。 */
  minX: -40,
  maxX: 40,
  minZ: -40,
  maxZ: 40,
} as const;

/**
 * 一人称の状態。位置はワールド座標（m）。
 * 向きはオイラー角（rad）で、`yaw = 0` は `-z` を向く。
 * `yaw` は `+y` 軸まわりで左向き（反時計まわり）が正、`pitch` は上が正である。
 * `vx`・`vz` は現在の水平速度（m/s）で、指数追従の中間状態として使う。
 */
export interface FirstPersonState {
  x: number;
  y: number;
  z: number;
  /** 水平方向の向き（rad）。`0` で `-z` を向く。 */
  yaw: number;
  /** 垂直方向の向き（rad）。上が正で `±maxPitch` に収まる。 */
  pitch: number;
  vx: number;
  vz: number;
}

/**
 * 1フレームぶんの移動入力。`forward`・`right` は `-1〜1`。
 * `forward = 1` が前進（W）、`right = 1` が右移動（D) である。
 */
export interface FirstPersonInput {
  forward: number;
  right: number;
  /** true のとき `sprintSpeed` で移動する（Shift 押下）。 */
  sprint: boolean;
}

/**
 * 初期状態を作る。`y` は目線の高さ、速度は 0 である。
 *
 * @param x - 初期位置の x（m）。
 * @param z - 初期位置の z（m）。
 * @param yaw - 初期の水平向き（rad）。
 * @param pitch - 初期の垂直向き（rad）。
 */
export function createFirstPersonState(
  x = 0,
  z = 0,
  yaw = 0,
  pitch = 0,
): FirstPersonState {
  return { x, y: FIRST_PERSON_TUNING.eyeHeight, z, yaw, pitch, vx: 0, vz: 0 };
}

/**
 * マウスの移動量から視点を回す。右移動で `yaw` が減り（右を向き）、
 * 上移動（`dyPixels < 0`）で `pitch` が増える（上を向く）。
 * `pitch` は `±maxPitch` に収める。`sensitivity <= 0` では向きは変わらない。
 *
 * @param state - 更新する状態（その場で書き換える）。
 * @param dxPixels - マウスの水平移動量（px。右が正）。
 * @param dyPixels - マウスの垂直移動量（px。下が正）。
 * @param sensitivity - マウス感度（rad/px）。
 */
export function applyLook(
  state: FirstPersonState,
  dxPixels: number,
  dyPixels: number,
  sensitivity: number = FIRST_PERSON_TUNING.mouseSensitivity,
): void {
  if (!Number.isFinite(dxPixels) || !Number.isFinite(dyPixels)) return;
  if (!(sensitivity > 0)) return;
  state.yaw -= dxPixels * sensitivity;
  state.pitch -= dyPixels * sensitivity;
  const limit = FIRST_PERSON_TUNING.maxPitch;
  state.pitch = Math.min(limit, Math.max(-limit, state.pitch));
}

/**
 * 移動入力から速度と位置を進める。`forward`・`right` の合成ベクトルは
 * 大きさが 1 を超えないよう正規化するため、斜め移動でも定常速度は変わらない。
 * 現在速度は目標速度へ `1 - exp(-accel*dt)` で追従する。
 * 位置は移動範囲に収め、はみ出した軸の速度は 0 にする。
 *
 * @param state - 更新する状態（その場で書き換える）。
 * @param dtSeconds - 経過時間（秒）。`<= 0` では位置も速度も変えない。
 * @param input - 移動入力。
 */
export function stepFirstPerson(
  state: FirstPersonState,
  dtSeconds: number,
  input: FirstPersonInput,
): void {
  if (!(dtSeconds > 0)) return;
  if (!Number.isFinite(dtSeconds)) return;
  const tuning = FIRST_PERSON_TUNING;
  const forward = Number.isFinite(input.forward) ? input.forward : 0;
  const right = Number.isFinite(input.right) ? input.right : 0;
  // yaw = 0 で -z を向き、yaw は +y まわりで左が正。
  // 前方向 (-sin(yaw), -cos(yaw)) と右方向 (cos(yaw), -sin(yaw)) に分解する。
  const sinYaw = Math.sin(state.yaw);
  const cosYaw = Math.cos(state.yaw);
  let wishX = -sinYaw * forward + cosYaw * right;
  let wishZ = -cosYaw * forward - sinYaw * right;
  const length = Math.hypot(wishX, wishZ);
  if (length > 1) {
    wishX /= length;
    wishZ /= length;
  }
  const maxSpeed = input.sprint ? tuning.sprintSpeed : tuning.speed;
  const blend = 1 - Math.exp(-tuning.accel * dtSeconds);
  state.vx += (wishX * maxSpeed - state.vx) * blend;
  state.vz += (wishZ * maxSpeed - state.vz) * blend;
  state.x += state.vx * dtSeconds;
  state.z += state.vz * dtSeconds;
  if (state.x < tuning.minX) {
    state.x = tuning.minX;
    state.vx = 0;
  } else if (state.x > tuning.maxX) {
    state.x = tuning.maxX;
    state.vx = 0;
  }
  if (state.z < tuning.minZ) {
    state.z = tuning.minZ;
    state.vz = 0;
  } else if (state.z > tuning.maxZ) {
    state.z = tuning.maxZ;
    state.vz = 0;
  }
}
