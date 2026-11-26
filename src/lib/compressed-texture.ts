/**
 * 圧縮テクスチャ（`CompressedTexture`）の判定・バイト数計算・ミップスライス。
 *
 * ライブラリ全体の方針に従い、`three` からの値 import は行わず `import type` のみを使う。
 *
 * @packageDocumentation
 */
import type {
  AnyMapping,
  CompressedPixelFormat,
  CompressedTexture,
  CompressedTextureMipmap,
  MagnificationTextureFilter,
  MinificationTextureFilter,
  Texture,
  TextureDataType,
  Wrapping,
} from 'three';

/**
 * {@link createCompressedTextureMipLevels} のオプション。
 */
export interface CompressedMipSliceOptions {
  /**
   * 選択を許可する最小辺サイズ（px）。1 以上の有限整数であること。
   *
   * WebGPU のブロック圧縮テクスチャ（BC7 / ASTC 4x4 / ETC2 / S3TC）は
   * 基底解像度にブロック倍数を要求するため、既定では `4` 未満の短辺になるスライスを避ける。
   *
   * @defaultValue `4`
   */
  readonly minDimension?: number;
}

/** 2D `CompressedTexture` と同等のコンストラクタシグネチャ。 */
type CompressedTextureConstructor = new (
  mipmaps: CompressedTextureMipmap[],
  width: number,
  height: number,
  format?: CompressedPixelFormat,
  type?: TextureDataType,
  mapping?: AnyMapping,
  wrapS?: Wrapping,
  wrapT?: Wrapping,
  magFilter?: MagnificationTextureFilter,
  minFilter?: MinificationTextureFilter,
  anisotropy?: number,
  colorSpace?: string,
) => CompressedTexture;

/** `mipmaps` 配列の `data.byteLength` を合算する。 */
function sumMipmapBytes(mipmaps: unknown): number {
  if (!Array.isArray(mipmaps)) {
    return 0;
  }
  let total = 0;
  for (const mip of mipmaps) {
    if (typeof mip !== 'object' || mip === null) {
      continue;
    }
    const data = (mip as { data?: unknown }).data;
    if (typeof data !== 'object' || data === null) {
      continue;
    }
    const byteLength = (data as { byteLength?: unknown }).byteLength;
    if (typeof byteLength === 'number' && Number.isFinite(byteLength) && byteLength > 0) {
      total += byteLength;
    }
  }
  return total;
}

/**
 * 値が `CompressedTexture` 相当かをダックタイピングで判定する。
 *
 * ADR: `src/lib/` は `three` からの値 import を行わないため `instanceof CompressedTexture` を使えない。
 * three.js の `CompressedTexture` が持つ不変フラグ `isTexture === true && isCompressedTexture === true` で判定する。
 *
 * @param value - 判定対象の値。
 * @returns `CompressedTexture` 相当であれば `true`。
 */
export function isCompressedTexture(value: unknown): value is CompressedTexture {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { isTexture?: unknown; isCompressedTexture?: unknown };
  return candidate.isTexture === true && candidate.isCompressedTexture === true;
}

/**
 * テクスチャの常駐バイト数を求める。
 *
 * `CompressedTexture` の場合は `mipmaps[].data.byteLength`（圧縮キューブマップで本体配列が空のときは
 * `image[].mipmaps[].data.byteLength`）の合算値を返す。
 * 非圧縮テクスチャの場合は RGBA8（1 画素 4 バイト）にミップマップ係数 `4/3` を掛けた推定値
 * `w * h * 4 * 4 / 3` を返す。画像情報やミップデータを持たない場合は `0` を返す。
 *
 * @param texture - 対象テクスチャ。
 * @returns バイト数（0 以上の有限値）。
 */
