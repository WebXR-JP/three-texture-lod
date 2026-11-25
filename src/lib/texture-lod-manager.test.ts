/**
 * TextureLodManager の仕様固定テスト。
 *
 * 登録・毎フレーム更新・ヒステリシス・visible・統計・常駐管理（evict/keep-all、共有テクスチャ）を確かめる。
 * remove 後の登録解除（追跡からの削除・再add・共有時の残存・pinのset単位管理・非破棄）も確かめる。
 * GPUなしで動くよう three の core クラスのみを使い、時計は注入して時間を操作する。
 */
import { describe, expect, it, vi } from 'vitest';
import { DataTexture, Material, Mesh, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, Texture } from 'three';
import { createTextureLodSet } from './texture-lod-set.js';
import { buildScaleLadder } from './threshold-scale.js';
import { TextureLodManager } from './texture-lod-manager.js';
import type { TextureLodLevel } from './types.js';

/** 一辺 size の正方形 DataTexture を作る。 */
function dataTexture(size: number): DataTexture {
  const texture = new DataTexture(new Uint8Array(size * size * 4), size, size);
  texture.needsUpdate = true;
  return texture;
}

/** map のみ・境界 [0,10,20] の3段階セットを作る。 */
function set3(name: string, sizes = [8, 4, 2]) {
  const base = new MeshStandardMaterial({ name });
  const maps = sizes.map((size) => dataTexture(size));
  const levels: TextureLodLevel[] = maps.map((map, i) => ({
    distance: [0, 10, 20][i],
    textures: { map },
  }));
  return { set: createTextureLodSet({ material: base, levels }), base, maps };
}

function sceneMesh(base: MeshStandardMaterial): Mesh {
  return new Mesh(new PlaneGeometry(2, 2), base);
}

function cameraAt(z: number): PerspectiveCamera {
  const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.set(0, 0, z);
  return camera;
}

/** 推定バイト数（RGBA8＋ミップ係数4/3）の期待値。 */
function bytes(size: number): number {
  return (size * size * 4 * 4) / 3;
}

