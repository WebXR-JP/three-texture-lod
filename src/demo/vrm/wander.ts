/**
 * 徘徊（うろちょろ）の純粋な状態機械。
 *
 * three の値には依存せず、`Object3D` は型だけを使う。乱数は mulberry32 で、
 * 種は呼び出し側（アバター名のハッシュなど）が与える。同じ種と同じ `dt` 列からは
 * 同じ軌跡になる。
 */
import type { Object3D } from 'three/webgpu';

/** 徘徊の調整値。単位は SI（メートル・秒・ラジアン）。 */
export const WANDER_TUNING = {
  /** home を中心とする移動半径。配置間隔との隙間計算と共有する。 */
  radius: 0.7,
  /** 歩行速度の最小値（m/s）。 */
  speedMin: 0.3,
  /** 歩行速度の最大値（m/s）。目的地ごとに一様に選ぶ。 */
  speedMax: 0.6,
  /** 待機時間の最小値（秒）。 */
  idleMin: 0.5,
  /** 待機時間の最大値（秒）。 */
  idleMax: 3.0,
  /** 旋回速度（rad/s）。歩行中の向き合わせとその場転回で使う。 */
  turnRate: 3.0,
  /** 加減速の大きさ（m/s^2）。発進と停止時の制動に使う。 */
  accel: 1.2,
  /** この向き誤差（rad）より大きい間は減速し、向き合わせを優先する。 */
  turnFirst: 0.3,
  /** その場転回を選ぶ確率。残りは歩行を選ぶ。 */
  lookAround: 0.3,
  /** 上下動の振幅（m）。 */
  bob: 0.02,
  /** 1歩の長さ（m）。`phase` の進行に使う。 */
  stride: 0.35,
  /** 目的地は現在地から最低この距離（m）だけ離す。4回試して決まらなければ最後の候補を使う。 */
  minHop: 0.3,
  /** 目的地からこの距離（m）以内に入ったら到着とする。 */
  arrive: 0.03,
} as const;

/** 徘徊の振る舞い。`idle`（待機）と `walk`（移動）、`turn`（その場転回）を繰り返す。 */
export type WanderMode = 'idle' | 'walk' | 'turn';

/**
 * 1体ぶんの徘徊状態。`rng` は mulberry32 の内部状態（uint32）で、
 * 乱数が必要なたびに進む。外部から直接書き換えないこと。
 */
export interface WanderState {
  homeX: number;
  homeZ: number;
  x: number;
  z: number;
  /** 現在の向き（rad）。前進方向は `(sin(yaw), cos(yaw))` である。 */
  yaw: number;
  mode: WanderMode;
  /** `idle` の残り待機時間（秒）。他モードでは 0 である。 */
  timer: number;
  /** 目的地。`walk` のときだけ意味を持つ。 */
  tx: number;
  tz: number;
  /** 目的地への向き（rad）。`walk`・`turn` の目標になる。 */
  targetYaw: number;
  /** 現在速度（m/s）。向きが合っていない間は減速する。 */
  speed: number;
  /** この歩行での目標速度（m/s）。目的地ごとに決める。 */
  vmax: number;
  /** 歩行の位相（rad）。進んだ距離を歩幅で割って進める。 */
  phase: number;
  /** 徘徊が有効か。無効中は `stepWander` を進めず、位置は home に固定される。 */
  enabled: boolean;
  /**
   * 円外から新 home へ歩いて入場中か。入場中は安全クランプを止め、
   * 速度×dt を超えない歩行だけで円内へ戻す。
   */
  entering: boolean;
  rng: number;
}

