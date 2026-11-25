/**
 * TextureLodSet の仕様固定テスト。
 *
 * バリアント生成・base不変・syncFromBase・検証エラー・dispose範囲・設定ずれ警告を確かめる。
 * NodeMaterial 系の回帰テストでは `NodeMaterial.copy` の深いコピー挙動に対する退避手順を確かめる。
 */
import { describe, expect, it, vi } from 'vitest';
import { DataTexture, MeshStandardMaterial, SRGBColorSpace, type Texture } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { createTextureLodSet, TextureLodSet } from './texture-lod-set.js';
import type { TextureLodLevel } from './types.js';

/** 一辺 size の正方形 DataTexture を作る。 */
function dataTexture(size: number): DataTexture {
  const texture = new DataTexture(new Uint8Array(size * size * 4), size, size);
  texture.needsUpdate = true;
  return texture;
}

function levels3(): { base: MeshStandardMaterial; levels: TextureLodLevel[]; maps: DataTexture[] } {
  const base = new MeshStandardMaterial({ name: 'wall' });
  const maps = [dataTexture(64), dataTexture(16), dataTexture(4)];
  const levels: TextureLodLevel[] = maps.map((map, i) => ({
    distance: [0, 10, 20][i],
    textures: { map },
  }));
  return { base, levels, maps };
}

