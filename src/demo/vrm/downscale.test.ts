/**
 * アトラス縮小のピクセル計算を固定する。
 * three の DataTexture は Node でも動くため、GPUなしで検証できる。
 */
import { describe, expect, it } from 'vitest';
import {
  CompressedTexture,
  DataTexture,
  type ColorSpace,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RGBA_BPTC_Format,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
} from 'three/webgpu';
import { createDownscaledTexture, createTierTexturesForSlot, enableMipmaps } from './downscale.js';

function texture(pixels: number[][], colorSpace: ColorSpace = NoColorSpace): DataTexture {
  const size = pixels.length;
  const data = new Uint8Array(size * size * 4);
  pixels.forEach((row, y) =>
    row.forEach((value, x) => {
      const i = (y * size + x) * 4;
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
      data[i + 3] = 255;
    }),
  );
  const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  tex.colorSpace = colorSpace;
  tex.needsUpdate = true;
  return tex;
}

describe('createDownscaledTexture', () => {
  it('divisor=1 では元テクスチャを返し、ミップマップを有効にする', () => {
    const source = texture([[0]]);
    const result = createDownscaledTexture(source, 1, 'scalar');
    expect(result).toBe(source);
    expect(result.generateMipmaps).toBe(true);
    expect(result.minFilter).toBe(LinearMipmapLinearFilter);
  });

  it('scalar は4画素の平均を取る', () => {
    const source = texture(
      [
        [0, 100],
        [200, 40],
      ],
      NoColorSpace,
    );
    const result = createDownscaledTexture(source, 2, 'scalar');
    const image = result.image as { width: number; height: number; data: Uint8Array };
    expect(image.width).toBe(1);
    expect(image.height).toBe(1);
    expect(image.data[0]).toBe(85);
    expect(image.data[3]).toBe(255);
  });

  it('透明画素のRGBはアルファで重み付けされ、黒が滲まない', () => {
    const data = new Uint8Array(2 * 2 * 4);
    // 左上: 不透明の赤、他は透明（RGB=0）
    data[0] = 255;
    data[3] = 255;
    const source = new DataTexture(data, 2, 2, RGBAFormat, UnsignedByteType);
    source.colorSpace = SRGBColorSpace;
    source.needsUpdate = true;
    const result = createDownscaledTexture(source, 2, 'color');
    const image = result.image as { data: Uint8Array };
    // 赤だけが残り、アルファは 1/4 になる
    expect(image.data[0]).toBe(255);
    expect(image.data[1]).toBe(0);
    expect(image.data[3]).toBe(64);
  });

  it('sRGBの平均はリニア空間で行う', () => {
    // 0 と 255 を2画素ずつ。リニア平均0.5 → sRGB 188。
    const data = new Uint8Array(2 * 2 * 4);
    for (let i = 0; i < 4; i++) {
      const value = i < 2 ? 0 : 255;
      data[i * 4] = value;
      data[i * 4 + 1] = value;
      data[i * 4 + 2] = value;
      data[i * 4 + 3] = 255;
    }
    const source = new DataTexture(data, 2, 2, RGBAFormat, UnsignedByteType);
    source.colorSpace = SRGBColorSpace;
    source.needsUpdate = true;
    const result = createDownscaledTexture(source, 2, 'color');
    const image = result.image as { data: Uint8Array };
    expect(image.data[0]).toBeGreaterThanOrEqual(187);
    expect(image.data[0]).toBeLessThanOrEqual(189);
  });

  it('normal は平均後に再正規化する', () => {
    const data = new Uint8Array(2 * 2 * 4);
    // 4画素とも +X 方向の法線 (255,128,128)
    for (let i = 0; i < 4; i++) {
      data[i * 4] = 255;
      data[i * 4 + 1] = 128;
      data[i * 4 + 2] = 128;
      data[i * 4 + 3] = 255;
    }
    const source = new DataTexture(data, 2, 2, RGBAFormat, UnsignedByteType);
    source.needsUpdate = true;
    const result = createDownscaledTexture(source, 2, 'normal');
    const image = result.image as { data: Uint8Array };
    expect(image.data[0]).toBeGreaterThan(240);
    expect(Math.abs(image.data[1] - 128)).toBeLessThanOrEqual(1);
    expect(Math.abs(image.data[2] - 128)).toBeLessThanOrEqual(1);
  });

  it('ミップマップ設定は全レベルで揃い、色空間とラップを引き継ぐ', () => {
    const source = texture(
      [
        [1, 2],
        [3, 4],
      ],
      SRGBColorSpace,
    );
    const result = createDownscaledTexture(source, 2, 'color');
    expect(result.generateMipmaps).toBe(true);
    expect(result.minFilter).toBe(LinearMipmapLinearFilter);
    expect(result.magFilter).toBe(LinearFilter);
    expect(result.colorSpace).toBe(SRGBColorSpace);
    expect(result.wrapS).toBe(source.wrapS);
    expect(result.flipY).toBe(source.flipY);
  });

  it('DataTexture以外は明示的に失敗する', () => {
    const source = new DataTexture(new Uint8Array(4), 1, 1);
    // image を差し替えて DataTexture でない画像を模す
    (source as unknown as { image: unknown }).image = { width: 2, height: 2 };
    expect(() => createDownscaledTexture(source, 2, 'color')).toThrow(/DataTexture/);
  });

  it('enableMipmaps はフィルタとフラグを設定する', () => {
    const source = texture([[0]]);
    source.generateMipmaps = false;
    source.minFilter = LinearFilter;
    enableMipmaps(source);
    expect(source.generateMipmaps).toBe(true);
    expect(source.minFilter).toBe(LinearMipmapLinearFilter);
  });

  it('enableMipmaps は CompressedTexture の generateMipmaps を true にしない', () => {
    const multi = new CompressedTexture(
      [
        { data: new Uint8Array(64), width: 8, height: 8 },
        { data: new Uint8Array(16), width: 4, height: 4 },
      ],
      8,
      8,
      RGBA_BPTC_Format,
    );
    multi.minFilter = LinearFilter;
    enableMipmaps(multi);
    expect(multi.generateMipmaps).toBe(false);
    expect(multi.minFilter).toBe(LinearMipmapLinearFilter);

    const single = new CompressedTexture(
      [{ data: new Uint8Array(64), width: 8, height: 8 }],
      8,
      8,
      RGBA_BPTC_Format,
    );
    single.minFilter = LinearFilter;
    enableMipmaps(single);
    expect(single.generateMipmaps).toBe(false);
    expect(single.minFilter).toBe(LinearFilter);
  });

  it('createTierTexturesForSlot は圧縮・非圧縮スロットを独立に処理する', () => {
    const compressed = new CompressedTexture(
      [
        { data: new Uint8Array(16), width: 16, height: 16 },
        { data: new Uint8Array(16), width: 8, height: 8 },
        { data: new Uint8Array(16), width: 4, height: 4 },
      ],
      16,
      16,
      RGBA_BPTC_Format,
    );
    const compLevels = createTierTexturesForSlot(compressed, [32, 16, 8], 'color');
    expect(compLevels[0]).toBe(compressed);
    expect(compLevels[1]).toBe(compressed);
    expect((compLevels[2].image as { width: number }).width).toBe(8);

    const uncompressed = new DataTexture(new Uint8Array(16 * 16 * 4), 16, 16, RGBAFormat, UnsignedByteType);
    uncompressed.needsUpdate = true;
    const rawLevels = createTierTexturesForSlot(uncompressed, [32, 16, 8], 'scalar');
    expect(rawLevels[0]).toBe(uncompressed);
    expect(rawLevels[1]).toBe(uncompressed);
    expect((rawLevels[2].image as { width: number }).width).toBe(8);
  });
});