describe('TextureLodManager', () => {
  it('add→updateでバリアントに切り替わり、removeでbaseに戻る', () => {
    const { set, base } = set3('wall');
    const manager = new TextureLodManager();
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      // 初回update前は未判定であり、マテリアルにも触れない。
      expect(manager.levelOf(mesh)).toBeNull();
      expect(mesh.material).toBe(base);
      manager.update(cameraAt(5));
      expect(manager.levelOf(mesh)).toBe(0);
      expect(mesh.material).toBe(set.variant(0));
      manager.remove(mesh);
      expect(mesh.material).toBe(base);
    } finally {
      manager.dispose();
    }
  });

  it('全meshをremoveすると追跡が空になり residentBytes=0 になる', () => {
    // remove 前は常駐分が数えられ、解除後は最粗テクスチャの参照も残らない。
    const { set, base } = set3('wall');
    const manager = new TextureLodManager();
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(5));
      expect(manager.stats().residentBytes).toBeGreaterThan(0);
      manager.remove(mesh);
      const stats = manager.stats();
      expect(stats.objectCount).toBe(0);
      expect(stats.residentBytes).toBe(0);
    } finally {
      manager.dispose();
    }
  });

  it('remove後に再addでき、レベル判定が再開する', () => {
    const { set, base } = set3('wall');
    const manager = new TextureLodManager();
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(5));
      expect(manager.levelOf(mesh)).toBe(0);
      manager.remove(mesh);
      expect(mesh.material).toBe(base);
      manager.add(mesh, set);
      expect(manager.levelOf(mesh)).toBeNull();
      manager.update(cameraAt(30));
      expect(manager.levelOf(mesh)).toBe(2);
      expect(mesh.material).toBe(set.variant(2));
    } finally {
      manager.dispose();
    }
  });

  it('共有テクスチャは片方のsetの解除では残り、両方で消える', () => {
    // setをまたいで同じ Texture を使う場合、どちらかが登録中は追跡に残す。
    const manager = new TextureLodManager();
    const shared = dataTexture(8);
    const a1 = dataTexture(4);
    const b1 = dataTexture(2);
    const baseA = new MeshStandardMaterial({ name: 'a' });
    const baseB = new MeshStandardMaterial({ name: 'b' });
    const setA = createTextureLodSet({
      material: baseA,
      levels: [
        { distance: 0, textures: { map: shared } },
        { distance: 10, textures: { map: a1 } },
      ],
    });
    const setB = createTextureLodSet({
      material: baseB,
      levels: [
        { distance: 0, textures: { map: shared } },
        { distance: 10, textures: { map: b1 } },
      ],
    });
    const meshA = sceneMesh(baseA);
    const meshB = sceneMesh(baseB);
    try {
      manager.add(meshA, setA);
      manager.add(meshB, setB);
      manager.update(cameraAt(5));
      manager.remove(meshA);
      // setA 側の a1 は追跡から外れ、共有の shared と setB 側は残る。
      expect(manager.stats().residentBytes).toBeCloseTo(bytes(8) + bytes(2), 10);
      manager.remove(meshB);
      expect(manager.stats().objectCount).toBe(0);
      expect(manager.stats().residentBytes).toBe(0);
    } finally {
      manager.dispose();
    }
  });

  it('最粗pinはset単位であり、片方のsetの解除で他方のpinは残る', () => {
    // texC は setA の最粗・setB の非最粗に使う。setA の解除で pin が外れ、
    // setB の最粗 b1 の pin には影響しない（set単位の計数であることの確認）。
    let now = 0;
    const manager = new TextureLodManager({ now: () => now, evictDelayMs: 1000 });
    const a0 = dataTexture(8);
    const texC = dataTexture(4);
    const b1 = dataTexture(2);
    const spyC = vi.spyOn(texC, 'dispose');
    const spyB1 = vi.spyOn(b1, 'dispose');
    const baseA = new MeshStandardMaterial({ name: 'a' });
    const baseB = new MeshStandardMaterial({ name: 'b' });
    const setA = createTextureLodSet({
      material: baseA,
      levels: [
        { distance: 0, textures: { map: a0 } },
        { distance: 10, textures: { map: texC } },
      ],
    });
    const setB = createTextureLodSet({
      material: baseB,
      levels: [
        { distance: 0, textures: { map: texC } },
        { distance: 10, textures: { map: b1 } },
      ],
    });
    const meshA = sceneMesh(baseA);
    const meshB = sceneMesh(baseB);
    meshB.position.z = 50;
    try {
      manager.add(meshA, setA);
      manager.add(meshB, setB);
      manager.update(cameraAt(5)); // A=レベル0、B=レベル1。texC は未参照だが setA の最粗で常駐する。
      now = 5000;
      manager.update(cameraAt(5));
      expect(spyC).not.toHaveBeenCalled();
      manager.remove(meshA); // setA の pin が外れる。setB は texC を最粗に使わないため pin なし。
      now = 10000;
      manager.update(cameraAt(5));
      expect(spyC).toHaveBeenCalledTimes(1);
      expect(spyB1).not.toHaveBeenCalled();
      // 破棄済みの texC は常駐から外れ、最粗の b1 のみ残る。
      expect(manager.stats().residentBytes).toBeCloseTo(bytes(2), 10);
    } finally {
      manager.dispose();
    }
  });

  it('removeはTexture.disposeを呼ばない', () => {
    // remove は登録解除にすぎず、テクスチャの寿命は利用者が持つ。
    const { set, base, maps } = set3('wall');
    const spies = maps.map((map) => vi.spyOn(map, 'dispose'));
    const manager = new TextureLodManager();
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(5));
      manager.remove(mesh);
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      manager.dispose();
    }
  });

  it('同一setを共有した2meshは片方removeでも常駐し、両方外すと0になり再addできる', () => {
    // 同一setを複数meshで使う場合、1件が残る間は追跡を維持することを確かめる。
    const { set, base } = set3('wall');
    const manager = new TextureLodManager();
    const meshA = sceneMesh(base);
    const meshB = sceneMesh(base);
    try {
      manager.add(meshA, set);
      manager.add(meshB, set);
      manager.update(cameraAt(5));
      expect(manager.levelOf(meshA)).toBe(0);
      expect(manager.levelOf(meshB)).toBe(0);
      manager.remove(meshA);
      expect(manager.stats().residentBytes).toBeGreaterThan(0);
      manager.remove(meshB);
      expect(manager.stats().residentBytes).toBe(0);
      manager.add(meshA, set);
      expect(manager.levelOf(meshA)).toBeNull();
      manager.update(cameraAt(5));
      expect(manager.levelOf(meshA)).toBe(0);
    } finally {
      manager.dispose();
    }
  });

  it('二重addがthrowしても部分登録は残らず、既存meshのremoveで追跡は空になる', () => {
    // 二重登録の失敗で参照カウントがずれないことを確かめる。
    const { set, base } = set3('wall');
    const manager = new TextureLodManager();
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      expect(() => manager.add(mesh, set)).toThrow(Error);
      manager.remove(mesh);
      expect(manager.stats().objectCount).toBe(0);
      expect(manager.stats().residentBytes).toBe(0);
    } finally {
      manager.dispose();
    }
  });

  it('位置NaNのメッシュがあってもthrowせず後続を更新し、NaN側はnullのまま', () => {
    // 不正な transform の1件で全LOD更新が止まらないことを確かめる。
    const { set, base } = set3('wall');
    const manager = new TextureLodManager({ distanceMode: 'center' });
    const bad = sceneMesh(base);
    bad.position.set(Number.NaN, 0, 0);
    const good = sceneMesh(base);
    try {
      manager.add(bad, set);
      manager.add(good, set);
      expect(() => manager.update(cameraAt(5))).not.toThrow();
      expect(manager.levelOf(bad)).toBeNull();
      expect(bad.material).toBe(base);
      expect(manager.levelOf(good)).not.toBeNull();
    } finally {
      manager.dispose();
    }
  });

  it('二重登録と未登録の解除・参照でErrorを投げる', () => {
    const { set, base } = set3('wall');
    const manager = new TextureLodManager();
    const mesh = sceneMesh(base);
    const other = sceneMesh(base);
    try {
      manager.add(mesh, set);
      expect(() => manager.add(mesh, set)).toThrow(Error);
      expect(() => manager.remove(other)).toThrow(Error);
      expect(() => manager.levelOf(other)).toThrow(Error);
    } finally {
      manager.dispose();
    }
  });

  it('updateで行列更新前の移動が反映され、距離に応じたレベルになる', () => {
    const { set, base } = set3('wall');
    const manager = new TextureLodManager();
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      // PlaneGeometry(2,2)の外接球半径は約1.41。surface距離で判定する。
      manager.update(cameraAt(5)); // surface 約3.59 → 0
      expect(manager.levelOf(mesh)).toBe(0);
      manager.update(cameraAt(15)); // surface 約13.59 → 1
      expect(manager.levelOf(mesh)).toBe(1);
      expect(mesh.material).toBe(set.variant(1));
      // 行列を自前で更新せずに動かしても、update側の更新で正しく判定される。
      mesh.position.z = 50;
      manager.update(cameraAt(15)); // surface 約36.4 → 2
      expect(manager.levelOf(mesh)).toBe(2);
    } finally {
      manager.dispose();
    }
  });

  it('境界往復では切り替わらず、バンドを抜けたら切り替わる', () => {
    const base = new MeshStandardMaterial({ name: 'wall' });
    const maps = [dataTexture(8), dataTexture(4)];
    // 上端 10*1.2=12・下端 10*0.8=8 のバンド。
    const set = createTextureLodSet({
      material: base,
      levels: [
        { distance: 0, textures: { map: maps[0] } },
        { distance: 10, textures: { map: maps[1] } },
      ],
      hysteresis: 0.2,
    });
    // 中心距離で厳密に境界を操作する。上端12・下端8のバンド。
    const manager = new TextureLodManager({ distanceMode: 'center' });
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(12.5));
      expect(manager.levelOf(mesh)).toBe(1);
      const switches = manager.stats().switchCount;
      // バンド内（8〜12）の往復では切替もマテリアル代入も起きない。
      const material = mesh.material;
      for (const z of [11, 9, 11, 9, 10, 8.5, 11.5]) {
        manager.update(cameraAt(z));
      }
      expect(manager.levelOf(mesh)).toBe(1);
      expect(mesh.material).toBe(material);
      expect(manager.stats().switchCount).toBe(switches);
      // 下端を抜けたら切り替わる。
      manager.update(cameraAt(7));
      expect(manager.levelOf(mesh)).toBe(0);
      expect(manager.stats().switchCount).toBe(switches + 1);
    } finally {
      manager.dispose();
    }
  });

  it('visible=false の間は判定せず、レベルと参照を保持する', () => {
    const { set, base } = set3('wall');
    const manager = new TextureLodManager();
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(30));
      expect(manager.levelOf(mesh)).toBe(2);
      const switches = manager.stats().switchCount;
      mesh.visible = false;
      manager.update(cameraAt(5));
      expect(manager.levelOf(mesh)).toBe(2);
      expect(mesh.material).toBe(set.variant(2));
      expect(manager.stats().switchCount).toBe(switches);
      mesh.visible = true;
      manager.update(cameraAt(5));
      expect(manager.levelOf(mesh)).toBe(0);
    } finally {
      manager.dispose();
    }
  });

  it('statsは台数・切替回数・レベル別台数・常駐推定値を返す', () => {
    let now = 0;
    const manager = new TextureLodManager({ now: () => now });
    const a = set3('a');
    const bBase = new MeshStandardMaterial({ name: 'b' });
    const bMaps = [dataTexture(6), dataTexture(3)];
    const bSet = createTextureLodSet({
      material: bBase,
      levels: [
        { distance: 0, textures: { map: bMaps[0] } },
        { distance: 30, textures: { map: bMaps[1] } },
      ],
    });
    const meshA = sceneMesh(a.base);
    const meshB = sceneMesh(bBase);
    try {
      manager.add(meshA, a.set);
      manager.add(meshB, bSet);
      manager.update(cameraAt(40));
      const stats = manager.stats();
      expect(stats.objectCount).toBe(2);
      expect(stats.switchCount).toBe(2);
      // レベル番号をまたいで集計する。最大段数3に合わせた長さになる。
      expect(stats.levelCounts).toEqual([0, 1, 1]);
      expect(stats.residentBytes).toBeCloseTo(
        bytes(8) + bytes(4) + bytes(2) + bytes(6) + bytes(3),
        10,
      );
    } finally {
      manager.dispose();
    }
  });

  it('evictでは猶予後に未使用テクスチャを破棄し、最粗は残す。再使用で復帰する', () => {
    let now = 0;
    const manager = new TextureLodManager({ now: () => now, evictDelayMs: 1000 });
    const { set, base, maps } = set3('wall');
    const spies = maps.map((map) => vi.spyOn(map, 'dispose'));
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(5)); // レベル0を使用
      manager.update(cameraAt(30)); // レベル2へ。レベル0は未参照になる
      now = 500;
      manager.update(cameraAt(30));
      expect(spies[0]).not.toHaveBeenCalled();
      now = 1000;
      manager.update(cameraAt(30));
      // 猶予経過で未使用のレベル0・1は破棄、最粗（レベル2）は常駐のため残る。
      expect(spies[0]).toHaveBeenCalledTimes(1);
      expect(spies[1]).toHaveBeenCalledTimes(1);
      expect(spies[2]).not.toHaveBeenCalled();
      const evictedBytes = manager.stats().residentBytes;
      expect(evictedBytes).toBeCloseTo(bytes(2), 10);
      // 再使用すると追跡に復帰する。レベル0に戻るとレベル0・2が常駐に戻り、
      // さらにレベル1を使うと全テクスチャが常駐に戻る。
      manager.update(cameraAt(5));
      expect(manager.stats().residentBytes).toBeCloseTo(bytes(8) + bytes(2), 10);
      manager.update(cameraAt(15));
      expect(manager.stats().residentBytes).toBeCloseTo(bytes(8) + bytes(4) + bytes(2), 10);
    } finally {
      manager.dispose();
    }
  });

  it('evictでも使っていない最粗テクスチャは破棄しない', () => {
    let now = 0;
    const manager = new TextureLodManager({ now: () => now, evictDelayMs: 1000 });
    const { set, base, maps } = set3('wall');
    const spies = maps.map((map) => vi.spyOn(map, 'dispose'));
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(5)); // ずっとレベル0
      now = 2000;
      manager.update(cameraAt(5));
      expect(spies[0]).not.toHaveBeenCalled();
      // 未使用のレベル1は破棄されるが、最粗のレベル2はpinのため残る。
      expect(spies[1]).toHaveBeenCalledTimes(1);
      expect(spies[2]).not.toHaveBeenCalled();
    } finally {
      manager.dispose();
    }
  });

  it('異なるsetで共有されたテクスチャの参照カウントが壊れない', () => {
    let now = 0;
    const manager = new TextureLodManager({ now: () => now, evictDelayMs: 1000 });
    const shared = dataTexture(8);
    const sharedSpy = vi.spyOn(shared, 'dispose');
    const baseA = new MeshStandardMaterial({ name: 'a' });
    const baseB = new MeshStandardMaterial({ name: 'b' });
    const setA = createTextureLodSet({
      material: baseA,
      levels: [
        { distance: 0, textures: { map: shared } },
        { distance: 10, textures: { map: dataTexture(4) } },
      ],
    });
    const setB = createTextureLodSet({
      material: baseB,
      levels: [
        { distance: 0, textures: { map: shared } },
        { distance: 10, textures: { map: dataTexture(2) } },
      ],
    });
    const meshA = sceneMesh(baseA);
    const meshB = sceneMesh(baseB);
    try {
      manager.add(meshA, setA);
      manager.add(meshB, setB);
      manager.update(cameraAt(5)); // 両方レベル0。shared の refs=2。
      meshA.position.z = 50;
      manager.update(cameraAt(5)); // meshAのみレベル1。refs=1。
      now = 5000;
      manager.update(cameraAt(5));
      // まだmeshBが使っているため破棄されない。
      expect(sharedSpy).not.toHaveBeenCalled();
      meshB.position.z = 50;
      manager.update(cameraAt(5)); // refs=0。
      now = 6000;
      manager.update(cameraAt(5));
      expect(sharedSpy).toHaveBeenCalledTimes(1);
    } finally {
      manager.dispose();
    }
  });

  it('keep-allでは時間が経っても破棄しない', () => {
    let now = 0;
    const manager = new TextureLodManager({ residency: 'keep-all', now: () => now });
    const { set, base, maps } = set3('wall');
    const spies = maps.map((map) => vi.spyOn(map, 'dispose'));
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(5));
      manager.update(cameraAt(30));
      now = 60_000;
      manager.update(cameraAt(30));
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
      expect(manager.stats().residentBytes).toBeCloseTo(bytes(8) + bytes(4) + bytes(2), 10);
    } finally {
      manager.dispose();
    }
  });

  it('disposeはマテリアルを戻し追跡を消すが、テクスチャは破棄しない', () => {
    const manager = new TextureLodManager();
    const { set, base, maps } = set3('wall');
    const spies = maps.map((map) => vi.spyOn(map, 'dispose'));
    const mesh = sceneMesh(base);
    manager.add(mesh, set);
    manager.update(cameraAt(30));
    manager.dispose();
    expect(mesh.material).toBe(base);
    expect(manager.stats().objectCount).toBe(0);
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

describe('TextureLodManager groups', () => {
  it('addGroupで複数メッシュが同じレベルに連動し、統計はグループ単位になる', () => {
    // 1つの距離ソース（束縛外のanchor可）から全束縛が同じレベルに切り替わることの確認。
    // 統計の objectCount・levelCounts と切替回数がグループ単位であることも確かめる。
    const a = set3('body');
    const bBase = new MeshStandardMaterial({ name: 'face' });
    const bSet = createTextureLodSet({
      material: bBase,
      levels: [8, 4, 2].map((size, i) => ({
        distance: [0, 10, 20][i],
        textures: { map: dataTexture(size) },
      })),
    });
    const manager = new TextureLodManager();
    const meshA = sceneMesh(a.base);
    const meshB = sceneMesh(bBase);
    const anchor = sceneMesh(a.base);
    try {
      manager.addGroup(
        [
          { mesh: meshA, set: a.set },
          { mesh: meshB, set: bSet },
        ],
        { anchor },
      );
      // 初回update前はマテリアルに触れない。
      expect(meshA.material).toBe(a.base);
      expect(meshB.material).toBe(bBase);
      manager.update(cameraAt(5));
      expect(manager.levelOf(meshA)).toBe(0);
      expect(manager.levelOf(meshB)).toBe(0);
      expect(meshA.material).toBe(a.set.variant(0));
      expect(meshB.material).toBe(bSet.variant(0));
      // 統計はグループ単位であり、切替もグループで1回だけ数える。
      expect(manager.stats().objectCount).toBe(1);
      expect(manager.stats().levelCounts).toEqual([1, 0, 0]);
      expect(manager.stats().switchCount).toBe(1);
      manager.update(cameraAt(30));
      expect(manager.levelOf(meshA)).toBe(2);
      expect(manager.levelOf(meshB)).toBe(2);
      expect(meshA.material).toBe(a.set.variant(2));
      expect(meshB.material).toBe(bSet.variant(2));
      expect(manager.stats().levelCounts).toEqual([0, 0, 1]);
      expect(manager.stats().switchCount).toBe(2);
    } finally {
      manager.dispose();
    }
  });

  it('境界が違うセットを混ぜるとthrowし、登録が残らない', () => {
    // レベル番号の共有には境界の完全一致が必要であり、失敗時は部分登録を残さないことの確認。
    const a = set3('a');
    const bBase = new MeshStandardMaterial({ name: 'b' });
    const bSet = createTextureLodSet({
      material: bBase,
      levels: [
        { distance: 0, textures: { map: dataTexture(8) } },
        { distance: 10, textures: { map: dataTexture(4) } },
        { distance: 25, textures: { map: dataTexture(2) } },
      ],
    });
    const manager = new TextureLodManager();
    const meshA = sceneMesh(a.base);
    const meshB = sceneMesh(bBase);
    try {
      expect(() =>
        manager.addGroup([
          { mesh: meshA, set: a.set },
          { mesh: meshB, set: bSet },
        ]),
      ).toThrow(/境界/);
      expect(manager.stats().objectCount).toBe(0);
      expect(manager.stats().residentBytes).toBe(0);
      // 失敗後に単独登録できる（部分登録が残っていない）。
      manager.add(meshA, a.set);
      expect(manager.stats().objectCount).toBe(1);
      manager.remove(meshA);
      expect(manager.stats().residentBytes).toBe(0);
    } finally {
      manager.dispose();
    }
  });

  it('hysteresisが違うセットを混ぜるとthrowする', () => {
    // 境界が同じでも幅が違えばレベル共有できないこと、どちら側の不一致かが分かることの確認。
    const aBase = new MeshStandardMaterial({ name: 'a' });
    const bBase = new MeshStandardMaterial({ name: 'b' });
    const levelsFor = (size: number): TextureLodLevel[] => [
      { distance: 0, textures: { map: dataTexture(size) } },
      { distance: 10, textures: { map: dataTexture(size / 2) } },
    ];
    const setA = createTextureLodSet({ material: aBase, levels: levelsFor(8), hysteresis: 0.1 });
    const setB = createTextureLodSet({ material: bBase, levels: levelsFor(8), hysteresis: 0.2 });
    const manager = new TextureLodManager();
    try {
      expect(() =>
        manager.addGroup([
          { mesh: sceneMesh(aBase), set: setA },
          { mesh: sceneMesh(bBase), set: setB },
        ]),
      ).toThrow(/hysteresis/);
      expect(manager.stats().objectCount).toBe(0);
      expect(manager.stats().residentBytes).toBe(0);
    } finally {
      manager.dispose();
    }
  });

  it('bindingsが空だとthrowする', () => {
    // 距離ソースも束縛もないグループは作れないことの確認。
    const manager = new TextureLodManager();
    try {
      expect(() => manager.addGroup([])).toThrow(Error);
      expect(manager.stats().objectCount).toBe(0);
    } finally {
      manager.dispose();
    }
  });

  it('二重登録があるとthrowし、部分登録が残らない', () => {
    // 2件目が登録済みでも、先に全件検証して1件目も登録しないことの確認。
    const a = set3('a');
    const b = set3('b');
    const manager = new TextureLodManager();
    const meshA = sceneMesh(a.base);
    const meshB = sceneMesh(b.base);
    const meshC = sceneMesh(b.base);
    try {
      manager.addGroup([
        { mesh: meshA, set: a.set },
        { mesh: meshB, set: b.set },
      ]);
      expect(() =>
        manager.addGroup([
          { mesh: meshC, set: b.set },
          { mesh: meshA, set: a.set },
        ]),
      ).toThrow(Error);
      // meshC は未登録のまま、既存グループは壊れていない。
      expect(() => manager.levelOf(meshC)).toThrow(Error);
      expect(manager.stats().objectCount).toBe(1);
      manager.update(cameraAt(5));
      expect(manager.levelOf(meshA)).toBe(0);
      expect(manager.levelOf(meshB)).toBe(0);
      // 解除後に組み直せる。
      manager.remove(meshA);
      expect(manager.stats().objectCount).toBe(0);
      manager.addGroup([
        { mesh: meshC, set: b.set },
        { mesh: meshA, set: a.set },
      ]);
      expect(manager.stats().objectCount).toBe(1);
    } finally {
      manager.dispose();
    }
  });

  it('removeはグループ全体を解除し、全メッシュがbaseに戻る', () => {
    // 片方の remove で同じグループの他メッシュも同時に外れることの確認。
    const a = set3('a');
    const b = set3('b');
    const manager = new TextureLodManager();
    const meshA = sceneMesh(a.base);
    const meshB = sceneMesh(b.base);
    try {
      manager.addGroup([
        { mesh: meshA, set: a.set },
        { mesh: meshB, set: b.set },
      ]);
      manager.update(cameraAt(5));
      expect(manager.stats().residentBytes).toBeGreaterThan(0);
      manager.remove(meshA);
      expect(meshA.material).toBe(a.base);
      expect(meshB.material).toBe(b.base);
      expect(() => manager.levelOf(meshB)).toThrow(Error);
      expect(manager.stats().objectCount).toBe(0);
      expect(manager.stats().residentBytes).toBe(0);
      // 再登録できる。
      manager.add(meshA, a.set);
      manager.update(cameraAt(5));
      expect(manager.levelOf(meshA)).toBe(0);
    } finally {
      manager.dispose();
    }
  });

  it('同じsetを共有したグループは解除で参照が残らない', () => {
    // 1つのsetを2束縛で使っても、グループ解除で登録数が0に戻ることの確認。
    const { set, base } = set3('wall');
    const manager = new TextureLodManager();
    const meshA = sceneMesh(base);
    const meshB = sceneMesh(base);
    try {
      manager.addGroup([
        { mesh: meshA, set },
        { mesh: meshB, set },
      ]);
      manager.update(cameraAt(5));
      expect(manager.stats().residentBytes).toBeGreaterThan(0);
      manager.remove(meshB);
      expect(meshA.material).toBe(base);
      expect(meshB.material).toBe(base);
      expect(manager.stats().objectCount).toBe(0);
      expect(manager.stats().residentBytes).toBe(0);
      // 再登録できる。
      manager.addGroup([
        { mesh: meshA, set },
        { mesh: meshB, set },
      ]);
      manager.update(cameraAt(5));
      expect(manager.levelOf(meshA)).toBe(0);
      expect(manager.levelOf(meshB)).toBe(0);
    } finally {
      manager.dispose();
    }
  });

  it('グループ内で共有されたテクスチャの参照カウントが壊れない', () => {
    // 異なるsetが同じ Texture を使う場合、束縛数ぶん数えて束縛数ぶん戻すことの確認。
    let now = 0;
    const manager = new TextureLodManager({ now: () => now, evictDelayMs: 1000 });
    const shared = dataTexture(8);
    const sharedSpy = vi.spyOn(shared, 'dispose');
    const baseA = new MeshStandardMaterial({ name: 'a' });
    const baseB = new MeshStandardMaterial({ name: 'b' });
    const setA = createTextureLodSet({
      material: baseA,
      levels: [
        { distance: 0, textures: { map: shared } },
        { distance: 10, textures: { map: dataTexture(4) } },
      ],
    });
    const setB = createTextureLodSet({
      material: baseB,
      levels: [
        { distance: 0, textures: { map: shared } },
        { distance: 10, textures: { map: dataTexture(2) } },
      ],
    });
    const meshA = sceneMesh(baseA);
    const meshB = sceneMesh(baseB);
    try {
      manager.addGroup([
        { mesh: meshA, set: setA },
        { mesh: meshB, set: setB },
      ]);
      manager.update(cameraAt(5)); // 両方レベル0。shared の refs=2。
      manager.update(cameraAt(50)); // 両方レベル1。refs=0。
      now = 5000;
      manager.update(cameraAt(50));
      // 2束縛ぶん戻したため破棄は1回だけ。
      expect(sharedSpy).toHaveBeenCalledTimes(1);
      // 再使用で復帰する。
      manager.update(cameraAt(5));
      expect(manager.stats().residentBytes).toBeCloseTo(bytes(8) + bytes(4) + bytes(2), 10);
    } finally {
      manager.dispose();
    }
  });

  it('anchorが見えない間はレベルを保持する', () => {
    // 判定基準は anchor であり、束縛側の可視性では止まらないことの確認。
    const a = set3('a');
    const b = set3('b');
    const manager = new TextureLodManager();
    const meshA = sceneMesh(a.base);
    const meshB = sceneMesh(b.base);
    const anchor = sceneMesh(a.base);
    try {
      manager.addGroup(
        [
          { mesh: meshA, set: a.set },
          { mesh: meshB, set: b.set },
        ],
        { anchor },
      );
      manager.update(cameraAt(30));
      expect(manager.levelOf(meshA)).toBe(2);
      const switches = manager.stats().switchCount;
      // anchor だけ不可視（束縛は可視のまま）でも判定を飛ばす。
      anchor.visible = false;
      manager.update(cameraAt(5));
      expect(manager.levelOf(meshA)).toBe(2);
      expect(manager.levelOf(meshB)).toBe(2);
      expect(meshA.material).toBe(a.set.variant(2));
      expect(meshB.material).toBe(b.set.variant(2));
      expect(manager.stats().switchCount).toBe(switches);
      // 束縛側が不可視でも anchor が可視なら判定する。
      meshA.visible = false;
      anchor.visible = true;
      manager.update(cameraAt(5));
      expect(manager.levelOf(meshA)).toBe(0);
      expect(meshA.material).toBe(a.set.variant(0));
    } finally {
      manager.dispose();
    }
  });

  it('NaNのanchorがあってもthrowせず、他グループは更新される', () => {
    // 不正な transform のグループ1件で全LOD更新が止まらないことの確認。
    const a = set3('a');
    const b = set3('b');
    const manager = new TextureLodManager({ distanceMode: 'center' });
    const badAnchor = sceneMesh(a.base);
    badAnchor.position.set(Number.NaN, 0, 0);
    const badMesh = sceneMesh(a.base);
    const goodMesh = sceneMesh(b.base);
    try {
      manager.addGroup([{ mesh: badMesh, set: a.set }], { anchor: badAnchor });
      manager.add(goodMesh, b.set);
      expect(() => manager.update(cameraAt(5))).not.toThrow();
      expect(manager.levelOf(badMesh)).toBeNull();
      expect(badMesh.material).toBe(a.base);
      expect(manager.levelOf(goodMesh)).not.toBeNull();
    } finally {
      manager.dispose();
    }
  });

  it('具象マテリアル型のセットも束縛として登録できる', () => {
    // 独自テクスチャスロットを持つセットが `TextureLodBinding<Material>` に載ることの確認。
    class AtlasMaterial extends MeshStandardMaterial {
      shadeMultiplyTexture: Texture | null = null;
    }
    const base = new AtlasMaterial();
    base.name = 'atlas';
    const nearShade = dataTexture(8);
    const farShade = dataTexture(2);
    const set = createTextureLodSet({
      material: base,
      levels: [
        { distance: 0, textures: { map: dataTexture(8), shadeMultiplyTexture: nearShade } },
        { distance: 10, textures: { map: dataTexture(4), shadeMultiplyTexture: farShade } },
      ],
    });
    const manager = new TextureLodManager();
    const mesh = sceneMesh(base);
    try {
      manager.addGroup([{ mesh, set }]);
      manager.update(cameraAt(5));
      expect(manager.levelOf(mesh)).toBe(0);
      expect(mesh.material).toBe(set.variant(0));
      manager.update(cameraAt(50));
      expect(manager.levelOf(mesh)).toBe(1);
      expect(mesh.material).toBe(set.variant(1));
      expect(set.variant(1).shadeMultiplyTexture).toBe(farShade);
    } finally {
      manager.dispose();
    }
  });
});


describe('TextureLodManager addGroup の境界', () => {
  it('共通のテクスチャスロットを持たない Material サブクラスでも型が通り、実行時に切り替わる', () => {
    class CustomMaterial extends Material {
      foo: Texture | null = null;
    }
    const base = new CustomMaterial();
    const textures = [dataTexture(8), dataTexture(4)];
    const set = createTextureLodSet({
      material: base,
      levels: [
        { distance: 0, textures: { foo: textures[0] } },
        { distance: 10, textures: { foo: textures[1] } },
      ],
    });
    const manager = new TextureLodManager();
    const mesh = new Mesh(new PlaneGeometry(2, 2), base);
    try {
      manager.addGroup([{ mesh, set }]);
      manager.update(cameraAt(5));
      expect(manager.levelOf(mesh)).toBe(0);
      expect((mesh.material as CustomMaterial).foo).toBe(textures[0]);
    } finally {
      manager.dispose();
    }
  });

  it('同一呼び出し内で同じmeshを2回束縛すると throw し、状態が変わらない', () => {
    const { set, base } = set3('dup');
    const mesh = sceneMesh(base);
    const manager = new TextureLodManager();
    try {
      expect(() =>
        manager.addGroup([
          { mesh, set },
          { mesh, set },
        ]),
      ).toThrow(Error);
      expect(manager.stats().objectCount).toBe(0);
      expect(manager.stats().residentBytes).toBe(0);
    } finally {
      manager.dispose();
    }
  });
});


describe('TextureLodManager addGroup の Contract 検証', () => {
  it('levels が空の Contract は addGroup で拒否され、状態が変わらない', () => {
    const { set, base } = set3('broken');
    const mesh = sceneMesh(base);
    const manager = new TextureLodManager();
    const broken = set as unknown as { levels: unknown[]; thresholds: number[] };
    const originalLevels = broken.levels;
    const originalThresholds = broken.thresholds;
    try {
      broken.levels = [];
      broken.thresholds = [];
      expect(() =>
        manager.addGroup([
          { mesh, set: set as unknown as Parameters<TextureLodManager['addGroup']>[0][number]['set'] },
        ]),
      ).toThrow(/levels/);
      expect(manager.stats().objectCount).toBe(0);
      expect(manager.stats().residentBytes).toBe(0);
    } finally {
      broken.levels = originalLevels;
      broken.thresholds = originalThresholds;
      manager.dispose();
    }
  });
});

describe('TextureLodManager maxResidentBytes', () => {
  it('上限内なら猶予前のテクスチャを破棄しない', () => {
    let now = 0;
    const total = bytes(8) + bytes(4) + bytes(2);
    const manager = new TextureLodManager({
      now: () => now,
      evictDelayMs: 1000,
      maxResidentBytes: total,
    });
    const { set, base, maps } = set3('wall');
    const spies = maps.map((map) => vi.spyOn(map, 'dispose'));
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(5)); // レベル0を使用
      manager.update(cameraAt(30)); // レベル2へ
      now = 500; // 猶予前
      manager.update(cameraAt(30));
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
      const stats = manager.stats();
      expect(stats.budgetBytes).toBe(total);
      expect(stats.overBudgetBytes).toBe(0);
      expect(stats.evictCount).toBe(0);
    } finally {
      manager.dispose();
    }
  });

  it('上限超過では最終使用の古い順に破棄する（サイズ優先ではない）', () => {
    // 時刻優先とサイズ優先を分離する。古い候補を小さく・新しい候補を大きくし、
    // 時刻を無視したサイズ降順なら新しい大きい方が先に落ちる予算（500）にしている。
    // 2件を別々の更新で解放するだけでは、先に解放した側がその時点の掃引で落ちるか
    // 上限内に収まってしまい、同じ掃引で比較できない。
    // おとり D を先に上限で破棄し、最後の更新で復帰（常駐を再超過）させることで、
    // 古い V（t=100）と新しい N（t=200）を同じ掃引の候補に残す。
    let now = 0;
    const manager = new TextureLodManager({
      now: () => now,
      evictDelayMs: 1_000_000,
      maxResidentBytes: 500,
    });
    const baseV = new MeshStandardMaterial({ name: 'victim' });
    const victimTex = dataTexture(2);
    const setV = createTextureLodSet({
      material: baseV,
      levels: [
        { distance: 0, textures: { map: victimTex } },
        { distance: 10, textures: { map: dataTexture(2) } },
      ],
    });
    const baseN = new MeshStandardMaterial({ name: 'newcomer' });
    const newcomerTex = dataTexture(8);
    const setN = createTextureLodSet({
      material: baseN,
      levels: [
        { distance: 0, textures: { map: newcomerTex } },
        { distance: 10, textures: { map: dataTexture(2) } },
      ],
    });
    const baseD = new MeshStandardMaterial({ name: 'decoy' });
    const decoyTex = dataTexture(4);
    const setD = createTextureLodSet({
      material: baseD,
      levels: [
        { distance: 0, textures: { map: decoyTex } },
        { distance: 10, textures: { map: dataTexture(2) } },
      ],
    });
    const spyV = vi.spyOn(victimTex, 'dispose');
    const spyN = vi.spyOn(newcomerTex, 'dispose');
    const spyD = vi.spyOn(decoyTex, 'dispose');
    const meshV = sceneMesh(baseV);
    const meshN = sceneMesh(baseN);
    const meshD = sceneMesh(baseD);
    meshD.position.z = 60; // D は最初から遠方（L1）。L0 は未参照のまま残る
    try {
      manager.add(meshV, setV);
      manager.add(meshN, setN);
      manager.add(meshD, setD);
      manager.update(cameraAt(5)); // V・N は L0、D は L1。段2でおとり D だけ落ちる
      expect(spyD).toHaveBeenCalledTimes(1);
      expect(spyV).not.toHaveBeenCalled();
      expect(spyN).not.toHaveBeenCalled();
      meshV.position.z = 60;
      now = 100;
      manager.update(cameraAt(5)); // V のみ L1 へ。常駐は上限内のため V は残る
      expect(spyV).not.toHaveBeenCalled();
      expect(manager.stats().evictCount).toBe(1);
      meshN.position.z = 60;
      meshD.position.z = 0;
      now = 200;
      manager.update(cameraAt(5)); // N を解放しつつ D を復帰。古い V から落ちる
      expect(spyV).toHaveBeenCalledTimes(1);
      expect(spyN).not.toHaveBeenCalled();
      expect(manager.stats().evictCount).toBe(2);
      expect(manager.stats().overBudgetBytes).toBe(0);
    } finally {
      manager.dispose();
    }
  });

  it('同時刻の候補は推定バイトの大きい順に破棄する（挿入順ではない）', () => {
    // タイ比較 `|| b.bytes - a.bytes` を分離する。小さい方を先に add して
    // Map 挿入順では小さい方が先になる構成にし、同時刻で解放する。
    // タイ比較がなければ挿入順で小さい方が落ちて失敗する。
    let now = 0;
    const manager = new TextureLodManager({
      now: () => now,
      evictDelayMs: 1_000_000,
      // pin 合計 + 小さい L0 + 1。大きい方を1枚落とすと収まる。
      maxResidentBytes: bytes(2) * 3 + 1,
    });
    const baseS = new MeshStandardMaterial({ name: 'smallFirst' });
    const smallTex = dataTexture(2);
    const setS = createTextureLodSet({
      material: baseS,
      levels: [
        { distance: 0, textures: { map: smallTex } },
        { distance: 10, textures: { map: dataTexture(2) } },
      ],
    });
    const baseB = new MeshStandardMaterial({ name: 'bigSecond' });
    const bigTex = dataTexture(8);
    const setB = createTextureLodSet({
      material: baseB,
      levels: [
        { distance: 0, textures: { map: bigTex } },
        { distance: 10, textures: { map: dataTexture(2) } },
      ],
    });
    const spyS = vi.spyOn(smallTex, 'dispose');
    const spyB = vi.spyOn(bigTex, 'dispose');
    const meshS = sceneMesh(baseS);
    const meshB = sceneMesh(baseB);
    meshS.position.z = 60;
    meshB.position.z = 60;
    try {
      // 小さい方を先に add（挿入順で小さい方が先）。
      manager.add(meshS, setS);
      manager.add(meshB, setB);
      // 両方 far のまま更新。L0 は未使用のまま lastUsedAt が登録時刻で同時刻になる。
      manager.update(cameraAt(5));
      expect(spyB).toHaveBeenCalledTimes(1);
      expect(spyS).not.toHaveBeenCalled();
      expect(manager.stats().evictCount).toBe(1);
      expect(manager.stats().overBudgetBytes).toBe(0);
    } finally {
      manager.dispose();
    }
  });

  it('上限超過でも使用中（refs>0）のテクスチャは破棄しない', () => {
    let now = 0;
    const manager = new TextureLodManager({
      now: () => now,
      evictDelayMs: 1_000_000,
      maxResidentBytes: 1,
    });
    const { set, base, maps } = set3('wall');
    const spies = maps.map((map) => vi.spyOn(map, 'dispose'));
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(5)); // レベル0を使用中
      // 未参照のレベル1だけが破棄され、使用中のレベル0とピン留めのレベル2は残る。
      expect(spies[0]).not.toHaveBeenCalled();
      expect(spies[1]).toHaveBeenCalledTimes(1);
      expect(spies[2]).not.toHaveBeenCalled();
      expect(manager.stats().overBudgetBytes).toBeGreaterThan(0);
    } finally {
      manager.dispose();
    }
  });

  it('上限超過でも最粗（pins>0）のテクスチャは破棄しない', () => {
    let now = 0;
    const manager = new TextureLodManager({
      now: () => now,
      evictDelayMs: 1_000_000,
      maxResidentBytes: 1,
    });
    const { set, base, maps } = set3('wall');
    const spies = maps.map((map) => vi.spyOn(map, 'dispose'));
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(30)); // レベル2を使用。レベル0・1は未参照
      expect(spies[0]).toHaveBeenCalledTimes(1);
      expect(spies[1]).toHaveBeenCalledTimes(1);
      expect(spies[2]).not.toHaveBeenCalled();
      expect(manager.stats().overBudgetBytes).toBeGreaterThan(0);
    } finally {
      manager.dispose();
    }
  });

  it('上限まで下げられなくても例外にならず、2回目以降のupdateで破棄は増えない', () => {
    let now = 0;
    const manager = new TextureLodManager({
      now: () => now,
      evictDelayMs: 1_000_000,
      maxResidentBytes: 1,
    });
    const { set, base, maps } = set3('wall');
    const spies = maps.map((map) => vi.spyOn(map, 'dispose'));
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      expect(() => manager.update(cameraAt(5))).not.toThrow();
      expect(manager.stats().overBudgetBytes).toBeGreaterThan(0);
      const calls = spies.map((spy) => spy.mock.calls.length);
      now = 500;
      manager.update(cameraAt(5));
      now = 1000;
      manager.update(cameraAt(5));
      expect(spies.map((spy) => spy.mock.calls.length)).toEqual(calls);
      expect(manager.stats().evictCount).toBe(1);
    } finally {
      manager.dispose();
    }
  });

  it('破棄済みテクスチャを再retainして超過したら、別のLRU候補が破棄される', () => {
    let now = 0;
    const manager = new TextureLodManager({
      now: () => now,
      evictDelayMs: 1_000_000,
      maxResidentBytes: 200,
    });
    const { set, base, maps } = set3('wall');
    const spies = maps.map((map) => vi.spyOn(map, 'dispose'));
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(5)); // レベル0。レベル1が上限で破棄される
      expect(spies[1]).toHaveBeenCalledTimes(1);
      now = 100;
      manager.update(cameraAt(15)); // レベル1へ。レベル1は復帰し、代わりにレベル0が破棄される
      expect(spies[0]).toHaveBeenCalledTimes(1);
      expect(spies[1]).toHaveBeenCalledTimes(1); // 再破棄はされない
      expect(spies[2]).not.toHaveBeenCalled();
      expect(manager.stats().residentBytes).toBeCloseTo(bytes(4) + bytes(2), 10);
    } finally {
      manager.dispose();
    }
  });

  it('猶予切れは上限内でも破棄される（段1と段2の併用）', () => {
    let now = 0;
    const total = bytes(8) + bytes(4) + bytes(2);
    const manager = new TextureLodManager({
      now: () => now,
      evictDelayMs: 1000,
      maxResidentBytes: total,
    });
    const { set, base, maps } = set3('wall');
    const spies = maps.map((map) => vi.spyOn(map, 'dispose'));
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(5));
      now = 100;
      manager.update(cameraAt(30)); // レベル2へ。上限内のため段2は何もしない
      expect(spies[0]).not.toHaveBeenCalled();
      now = 2000;
      manager.update(cameraAt(30)); // 猶予切れでレベル0・1を破棄
      expect(spies[0]).toHaveBeenCalledTimes(1);
      expect(spies[1]).toHaveBeenCalledTimes(1);
      expect(spies[2]).not.toHaveBeenCalled();
      expect(manager.stats().evictCount).toBe(2);
      expect(manager.stats().overBudgetBytes).toBe(0);
    } finally {
      manager.dispose();
    }
  });

  it('上限0なら未参照の候補をすべて破棄し、現用とピンだけ残る', () => {
    let now = 0;
    const manager = new TextureLodManager({
      now: () => now,
      evictDelayMs: 1_000_000,
      maxResidentBytes: 0,
    });
    const { set, base, maps } = set3('wall');
    const spies = maps.map((map) => vi.spyOn(map, 'dispose'));
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(5)); // レベル0を使用
      expect(spies[0]).not.toHaveBeenCalled();
      expect(spies[1]).toHaveBeenCalledTimes(1);
      expect(spies[2]).not.toHaveBeenCalled();
      const stats = manager.stats();
      expect(stats.budgetBytes).toBe(0);
      expect(stats.residentBytes).toBeCloseTo(bytes(8) + bytes(2), 10);
      expect(stats.overBudgetBytes).toBeCloseTo(bytes(8) + bytes(2), 10);
    } finally {
      manager.dispose();
    }
  });

  it('画像なし（0バイト）のテクスチャは上限破棄でdisposeされない', () => {
    let now = 0;
    const base = new MeshStandardMaterial({ name: 'empty' });
    const fine = dataTexture(8);
    const empty = new Texture();
    const coarse = dataTexture(2);
    const set = createTextureLodSet({
      material: base,
      levels: [
        { distance: 0, textures: { map: fine } },
        { distance: 10, textures: { map: empty } },
        { distance: 20, textures: { map: coarse } },
      ],
    });
    const emptySpy = vi.spyOn(empty, 'dispose');
    const manager = new TextureLodManager({
      now: () => now,
      evictDelayMs: 1_000_000,
      maxResidentBytes: bytes(8),
    });
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(5)); // レベル0を使用。常駐は上限を超過するが候補がいない
      expect(emptySpy).not.toHaveBeenCalled();
      expect(manager.stats().overBudgetBytes).toBeCloseTo(bytes(2), 10);
      expect(manager.stats().evictCount).toBe(0);
    } finally {
      manager.dispose();
    }
  });

  it('異なるsetで共有するテクスチャは、一方で現用なら上限超過でも破棄しない', () => {
    let now = 0;
    const manager = new TextureLodManager({
      now: () => now,
      evictDelayMs: 1_000_000,
      maxResidentBytes: 1,
    });
    // shared は両setの最粗以外に置き、ピンではなく参照カウントで守られる状態にする。
    const shared = dataTexture(8);
    const sharedSpy = vi.spyOn(shared, 'dispose');
    const baseA = new MeshStandardMaterial({ name: 'a' });
    const baseB = new MeshStandardMaterial({ name: 'b' });
    const setA = createTextureLodSet({
      material: baseA,
      levels: [
        { distance: 0, textures: { map: shared } },
        { distance: 10, textures: { map: dataTexture(4) } },
        { distance: 20, textures: { map: dataTexture(1) } },
      ],
    });
    const setB = createTextureLodSet({
      material: baseB,
      levels: [
        { distance: 0, textures: { map: dataTexture(6) } },
        { distance: 10, textures: { map: shared } },
        { distance: 20, textures: { map: dataTexture(1) } },
      ],
    });
    const meshA = sceneMesh(baseA);
    const meshB = sceneMesh(baseB);
    try {
      manager.add(meshA, setA);
      manager.add(meshB, setB);
      manager.update(cameraAt(5)); // 両方レベル0。shared は A が現用（refs=1）
      // 掃引は動いているが、現用の shared は破棄されない。
      expect(sharedSpy).not.toHaveBeenCalled();
      expect(manager.stats().overBudgetBytes).toBeGreaterThan(0);
      meshA.position.z = 60;
      now = 100;
      manager.update(cameraAt(5)); // Aのみレベル2。shared の参照が外れる
      expect(sharedSpy).toHaveBeenCalledTimes(1);
    } finally {
      manager.dispose();
    }
  });

  it('evictDelayMs: Infinity では時間で破棄されず、容量だけで破棄される', () => {
    let now = 0;
    const total = bytes(8) + bytes(4) + bytes(2);
    const keepManager = new TextureLodManager({
      now: () => now,
      evictDelayMs: Infinity,
      maxResidentBytes: total,
    });
    const overManager = new TextureLodManager({
      now: () => now,
      evictDelayMs: Infinity,
      maxResidentBytes: 200,
    });
    const keep = set3('keep');
    const over = set3('over');
    const keepSpies = keep.maps.map((map) => vi.spyOn(map, 'dispose'));
    const overSpies = over.maps.map((map) => vi.spyOn(map, 'dispose'));
    const meshKeep = sceneMesh(keep.base);
    const meshOver = sceneMesh(over.base);
    try {
      keepManager.add(meshKeep, keep.set);
      overManager.add(meshOver, over.set);
      keepManager.update(cameraAt(5));
      overManager.update(cameraAt(5)); // レベル0。段2でレベル1が破棄される
      keepManager.update(cameraAt(30));
      overManager.update(cameraAt(30)); // レベル2へ。段2でレベル0が破棄される
      // 上限超過分は容量だけで破棄される（猶予 Infinity は有限差で発火しないため段1の寄与はない）。
      expect(overSpies[0]).toHaveBeenCalledTimes(1);
      expect(overSpies[1]).toHaveBeenCalledTimes(1);
      expect(overSpies[2]).not.toHaveBeenCalled();
      now = 1e12;
      keepManager.update(cameraAt(30));
      overManager.update(cameraAt(30));
      // 猶予 Infinity は有限差では発火しない。時間が経っても破棄は増えず、
      // 上限内なら何も破棄されない。
      expect(overSpies[0]).toHaveBeenCalledTimes(1);
      expect(overSpies[1]).toHaveBeenCalledTimes(1);
      for (const spy of keepSpies) {
        expect(spy).not.toHaveBeenCalled();
      }
      expect(keepManager.stats().evictCount).toBe(0);
    } finally {
      keepManager.dispose();
      overManager.dispose();
    }
  });

  it('maxResidentBytes が負・NaN・Infinity なら RangeError、keep-all 併用なら Error', () => {
    expect(() => new TextureLodManager({ maxResidentBytes: -1 })).toThrow(RangeError);
    expect(() => new TextureLodManager({ maxResidentBytes: NaN })).toThrow(RangeError);
    expect(() => new TextureLodManager({ maxResidentBytes: Infinity })).toThrow(RangeError);
    expect(() => new TextureLodManager({ maxResidentBytes: 0 })).not.toThrow();
    expect(
      () => new TextureLodManager({ residency: 'keep-all', maxResidentBytes: 1024 }),
    ).toThrow("maxResidentBytes は residency: 'keep-all' と併用できません");
  });

  it('stats は budgetBytes・overBudgetBytes・evictCount（猶予＋上限の累計）を返す', () => {
    // 未設定なら budgetBytes は null、overBudgetBytes は 0。
    {
      const manager = new TextureLodManager();
      const { set, base } = set3('plain');
      const mesh = sceneMesh(base);
      try {
        manager.add(mesh, set);
        manager.update(cameraAt(5));
        const stats = manager.stats();
        expect(stats.budgetBytes).toBeNull();
        expect(stats.overBudgetBytes).toBe(0);
        expect(stats.evictCount).toBe(0);
      } finally {
        manager.dispose();
      }
    }
    // 猶予破棄と上限破棄の合計が evictCount になる。
    let now = 0;
    const budget = 800;
    const manager = new TextureLodManager({
      now: () => now,
      evictDelayMs: 1000,
      maxResidentBytes: budget,
    });
    const a = set3('a');
    const b = set3('b');
    const meshA = sceneMesh(a.base);
    const meshB = sceneMesh(b.base);
    const spyA0 = vi.spyOn(a.maps[0], 'dispose');
    const spyA1 = vi.spyOn(a.maps[1], 'dispose');
    const spyB1 = vi.spyOn(b.maps[1], 'dispose');
    try {
      manager.add(meshA, a.set);
      manager.add(meshB, b.set);
      expect(manager.stats().budgetBytes).toBe(budget);
      manager.update(cameraAt(5)); // 両方レベル0。段2で古い順に A-L1・B-L1 を破棄
      expect(spyA1).toHaveBeenCalledTimes(1);
      expect(spyB1).toHaveBeenCalledTimes(1);
      expect(manager.stats().evictCount).toBe(2);
      meshA.position.z = 60;
      now = 100;
      manager.update(cameraAt(5)); // Aのみレベル2。上限内のため段2は動かない
      expect(manager.stats().evictCount).toBe(2);
      now = 2000;
      manager.update(cameraAt(5)); // A-L0 が猶予切れで段1が破棄
      expect(spyA0).toHaveBeenCalledTimes(1);
      expect(manager.stats().evictCount).toBe(3);
      expect(manager.stats().overBudgetBytes).toBe(0);
    } finally {
      manager.dispose();
    }
  });

  it('上限はupdate内でのみ効く（add直後は超過し得て、update後に解消する）', () => {
    let now = 0;
    const budget = bytes(8) + bytes(2);
    const manager = new TextureLodManager({
      now: () => now,
      evictDelayMs: 1_000_000,
      maxResidentBytes: budget,
    });
    const { set, base, maps } = set3('wall');
    const spies = maps.map((map) => vi.spyOn(map, 'dispose'));
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      // update 前は掃引が走らず、全テクスチャが常駐扱いで上限を超過し得る。
      expect(manager.stats().overBudgetBytes).toBeGreaterThan(0);
      expect(spies[1]).not.toHaveBeenCalled();
      manager.update(cameraAt(5)); // レベル0。未参照のレベル1を上限で破棄し、超過が解消する
      expect(spies[1]).toHaveBeenCalledTimes(1);
      expect(manager.stats().overBudgetBytes).toBe(0);
    } finally {
      manager.dispose();
    }
  });

  it('removeで追跡から外れたテクスチャは上限計算に入らない', () => {
    let now = 0;
    const manager = new TextureLodManager({
      now: () => now,
      evictDelayMs: 1_000_000,
      maxResidentBytes: bytes(2),
    });
    const a = set3('a');
    const b = set3('b');
    const meshA = sceneMesh(a.base);
    const meshB = sceneMesh(b.base);
    try {
      manager.add(meshA, a.set);
      manager.add(meshB, b.set);
      manager.update(cameraAt(5)); // 両方レベル0。未参照の L1 が2件とも上限で破棄される
      expect(manager.stats().residentBytes).toBeCloseTo(2 * (bytes(8) + bytes(2)), 10);
      manager.remove(meshA);
      // A のテクスチャは追跡から外れ、B の分だけが残る。
      const after = manager.stats();
      expect(after.objectCount).toBe(1);
      expect(after.residentBytes).toBeCloseTo(bytes(8) + bytes(2), 10);
      expect(after.overBudgetBytes).toBeCloseTo(bytes(8), 10);
    } finally {
      manager.dispose();
    }
  });
});

