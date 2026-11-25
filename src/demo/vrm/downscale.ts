/**
 * アトラステクスチャのダウンサンプル。
 *
 * avatar-optimizer が生成するアトラスは `DataTexture`（RGBA8）なので、
 * canvas を介さずピクセル配列を直接縮小する。
 * 単純なbox平均ではなく、次の性質を保つ:
 * - 色は sRGB をリニアへ戻して平均し、sRGB へ戻す（見た目の明るさを保つ）
 * - RGB はアルファで重み付けする（透明領域の黒が縁へ滲まない）
 * - 法線は [-1,1] に戻して平均・再正規化する
 *
 * @packageDocumentation
 */
import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
  type Texture,
} from 'three/webgpu';

/** スロットの性質。法線だけ特別扱いする。 */
export type DownsampleKind = 'color' | 'normal' | 'scalar';

/**
 * sRGB の1チャンネルをリニアへ。
 *
 * 1024px アトラスを4スロット×3段階で縮小すると数千万回呼ばれるため、
 * 0..255 の LUT にして `** 2.4` の計算を避ける。
 */
const SRGB_TO_LINEAR = (() => {
  const table = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    table[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  return table;
})();

function srgbToLinear(value: number): number {
  return SRGB_TO_LINEAR[value] ?? 0;
}

/** リニアの1チャンネルを sRGB へ。 */
function linearToSrgb(value: number): number {
  const c = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
}

function clamp255(value: number): number {
  return Math.round(Math.min(255, Math.max(0, value)));
}

/**
 * アトラステクスチャにミップマップを有効化する。
 *
 * 元のアトラスは LinearFilter・ミップなしで生成される。遠景でちらつくため、
 * LODの全レベルで同じ設定（LinearMipmapLinear + generateMipmaps）に揃える。
 * 設定をレベル間で揃えることで、TextureLodSet の設定ずれ警告も出ない。
 */
export function enableMipmaps(texture: Texture): void {
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
}

/**
 * 1辺を divisor 分の1に縮小した DataTexture を作る。
 *
 * @param source - 元のアトラステクスチャ（`image.data` が Uint8Array であること）。
 * @param divisor - 2, 4, 8 などの整数。
 * @param kind - `normal` はベクトルとして再正規化する。`color` は sRGB/アルファを考慮する。
 * @returns 新しいテクスチャ。`divisor === 1` のときは source 自身を返す。
 */
export function createDownscaledTexture(
  source: Texture,
  divisor: number,
  kind: DownsampleKind,
): Texture {
  if (divisor === 1) {
    enableMipmaps(source);
    return source;
  }
  const image = source.image as
    | { data?: Uint8Array; width?: number; height?: number }
    | undefined;
  const data = image?.data;
  const width = image?.width;
  const height = image?.height;
  if (!(data instanceof Uint8Array) || !width || !height) {
    throw new Error('createDownscaledTexture: DataTexture(Uint8Array) 以外は縮小できません');
  }

  const outWidth = Math.max(1, Math.floor(width / divisor));
  const outHeight = Math.max(1, Math.floor(height / divisor));
  const out = new Uint8Array(outWidth * outHeight * 4);
  const isSrgb = kind === 'color' && source.colorSpace === SRGBColorSpace;
  const isNormal = kind === 'normal';

  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumA = 0;
      let count = 0;
      for (let dy = 0; dy < divisor; dy++) {
        const sy = Math.min(height - 1, y * divisor + dy);
        for (let dx = 0; dx < divisor; dx++) {
          const sx = Math.min(width - 1, x * divisor + dx);
          const i = (sy * width + sx) * 4;
          const a = data[i + 3] / 255;
          if (isNormal) {
            sumR += (data[i] / 127.5 - 1) * a;
            sumG += (data[i + 1] / 127.5 - 1) * a;
            sumB += (data[i + 2] / 127.5 - 1) * a;
          } else if (isSrgb) {
            sumR += srgbToLinear(data[i]) * a;
            sumG += srgbToLinear(data[i + 1]) * a;
            sumB += srgbToLinear(data[i + 2]) * a;
          } else {
            sumR += data[i] * a;
            sumG += data[i + 1] * a;
            sumB += data[i + 2] * a;
          }
          sumA += a;
          count++;
        }
      }

      const o = (y * outWidth + x) * 4;
      if (isNormal) {
        let nx = sumR;
        let ny = sumG;
        let nz = sumB;
        const length = Math.hypot(nx, ny, nz);
        if (length < 1e-6) {
          nx = 0;
          ny = 0;
          nz = 1;
        } else {
          nx /= length;
          ny /= length;
          nz /= length;
        }
        out[o] = clamp255((nx * 0.5 + 0.5) * 255);
        out[o + 1] = clamp255((ny * 0.5 + 0.5) * 255);
        out[o + 2] = clamp255((nz * 0.5 + 0.5) * 255);
      } else if (sumA > 0) {
        if (isSrgb) {
          out[o] = linearToSrgb(sumR / sumA);
          out[o + 1] = linearToSrgb(sumG / sumA);
          out[o + 2] = linearToSrgb(sumB / sumA);
        } else {
          out[o] = clamp255(sumR / sumA);
          out[o + 1] = clamp255(sumG / sumA);
          out[o + 2] = clamp255(sumB / sumA);
        }
      }
      out[o + 3] = clamp255((sumA / count) * 255);
    }
  }

  const texture = new DataTexture(out, outWidth, outHeight, RGBAFormat, UnsignedByteType);
  texture.name = `${source.name || 'atlas'}@1/${divisor}`;
  texture.colorSpace = source.colorSpace;
  texture.mapping = source.mapping;
  texture.channel = source.channel;
  texture.wrapS = source.wrapS;
  texture.wrapT = source.wrapT;
  texture.flipY = source.flipY;
  texture.anisotropy = source.anisotropy;
  texture.offset.copy(source.offset);
  texture.repeat.copy(source.repeat);
  texture.center.copy(source.center);
  texture.rotation = source.rotation;
  texture.magFilter = LinearFilter;
  enableMipmaps(texture);
  return texture;
}