export function estimateTextureBytes(texture: Texture): number {
  if (isCompressedTexture(texture)) {
    const directBytes = sumMipmapBytes(texture.mipmaps);
    if (directBytes > 0) {
      return directBytes;
    }
    // ADR: `CompressedCubeTexture` は `mipmaps` が空で `image` の各面に `mipmaps` を持つ構造になる。
    // 値 import なしの方針のため `isCompressedCubeTexture` フラグと配列構造でフォールバックする。
    const cubeCandidate = texture as unknown as {
      isCompressedCubeTexture?: unknown;
      image?: unknown;
    };
    if (cubeCandidate.isCompressedCubeTexture === true && Array.isArray(cubeCandidate.image)) {
      let cubeBytes = 0;
      for (const face of cubeCandidate.image) {
        if (typeof face === 'object' && face !== null) {
          cubeBytes += sumMipmapBytes((face as { mipmaps?: unknown }).mipmaps);
        }
      }
      return cubeBytes;
    }
    return 0;
  }

  // ADR: `texture.image` の型は three のバージョンで `any` のため、
  // `unknown` 経由の絞り込みで幅・高さだけを安全に読む。
  const image: unknown = texture.image;
  let width = 0;
  let height = 0;
  if (typeof image === 'object' && image !== null) {
    const { width: w, height: h } = image as { width?: unknown; height?: unknown };
    if (typeof w === 'number' && Number.isFinite(w) && w > 0) {
      width = w;
    }
    if (typeof h === 'number' && Number.isFinite(h) && h > 0) {
      height = h;
    }
  }
  return (width * height * 4 * 4) / 3;
}

/**
 * 2D `CompressedTexture` のミップ配列を `mipOffset` から切り出した新しいインスタンスを作る。
 *
 * `mipOffset === 0` のときは複製せず `source` 自身をそのまま返す（共有維持のため）。
 *
 * ADR: `source.clone()` は `Texture.prototype.copy` が `this.source = source.source` を共有するため、
 * `image` の幅・高さを書き換えると元テクスチャまで破壊される。また `three` を値 import しない方針のため、
 * `source.constructor` を直接呼び出して独立した `Source` を持つ新インスタンスを生成する。
 *
 * @param source - 元となる 2D `CompressedTexture`。
 * @param mipOffset - 切り出し開始ミップ番号（0 以上 `source.mipmaps.length` 未満の整数）。
 * @returns スライス済み `CompressedTexture`（`mipOffset === 0` のときは `source` 自身）。
 * @throws `Error` — `source` が 2D `CompressedTexture` でない場合、または切り出した先頭ミップの寸法が不正な場合。
 * @throws `RangeError` — `mipOffset` が範囲外・負・非整数の場合。
 */
export function sliceCompressedTexture(
  source: CompressedTexture,
  mipOffset: number,
): CompressedTexture {
  if (!isCompressedTexture(source)) {
    throw new Error('sliceCompressedTexture: source は CompressedTexture である必要があります');
  }
  const kindFlags = source as unknown as {
    isCompressedCubeTexture?: unknown;
    isCompressedArrayTexture?: unknown;
  };
  if (kindFlags.isCompressedCubeTexture === true || kindFlags.isCompressedArrayTexture === true) {
    throw new Error(
      'sliceCompressedTexture: 2D CompressedTexture のみ対応しています（Cube/Array は未対応）',
    );
  }
  if (!Number.isInteger(mipOffset) || mipOffset < 0) {
    throw new RangeError(
      `mipOffset は 0 以上の整数である必要があります: ${String(mipOffset)}`,
    );
  }
  if (!Array.isArray(source.mipmaps) || source.mipmaps.length === 0 || mipOffset >= source.mipmaps.length) {
    throw new RangeError(
      `mipOffset が mipmaps の範囲外です: mipOffset=${mipOffset}, length=${Array.isArray(source.mipmaps) ? source.mipmaps.length : 0}`,
    );
  }
  if (mipOffset === 0) {
    return source;
  }

  const slicedMipmaps = source.mipmaps.slice(mipOffset);
  const top = slicedMipmaps[0];
  if (
    top === undefined ||
    !Number.isFinite(top.width) ||
    top.width <= 0 ||
    !Number.isFinite(top.height) ||
    top.height <= 0
  ) {
    throw new Error(
      `sliceCompressedTexture: 先頭ミップの寸法が不正です（mipOffset=${mipOffset}）`,
    );
  }

  // ADR: 値 import を避けるため `source.constructor` を `CompressedTextureConstructor` として呼び出す。
  // 上記で `isCompressedTexture` かつ非 Cube/Array を検証済みのため、2D `CompressedTexture` 互換コンストラクタが成立する。
  const Ctor = source.constructor as unknown as CompressedTextureConstructor;
  const sliced = new Ctor(
    slicedMipmaps,
    top.width,
    top.height,
    source.format,
    source.type,
    source.mapping,
    source.wrapS,
    source.wrapT,
    source.magFilter,
    source.minFilter,
    source.anisotropy,
    source.colorSpace,
  );

  sliced.name = `${source.name || 'compressed'}@mip${mipOffset}`;
  sliced.internalFormat = source.internalFormat;
  sliced.channel = source.channel;
  sliced.flipY = source.flipY;
  sliced.generateMipmaps = false;
  sliced.premultiplyAlpha = source.premultiplyAlpha;
  sliced.unpackAlignment = source.unpackAlignment;
  sliced.offset.copy(source.offset);
  sliced.repeat.copy(source.repeat);
  sliced.center.copy(source.center);
  sliced.rotation = source.rotation;
  sliced.matrixAutoUpdate = source.matrixAutoUpdate;
  sliced.matrix.copy(source.matrix);
  // ADR: 新規生成直後の `version` は 0 のため、`needsUpdate = true` を立てて
  // WebGPURenderer が非同期未完了のデフォルトテクスチャ扱いするのを防ぐ。
  sliced.needsUpdate = true;

  return sliced;
}