describe('TextureLodManager thresholdScale（固定）', () => {
  /** 境界 [0,3,6,12] の4段階セットを作る。 */
  function set4(name: string, sizes = [8, 4, 2, 1]) {
    const base = new MeshStandardMaterial({ name });
    const maps = sizes.map((size) => dataTexture(size));
    const levels: TextureLodLevel[] = maps.map((map, i) => ({
      distance: [0, 3, 6, 12][i],
      textures: { map },
    }));
    return { set: createTextureLodSet({ material: base, levels }), base, maps };
  }

  it('距離4・T=[0,3,6,12] で s=1→L1・s=0.5→L2。設定だけでは levelOf 不変', () => {
    // 中心距離で厳密に測り、s=1 で d=4→L1、s=0.5 で d/s=8→L2 になることの確認。
    const { set, base } = set4('fixed');
    const manager = new TextureLodManager({ distanceMode: 'center' });
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(4));
      expect(manager.levelOf(mesh)).toBe(1);
      manager.setThresholdScale(0.5);
      // 設定だけでは判定が走らず、レベルは変わらない（スケール値自体は即時反映される）。
      expect(manager.levelOf(mesh)).toBe(1);
      expect(manager.stats().thresholdScale).toBe(0.5);
      manager.update(cameraAt(4));
      expect(manager.levelOf(mesh)).toBe(2);
      expect(manager.stats().thresholdScale).toBe(0.5);
    } finally {
      manager.dispose();
    }
  });

  it('setThresholdScale の不正値は RangeError、adaptive 中は Error', () => {
    const { base } = set4('invalid');
    const plain = new TextureLodManager();
    try {
      expect(() => plain.setThresholdScale(0)).toThrow(RangeError);
      expect(() => plain.setThresholdScale(-1)).toThrow(RangeError);
      expect(() => plain.setThresholdScale(NaN)).toThrow(RangeError);
      expect(() => plain.setThresholdScale(Infinity)).toThrow(RangeError);
    } finally {
      plain.dispose();
    }
    const adaptive = new TextureLodManager({ adaptiveThresholdScale: true });
    try {
      expect(() => adaptive.setThresholdScale(0.5)).toThrow(Error);
    } finally {
      adaptive.dispose();
    }
    void base;
  });

  it('ヒステリシスの両端も T*s*(1±h) になる', () => {
    // T=[0,10]・h=0.2・s=0.5 のとき上端 6・下端 4 のバンドになることの確認。
    const base = new MeshStandardMaterial({ name: 'band' });
    const maps = [dataTexture(8), dataTexture(2)];
    const set = createTextureLodSet({
      material: base,
      levels: [
        { distance: 0, textures: { map: maps[0] } },
        { distance: 10, textures: { map: maps[1] } },
      ],
      hysteresis: 0.2,
    });
    const manager = new TextureLodManager({ distanceMode: 'center', thresholdScale: 0.5 });
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(3)); // 3/0.5=6 <10 → L0
      expect(manager.levelOf(mesh)).toBe(0);
      manager.update(cameraAt(5.9)); // 11.8 < 12 → 上端内なので L0 のまま
      expect(manager.levelOf(mesh)).toBe(0);
      manager.update(cameraAt(6.1)); // 12.2 > 12 → L1
      expect(manager.levelOf(mesh)).toBe(1);
      manager.update(cameraAt(4.1)); // 8.2 > 8 → 下端内なので L1 のまま
      expect(manager.levelOf(mesh)).toBe(1);
      manager.update(cameraAt(3.9)); // 7.8 < 8 → L0
      expect(manager.levelOf(mesh)).toBe(0);
    } finally {
      manager.dispose();
    }
  });

  it('スケール変更後も同じ base thresholds の addGroup が通る', () => {
    // スケールは距離側の読み替えであり、境界配列自体は不変のため検証が壊れないことの確認。
    const a = set4('a');
    const b = set4('b');
    const manager = new TextureLodManager({ distanceMode: 'center', thresholdScale: 0.5 });
    const meshA = sceneMesh(a.base);
    const meshB = sceneMesh(b.base);
    try {
      manager.addGroup([
        { mesh: meshA, set: a.set },
        { mesh: meshB, set: b.set },
      ]);
      manager.update(cameraAt(4)); // 4/0.5=8 → L2 に連動する
      expect(manager.levelOf(meshA)).toBe(2);
      expect(manager.levelOf(meshB)).toBe(2);
    } finally {
      manager.dispose();
    }
  });

  it('stats は既定 thresholdScale===1・requiredBytes・over を返す', () => {
    // 未参照の非ピン留め分を含まない必要量と、掃引後の超過が required 基準と一致することの確認。
    const manager = new TextureLodManager({ now: () => 0, evictDelayMs: 1_000_000 });
    const { set, base } = set3('stats');
    const mesh = sceneMesh(base);
    try {
      expect(manager.stats().thresholdScale).toBe(1);
      expect(manager.stats().requiredBytes).toBe(0);
      manager.add(mesh, set);
      manager.update(cameraAt(5)); // L0: 参照が L0、最粗ピンが L2
      const stats = manager.stats();
      expect(stats.thresholdScale).toBe(1);
      expect(stats.requiredBytes).toBeCloseTo(bytes(8) + bytes(2), 10);
    } finally {
      manager.dispose();
    }
    // 超過時は掃引で未参照が落ち、resident==required になるため over==max(0, required-budget)。
    const budget = bytes(8) + bytes(2) - 1;
    const over = new TextureLodManager({
      now: () => 0,
      evictDelayMs: 1_000_000,
      maxResidentBytes: budget,
    });
    const fixture = set3('over');
    const meshOver = sceneMesh(fixture.base);
    try {
      over.add(meshOver, fixture.set);
      over.update(cameraAt(5));
      const stats = over.stats();
      expect(stats.requiredBytes).toBeCloseTo(bytes(8) + bytes(2), 10);
      expect(stats.overBudgetBytes).toBeCloseTo(Math.max(0, stats.requiredBytes - budget), 10);
      expect(stats.overBudgetBytes).toBeGreaterThan(0);
    } finally {
      over.dispose();
    }
  });
});

