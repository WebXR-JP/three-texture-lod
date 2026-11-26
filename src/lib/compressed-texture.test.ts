/**
 * 圧縮テクスチャ補助関数の仕様固定テスト。
 *
 * isCompressedTexture の判定、estimateTextureBytes の圧縮・非圧縮計算、
 * sliceCompressedTexture の独立複製と非破壊性、createCompressedTextureMipLevels の
 * ミップ選択・共有・下限クランプを確かめる。
 */
import { describe, expect, it } from 'vitest';
import {
  ClampToEdgeWrapping,
  CompressedTexture,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NearestFilter,
  RGBA_BPTC_Format,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  UnsignedByteType,
  type CompressedTextureMipmap,
} from 'three';
import {
  createCompressedTextureMipLevels,
  estimateTextureBytes,
  isCompressedTexture,
  sliceCompressedTexture,
} from './compressed-texture.js';

/** 1024 等から 1x1 までのダミーミップチェーンを持つ CompressedTexture を作る。 */
function compressedTexture(
  baseWidth: number,
  baseHeight = baseWidth,
  minSize = 1,
): CompressedTexture {
  const mipmaps: CompressedTextureMipmap[] = [];
  let w = baseWidth;
  let h = baseHeight;
  while (true) {
    // BC7 相当（4x4 ブロック 16 バイト）としてバイト列を用意する。
    const blocksW = Math.max(1, Math.ceil(w / 4));
    const blocksH = Math.max(1, Math.ceil(h / 4));
    mipmaps.push({
      data: new Uint8Array(blocksW * blocksH * 16),
      width: w,
      height: h,
    });
    if (w <= minSize && h <= minSize) {
      break;
    }
    w = Math.max(1, Math.floor(w / 2));
    h = Math.max(1, Math.floor(h / 2));
  }
  const tex = new CompressedTexture(
    mipmaps,
    baseWidth,
    baseHeight,
    RGBA_BPTC_Format,
    UnsignedByteType,
  );
  tex.name = 'test-bc7';
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.minFilter = mipmaps.length > 1 ? LinearMipmapLinearFilter : LinearFilter;
  tex.magFilter = LinearFilter;
  tex.anisotropy = 4;
  tex.channel = 1;
  tex.offset.set(0.25, 0.5);
  tex.repeat.set(2, 3);
  tex.center.set(0.5, 0.5);
  tex.rotation = 0.5;
  tex.needsUpdate = true;
  return tex;
}

describe('isCompressedTexture', () => {
  it('CompressedTexture のみ true を返し、他は false を返す', () => {
    expect(isCompressedTexture(compressedTexture(16))).toBe(true);
    expect(isCompressedTexture(new DataTexture(new Uint8Array(16), 2, 2))).toBe(false);
    expect(isCompressedTexture(new Texture())).toBe(false);
    expect(isCompressedTexture(null)).toBe(false);
    expect(isCompressedTexture(undefined)).toBe(false);
    expect(isCompressedTexture({ isTexture: true })).toBe(false);
    expect(isCompressedTexture({ isCompressedTexture: true })).toBe(false);
  });
});

describe('estimateTextureBytes', () => {
  it('CompressedTexture は全ミップの byteLength 合計を返す', () => {
    const tex = compressedTexture(8, 8);
    // 8x8(2x2=4blk=64B) + 4x4(1blk=16B) + 2x2(1blk=16B) + 1x1(1blk=16B) = 112B
    expect(estimateTextureBytes(tex)).toBe(112);

    const single = compressedTexture(8, 8, 8);
    expect(estimateTextureBytes(single)).toBe(64);
  });

  it('ミップデータが空の CompressedTexture は 0 を返す', () => {
    const empty = new CompressedTexture([], 64, 64, RGBA_BPTC_Format);
    expect(estimateTextureBytes(empty)).toBe(0);
  });

  it('CompressedCubeTexture 相当の構造では全面のミップ合計を返す', () => {
    const faceMip: CompressedTextureMipmap = { data: new Uint8Array(32), width: 4, height: 4 };
    const cubeLike = Object.assign(new CompressedTexture([], 4, 4, RGBA_BPTC_Format), {
      isCompressedCubeTexture: true,
      image: Array.from({ length: 6 }, () => ({ mipmaps: [faceMip] })),
    });
    expect(estimateTextureBytes(cubeLike)).toBe(32 * 6);
  });

  it('非圧縮テクスチャは RGBA8 × 4/3 の推定値を返す', () => {
    const dataTex = new DataTexture(new Uint8Array(16 * 8 * 4), 16, 8);
    expect(estimateTextureBytes(dataTex)).toBeCloseTo((16 * 8 * 4 * 4) / 3, 10);
    expect(estimateTextureBytes(new Texture())).toBe(0);
  });
});