describe('TextureLodSet', () => {
  it('レベル数ぶんバリアントを作り、各レベルのテクスチャを割り当てる', () => {
    const { base, levels, maps } = levels3();
    const set = createTextureLodSet({ material: base, levels });
    expect(set.thresholds).toEqual([0, 10, 20]);
    expect(set.hysteresis).toBe(0.1);
    for (const [i, map] of maps.entries()) {
      const v = set.variant(i) as MeshStandardMaterial;
      expect(v).not.toBe(base);
      expect(v.map).toBe(map);
      expect(v.name).toContain('wall');
      expect(v.name).toContain(`lod${i}`);
    }
  });

  it('baseマテリアルは変更されない', () => {
    const { base, levels } = levels3();
    const originalMap = base.map;
    createTextureLodSet({ material: base, levels });
    expect(base.map).toBe(originalMap);
    expect(base.name).toBe('wall');
  });

  it('syncFromBase は色などを反映し、LODテクスチャと名前を保持する', () => {
    const { base, levels, maps } = levels3();
    const set = createTextureLodSet({ material: base, levels });
    const before = set.variant(1) as MeshStandardMaterial;
    const versionBefore = before.version;

    base.color.set(0xff0000);
    base.roughness = 0.25;
    set.syncFromBase();

    for (const [i, map] of maps.entries()) {
      const v = set.variant(i) as MeshStandardMaterial;
      expect(v.color.getHex()).toBe(0xff0000);
      expect(v.roughness).toBe(0.25);
      // LODテクスチャは上書きされず、名前の接尾辞も残る。
      expect(v.map).toBe(map);
      expect(v.name).toContain(`lod${i}`);
    }
    // needsUpdate=true により再ビルドが走る（version が進む）。
    expect(before.version).toBeGreaterThan(versionBefore);
  });

  it('syncFromBase（NodeMaterial）はLOD対象外の共有テクスチャを自己copyしない', () => {
    // base.normalMap とバリアントが同じ Texture を共有しても、退避により自己 copy を避け、
    // version が上がらない（毎回再アップロードにならない）ことを確かめる。
    const base = new MeshStandardNodeMaterial();
    const tN1 = dataTexture(16);
    base.normalMap = tN1;
    const set = createTextureLodSet({
      material: base,
      levels: [
        { distance: 0, textures: { map: dataTexture(64) } },
        { distance: 10, textures: { map: dataTexture(8) } },
      ],
    });
    const versionBefore = tN1.version;
    set.syncFromBase();
    expect(tN1.version).toBe(versionBefore);
    expect(set.variant(0).normalMap).toBe(tN1);
    expect(set.variant(1).normalMap).toBe(tN1);
  });

  it('syncFromBase（NodeMaterial）はbase側の差し替えで旧テクスチャを壊さない', () => {
    // base.normalMap を差し替えて取り込んでも、旧テクスチャの中身は上書きされず、
    // バリアントは新テクスチャを指すことを確かめる。
    const base = new MeshStandardNodeMaterial();
    const tN1 = dataTexture(16);
    const tN2 = dataTexture(32);
    base.normalMap = tN1;
    const set = createTextureLodSet({
      material: base,
      levels: [
        { distance: 0, textures: { map: dataTexture(64) } },
        { distance: 10, textures: { map: dataTexture(8) } },
      ],
    });
    base.normalMap = tN2;
    set.syncFromBase();
    expect(tN1.image.width).toBe(16);
    expect(set.variant(0).normalMap).toBe(tN2);
    expect(set.variant(1).normalMap).toBe(tN2);
  });

  it('syncFromBase（NodeMaterial）はbase側がnullでもthrowせずnullを取り込む', () => {
    // base.normalMap = null の取り込みで `copy(null)` 例外にならず、null が採用されることを確かめる。
    const base = new MeshStandardNodeMaterial();
    base.normalMap = dataTexture(16);
    const set = createTextureLodSet({
      material: base,
      levels: [
        { distance: 0, textures: { map: dataTexture(64) } },
        { distance: 10, textures: { map: dataTexture(8) } },
      ],
    });
    base.normalMap = null;
    expect(() => set.syncFromBase()).not.toThrow();
    expect(set.variant(0).normalMap).toBeNull();
    expect(set.variant(1).normalMap).toBeNull();
  });

  it('syncFromBase は copy 例外でも名前とLODスロットを復元する', () => {
    // `try/finally` の固定用。copy が throw しても名前とLODテクスチャが半端に残らないことを確かめる。
    const base = new MeshStandardNodeMaterial();
    base.normalMap = dataTexture(16);
    const map0 = dataTexture(64);
    const map1 = dataTexture(8);
    const set = createTextureLodSet({
      material: base,
      levels: [
        { distance: 0, textures: { map: map0 } },
        { distance: 10, textures: { map: map1 } },
      ],
    });
    const target = set.variant(0) as MeshStandardNodeMaterial;
    const nameBefore = target.name;
    const versionBefore = target.version;
    const originalCopy = target.copy;
    target.copy = (() => {
      throw new Error('copy fail');
    }) as typeof target.copy;
    try {
      expect(() => set.syncFromBase()).toThrow('copy fail');
    } finally {
      target.copy = originalCopy;
    }
    expect(target.name).toBe(nameBefore);
    expect(target.map).toBe(map0);
    // 失敗時は needsUpdate による再ビルドが走らない。
    expect(target.version).toBe(versionBefore);
    expect(set.variant(1).map).toBe(map1);
  });

  it('syncFromBase（NodeMaterial）はLODテクスチャの中身を書き換えない', () => {
    // NodeMaterial.copy はコピー先の Texture に `.copy()` を呼ぶため、
    // 退避なしだと LOD 側の t1 が base 側の t0 で上書きされる。このテストはその不変性を確かめる。
    const base = new MeshStandardNodeMaterial();
    const t0 = dataTexture(64);
    const t1 = dataTexture(2);
    base.map = t0;
    const set = createTextureLodSet({
      material: base,
      levels: [
        { distance: 0, textures: { map: t0 } },
        { distance: 10, textures: { map: t1 } },
      ],
    });
    base.color.set(0xff0000);
    set.syncFromBase();
    expect(t1.image.width).toBe(2);
    expect(set.variant(0).map).toBe(t0);
    expect(set.variant(1).map).toBe(t1);
    expect(base.map).toBe(t0);
    expect(set.variant(1).color.getHex()).toBe(0xff0000);
  });

  it('syncFromBase（NodeMaterial）はbaseのスロットがnullでもthrowしない', () => {
    // 退避なしだと `t.copy(null)` で例外になる。LODテクスチャは保持されること。
    const base = new MeshStandardNodeMaterial();
    expect(base.map).toBeNull();
    const t0 = dataTexture(8);
    const t1 = dataTexture(4);
    const set = createTextureLodSet({
      material: base,
      levels: [
        { distance: 0, textures: { map: t0 } },
        { distance: 10, textures: { map: t1 } },
      ],
    });
    expect(() => set.syncFromBase()).not.toThrow();
    expect(set.variant(0).map).toBe(t0);
    expect(set.variant(1).map).toBe(t1);
    expect(t0.image.width).toBe(8);
    expect(t1.image.width).toBe(4);
  });

  it('syncFromBase（NodeMaterial）は複数レベルで共有されたテクスチャも壊さない', () => {
    const base = new MeshStandardNodeMaterial();
    const t0 = dataTexture(64);
    const shared = dataTexture(8);
    base.map = t0;
    const set = createTextureLodSet({
      material: base,
      levels: [
        { distance: 0, textures: { map: t0 } },
        { distance: 10, textures: { map: shared } },
        { distance: 20, textures: { map: shared } },
      ],
    });
    set.syncFromBase();
    expect(shared.image.width).toBe(8);
    expect(set.variant(1).map).toBe(shared);
    expect(set.variant(2).map).toBe(shared);
  });

  it('スロット名がマテリアルに存在しないと検証エラーになる', () => {
    const levels: TextureLodLevel[] = [
      { distance: 0, textures: { map: dataTexture(4) } },
      { distance: 10, textures: { map: dataTexture(2) } },
    ];
    // `map` を持たないマテリアル相当。存在確認は `in` で行う。
    const withoutMap = { name: 'no-map' } as unknown as MeshStandardMaterial;
    expect(() => createTextureLodSet({ material: withoutMap, levels })).toThrow(Error);
  });

  it('createVariant が base と同一を返すと検証エラーになる', () => {
    const { base, levels } = levels3();
    expect(() =>
      createTextureLodSet({ material: base, levels, createVariant: (source) => source }),
    ).toThrow(Error);
  });

  it('createVariant がマテリアル以外を返すと検証エラーになる', () => {
    const { base, levels } = levels3();
    const notMaterial = {} as unknown as MeshStandardMaterial;
    expect(() =>
      createTextureLodSet({ material: base, levels, createVariant: () => notMaterial }),
    ).toThrow(Error);
  });

  it('createVariant フックで独自マテリアルを組み立てられる', () => {
    const { base, levels } = levels3();
    const set = createTextureLodSet({
      material: base,
      levels,
      createVariant: (source, level, index) => {
        const v = source.clone();
        v.userData = { customLevel: index, count: Object.keys(level.textures).length };
        return v;
      },
    });
    expect((set.variant(2) as MeshStandardMaterial).userData).toEqual({ customLevel: 2, count: 1 });
  });

  it('variant の範囲外アクセスで RangeError を投げる', () => {
    const { base, levels } = levels3();
    const set = createTextureLodSet({ material: base, levels });
    expect(() => set.variant(-1)).toThrow(RangeError);
    expect(() => set.variant(3)).toThrow(RangeError);
  });

  it.each([
    ['levelsが1件', [{ distance: 0, textures: {} }]],
    ['先頭distanceが0でない', [
      { distance: 2, textures: { map: dataTexture(4) } },
      { distance: 10, textures: { map: dataTexture(2) } },
    ]],
    ['distanceが昇順でない', [
      { distance: 0, textures: { map: dataTexture(4) } },
      { distance: 10, textures: { map: dataTexture(2) } },
      { distance: 9, textures: { map: dataTexture(1) } },
    ]],
    ['スロット集合が一致しない', [
      { distance: 0, textures: { map: dataTexture(4) } },
      { distance: 10, textures: { roughnessMap: dataTexture(2) } },
    ]],
    ['スロットが空', [
      { distance: 0, textures: {} },
      { distance: 10, textures: {} },
    ]],
  ])('検証エラー: %s', (_label, rawLevels) => {
    const base = new MeshStandardMaterial();
    expect(() =>
      createTextureLodSet({ material: base, levels: rawLevels as TextureLodLevel[] }),
    ).toThrow(Error);
  });

  it('スロット値が Texture でないと検証エラーになる', () => {
    const base = new MeshStandardMaterial();
    const levels = [
      { distance: 0, textures: { map: dataTexture(4) } },
      { distance: 10, textures: { map: {} } },
    ];
    expect(() => createTextureLodSet({ material: base, levels: levels as unknown as TextureLodLevel[] })).toThrow(
      Error,
    );
  });

  it('ヒステリシスバンドが重なると検証エラーになる', () => {
    // T[1]*(1+h)=11 が T[2]*(1-h)=9.9 を上回り、バンドが重なる。
    const { base, maps } = levels3();
    const levels: TextureLodLevel[] = [
      { distance: 0, textures: { map: maps[0] } },
      { distance: 10, textures: { map: maps[1] } },
      { distance: 11, textures: { map: maps[2] } },
    ];
    expect(() => createTextureLodSet({ material: base, levels, hysteresis: 0.1 })).toThrow(Error);
  });

  it.each([[-0.1], [1], [2]])('hysteresis=%s は範囲外で検証エラーになる', (h) => {
    const { base, levels } = levels3();
    expect(() => createTextureLodSet({ material: base, levels, hysteresis: h })).toThrow(Error);
  });

  it('レベル間でテクスチャ設定がずれると console.warn で知らせる', () => {
    const { base, levels } = levels3();
    const near = levels[0].textures.map as DataTexture;
    const far = levels[2].textures.map as DataTexture;
    far.colorSpace = SRGBColorSpace;
    expect(near.colorSpace).not.toBe(far.colorSpace);
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      createTextureLodSet({ material: base, levels });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toContain('map');
    } finally {
      spy.mockRestore();
    }
  });

  it('全レベルで設定が一致していれば警告しない', () => {
    const { base, levels } = levels3();
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      createTextureLodSet({ material: base, levels });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('anisotropy のずれでも警告する', () => {
    // 解像度以外の見え方のずれは LOD 切替時の段差になるため、異方性も比較対象である。
    const { base, levels } = levels3();
    const far = levels[2].textures.map as DataTexture;
    far.anisotropy = 4;
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      createTextureLodSet({ material: base, levels });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toContain('anisotropy');
    } finally {
      spy.mockRestore();
    }
  });

  it('dispose はバリアントのみ破棄し、テクスチャは破棄しない', () => {
    const { base, levels } = levels3();
    const set = new TextureLodSet({ material: base, levels });
    const variantSpies = [0, 1, 2].map((i) => vi.spyOn(set.variant(i), 'dispose'));
    const textureSpies = levels.map((level) =>
      vi.spyOn(level.textures.map as Texture, 'dispose'),
    );
    set.dispose();
    for (const spy of variantSpies) {
      expect(spy).toHaveBeenCalledTimes(1);
    }
    for (const spy of textureSpies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('独自テクスチャスロットを足した型が levels に通る', () => {
    // `MeshStandardMaterial` に `shadeMultiplyTexture` を足した型で、
    // 派生スロット名が型検査を通ること（`as any` を使わない）の確認。
    // `Object.assign` で実行時のプロパティも用意するため、存在確認も通る。
    const base = Object.assign(new MeshStandardMaterial({ name: 'shade' }), {
      shadeMultiplyTexture: null,
    });
    const nearShade = dataTexture(8);
    const farShade = dataTexture(2);
    const set = createTextureLodSet({
      material: base,
      levels: [
        { distance: 0, textures: { map: dataTexture(8), shadeMultiplyTexture: nearShade } },
        { distance: 10, textures: { map: dataTexture(4), shadeMultiplyTexture: farShade } },
      ],
    });
    expect(set.variant(0).shadeMultiplyTexture).toBe(nearShade);
    expect(set.variant(1).shadeMultiplyTexture).toBe(farShade);
    expect(set.thresholds).toEqual([0, 10]);
  });

  it('MToon相当の独自スロット型でも shadeMultiplyTexture が差し替わる', () => {
    // `@webxr-jp/mtoon-atlas` は依存に無いため、`Texture | null` を持つ
    // サブクラスで模擬する。NodeMaterial 系の型でも派生スロットが通ることの確認。
    class MockMToonMaterial extends MeshStandardNodeMaterial {
      shadeMultiplyTexture: Texture | null = null;
    }
    const base = new MockMToonMaterial();
    const nearShade = dataTexture(8);
    const farShade = dataTexture(2);
    const nearMap = dataTexture(8);
    const farMap = dataTexture(4);
    const set = createTextureLodSet({
      material: base,
      levels: [
        { distance: 0, textures: { map: nearMap, shadeMultiplyTexture: nearShade } },
        { distance: 10, textures: { map: farMap, shadeMultiplyTexture: farShade } },
      ],
    });
    expect(set.variant(0).shadeMultiplyTexture).toBe(nearShade);
    expect(set.variant(1).shadeMultiplyTexture).toBe(farShade);
    expect(set.variant(1).map).toBe(farMap);
  });
});

describe('TextureLodSet マテリアル共有', () => {
  it('同一内容のレベルはマテリアルを共有し、canonicalLevelは先頭番号を返す', () => {
    // 同一Texture集合の共有により実体が減ること、levels長は保たれることを確かめる。
    const base = new MeshStandardMaterial({ name: 'wall' });
    const t0 = dataTexture(64);
    const t1 = dataTexture(16);
    const t2 = dataTexture(4);
    const set = createTextureLodSet({
      material: base,
      levels: [
        { distance: 0, textures: { map: t0 } },
        { distance: 10, textures: { map: t1 } },
        { distance: 20, textures: { map: t1 } },
        { distance: 30, textures: { map: t2 } },
        { distance: 40, textures: { map: t2 } },
      ],
    });
    expect(set.levels.length).toBe(5);
    expect(set.variant(1)).toBe(set.variant(2));
    expect(set.variant(3)).toBe(set.variant(4));
    expect(set.variant(0)).not.toBe(set.variant(1));
    expect(set.variant(1)).not.toBe(set.variant(3));
    expect(set.canonicalLevel(0)).toBe(0);
    expect(set.canonicalLevel(1)).toBe(1);
    expect(set.canonicalLevel(2)).toBe(1);
    expect(set.canonicalLevel(3)).toBe(3);
    expect(set.canonicalLevel(4)).toBe(3);
    expect((set.variant(0) as MeshStandardMaterial).name).toContain('lod0');
    expect((set.variant(1) as MeshStandardMaterial).name).toContain('lod1-2');
    expect((set.variant(3) as MeshStandardMaterial).name).toContain('lod3-4');
  });

  it('全レベルが同一内容でもlevels長は保ち、単一マテリアルを共有する', () => {
    // Tier繰り返しで全段が同じTextureになる場合でも動くことの確認。
    const base = new MeshStandardMaterial({ name: 'wall' });
    const shared = dataTexture(8);
    const set = createTextureLodSet({
      material: base,
      levels: [
        { distance: 0, textures: { map: shared } },
        { distance: 10, textures: { map: shared } },
        { distance: 20, textures: { map: shared } },
        { distance: 30, textures: { map: shared } },
        { distance: 40, textures: { map: shared } },
      ],
    });
    expect(set.levels.length).toBe(5);
    expect(set.variant(0)).toBe(set.variant(4));
    expect(set.variant(1)).toBe(set.variant(2));
    for (let i = 0; i < 5; i++) {
      expect(set.canonicalLevel(i)).toBe(0);
    }
  });

  it('1スロットでも違えば別マテリアルになる', () => {
    // mapが同じでも他スロットが違えば内容が違うため共有しないことの確認。
    const base = new MeshStandardMaterial({ name: 'wall' });
    const sameMap = dataTexture(8);
    const roughA = dataTexture(4);
    const roughB = dataTexture(2);
    const set = createTextureLodSet({
      material: base,
      levels: [
        { distance: 0, textures: { map: sameMap, roughnessMap: roughA } },
        { distance: 10, textures: { map: sameMap, roughnessMap: roughB } },
      ],
    });
    expect(set.variant(0)).not.toBe(set.variant(1));
    expect(set.canonicalLevel(0)).toBe(0);
    expect(set.canonicalLevel(1)).toBe(1);
  });

  it('createVariantはグループごとに1回だけ先頭番号で呼ばれる', () => {
    // フックの呼び出し回数と引数が共有単位であること、戻り値も共有されることの確認。
    const base = new MeshStandardMaterial({ name: 'wall' });
    const t0 = dataTexture(64);
    const t1 = dataTexture(16);
    const seen: number[] = [];
    const set = createTextureLodSet({
      material: base,
      levels: [
        { distance: 0, textures: { map: t0 } },
        { distance: 10, textures: { map: t1 } },
        { distance: 20, textures: { map: t1 } },
      ],
      createVariant: (source, _level, index) => {
        seen.push(index);
        return source.clone();
      },
    });
    expect(seen).toEqual([0, 1]);
    expect(set.variant(1)).toBe(set.variant(2));
  });

  it('disposeは共有マテリアルに1回だけ走る', () => {
    // 同一実体の二重破棄を避けることの確認。テクスチャは破棄しない。
    const base = new MeshStandardMaterial({ name: 'wall' });
    const t0 = dataTexture(64);
    const t1 = dataTexture(16);
    const set = createTextureLodSet({
      material: base,
      levels: [
        { distance: 0, textures: { map: t0 } },
        { distance: 10, textures: { map: t1 } },
        { distance: 20, textures: { map: t1 } },
      ],
    });
    const unique0 = set.variant(0);
    const shared = set.variant(1);
    const spy0 = vi.spyOn(unique0, 'dispose');
    const spyShared = vi.spyOn(shared, 'dispose');
    set.dispose();
    expect(spy0).toHaveBeenCalledTimes(1);
    expect(spyShared).toHaveBeenCalledTimes(1);
  });

  it('syncFromBaseは共有マテリアルに1回だけ走る', () => {
    // 共有実体へのcopyが重複しないことの確認。
    const base = new MeshStandardMaterial({ name: 'wall' });
    const t0 = dataTexture(64);
    const t1 = dataTexture(16);
    const set = createTextureLodSet({
      material: base,
      levels: [
        { distance: 0, textures: { map: t0 } },
        { distance: 10, textures: { map: t1 } },
        { distance: 20, textures: { map: t1 } },
      ],
    });
    const shared = set.variant(1);
    expect(set.variant(2)).toBe(shared);
    const copySpy = vi.spyOn(shared, 'copy');
    base.color.set(0x00ff00);
    set.syncFromBase();
    expect(copySpy).toHaveBeenCalledTimes(1);
    expect((shared as MeshStandardMaterial).color.getHex()).toBe(0x00ff00);
  });

  it('canonicalLevelの範囲外でRangeErrorを投げる', () => {
    const { base, levels } = levels3();
    const set = createTextureLodSet({ material: base, levels });
    expect(() => set.canonicalLevel(-1)).toThrow(RangeError);
    expect(() => set.canonicalLevel(3)).toThrow(RangeError);
  });
});