describe('TextureLodManager adaptiveThresholdScale', () => {
  it('adaptive 初回 update 後は requiredBytes<=budget になる（超過フレームがない）', () => {
    // 近距離でも初回 update 内で先に2軸で下げてから判定するため、超過が出ないことの確認。
    // set3は全段で実質差があるため、2軸ではスケールではなく上限で収める。
    const budget = bytes(4) + bytes(2);
    const manager = new TextureLodManager({
      distanceMode: 'center',
      now: () => 0,
      evictDelayMs: 1_000_000,
      maxResidentBytes: budget,
      adaptiveThresholdScale: true,
    });
    const { set, base } = set3('first');
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(5)); // s=1 なら L0 で超過する距離
      const stats = manager.stats();
      expect(stats.requiredBytes).toBeLessThanOrEqual(budget);
      // 2軸では cap-lower で収め、スケールは最良のまま残る。
      expect(stats.thresholdScale).toBe(1);
      expect(stats.finestLevel).toBe(1);
      expect(manager.stats().levelCapLowerCount).toBeGreaterThan(0);
    } finally {
      manager.dispose();
    }
  });

  it('固定乱数距離列で毎 update 後に required<=budget || scale===minScale が成り立つ', () => {
    // ヒステリシス付き予測と実判定が一致するため、選択後の必要量は予測どおりに収まることの確認。
    // 疑似乱数で距離列を固定し、evictDelayMs: Infinity でも不変条件が成り立つ。
    const runWithEvictDelay = (evictDelayMs: number): void => {
      let now = 0;
      const budget = bytes(4) + bytes(2);
      const manager = new TextureLodManager({
        distanceMode: 'center',
        now: () => now,
        evictDelayMs,
        maxResidentBytes: budget,
        adaptiveThresholdScale: true,
      });
      const fixtures = [set3('r0'), set3('r1'), set3('r2')];
      const meshes = fixtures.map((fixture) => sceneMesh(fixture.base));
      try {
        for (const [i, fixture] of fixtures.entries()) {
          manager.add(meshes[i] as Mesh, fixture.set);
        }
        let seed = 42;
        const nextRandom = (): number => {
          seed = (seed * 1664525 + 1013904223) >>> 0;
          return seed / 0x100000000;
        };
        const minScale = 0.05;
        for (let frame = 0; frame < 60; frame++) {
          for (const mesh of meshes) {
            (mesh as Mesh).position.z = 2 + nextRandom() * 40;
          }
          now += 16;
          manager.update(cameraAt(0));
          const stats = manager.stats();
          const fits = stats.requiredBytes <= budget * (1 + 1e-12) + 1e-6;
          expect(fits || stats.thresholdScale === minScale).toBe(true);
        }
      } finally {
        manager.dispose();
      }
    };
    runWithEvictDelay(5000);
    runWithEvictDelay(Infinity);
  });

  it('下限では scale===min で止まり、over>0 でも例外にならない', () => {
    // ピン留め合計より小さい予算ではどこまで下げても収まらず、末尾で頭打ちになることの確認。
    let now = 0;
    const manager = new TextureLodManager({
      distanceMode: 'center',
      now: () => now,
      evictDelayMs: 1_000_000,
      maxResidentBytes: 1,
      adaptiveThresholdScale: true,
    });
    const { set, base } = set3('floor');
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      expect(() => manager.update(cameraAt(5))).not.toThrow();
      expect(manager.stats().thresholdScale).toBe(0.05);
      expect(manager.stats().overBudgetBytes).toBeGreaterThan(0);
      now += 16;
      expect(() => manager.update(cameraAt(5))).not.toThrow();
      expect(manager.stats().thresholdScale).toBe(0.05);
    } finally {
      manager.dispose();
    }
  });

  it('カメラを遠ざけると冷却3秒＋1秒ごとに上限が1段戻る', () => {
    // 引き下げ後に遠方へ移し、注入時計で冷却と間隔どおり段階的に戻ることの確認。
    // 2軸では最初の引き下げが cap-lower のため、戻りも cap-raise になる。
    let now = 0;
    const budget = bytes(4) + bytes(2);
    const manager = new TextureLodManager({
      distanceMode: 'center',
      now: () => now,
      evictDelayMs: 1_000_000,
      maxResidentBytes: budget,
      adaptiveThresholdScale: true,
    });
    const { set, base } = set3('raise');
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(5)); // L0 相当で超過し、cap=1・scale=1 で収める
      expect(manager.stats().thresholdScale).toBe(1);
      expect(manager.stats().finestLevel).toBe(1);
      // 遠方へ移す。以降の予測は最粗＋ピンだけになり、上げ余裕が生まれる。
      // PlaneGeometry の外接球を避けるため十分に遠ざける。
      mesh.position.z = 500;
      const raisesBefore = manager.stats().levelCapRaiseCount;
      now += 1000;
      manager.update(cameraAt(0));
      expect(manager.stats().finestLevel).toBe(1); // 冷却中 (1秒<3秒)
      now += 1000;
      manager.update(cameraAt(0));
      expect(manager.stats().finestLevel).toBe(1); // 冷却中 (2秒<3秒)
      now += 1000;
      manager.update(cameraAt(0));
      expect(manager.stats().finestLevel).toBe(0); // 冷却明けで上限が1段戻る
      expect(manager.stats().thresholdScale).toBe(1);
      now += 1000;
      manager.update(cameraAt(0));
      expect(manager.stats().finestLevel).toBe(0); // これ以上は戻らない
      expect(manager.stats().levelCapRaiseCount).toBe(raisesBefore + 1);
    } finally {
      manager.dispose();
    }
  });

  it('排他: adaptive×keep-all と adaptive×thresholdScale は Error', () => {
    expect(
      () => new TextureLodManager({ residency: 'keep-all', adaptiveThresholdScale: true }),
    ).toThrow(Error);
    expect(
      () =>
        new TextureLodManager({
          residency: 'keep-all',
          adaptiveThresholdScale: { minScale: 0.5 },
        }),
    ).toThrow(Error);
    expect(
      () => new TextureLodManager({ thresholdScale: 0.5, adaptiveThresholdScale: true }),
    ).toThrow(Error);
    expect(
      () =>
        new TextureLodManager({
          thresholdScale: 0.5,
          adaptiveThresholdScale: { minScale: 0.1 },
        }),
    ).toThrow(Error);
    // 非自動の thresholdScale 単体と adaptive 単体は許容する。
    expect(() => new TextureLodManager({ thresholdScale: 0.5 })).not.toThrow();
    expect(() => new TextureLodManager({ adaptiveThresholdScale: true })).not.toThrow();
  });

  it('非表示 anchor・非有限距離は現レベル維持で予測に含まれ、例外にならない', () => {
    // 維持グループが予測の和集合に参加しても落ちず、レベルも動かないことの確認。
    let now = 0;
    const budget = bytes(4) + bytes(2);
    const manager = new TextureLodManager({
      distanceMode: 'center',
      now: () => now,
      evictDelayMs: 1_000_000,
      maxResidentBytes: budget,
      adaptiveThresholdScale: true,
    });
    const good = set3('good');
    const bad = set3('bad');
    const meshGood = sceneMesh(good.base);
    const meshBad = sceneMesh(bad.base);
    try {
      manager.add(meshGood, good.set);
      manager.add(meshBad, bad.set);
      manager.update(cameraAt(5));
      const levelBefore = manager.levelOf(meshBad);
      meshBad.visible = false;
      meshGood.position.set(Number.NaN, 0, 0);
      now += 16;
      expect(() => manager.update(cameraAt(5))).not.toThrow();
      expect(manager.levelOf(meshBad)).toBe(levelBefore);
      expect(manager.stats().thresholdScale).toBeGreaterThan(0);
    } finally {
      manager.dispose();
    }
  });

  it('setMaxResidentBytes で下げると次の update で cap が下がり、null で budgetBytes null・over 0', () => {
    let now = 0;
    const manager = new TextureLodManager({
      distanceMode: 'center',
      now: () => now,
      evictDelayMs: 1_000_000,
      maxResidentBytes: bytes(8) + bytes(4) + bytes(2),
      adaptiveThresholdScale: true,
    });
    const { set, base } = set3('budget');
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(5));
      expect(manager.stats().thresholdScale).toBe(1);
      expect(manager.stats().finestLevel).toBe(0);
      manager.setMaxResidentBytes(bytes(4) + bytes(2));
      // 設定だけでは変わらず、次の update で下がる。
      expect(manager.stats().thresholdScale).toBe(1);
      expect(manager.stats().finestLevel).toBe(0);
      now += 16;
      manager.update(cameraAt(5));
      // 2軸では上限で収め、スケールは最良のまま残る。
      expect(manager.stats().thresholdScale).toBe(1);
      expect(manager.stats().finestLevel).toBe(1);
      manager.setMaxResidentBytes(null);
      const stats = manager.stats();
      expect(stats.budgetBytes).toBeNull();
      expect(stats.overBudgetBytes).toBe(0);
      expect(() => manager.setMaxResidentBytes(-1)).toThrow(RangeError);
      expect(() => manager.setMaxResidentBytes(NaN)).toThrow(RangeError);
      expect(() => manager.setMaxResidentBytes(Infinity)).toThrow(RangeError);
    } finally {
      manager.dispose();
    }
    const keepAll = new TextureLodManager({ residency: 'keep-all' });
    try {
      expect(() => keepAll.setMaxResidentBytes(1024)).toThrow(Error);
      expect(() => keepAll.setMaxResidentBytes(null)).not.toThrow();
    } finally {
      keepAll.dispose();
    }
  });

  it('adaptive の不正な調整値は RangeError になる', () => {
    expect(() => new TextureLodManager({ adaptiveThresholdScale: { minScale: 0 } })).toThrow(
      RangeError,
    );
    expect(() => new TextureLodManager({ adaptiveThresholdScale: { minScale: 2 } })).toThrow(
      RangeError,
    );
    expect(
      () => new TextureLodManager({ adaptiveThresholdScale: { stepsPerOctave: 1.5 } }),
    ).toThrow(RangeError);
    expect(() => new TextureLodManager({ adaptiveThresholdScale: { raiseHeadroom: 0 } })).toThrow(
      RangeError,
    );
    expect(() => new TextureLodManager({ adaptiveThresholdScale: { raiseHeadroom: 2 } })).toThrow(
      RangeError,
    );
    expect(() => new TextureLodManager({ thresholdScale: 0 })).toThrow(RangeError);
    expect(() => new TextureLodManager({ thresholdScale: NaN })).toThrow(RangeError);
    expect(() => new TextureLodManager({ adaptiveThresholdScale: { stepsPerOctave: 65 } })).toThrow(
      RangeError,
    );
  });
});

