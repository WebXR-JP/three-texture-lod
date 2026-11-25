/**
 * TextureLodManager の仕様固定テスト。
 *
 * 登録・毎フレーム更新・ヒステリシス・visible・統計・常駐管理（evict/keep-all、共有テクスチャ）を確かめる。
 * remove 後の登録解除（追跡からの削除・再add・共有時の残存・pinのset単位管理・非破棄）も確かめる。
 * GPUなしで動くよう three の core クラスのみを使い、時計は注入して時間を操作する。
 */
import { describe, expect, it, vi } from 'vitest';
import { DataTexture, Material, Mesh, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, type Texture } from 'three';
import { createTextureLodSet } from './texture-lod-set.js';
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
