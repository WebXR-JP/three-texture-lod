/**
 * computeLodDistance の仕様固定テスト。
 *
 * 中心距離・表面距離（バウンディング球半径と最大スケールの反映）、
 * 親の移動・回転・スケールの反映、球内側での 0 クランプを確かめる。
 * ワールド行列は呼び出し側で最新化する契約のため、各テストで明示的に更新する。
 */
import { describe, expect, it } from 'vitest';
import { BufferGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry } from 'three';
import { computeLodDistance } from './lod-distance.js';

function cameraAt(x: number, y: number, z: number): PerspectiveCamera {
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(x, y, z);
  camera.updateWorldMatrix(true, false);
  return camera;
}

/** 行列を最新化してから測る（マネージャが行う手順と同じ）。 */
function measure(mesh: Mesh | Group, camera: PerspectiveCamera, mode: 'center' | 'surface'): number {
  mesh.updateWorldMatrix(true, false);
  camera.updateWorldMatrix(true, false);
  return computeLodDistance(mesh, camera, mode);
}

describe('computeLodDistance', () => {
  it('中心距離はワールド中心間の直線距離である', () => {
    const mesh = new Mesh(new PlaneGeometry(2, 2));
    const camera = cameraAt(0, 0, 10);
    expect(measure(mesh, camera, 'center')).toBeCloseTo(10, 10);
  });

  it('表面距離は中心距離からバウンディング球半径を引いた値である', () => {
    // PlaneGeometry(2,2) の外接球半径は sqrt(2)。
    const mesh = new Mesh(new PlaneGeometry(2, 2));
    const camera = cameraAt(0, 0, 10);
    expect(measure(mesh, camera, 'surface')).toBeCloseTo(10 - Math.SQRT2, 10);
  });

  it('表面距離に最大スケールが反映される（自身・親とも）', () => {
    const scaled = new Mesh(new PlaneGeometry(2, 2));
    scaled.scale.set(2, 2, 2);
    expect(measure(scaled, cameraAt(0, 0, 10), 'surface')).toBeCloseTo(10 - 2 * Math.SQRT2, 10);

    const group = new Group();
    group.scale.set(3, 3, 3);
    const child = new Mesh(new PlaneGeometry(2, 2));
    group.add(child);
    // 測定対象はメッシュ自身であり、そのワールド行列に親スケールが含まれる。
    expect(measure(child, cameraAt(0, 0, 10), 'surface')).toBeCloseTo(10 - 3 * Math.SQRT2, 10);
  });

  it('距離の基準はバウンディング球の中心である', () => {
    // 板を x=10 にずらすと球中心も (10,0,0) に移る。原点基準なら 0 になるが、球中心基準では 10 である。
    const geometry = new PlaneGeometry(2, 2);
    geometry.translate(10, 0, 0);
    const mesh = new Mesh(geometry);
    expect(measure(mesh, cameraAt(0, 0, 0), 'center')).toBeCloseTo(10, 10);
  });

  it('非一様スケールでは最大軸のスケールで半径を広げる', () => {
    // 外接球半径 sqrt(2) に最大軸 3 を掛ける。最小軸で割ると粗いLOD側に寄り過ぎる。
    const mesh = new Mesh(new PlaneGeometry(2, 2));
    mesh.scale.set(1, 3, 2);
    expect(measure(mesh, cameraAt(0, 0, 10), 'surface')).toBeCloseTo(10 - 3 * Math.SQRT2, 10);
  });

  it('InstancedMesh ではオブジェクト直属の球を優先する', () => {
    // 2枚の板を x=0 と x=10 に置くと、実配置の球中心は (5,0,0) 付近になる。
    // ジオメトリの球（原点中心）では距離が 0 になるが、直属の球では 5 である。
    const mesh = new InstancedMesh(new PlaneGeometry(2, 2), new MeshBasicMaterial(), 2);
    mesh.setMatrixAt(0, new Matrix4().makeTranslation(0, 0, 0));
    mesh.setMatrixAt(1, new Matrix4().makeTranslation(10, 0, 0));
    expect(measure(mesh, cameraAt(0, 0, 0), 'center')).toBeCloseTo(5, 6);
  });

  it('空ジオメトリでは surface は center を超えず、負にならない', () => {
    // 空ジオメトリの球半径は -1 になり得る。クランプにより半径 0 として扱う。
    const mesh = new Mesh(new BufferGeometry());
    const center = measure(mesh, cameraAt(0, 0, 7), 'center');
    const surface = measure(mesh, cameraAt(0, 0, 7), 'surface');
    expect(surface).toBeLessThanOrEqual(center);
    expect(surface).toBeGreaterThanOrEqual(0);
  });

  it('親の移動・回転が中心距離に反映される', () => {
    const group = new Group();
    const child = new Mesh(new PlaneGeometry(0.5, 0.5));
    child.position.set(3, 0, 0);
    group.add(child);

    // 回転なし: 子のワールド位置は (3,0,0)。カメラ (5,0,0) との距離は 2。
    // 測定対象は子メッシュであり、Group の原点ではない。
    expect(measure(child, cameraAt(5, 0, 0), 'center')).toBeCloseTo(2, 10);

    // Y軸180度回転: 子のワールド位置は (-3,0,0)。カメラ (5,0,0) との距離は 8。
    group.rotation.y = Math.PI;
    expect(measure(child, cameraAt(5, 0, 0), 'center')).toBeCloseTo(8, 10);
  });

  it('カメラがバウンディング球の内側にあるとき表面距離は 0 で負にならない', () => {
    const mesh = new Mesh(new PlaneGeometry(10, 10));
    // 外接球半径は約 7.07。中心距離 1 は球の内側である。
    expect(measure(mesh, cameraAt(0, 0, 1), 'surface')).toBe(0);
    expect(measure(mesh, cameraAt(0, 0, 0), 'surface')).toBe(0);
  });

  it('転置した行列読みでは落ちる配置で中心距離が約0になる', () => {
    // ジオメトリを x=10 にずらして Y軸90度回転すると球中心は (0,0,-10) に移る。
    // カメラ (0,0,-10) との中心距離は約0。行列を行・列を取り違えると0にならない。
    const geometry = new PlaneGeometry(2, 2);
    geometry.translate(10, 0, 0);
    const mesh = new Mesh(geometry);
    mesh.rotation.y = Math.PI / 2;
    expect(measure(mesh, cameraAt(0, 0, -10), 'center')).toBeCloseTo(0, 6);
  });

  it('count 0 の InstancedMesh で surface が負にならない', () => {
    // 空のインスタンス集合は球半径が -1 になり得る。クランプにより負の距離を返さない。
    const mesh = new InstancedMesh(new PlaneGeometry(2, 2), new MeshBasicMaterial(), 0);
    const center = measure(mesh, cameraAt(0, 0, 7), 'center');
    const surface = measure(mesh, cameraAt(0, 0, 7), 'surface');
    expect(Number.isFinite(center)).toBe(true);
    expect(Number.isFinite(surface)).toBe(true);
    expect(surface).toBeGreaterThanOrEqual(0);
    expect(surface).toBeLessThanOrEqual(center);
  });

  it('NaN 中心・半径でも throw せず非有限を返す', () => {
    // NaN 座標は manager 側でスキップされる前提。ここでは throw しないことだけ確かめる。
    const nanPos = new Mesh(new PlaneGeometry(2, 2));
    nanPos.position.set(Number.NaN, 0, 0);
    expect(() => measure(nanPos, cameraAt(0, 0, 7), 'center')).not.toThrow();
    expect(measure(nanPos, cameraAt(0, 0, 7), 'center')).toBeNaN();
    const nanScale = new Mesh(new PlaneGeometry(2, 2));
    nanScale.scale.set(Number.NaN, 1, 1);
    expect(() => measure(nanScale, cameraAt(0, 0, 7), 'surface')).not.toThrow();
    expect(measure(nanScale, cameraAt(0, 0, 7), 'surface')).toBeNaN();
  });

  it('ジオメトリを持たないオブジェクトでは surface と center が一致する', () => {
    const group = new Group();
    expect(measure(group, cameraAt(0, 0, 7), 'surface')).toBeCloseTo(7, 10);
    expect(measure(group, cameraAt(0, 0, 7), 'center')).toBeCloseTo(7, 10);
  });
});