describe('TextureLodManager adaptiveThresholdScale（レビュー追補）', () => {
  it('末尾で floor が続いても scaleLowerCount が増えない', () => {
    // 既に下限で動かない floor は変化なしのため数えないことの確認。
    let now = 0;
    const manager = new TextureLodManager({
      distanceMode: 'center',
      now: () => now,
      evictDelayMs: 1_000_000,
      maxResidentBytes: 1,
      adaptiveThresholdScale: true,
    });
    const { set, base } = set3('floorCount');
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(5));
      expect(manager.stats().thresholdScale).toBe(0.05);
      const lowers = manager.stats().scaleLowerCount;
      expect(lowers).toBeGreaterThan(0);
      for (let frame = 0; frame < 10; frame++) {
        now += 16;
        manager.update(cameraAt(5));
      }
      expect(manager.stats().thresholdScale).toBe(0.05);
      expect(manager.stats().scaleLowerCount).toBe(lowers);
    } finally {
      manager.dispose();
    }
  });

  it('静止収束後は scaleLowerCount/scaleRaiseCount が増えない', () => {
    // 変化のない入力では判定が hold に落ち着き、回数が動かないことの確認。
    let now = 0;
    const budget = bytes(4) + bytes(2);
    const manager = new TextureLodManager({
      distanceMode: 'center',
      now: () => now,
      evictDelayMs: 1_000_000,
      maxResidentBytes: budget,
      adaptiveThresholdScale: true,
    });
    const { set, base } = set3('stable');
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(5));
      // 冷却と判定間隔が開くまで進め、収束させる。
      for (let frame = 0; frame < 500; frame++) {
        now += 16;
        manager.update(cameraAt(5));
      }
      const stats = manager.stats();
      const lowers = stats.scaleLowerCount;
      const raises = stats.scaleRaiseCount;
      for (let frame = 0; frame < 500; frame++) {
        now += 16;
        manager.update(cameraAt(5));
      }
      expect(manager.stats().scaleLowerCount).toBe(lowers);
      expect(manager.stats().scaleRaiseCount).toBe(raises);
    } finally {
      manager.dispose();
    }
  });

  it('setMaxResidentBytes(null) 後に冷却＋1段/秒で cap 0・scale 1 に戻る', () => {
    // 予算なしでは predict を呼ばず、間隔ごとに段階的に最大へ戻ることの確認。
    // 2軸では上限で下げているため、戻りも上限からになる。
    let now = 0;
    const manager = new TextureLodManager({
      distanceMode: 'center',
      now: () => now,
      evictDelayMs: 1_000_000,
      maxResidentBytes: bytes(4) + bytes(2),
      adaptiveThresholdScale: true,
    });
    const { set, base } = set3('restore');
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(5));
      expect(manager.stats().finestLevel).toBe(1);
      expect(manager.stats().thresholdScale).toBe(1);
      manager.setMaxResidentBytes(null);
      // 冷却中は上がらない。
      now += 1000;
      manager.update(cameraAt(5));
      expect(manager.stats().finestLevel).toBe(1);
      // 冷却明け後は1秒ごとに上限が戻り、やがて cap=0・scale=1 に戻る。
      now += 1000;
      manager.update(cameraAt(5));
      expect(manager.stats().finestLevel).toBe(1);
      now += 1000;
      manager.update(cameraAt(5));
      expect(manager.stats().finestLevel).toBe(0);
      expect(manager.stats().thresholdScale).toBe(1);
    } finally {
      manager.dispose();
    }
  });

  it('adaptiveThresholdScale: null は false と同じく無効扱いになる', () => {
    const manager = new TextureLodManager({
      adaptiveThresholdScale: null as unknown as undefined,
    });
    const { set, base } = set3('nullAdaptive');
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(5));
      expect(manager.stats().thresholdScale).toBe(1);
      expect(manager.stats().scaleLowerCount).toBe(0);
      expect(manager.stats().scaleRaiseCount).toBe(0);
    } finally {
      manager.dispose();
    }
  });

  it('極小スケールで distance/scale が非有限でも update 全体が止まらない', () => {
    // 固定スケール 1e-310 では通常距離でも非有限になり、現レベル維持になることの確認。
    const manager = new TextureLodManager({ distanceMode: 'center', thresholdScale: 1e-310 });
    const { set, base } = set3('tiny');
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      expect(() => manager.update(cameraAt(5))).not.toThrow();
      // 一度も判定できていないためレベルは未割当のまま。
      expect(manager.levelOf(mesh)).toBeNull();
      // 十分大きいスケールに戻すと通常判定に戻る。
      manager.setThresholdScale(1);
      manager.update(cameraAt(5));
      expect(manager.levelOf(mesh)).toBe(0);
      // 既に割当済みのレベルがある状態で極小化しても、現レベルを維持し例外にならない。
      manager.setThresholdScale(1e-310);
      expect(() => manager.update(cameraAt(30))).not.toThrow();
      expect(manager.levelOf(mesh)).toBe(0);
    } finally {
      manager.dispose();
    }
  });
});

