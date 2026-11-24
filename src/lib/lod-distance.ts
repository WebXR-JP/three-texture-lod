/**
 * カメラからオブジェクトまでのLOD用距離の計算。
 *
 * @packageDocumentation
 */
import type { Camera, Object3D } from 'three';
import type { DistanceMode } from './types.js';

/**
 * カメラからオブジェクトまでのLOD用距離を求める。
 *
 * `center` はバウンディング球の中心からカメラまでの直線距離を返す。
 * `surface` は中心距離からバウンディング球のワールド半径を引いた値を 0 でクランプして返す。
 * ワールド半径はローカル半径にワールド行列の最大スケール（親のスケールを含む）を掛けた値である。
 * 球を持たないオブジェクトの半径は 0 であり、`surface` と `center` は一致する。
 * 球の中心はオブジェクト直属の `boundingSphere`（`InstancedMesh` 等が持つ）を優先し、
 * なければジオメトリの `boundingSphere` を使う。どちらもなければ原点・半径 0 とみなす。
 *
 * @param object - 対象オブジェクト。
 * @param camera - 基準カメラ。
 * @param mode - 距離の測り方。
 * @returns メートル単位の距離。負にはならない。
 * @remarks
 * ワールド行列は読み取るだけであり、更新しない。
 * 移動・回転・スケールの反映には呼び出し側でワールド行列を最新にすること。
 * {@link TextureLodManager.update} は呼び出し前に自動で更新する。
 * `InstancedMesh` の直属球は計算後にキャッシュされ、インスタンス配置を変えても自動更新されない。
 * 配置を変えたら `computeBoundingSphere()` を呼んで取り直すこと。
 */
export function computeLodDistance(object: Object3D, camera: Camera, mode: DistanceMode): number {
  const sphere = localSphere(object);
  // ADR: three の値importなしの方針のため `Vector3` を使わず、行列要素から手計算する。
  // 列優先の Matrix4 で、平行移動は e[12..14]、基底ベクトルは列であることが前提である。
  const e = object.matrixWorld.elements;
  const worldX = e[0] * sphere.x + e[4] * sphere.y + e[8] * sphere.z + e[12];
  const worldY = e[1] * sphere.x + e[5] * sphere.y + e[9] * sphere.z + e[13];
  const worldZ = e[2] * sphere.x + e[6] * sphere.y + e[10] * sphere.z + e[14];
  const cameraElements = camera.matrixWorld.elements;
  const dx = worldX - cameraElements[12];
  const dy = worldY - cameraElements[13];
  const dz = worldZ - cameraElements[14];
  const centerDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (mode === 'center') {
    return centerDistance;
  }
  const radius = worldRadius(object, sphere.radius);
  // ADR: カメラがバウンディング球の内側にある場合は 0 にクランプする。
  // 負の距離は selectLevel の前提（d >= 0）を崩すため、ここで吸収する。
  return Math.max(0, centerDistance - radius);
}

/**
 * オブジェクト直属またはジオメトリ由来の球をローカル座標で求めるための最小の構造型。
 *
 * ADR: `Vector3` 等を使わず中心座標と半径だけを読むのは、値importなしの方針のためである。
 * 型引数の `Object3D` は `import type` のままであり、実行時依存は生じない。
 */
interface WithBoundingSphere {
  readonly boundingSphere?: {
    readonly center: { readonly x: number; readonly y: number; readonly z: number };
    readonly radius: number;
  } | null;
  computeBoundingSphere?: () => void;
}

/**
 * ジオメトリ経由の球取得のための最小の構造型。
 *
 * ADR: `as` の理由は computeLodDistance と同じ（値importの回避）。
 * `geometry` の有無は構造で判定し、Mesh 以外（Group 等）は半径 0 として扱う。
 */
interface WithGeometry {
  readonly geometry?: {
    boundingSphere: { readonly center: { readonly x: number; readonly y: number; readonly z: number }; readonly radius: number } | null;
    computeBoundingSphere(): void;
  } | null;
}

/** ローカル中心と半径を求める。球がなければ原点・半径 0。半径は 0 でクランプする。 */
function localSphere(object: Object3D): { readonly x: number; readonly y: number; readonly z: number; readonly radius: number } {
  // ADR: `as` の理由は computeLodDistance と同じ（値importの回避）。
  // 直属の `boundingSphere` を持たないオブジェクト（Mesh・Group 等）では `undefined` になり、
  // ジオメトリ側へフォールバックする。`null` は「未計算」の意味であり、計算を試みる。
  const shaped = object as unknown as Partial<WithBoundingSphere> & Partial<WithGeometry>;
  const own = shaped.boundingSphere;
  if (own !== undefined) {
    // ADR: オブジェクト直属の球（`InstancedMesh` 等が持つ）を優先する。
    // ジオメトリの球は型枠の広がりしか表さず、実配置の広がりはオブジェクト側の球にしか現れないためである。
    let sphere = own;
    if (sphere === null) {
      shaped.computeBoundingSphere?.();
      sphere = shaped.boundingSphere ?? null;
    }
    if (sphere === null) {
      return { x: 0, y: 0, z: 0, radius: 0 };
    }
    // ADR: 空ジオメトリでは `boundingSphere.radius` が -1 になり得る。
    // 負の半径は距離計算の前提（r >= 0）を崩すため、ここで 0 にクランプする。
    return { x: sphere.center.x, y: sphere.center.y, z: sphere.center.z, radius: Math.max(0, sphere.radius) };
  }
  const geometry = shaped.geometry;
  if (geometry == null) {
    return { x: 0, y: 0, z: 0, radius: 0 };
  }
  if (geometry.boundingSphere === null) {
    geometry.computeBoundingSphere();
  }
  const sphere = geometry.boundingSphere;
  if (sphere === null) {
    return { x: 0, y: 0, z: 0, radius: 0 };
  }
  return { x: sphere.center.x, y: sphere.center.y, z: sphere.center.z, radius: Math.max(0, sphere.radius) };
}

/** バウンディング球のワールド半径を求める。ジオメトリがなければ 0。 */
function worldRadius(object: Object3D, localRadius: number): number {
  if (!(localRadius > 0)) {
    return 0;
  }
  // `Object3D['matrixWorld']` は型付きのため直接読む。
  // 平行移動が [12],[13],[14]、基底ベクトルが列優先なのは three の Matrix4 の不変条件である。
  const e = object.matrixWorld.elements;
  // 列ベクトルの長さが各軸のワールドスケールである。親のスケールも行列に含まれる。
  const scaleX = Math.sqrt(e[0] * e[0] + e[1] * e[1] + e[2] * e[2]);
  const scaleY = Math.sqrt(e[4] * e[4] + e[5] * e[5] + e[6] * e[6]);
  const scaleZ = Math.sqrt(e[8] * e[8] + e[9] * e[9] + e[10] * e[10]);
  // ADR: 非一様スケールでは球が楕円体になるが、最大スケールを採用する。
  // 半径が大きく→距離が小さく→細かいLOD側に寄る。粗くし過ぎるより安全側であり、
  // 境界でのちらつきも抑えられる。
  return localRadius * Math.max(scaleX, scaleY, scaleZ);
}