/**
 * 2D `CompressedTexture` から、指定した最大解像度列に対応する LOD レベル用テクスチャ配列を生成する。
 *
 * 各レベルで長辺が `maxDimensions[i]` 以下となる最も細かいミップを選び、同じ `mipOffset` になるレベル間では
 * 同一の `CompressedTexture` インスタンスを共有する（`mipOffset === 0` は `source` 自身）。
 *
 * @param source - ミップチェーンを持つ 2D `CompressedTexture`。
 * @param maxDimensions - レベルごとの最大長辺（px）。正の有限数。
 * @param options - スライス制約オプション。
 * @returns `maxDimensions` と同じ長さの `CompressedTexture` 配列。
 * @throws `Error` — `source` が 2D `CompressedTexture` でない、または `mipmaps` が空の場合。
 * @throws `RangeError` — `maxDimensions` に非正数・非有限値が含まれる、または `minDimension` が不正な場合。
 */
export function createCompressedTextureMipLevels(
  source: CompressedTexture,
  maxDimensions: readonly number[],
  options?: CompressedMipSliceOptions,
): CompressedTexture[] {
  if (!isCompressedTexture(source)) {
    throw new Error(
      'createCompressedTextureMipLevels: source は CompressedTexture である必要があります',
    );
  }
  const kindFlags = source as unknown as {
    isCompressedCubeTexture?: unknown;
    isCompressedArrayTexture?: unknown;
  };
  if (kindFlags.isCompressedCubeTexture === true || kindFlags.isCompressedArrayTexture === true) {
    throw new Error(
      'createCompressedTextureMipLevels: 2D CompressedTexture のみ対応しています（Cube/Array は未対応）',
    );
  }
  if (!Array.isArray(source.mipmaps) || source.mipmaps.length === 0) {
    throw new Error('createCompressedTextureMipLevels: source.mipmaps が空です');
  }

  const minDimension = options?.minDimension ?? 4;
  if (!Number.isInteger(minDimension) || minDimension < 1) {
    throw new RangeError(
      `minDimension は 1 以上の整数である必要があります: ${String(minDimension)}`,
    );
  }

  for (const [index, maxDim] of maxDimensions.entries()) {
    if (!Number.isFinite(maxDim) || maxDim <= 0) {
      throw new RangeError(
        `maxDimensions[${index}] は正の有限数である必要があります: ${String(maxDim)}`,
      );
    }
  }

  // 最小辺が `minDimension` 以上を満たす最深のミップ位置を求める（0 番目が未満なら 0 に留める）。
  let maxValidOffset = 0;
  for (let i = 0; i < source.mipmaps.length; i++) {
    const mip = source.mipmaps[i];
    if (mip !== undefined && Math.min(mip.width, mip.height) >= minDimension) {
      maxValidOffset = i;
    } else if (i > 0) {
      break;
    }
  }

  const byOffset = new Map<number, CompressedTexture>();
  const getAtOffset = (offset: number): CompressedTexture => {
    let tex = byOffset.get(offset);
    if (tex === undefined) {
      tex = sliceCompressedTexture(source, offset);
      byOffset.set(offset, tex);
    }
    return tex;
  };

  return maxDimensions.map((maxDim) => {
    let chosenOffset = maxValidOffset;
    for (let offset = 0; offset <= maxValidOffset; offset++) {
      const mip = source.mipmaps[offset];
      if (mip !== undefined && Math.max(mip.width, mip.height) <= maxDim) {
        chosenOffset = offset;
        break;
      }
    }
    return getAtOffset(chosenOffset);
  });
}