describe('TextureLodManager requiredBytes の独立検証（過大評価検出）', () => {
  /** 共有テクスチャを含む2セットの器具。両 set の L0 は同一 Texture を指す。 */
  function sharedFixture() {
    const shared = dataTexture(8);
    const a1 = dataTexture(4);
    const coarseA = dataTexture(2);
    const b1 = dataTexture(4);
    const coarseB = dataTexture(1);
    const baseA = new MeshStandardMaterial({ name: 'a' });
    const baseB = new MeshStandardMaterial({ name: 'b' });
    const setA = createTextureLodSet({
      material: baseA,
      levels: [
        { distance: 0, textures: { map: shared } },
        { distance: 10, textures: { map: a1 } },
        { distance: 20, textures: { map: coarseA } },
      ],
      hysteresis: 0.1,
    });
    const setB = createTextureLodSet({
      material: baseB,
      levels: [
        { distance: 0, textures: { map: shared } },
        { distance: 10, textures: { map: b1 } },
        { distance: 20, textures: { map: coarseB } },
      ],
      hysteresis: 0.1,
    });
    return { setA, baseA, setB, baseB, shared, a1, b1, coarseA, coarseB };
  }

  it('requiredBytes は現用レベル∪全set最粗の和と一致する（共有は1回だけ）', () => {
    // 過小評価（M1/M2/M3）だけでなく、共有テクスチャの二重計上のような過大評価も落とす。
    // 期待値はテスト側で和集合として独立に計算し、実装の内部計算とは別経路にする。
    let now = 0;
    const manager = new TextureLodManager({
      distanceMode: 'center',
      now: () => now,
      evictDelayMs: 1_000_000,
    });
    const fixture = sharedFixture();
    const meshA1 = sceneMesh(fixture.baseA);
    meshA1.position.z = 5;
    const meshA2 = sceneMesh(fixture.baseA);
    meshA2.position.z = 5;
    const meshB2 = sceneMesh(fixture.baseB);
    const meshB3 = sceneMesh(fixture.baseB);
    meshB3.position.z = 15;
    const camera = cameraAt(0);
    try {
      manager.add(meshA1, fixture.setA);
      manager.addGroup([
        { mesh: meshA2, set: fixture.setA },
        { mesh: meshB2, set: fixture.setB },
      ]);
      manager.add(meshB3, fixture.setB);
      manager.update(camera); // g1=L0、g2=L0、g3=L1
      expect(manager.levelOf(meshA1)).toBe(0);
      expect(manager.levelOf(meshA2)).toBe(0);
      expect(manager.levelOf(meshB3)).toBe(1);
      // 現用 {shared, b1} ∪ 最粗 {coarseA, coarseB}。shared は2束縛で使っても1回だけ。
      const expected1 = bytes(8) + bytes(4) + bytes(2) + bytes(1);
      expect(manager.stats().requiredBytes).toBeCloseTo(expected1, 10);
      // 未参照の a1 を含むため resident は required より大きい（required != resident の確認）。
      expect(manager.stats().residentBytes).toBeCloseTo(expected1 + bytes(4), 10);
      // g3 を隠して維持にし、g1 を L1 へ動かす。維持中の b1 も必要量に残る。
      meshB3.visible = false;
      meshA1.position.z = 15;
      now += 16;
      manager.update(camera); // g1=L1、g2=L0、g3=L1維持
      expect(manager.levelOf(meshA1)).toBe(1);
      expect(manager.levelOf(meshB3)).toBe(1);
      // 現用 {a1, shared, b1} ∪ 最粗 {coarseA, coarseB}。
      const expected2 = bytes(4) + bytes(8) + bytes(4) + bytes(2) + bytes(1);
      expect(manager.stats().requiredBytes).toBeCloseTo(expected2, 10);
    } finally {
      manager.dispose();
    }
  });

  it('予算が十分なら下げず scale===1・lower 0 を保つ', () => {
    // 過大評価（常に下限へ落とす実装など）はここで落ちる。予算は全テクスチャ合計の1.5倍。
    // 二重計上の変異では必要量が2倍に見えるため、この予算では超過して落ちる。
    const fixture = sharedFixture();
    const total = bytes(8) + bytes(4) + bytes(4) + bytes(2) + bytes(1);
    let now = 0;
    const manager = new TextureLodManager({
      distanceMode: 'center',
      now: () => now,
      evictDelayMs: 1_000_000,
      maxResidentBytes: total * 1.5,
      adaptiveThresholdScale: true,
    });
    const meshA1 = sceneMesh(fixture.baseA);
    const meshA2 = sceneMesh(fixture.baseA);
    const meshB2 = sceneMesh(fixture.baseB);
    const anchors = [meshA1, meshA2];
    const camera = cameraAt(0);
    try {
      manager.add(meshA1, fixture.setA);
      manager.addGroup([
        { mesh: meshA2, set: fixture.setA },
        { mesh: meshB2, set: fixture.setB },
      ]);
      const pattern = [3, 12, 25, 7, 30, 5];
      for (let frame = 0; frame < 200; frame++) {
        now += 16;
        for (const [i, anchor] of anchors.entries()) {
          anchor.position.z = pattern[(frame + i) % pattern.length] as number;
          anchor.visible = frame % 7 !== 3 || i !== 0;
        }
        manager.update(camera);
        const stats = manager.stats();
        expect(stats.thresholdScale).toBe(1);
        expect(stats.budgetBytes).toBe(total * 1.5);
        expect(stats.requiredBytes).toBeLessThanOrEqual(total * 1.5);
      }
      expect(manager.stats().scaleLowerCount).toBe(0);
      expect(manager.stats().scaleRaiseCount).toBe(0);
    } finally {
      manager.dispose();
    }
  });

  it('予算が必要量ちょうどでも下げない（1バイトの過大評価も検出する）', () => {
    // 更新後の現用レベル∪全set最粗の和をテスト側で独立に計算し、その値を上限に設定する。
    // 実装が1バイトでも過大評価していれば `predict > budget` で scale が下がるため、
    // `scale===1` で検出できる。逆に過小評価していれば不変条件テスト側で落ちる。
    // 推定バイトが整数になるサイズ（3の倍数）を選び、浮動小数点の順序誤差を排除する。
    let now = 0;
    const manager = new TextureLodManager({
      distanceMode: 'center',
      now: () => now,
      evictDelayMs: 1_000_000,
      maxResidentBytes: 1_000_000,
      adaptiveThresholdScale: true,
    });
    const shared = dataTexture(12);
    const a1 = dataTexture(6);
    const coarseA = dataTexture(3);
    const b1 = dataTexture(6);
    const coarseB = dataTexture(3);
    const baseA = new MeshStandardMaterial({ name: 'a' });
    const baseB = new MeshStandardMaterial({ name: 'b' });
    const setA = createTextureLodSet({
      material: baseA,
      levels: [
        { distance: 0, textures: { map: shared } },
        { distance: 10, textures: { map: a1 } },
        { distance: 20, textures: { map: coarseA } },
      ],
      hysteresis: 0.1,
    });
    const setB = createTextureLodSet({
      material: baseB,
      levels: [
        { distance: 0, textures: { map: shared } },
        { distance: 10, textures: { map: b1 } },
        { distance: 20, textures: { map: coarseB } },
      ],
      hysteresis: 0.1,
    });
    const meshA1 = sceneMesh(baseA);
    meshA1.position.z = 5;
    const meshA2 = sceneMesh(baseA);
    meshA2.position.z = 5;
    const meshB2 = sceneMesh(baseB);
    const meshB3 = sceneMesh(baseB);
    meshB3.position.z = 15;
    const camera = cameraAt(0);
    try {
      manager.add(meshA1, setA);
      manager.addGroup([
        { mesh: meshA2, set: setA },
        { mesh: meshB2, set: setB },
      ]);
      manager.add(meshB3, setB);
      manager.update(camera); // g1=L0、g2=L0、g3=L1
      expect(manager.levelOf(meshA1)).toBe(0);
      expect(manager.levelOf(meshA2)).toBe(0);
      expect(manager.levelOf(meshB3)).toBe(1);
      // 現用 {shared, b1} ∪ 最粗 {coarseA, coarseB}。整数和のため順序誤差なし。
      const sizeOf = new Map<Texture, number>([
        [shared, 12],
        [a1, 6],
        [coarseA, 3],
        [b1, 6],
        [coarseB, 3],
      ]);
      const expected = new Set([shared, b1, coarseA, coarseB]);
      let expectedBytes = 0;
      for (const texture of expected) {
        expectedBytes += bytes(sizeOf.get(texture) as number);
      }
      expect(manager.stats().requiredBytes).toBe(expectedBytes);
      manager.setMaxResidentBytes(expectedBytes);
      // シーンは静止させる。predict が1バイトでも多ければ初回で下がる。
      for (let frame = 0; frame < 50; frame++) {
        now += 16;
        manager.update(camera);
        expect(manager.stats().thresholdScale).toBe(1);
        expect(manager.stats().requiredBytes).toBe(expectedBytes);
      }
      expect(manager.stats().scaleLowerCount).toBe(0);
      expect(manager.stats().scaleRaiseCount).toBe(0);
    } finally {
      manager.dispose();
    }
  });
});