/** mulberry32 を1段進め、`[0, 1)` の乱数を返す。 */
function nextRandom(state: WanderState): number {
  let t = (state.rng + 0x6d2b79f5) | 0;
  state.rng = t;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** 角度差を `-π`〜`π` に正規化する。 */
function wrapAngle(angle: number): number {
  const tau = Math.PI * 2;
  return ((angle + Math.PI) % tau + tau) % tau - Math.PI;
}

/** 次の待機時間を調整値の範囲から一様に選ぶ。 */
function nextIdleTime(state: WanderState): number {
  return (
    WANDER_TUNING.idleMin + nextRandom(state) * (WANDER_TUNING.idleMax - WANDER_TUNING.idleMin)
  );
}

/**
 * 新しい目的地を home 中心・半径内の円から一様に選ぶ。
 *
 * 現在地から `minHop` 以上離れた点を最大4回試す。向きと目標速度も決め直す。
 */
function pickDestination(state: WanderState): void {
  const radius = WANDER_TUNING.radius;
  let px = state.homeX;
  let pz = state.homeZ;
  for (let attempt = 0; attempt < 4; attempt++) {
    const angle = nextRandom(state) * Math.PI * 2;
    const distance = radius * Math.sqrt(nextRandom(state));
    px = state.homeX + Math.cos(angle) * distance;
    pz = state.homeZ + Math.sin(angle) * distance;
    if (Math.hypot(px - state.x, pz - state.z) >= WANDER_TUNING.minHop) break;
  }
  state.tx = px;
  state.tz = pz;
  state.targetYaw = Math.atan2(px - state.x, pz - state.z);
  state.vmax =
    WANDER_TUNING.speedMin + nextRandom(state) * (WANDER_TUNING.speedMax - WANDER_TUNING.speedMin);
  state.speed = 0;
}

/**
 * 初期状態を作る。位置は home と一致し、`idle` から始める。
 *
 * @param home - 徘徊の中心。
 * @param seed - 乱数の種（uint32 として扱う）。同じ種からは同じ軌跡になる。
 */
export function createWander(home: { x: number; z: number }, seed: number): WanderState {
  const state: WanderState = {
    homeX: home.x,
    homeZ: home.z,
    x: home.x,
    z: home.z,
    yaw: 0,
    mode: 'idle',
    timer: 0,
    tx: home.x,
    tz: home.z,
    targetYaw: 0,
    speed: 0,
    vmax: 0,
    phase: 0,
    enabled: true,
    entering: false,
    rng: seed >>> 0,
  };
  state.timer = nextIdleTime(state);
  return state;
}

/** `idle` の更新。待機終了後に 70% で歩行、30% でその場転回を始める。 */
function stepIdle(state: WanderState, dt: number): void {
  state.timer -= dt;
  if (state.timer > 0) return;
  state.timer = 0;
  if (nextRandom(state) < WANDER_TUNING.lookAround) {
    state.mode = 'turn';
    state.targetYaw = state.yaw + (nextRandom(state) * 2 - 1) * Math.PI;
    return;
  }
  state.mode = 'walk';
  pickDestination(state);
}

/** `turn` の更新。その場で目標の向きへ旋回し、合えば待機に戻る。 */
function stepTurn(state: WanderState, dt: number): void {
  const error = wrapAngle(state.targetYaw - state.yaw);
  const maxTurn = WANDER_TUNING.turnRate * dt;
  if (Math.abs(error) <= maxTurn) {
    state.yaw = state.targetYaw;
    state.mode = 'idle';
    state.timer = nextIdleTime(state);
    return;
  }
  state.yaw += Math.sign(error) * maxTurn;
}

/** `walk` の更新。向き合わせを優先し、加減速しながら目的地へ進む。 */
function stepWalk(state: WanderState, dt: number): void {
  const dx = state.tx - state.x;
  const dz = state.tz - state.z;
  const distance = Math.hypot(dx, dz);
  if (distance <= WANDER_TUNING.arrive) {
    state.mode = 'idle';
    state.timer = nextIdleTime(state);
    state.speed = 0;
    state.entering = false;
    return;
  }
  const desired = Math.atan2(dx, dz);
  const error = wrapAngle(desired - state.yaw);
  const maxTurn = WANDER_TUNING.turnRate * dt;
  state.yaw =
    Math.abs(error) <= maxTurn ? desired : state.yaw + Math.sign(error) * maxTurn;
  if (Math.abs(error) > WANDER_TUNING.turnFirst) {
    state.speed = Math.max(0, state.speed - WANDER_TUNING.accel * dt);
  } else {
    // 到着前に止まれるよう、制動距離 `sqrt(2*accel*d)` で上限をかける。
    const braking = Math.sqrt(2 * WANDER_TUNING.accel * Math.max(0, distance));
    state.speed = Math.min(
      state.vmax,
      state.speed + WANDER_TUNING.accel * dt,
      braking,
    );
  }
  // 横滑りしないよう、向き方向にだけ進む。
  const step = state.speed * dt;
  state.x += Math.sin(state.yaw) * step;
  state.z += Math.cos(state.yaw) * step;
  state.phase += (step / WANDER_TUNING.stride) * Math.PI;
  // 数値誤差の蓄積で円を外れたら、円周上に戻す。円外からの入場中は
  // 歩行だけで戻すため適用せず、円内に入った時点で入場を終える。
  const offX = state.x - state.homeX;
  const offZ = state.z - state.homeZ;
  const offDistance = Math.hypot(offX, offZ);
  const limit = WANDER_TUNING.radius + 0.05;
  if (state.entering) {
    if (offDistance <= WANDER_TUNING.radius) state.entering = false;
  } else if (offDistance > limit && offDistance > 0) {
    state.x = state.homeX + (offX / offDistance) * WANDER_TUNING.radius;
    state.z = state.homeZ + (offZ / offDistance) * WANDER_TUNING.radius;
  }
}

/**
 * 状態を `dt` 秒だけ進める。
 *
 * @param dt - 経過時間（秒）。有限かつ正の値を想定し、それ以外では何もしない。
 */
export function stepWander(state: WanderState, dt: number): void {
  if (!(dt > 0) || !Number.isFinite(dt)) return;
  if (state.mode === 'idle') stepIdle(state, dt);
  else if (state.mode === 'turn') stepTurn(state, dt);
  else stepWalk(state, dt);
}

/**
 * home を付け替える。
 *
 * 無効化するときは位置を home に一致させ、正面（`yaw = 0`）の待機に戻す
 * （瞬間移動してよい）。有効化するときは瞬間移動しない。現在地が新しい円の外なら
 * その場から新しい円内への歩行を始め、円内では構えを保つ。
 * 待機の切り詰めは、無効から有効への遷移のときだけ行う。
 */
export function setHome(state: WanderState, home: { x: number; z: number }, enabled: boolean): void {
  state.homeX = home.x;
  state.homeZ = home.z;
  if (!enabled) {
    state.enabled = false;
    state.entering = false;
    state.x = home.x;
    state.z = home.z;
    state.yaw = 0;
    state.mode = 'idle';
    state.timer = nextIdleTime(state);
    state.tx = home.x;
    state.tz = home.z;
    state.targetYaw = 0;
    state.speed = 0;
    return;
  }
  const wasEnabled = state.enabled;
  state.enabled = true;
  const outside =
    Math.hypot(state.x - state.homeX, state.z - state.homeZ) > WANDER_TUNING.radius;
  if (!outside) {
    state.entering = false;
    // 円内では構えを保つ。歩行の目的地だけが円を外れたら選び直す。
    if (
      state.mode === 'walk' &&
      Math.hypot(state.tx - state.homeX, state.tz - state.homeZ) > WANDER_TUNING.radius
    ) {
      pickDestination(state);
    }
    // 有効化の直後に動き出すよう、遷移時に限り長い待機を切り詰める（向き・位置は変えない）。
    if (state.mode === 'idle' && !wasEnabled) {
      state.timer = Math.min(state.timer, nextRandom(state) * 0.5);
    }
    return;
  }
  // 入場中の再設定では、目的地が新しい円内なら維持し、円外なら選び直す。
  const keepDestination =
    state.entering &&
    Math.hypot(state.tx - state.homeX, state.tz - state.homeZ) <= WANDER_TUNING.radius;
  state.mode = 'walk';
  state.timer = 0;
  state.entering = true;
  if (keepDestination) {
    state.targetYaw = Math.atan2(state.tx - state.x, state.tz - state.z);
  } else {
    pickDestination(state);
  }
}

/**
 * 状態をシーンの向きへ反映する。VRM0 は `baseYaw` に π が入るため、足し忘れないこと。
 */
export function applyWander(state: WanderState, root: Object3D, baseYaw: number): void {
  root.position.set(state.x, bobY(state), state.z);
  root.rotation.y = baseYaw + state.yaw;
}

/**
 * 上下動の量を返す。歩行中だけ `0`〜`bob` を取り、待機・転回中は `0` である。
 */
export function bobY(state: WanderState): number {
  if (state.mode !== 'walk' || state.vmax <= 0) return 0;
  return WANDER_TUNING.bob * Math.abs(Math.sin(state.phase)) * (state.speed / state.vmax);
}