describe('sliceCompressedTexture', () => {
  it('mipOffset=0 は元インスタンスをそのまま返す', () => {
    const source = compressedTexture(64);
    expect(sliceCompressedTexture(source, 0)).toBe(source);
  });

  it('mipOffset>0 は独立した Source を持ち、元テクスチャを壊さず全設定を引き継ぐ', () => {
    const source = compressedTexture(64);
    const sliced = sliceCompressedTexture(source, 2);

    expect(sliced).not.toBe(source);
    expect(sliced.source).not.toBe(source.source);
    expect(source.image).toEqual({ width: 64, height: 64 });
    expect(sliced.image).toEqual({ width: 16, height: 16 });
    expect(sliced.mipmaps.length).toBe(source.mipmaps.length - 2);
    // ピクセル配列の実体はコピーせず共有する。
    expect(sliced.mipmaps[0]).toBe(source.mipmaps[2]);
    expect(sliced.version).toBeGreaterThan(0);

    expect(sliced.name).toBe('test-bc7@mip2');
    expect(sliced.format).toBe(RGBA_BPTC_Format);
    expect(sliced.type).toBe(UnsignedByteType);
    expect(sliced.colorSpace).toBe(SRGBColorSpace);
    expect(sliced.wrapS).toBe(RepeatWrapping);
    expect(sliced.wrapT).toBe(RepeatWrapping);
    expect(sliced.minFilter).toBe(LinearMipmapLinearFilter);
    expect(sliced.magFilter).toBe(LinearFilter);
    expect(sliced.anisotropy).toBe(4);
    expect(sliced.channel).toBe(1);
    expect(sliced.generateMipmaps).toBe(false);
    expect(sliced.flipY).toBe(false);
    expect(sliced.offset.x).toBe(0.25);
    expect(sliced.offset.y).toBe(0.5);
    expect(sliced.repeat.x).toBe(2);
    expect(sliced.repeat.y).toBe(3);
    expect(sliced.center.x).toBe(0.5);
    expect(sliced.rotation).toBe(0.5);

    // 独立した Source のため、設定変更が互いに波及しない。
    sliced.wrapS = ClampToEdgeWrapping;
    sliced.minFilter = NearestFilter;
    expect(source.wrapS).toBe(RepeatWrapping);
    expect(source.minFilter).toBe(LinearMipmapLinearFilter);
  });

  it('不正入力や範囲外・未対応種別を拒否する', () => {
    const source = compressedTexture(16, 16, 4); // mipmaps: 16, 8, 4 (length=3)
    expect(() => sliceCompressedTexture(source, -1)).toThrow(RangeError);
    expect(() => sliceCompressedTexture(source, 1.5)).toThrow(RangeError);
    expect(() => sliceCompressedTexture(source, 3)).toThrow(RangeError);

    const empty = new CompressedTexture([], 16, 16, RGBA_BPTC_Format);
    expect(() => sliceCompressedTexture(empty, 0)).toThrow(RangeError);

    const dataTex = new DataTexture(new Uint8Array(16), 2, 2);
    expect(() => sliceCompressedTexture(dataTex as unknown as CompressedTexture, 0)).toThrow(Error);

    const cubeLike = Object.assign(compressedTexture(8), { isCompressedCubeTexture: true });
    expect(() => sliceCompressedTexture(cubeLike, 1)).toThrow(Error);

    const arrayLike = Object.assign(compressedTexture(8), { isCompressedArrayTexture: true });
    expect(() => sliceCompressedTexture(arrayLike, 1)).toThrow(Error);
  });
});

describe('createCompressedTextureMipLevels', () => {
  it('絶対解像度 Tier に応じたミップを選び、同一ミップのレベル間で実体を共有する', () => {
    const tex1024 = compressedTexture(1024);
    const tiers = [4096, 2048, 1024, 512, 256];
    const levels1024 = createCompressedTextureMipLevels(tex1024, tiers);

    expect(levels1024).toHaveLength(5);
    expect(levels1024[0]).toBe(tex1024);
    expect(levels1024[1]).toBe(tex1024);
    expect(levels1024[2]).toBe(tex1024);
    expect(levels1024[3].image).toEqual({ width: 512, height: 512 });
    expect(levels1024[3].mipmaps).toHaveLength(10);
    expect(levels1024[4].image).toEqual({ width: 256, height: 256 });
    expect(levels1024[4].mipmaps).toHaveLength(9);

    const tex512 = compressedTexture(512);
    const levels512 = createCompressedTextureMipLevels(tex512, tiers);
    expect(levels512[0]).toBe(tex512);
    expect(levels512[3]).toBe(tex512);
    expect(levels512[4].image).toEqual({ width: 256, height: 256 });
  });

  it('非正方形テクスチャでも短辺 minDimension で下限クランプし、同じオフセットを共有する', () => {
    // 1024x256 -> 512x128 -> 256x64 -> 128x32 -> 64x16 -> 32x8 -> 16x4 -> 8x2 -> 4x1
    const rect = compressedTexture(1024, 256);
    const levels = createCompressedTextureMipLevels(rect, [1024, 512, 16, 8]);
    expect(levels[0]).toBe(rect);
    expect(levels[1].image).toEqual({ width: 512, height: 128 });
    // 既定 minDimension=4 のため、8x2 には落ちず 16x4 で止まり、L2 と L3 が同一実体になる。
    expect(levels[2].image).toEqual({ width: 16, height: 4 });
    expect(levels[3]).toBe(levels[2]);

    const unconstrained = createCompressedTextureMipLevels(rect, [1024, 8], { minDimension: 1 });
    expect(unconstrained[1].image).toEqual({ width: 8, height: 2 });
  });

  it('単一ミップのテクスチャは全レベルで元インスタンスを返す', () => {
    const single = compressedTexture(256, 256, 256);
    const levels = createCompressedTextureMipLevels(single, [1024, 512, 256, 128]);
    for (const tex of levels) {
      expect(tex).toBe(single);
    }
  });

  it('不正な引数でエラーを投げる', () => {
    const source = compressedTexture(64);
    expect(() => createCompressedTextureMipLevels(source, [0])).toThrow(RangeError);
    expect(() => createCompressedTextureMipLevels(source, [-8])).toThrow(RangeError);
    expect(() => createCompressedTextureMipLevels(source, [Number.NaN])).toThrow(RangeError);
    expect(() =>
      createCompressedTextureMipLevels(source, [64], { minDimension: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      createCompressedTextureMipLevels(source, [64], { minDimension: 1.5 }),
    ).toThrow(RangeError);
    const empty = new CompressedTexture([], 64, 64, RGBA_BPTC_Format);
    expect(() => createCompressedTextureMipLevels(empty, [64])).toThrow(Error);
  });
});