describe('TextureLodManager finestLevel（Tier上限）', () => {
  it('finestLevel: 2 で近距離でもレベル2になり、levelOf/levelCountsが2になる', () => {
    // 手動上限が選択に一貫して効くことの確認。
    const { set, base } = set3('wall');
    const manager = new TextureLodManager({ finestLevel: 2 });
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(5));
      expect(manager.levelOf(mesh)).toBe(2);
      expect(mesh.material).toBe(set.variant(2));
      expect(manager.stats().levelCounts).toEqual([0, 0, 1]);
      expect(manager.stats().finestLevel).toBe(2);
    } finally {
      manager.dispose();
    }
  });

  it('レベルの少ないセットでは最粗にクランプする', () => {
    // 3段セットに上限4を指定しても最粗2に丸まることの確認。統計値も丸め済みになる。
    const { set, base } = set3('short');
    const manager = new TextureLodManager({ finestLevel: 4 });
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(5));
      expect(manager.levelOf(mesh)).toBe(2);
      expect(manager.stats().finestLevel).toBe(2);
    } finally {
      manager.dispose();
    }
  });

  it('非表示グループにも上限がかかる', () => {
    // held のまま上限超過を作らないことの確認。
    const { set, base } = set3('hidden');
    const manager = new TextureLodManager({ finestLevel: 0 });
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(30));
      expect(manager.levelOf(mesh)).toBe(2);
      mesh.visible = false;
      manager.setFinestLevel(2);
      manager.update(cameraAt(5));
      // 非表示のまま上限側へ寄る。
      expect(manager.levelOf(mesh)).toBe(2);
      mesh.visible = true;
      manager.update(cameraAt(5));
      expect(manager.levelOf(mesh)).toBe(2);
      // 上限を緩めても次の update までは変わらない。
      manager.setFinestLevel(0);
      expect(manager.levelOf(mesh)).toBe(2);
      manager.update(cameraAt(5));
      expect(manager.levelOf(mesh)).toBe(0);
    } finally {
      manager.dispose();
    }
  });

  it('非表示中に上限を厳しくすると保持レベルが上限まで粗くなる', () => {
    // 表示→非表示→上限変更→再表示で cap 以上になることの確認。
    const { set, base } = set3('cap-held');
    const manager = new TextureLodManager({ finestLevel: 0 });
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(5));
      expect(manager.levelOf(mesh)).toBe(0);
      mesh.visible = false;
      manager.setFinestLevel(1);
      manager.update(cameraAt(5));
      expect(manager.levelOf(mesh)).toBe(1);
      expect(mesh.material).toBe(set.variant(1));
      mesh.visible = true;
      manager.update(cameraAt(5));
      expect(manager.levelOf(mesh)).toBe(1);
    } finally {
      manager.dispose();
    }
  });

  it('setFinestLevelは設定だけではlevelOf不変、次のupdateで変わる', () => {
    // 固定スケールと同様に設定と判定を分離することの確認。
    const { set, base } = set3('defer');
    const manager = new TextureLodManager({ finestLevel: 0 });
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(5));
      expect(manager.levelOf(mesh)).toBe(0);
      manager.setFinestLevel(2);
      expect(manager.levelOf(mesh)).toBe(0);
      manager.update(cameraAt(5));
      expect(manager.levelOf(mesh)).toBe(2);
    } finally {
      manager.dispose();
    }
  });

  it('非整数・負数はRangeErrorになる', () => {
    const plain = new TextureLodManager();
    try {
      expect(() => new TextureLodManager({ finestLevel: 1.5 })).toThrow(RangeError);
      expect(() => new TextureLodManager({ finestLevel: -1 })).toThrow(RangeError);
      expect(() => plain.setFinestLevel(0.5)).toThrow(RangeError);
      expect(() => plain.setFinestLevel(-1)).toThrow(RangeError);
    } finally {
      plain.dispose();
    }
  });

  it('上限で細かいレベルが未参照になり、予算破棄の対象になる', () => {
    // 上限適用後のレベルで retain/release するため、細かい側は掃引で落ちることの確認。
    let now = 0;
    const manager = new TextureLodManager({
      now: () => now,
      evictDelayMs: 1_000_000,
      maxResidentBytes: bytes(2),
      finestLevel: 2,
    });
    const { set, base } = set3('budget');
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(5));
      expect(manager.levelOf(mesh)).toBe(2);
      // L0・L1 は未参照のため上限超過分として破棄される。最粗 L2 は残る。
      expect(manager.stats().residentBytes).toBeCloseTo(bytes(2), 10);
    } finally {
      manager.dispose();
    }
  });

  it('pinnedBytesはpins>0の和と一致する', () => {
    // 最粗テクスチャだけがピン留めされるため、その推定値になることの確認。
    const manager = new TextureLodManager();
    const { set, base } = set3('pinned');
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(5));
      expect(manager.stats().pinnedBytes).toBeCloseTo(bytes(2), 10);
      expect(manager.stats().levelCapLowerCount).toBe(0);
      expect(manager.stats().levelCapRaiseCount).toBe(0);
    } finally {
      manager.dispose();
    }
  });
});

describe('TextureLodManager stats().finestLevel の空グループ挙動', () => {
  it('グループ0件では手動finestLevelを返す（3方式）', () => {
    // 空の上限候補が手動値を潰さないことの確認。適応中も初回update前から手動値になる。
    const modes = ['plain', 'adaptive', 'noCap'] as const;
    for (const mode of modes) {
      const manager =
        mode === 'plain'
          ? new TextureLodManager({ finestLevel: 2 })
          : mode === 'adaptive'
            ? new TextureLodManager({ adaptiveThresholdScale: true, finestLevel: 2 })
            : new TextureLodManager({
                adaptiveThresholdScale: { levelCap: false },
                finestLevel: 2,
              });
      try {
        expect(manager.stats().finestLevel).toBe(2);
        manager.update(cameraAt(5));
        expect(manager.stats().finestLevel).toBe(2);
      } finally {
        manager.dispose();
      }
    }
  });

  it('setFinestLevel(2)を空で呼ぶと直ちに2、addGroup後はmin(2,maxLevel)（3方式）', () => {
    // 手動変更が空でも即時反映され、登録後は段数で丸まることの確認。
    const modes = ['plain', 'adaptive', 'noCap'] as const;
    for (const mode of modes) {
      const manager =
        mode === 'plain'
          ? new TextureLodManager()
          : mode === 'adaptive'
            ? new TextureLodManager({ adaptiveThresholdScale: true })
            : new TextureLodManager({ adaptiveThresholdScale: { levelCap: false } });
      const { set, base } = set3(`${mode}-empty2`);
      const mesh = sceneMesh(base);
      try {
        manager.setFinestLevel(2);
        expect(manager.stats().finestLevel).toBe(2);
        manager.add(mesh, set);
        manager.update(cameraAt(5));
        // set3は3段（maxLevel=2）のため min(2,2)=2 になる。
        expect(manager.stats().finestLevel).toBe(2);
      } finally {
        manager.dispose();
      }
    }
  });

  it('全解除後は手動値に戻る（3方式）', () => {
    // 適応で上限が動いた後でも、解除後は残留capではなく手動値を返すことの確認。
    let now = 0;
    const managers = [
      new TextureLodManager({ finestLevel: 0 }),
      new TextureLodManager({
        now: () => now,
        evictDelayMs: 1_000_000,
        maxResidentBytes: bytes(4) + bytes(2),
        adaptiveThresholdScale: true,
        finestLevel: 0,
      }),
      new TextureLodManager({
        now: () => now,
        evictDelayMs: 1_000_000,
        maxResidentBytes: bytes(4) + bytes(2),
        adaptiveThresholdScale: { levelCap: false },
        finestLevel: 0,
      }),
    ];
    for (const [i, manager] of managers.entries()) {
      const { set, base } = set3('removed');
      const mesh = sceneMesh(base);
      try {
        manager.add(mesh, set);
        manager.update(cameraAt(5));
        // 適応・2軸の1番目は予算で上限が1まで動く。残留capが解除後に残らない前提である。
        if (i === 1) {
          expect(manager.stats().finestLevel).toBe(1);
        }
        manager.remove(mesh);
        expect(manager.stats().objectCount).toBe(0);
        expect(manager.stats().finestLevel).toBe(0);
      } finally {
        manager.dispose();
      }
    }
  });

  it('finestLevel:2で段数2のセット追加後はupdate前から1になる（3方式）', () => {
    // `addGroup` 直後の初回 `update` 前でも古い候補を読まず、最大レベルで丸めることの確認。
    const modes = ['plain', 'adaptive', 'noCap'] as const;
    for (const mode of modes) {
      const manager =
        mode === 'plain'
          ? new TextureLodManager({ finestLevel: 2 })
          : mode === 'adaptive'
            ? new TextureLodManager({ adaptiveThresholdScale: true, finestLevel: 2 })
            : new TextureLodManager({
                adaptiveThresholdScale: { levelCap: false },
                finestLevel: 2,
              });
      const base = new MeshStandardMaterial({ name: `${mode}-two` });
      const set = createTextureLodSet({
        material: base,
        levels: [
          { distance: 0, textures: { map: dataTexture(8) } },
          { distance: 10, textures: { map: dataTexture(2) } },
        ],
      });
      const mesh = sceneMesh(base);
      try {
        manager.add(mesh, set);
        // 2段（maxLevel=1）のため min(2,1)=1 になる。更新前から変わらない。
        expect(manager.stats().finestLevel).toBe(1);
        manager.update(cameraAt(5));
        expect(manager.stats().finestLevel).toBe(1);
        expect(manager.levelOf(mesh)).toBe(1);
      } finally {
        manager.dispose();
      }
    }
  });

  it('finestLevel:2で段数5のセット追加後はupdate前後とも2（3方式）', () => {
    // 最大レベルが手動値を上回るときは手動値のまま変わらないことの確認。
    const modes = ['plain', 'adaptive', 'noCap'] as const;
    for (const mode of modes) {
      const manager =
        mode === 'plain'
          ? new TextureLodManager({ finestLevel: 2 })
          : mode === 'adaptive'
            ? new TextureLodManager({ adaptiveThresholdScale: true, finestLevel: 2 })
            : new TextureLodManager({
                adaptiveThresholdScale: { levelCap: false },
                finestLevel: 2,
              });
      const base = new MeshStandardMaterial({ name: `${mode}-five` });
      const set = createTextureLodSet({
        material: base,
        levels: [16, 8, 4, 2, 1].map((size, i) => ({
          distance: [0, 10, 20, 30, 40][i] as number,
          textures: { map: dataTexture(size) },
        })),
      });
      const mesh = sceneMesh(base);
      try {
        manager.add(mesh, set);
        // 5段（maxLevel=4）のため min(2,4)=2 になる。
        expect(manager.stats().finestLevel).toBe(2);
        manager.update(cameraAt(5));
        expect(manager.stats().finestLevel).toBe(2);
      } finally {
        manager.dispose();
      }
    }
  });

  it('適応でcap移動後のaddGroup直後は古いcapを返さない', () => {
    // 上限が動いた後に段数の多いセットを追加して候補が変わっても、
    // 更新前の統計が古い候補のcapではなく作り直した値を返すことの確認。
    const manager = new TextureLodManager({ adaptiveThresholdScale: true, finestLevel: 2 });
    const base2 = new MeshStandardMaterial({ name: 'moved-two' });
    const set2 = createTextureLodSet({
      material: base2,
      levels: [
        { distance: 0, textures: { map: dataTexture(8) } },
        { distance: 10, textures: { map: dataTexture(2) } },
      ],
    });
    const mesh2 = sceneMesh(base2);
    const base5 = new MeshStandardMaterial({ name: 'moved-five' });
    const set5 = createTextureLodSet({
      material: base5,
      levels: [16, 8, 4, 2, 1].map((size, i) => ({
        distance: [0, 10, 20, 30, 40][i] as number,
        textures: { map: dataTexture(size) },
      })),
    });
    const mesh5 = sceneMesh(base5);
    try {
      manager.add(mesh2, set2);
      manager.update(cameraAt(5));
      // 2段（maxLevel=1）のため上限は1まで動く。
      expect(manager.stats().finestLevel).toBe(1);
      manager.add(mesh5, set5);
      // 候補が [2,...] になるため、更新前から2に戻る。古い [1] のまま1を返さない。
      expect(manager.stats().finestLevel).toBe(2);
      manager.update(cameraAt(5));
      expect(manager.stats().finestLevel).toBe(2);
    } finally {
      manager.dispose();
    }
  });

  it('remove→stats→add→updateはstatsを挟まない場合と同じcapになる（3方式）', () => {
    // `stats()` が `budgetCaps` / `scaleState.cap` を書き換えないことの確認。
    // 空グループでの読み取りを挟んでも、挟まない場合と `update` の判定が一致する。
    const modes = ['plain', 'adaptive', 'noCap'] as const;
    for (const mode of modes) {
      let now = 0;
      const make = (): TextureLodManager =>
        mode === 'plain'
          ? new TextureLodManager({ finestLevel: 2 })
          : mode === 'adaptive'
            ? new TextureLodManager({
                now: () => now,
                evictDelayMs: 1_000_000,
                maxResidentBytes: 1,
                adaptiveThresholdScale: true,
                finestLevel: 0,
              })
            : new TextureLodManager({
                now: () => now,
                evictDelayMs: 1_000_000,
                maxResidentBytes: 1,
                adaptiveThresholdScale: { levelCap: false },
                finestLevel: 2,
              });
      const fiveLevels = () => {
        const coarse = dataTexture(2);
        const base = new MeshStandardMaterial({ name: `${mode}-fiveagain` });
        const maps = [dataTexture(8), dataTexture(4), coarse, coarse, coarse];
        const levels: TextureLodLevel[] = maps.map((map, i) => ({
          distance: [0, 10, 20, 30, 40][i] as number,
          textures: { map },
        }));
        return { set: createTextureLodSet({ material: base, levels }), base };
      };
      const run = (touchStats: boolean) => {
        const manager = make();
        try {
          const first = mode === 'adaptive' ? set3(`${mode}-drive`) : fiveLevels();
          const meshFirst = sceneMesh(first.base);
          manager.add(meshFirst, first.set);
          manager.update(cameraAt(5));
          if (mode === 'adaptive') {
            // 予算1ではどこにも収まらず、上限が最粗まで動く。
            expect(manager.stats().finestLevel).toBe(2);
            manager.setMaxResidentBytes(1_000_000);
          }
          manager.remove(meshFirst);
          if (touchStats) {
            // 空グループでの読み取りは手動値を返す。状態を変えてはならない。
            manager.stats();
          }
          const second = fiveLevels();
          const meshSecond = sceneMesh(second.base);
          manager.add(meshSecond, second.set);
          manager.update(cameraAt(5));
          const stats = manager.stats();
          return {
            finestLevel: stats.finestLevel,
            thresholdScale: stats.thresholdScale,
            levelCounts: [...stats.levelCounts],
          };
        } finally {
          manager.dispose();
        }
      };
      const without = run(false);
      const withStats = run(true);
      expect(withStats).toEqual(without);
      // 適応2軸は床まで動いた上限2を保ち、0に戻らない。手動2の2方式も2のまま。
      expect(withStats.finestLevel).toBe(2);
    }
  });

  it('stats()を何回呼んでもupdate結果が変わらない', () => {
    // 表示の読み取りが次回判定に影響しないことの確認。HUD が高頻度で読んでも挙動は同一になる。
    const run = (touch: boolean) => {
      let now = 0;
      const manager = new TextureLodManager({
        distanceMode: 'center',
        now: () => now,
        evictDelayMs: 1_000_000,
        maxResidentBytes: bytes(4) + bytes(2),
        adaptiveThresholdScale: true,
        finestLevel: 0,
      });
      const { set, base } = set3('idem');
      const mesh = sceneMesh(base);
      try {
        if (touch) {
          manager.stats();
        }
        manager.add(mesh, set);
        if (touch) {
          manager.stats();
        }
        manager.update(cameraAt(5));
        if (touch) {
          manager.stats();
          manager.stats();
        }
        now += 4000;
        manager.update(cameraAt(30));
        if (touch) {
          manager.stats();
        }
        const stats = manager.stats();
        return {
          finestLevel: stats.finestLevel,
          thresholdScale: stats.thresholdScale,
          levelCounts: [...stats.levelCounts],
          requiredBytes: stats.requiredBytes,
        };
      } finally {
        manager.dispose();
      }
    };
    expect(run(true)).toEqual(run(false));
  });
});

describe('TextureLodManager 2軸予算適応（距離スケール＋Tier上限）', () => {
  /** 5段で 0-2 同一・3-4 相異なるセットを作る。 */
  function set5(name: string) {
    const base = new MeshStandardMaterial({ name });
    const texA = dataTexture(8);
    const texB = dataTexture(4);
    const texC = dataTexture(2);
    const maps = [texA, texA, texA, texB, texC];
    const levels: TextureLodLevel[] = maps.map((map, i) => ({
      distance: [0, 10, 20, 30, 40][i] as number,
      textures: { map },
    }));
    const set = createTextureLodSet({ material: base, levels });
    return { set, base, texA, texB, texC };
  }

  it('5段で0-2同一・3-4相異なら上限候補は[0,3,4]でfinestLevelが動く', () => {
    // 効果のない段（1・2）を飛ばし、有効段だけに上限が動くことの確認。
    let now = 0;
    const manager = new TextureLodManager({
      distanceMode: 'center',
      now: () => now,
      evictDelayMs: 1_000_000,
      maxResidentBytes: bytes(4) + bytes(2),
      adaptiveThresholdScale: true,
    });
    const { set, base } = set5('caps');
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(5)); // 近接でL0相当。cap=0では超過し、cap=3で収まる
      expect(manager.stats().finestLevel).toBe(3);
      expect(manager.levelOf(mesh)).toBe(3);
      expect(manager.stats().requiredBytes).toBeLessThanOrEqual(bytes(4) + bytes(2));
      expect(manager.stats().levelCapLowerCount).toBe(1);
      expect(manager.stats().scaleLowerCount).toBe(0);
    } finally {
      manager.dispose();
    }
  });

  it('4096相当の近接1グループ＋予算小でcapが下がりrequired<=budget、解除で戻る', () => {
    // 共有シナリオの代表として、近接の重い1体を上限で抑えることの確認。
    let now = 0;
    const big = dataTexture(64);
    const mid = dataTexture(4);
    const coarse = dataTexture(2);
    const base = new MeshStandardMaterial({ name: 'heavy' });
    const set = createTextureLodSet({
      material: base,
      levels: [
        { distance: 0, textures: { map: big } },
        { distance: 10, textures: { map: mid } },
        { distance: 20, textures: { map: coarse } },
      ],
    });
    const budget = bytes(4) + bytes(2);
    const manager = new TextureLodManager({
      distanceMode: 'center',
      now: () => now,
      evictDelayMs: 1_000_000,
      maxResidentBytes: budget,
      adaptiveThresholdScale: true,
    });
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(5));
      expect(manager.stats().requiredBytes).toBeLessThanOrEqual(budget);
      expect(manager.stats().finestLevel).toBeGreaterThan(0);
      expect(manager.stats().thresholdScale).toBe(1);
      // 予算解除後は冷却と間隔を空けて cap=0・scale=1 に戻る。
      manager.setMaxResidentBytes(null);
      now += 1000;
      manager.update(cameraAt(5));
      expect(manager.stats().finestLevel).toBeGreaterThan(0); // 冷却中
      now += 1000;
      manager.update(cameraAt(5));
      now += 1000;
      manager.update(cameraAt(5));
      expect(manager.stats().finestLevel).toBe(0);
      expect(manager.stats().thresholdScale).toBe(1);
    } finally {
      manager.dispose();
    }
  });

  it('非表示グループにもcapがかかる', () => {
    // held のまま上限超過を作らず、上限側へ寄せることの確認。
    let now = 0;
    const manager = new TextureLodManager({
      distanceMode: 'center',
      now: () => now,
      evictDelayMs: 1_000_000,
      maxResidentBytes: bytes(4) + bytes(2),
      adaptiveThresholdScale: true,
    });
    const { set, base } = set3('hiddenCap');
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(5));
      expect(manager.stats().finestLevel).toBe(1);
      const levelBefore = manager.levelOf(mesh);
      mesh.visible = false;
      now += 16;
      manager.update(cameraAt(5));
      // 非表示でも上限は維持され、レベルは上限以上になる。
      expect(manager.levelOf(mesh)).toBe(levelBefore);
      expect((manager.levelOf(mesh) as number) >= (manager.stats().finestLevel as number)).toBe(
        true,
      );
      expect(manager.stats().requiredBytes).toBeLessThanOrEqual(bytes(4) + bytes(2));
    } finally {
      manager.dispose();
    }
  });

  it('levelCap:false は従来どおりfloorする', () => {
    // 上限を使わずスケールだけで下げるため、最粗でも収まらなければ下限で頭打ちになることの確認。
    let now = 0;
    const manager = new TextureLodManager({
      distanceMode: 'center',
      now: () => now,
      evictDelayMs: 1_000_000,
      maxResidentBytes: 1,
      adaptiveThresholdScale: { levelCap: false },
    });
    const { set, base } = set3('noCap');
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(5));
      expect(manager.stats().thresholdScale).toBe(0.05);
      expect(manager.stats().finestLevel).toBe(0);
      expect(manager.stats().requiredBytes).toBeGreaterThan(1);
      expect(manager.stats().levelCapLowerCount).toBe(0);
      expect(manager.stats().levelCapRaiseCount).toBe(0);
    } finally {
      manager.dispose();
    }
  });

  it('手動finestLevel=2とadaptiveでcapが2より細かくならない', () => {
    // 手動下限を割り込んで細かく戻さないことの確認。
    let now = 0;
    const manager = new TextureLodManager({
      distanceMode: 'center',
      now: () => now,
      evictDelayMs: 1_000_000,
      maxResidentBytes: bytes(8) + bytes(4) + bytes(2),
      adaptiveThresholdScale: true,
      finestLevel: 2,
    });
    const { set, base } = set3('manual');
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(5));
      expect(manager.stats().finestLevel).toBe(2);
      expect(manager.levelOf(mesh)).toBe(2);
      // 予算を緩めても上限は2のまま細かくならない。
      manager.setMaxResidentBytes(null);
      for (let frame = 0; frame < 10; frame++) {
        now += 1000;
        manager.update(cameraAt(5));
      }
      expect(manager.stats().finestLevel).toBe(2);
      // 手動で下げると候補が増え、次の更新で寄る。
      manager.setFinestLevel(0);
      now += 16;
      manager.update(cameraAt(5));
      expect(manager.stats().finestLevel).toBeLessThanOrEqual(2);
    } finally {
      manager.dispose();
    }
  });

  it('カウンタが軸ごとに増え、収束後に増えない', () => {
    // スケールと上限で別々に数え、静止後は両方とも動かないことの確認。
    let now = 0;
    const manager = new TextureLodManager({
      distanceMode: 'center',
      now: () => now,
      evictDelayMs: 1_000_000,
      maxResidentBytes: bytes(4) + bytes(2),
      adaptiveThresholdScale: true,
    });
    const { set, base } = set3('counter');
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(5));
      expect(manager.stats().levelCapLowerCount).toBe(1);
      const lowers = manager.stats().levelCapLowerCount;
      const raises = manager.stats().levelCapRaiseCount;
      const scaleLowers = manager.stats().scaleLowerCount;
      const scaleRaises = manager.stats().scaleRaiseCount;
      for (let frame = 0; frame < 500; frame++) {
        now += 16;
        manager.update(cameraAt(5));
      }
      expect(manager.stats().levelCapLowerCount).toBe(lowers);
      expect(manager.stats().levelCapRaiseCount).toBe(raises);
      expect(manager.stats().scaleLowerCount).toBe(scaleLowers);
      expect(manager.stats().scaleRaiseCount).toBe(scaleRaises);
    } finally {
      manager.dispose();
    }
  });

  it('pinnedBytesがpins>0の和になる', () => {
    // 破棄済みを除き、ピン留めだけを数えることの確認。
    let now = 0;
    const manager = new TextureLodManager({
      distanceMode: 'center',
      now: () => now,
      evictDelayMs: 1_000_000,
      maxResidentBytes: bytes(4) + bytes(2),
      adaptiveThresholdScale: true,
    });
    const { set, base } = set3('pinnedCap');
    const mesh = sceneMesh(base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(5));
      // 最粗だけがピン留めされる。
      expect(manager.stats().pinnedBytes).toBeCloseTo(bytes(2), 10);
    } finally {
      manager.dispose();
    }
  });

  it('levelCapの不正値はRangeErrorになる', () => {
    expect(
      () =>
        new TextureLodManager({
          adaptiveThresholdScale: { levelCap: 'yes' as unknown as boolean },
        }),
    ).toThrow(RangeError);
  });
});
