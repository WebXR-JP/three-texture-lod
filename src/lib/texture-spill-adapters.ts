/**
 * テクスチャ種別ごとの画素・圧縮データ退避・復元アダプタ（ライブラリ内部用）。
 *
 * `three` からの値 import を行わない方針に従い、ダックタイピングと標準 Web API のみで判定・変換する。
 *
 * @packageDocumentation
 */
import type { Texture } from 'three';
import { isCompressedTexture, recordSpilledMipBytes } from './compressed-texture.js';

/** 退避アダプタ解決の結果。 */
export type AdapterResolution =
  | { readonly kind: 'supported'; readonly adapter: SpillAdapter }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'defer' };

/** テクスチャからデータを外した結果。 */
export type DetachResult =
  | {
      readonly status: 'ok';
      readonly snapshot: unknown;
      readonly bytes?: Uint8Array<ArrayBuffer>;
    }
  | { readonly status: 'invalid' }
  | { readonly status: 'error' };

/** 1件の `TextureSource` に対する退避・復元操作。 */
export interface SpillAdapter {
  /** 統計 `spilledBytes` 用の実データバイト合計（パック余白を含まない）。 */
  readonly byteLength: number;
  /** データをメインメモリから外す。`needBytes` が `true` のときだけストア用バイト列を返す。 */
  detach(needBytes: boolean): DetachResult;
  /** 書き込み中の取り消しや失敗時に、`detach` が返したスナップショットを即座に戻す。 */
  reattach(snapshot: unknown): void;
  /** `spilled` 確定時にスナップショットが持つ一時リソース（`ImageBitmap` 等）を解放する。 */
  releaseSnapshot?(snapshot: unknown): void;
  /** ストアから読んだバイト列でテクスチャを復元する。失敗時は `false`（または拒否）を返す。 */
  restore(buffer: ArrayBuffer): boolean | Promise<boolean>;
  /** 同一 `source` を共有する `Texture` を登録し、退避中なら配列等を同期する。 */
  trackTexture?(texture: Texture, isDetached: boolean): void;
}

type TypedArray =
  | Uint8Array<ArrayBuffer>
  | Uint8ClampedArray<ArrayBuffer>
  | Int8Array<ArrayBuffer>
  | Uint16Array<ArrayBuffer>
  | Int16Array<ArrayBuffer>
  | Uint32Array<ArrayBuffer>
  | Int32Array<ArrayBuffer>
  | Float32Array<ArrayBuffer>
  | Float64Array<ArrayBuffer>
  | ArrayBufferView<ArrayBuffer>;

interface TypedArrayCtor {
  readonly BYTES_PER_ELEMENT: number;
  new (buffer: ArrayBuffer, byteOffset?: number, length?: number): TypedArray;
}

interface WritableDataImage {
  data: unknown;
  readonly width: number;
  readonly height: number;
}

interface MipDescriptor {
  readonly width: number;
  readonly height: number;
  readonly depth?: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly ctor: TypedArrayCtor;
}

interface MipStub {
  readonly data: null;
  readonly width: number;
  readonly height: number;
  readonly depth?: number;
}

interface CubeFaceLike {
  mipmaps: unknown[];
}

type RasterKind =
  | 'image-data'
  | 'image-bitmap'
  | 'html-image'
  | 'html-canvas'
  | 'offscreen-canvas';

type Canvas2DContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const TYPED_ARRAY_CTORS: readonly TypedArrayCtor[] = (() => {
  const ctors: TypedArrayCtor[] = [
    Uint8Array,
    Uint8ClampedArray,
    Int8Array,
    Uint16Array,
    Int16Array,
    Uint32Array,
    Int32Array,
    Float32Array,
    Float64Array,
  ];
  // ADR: `tsconfig.build.json` の lib (ES2022) に `Float16Array` 型定義がないため、
  // `globalThis` 経由で実行時存在を確認し、存在すれば対応一覧へ追加する。
  const maybeFloat16 = (globalThis as { readonly Float16Array?: unknown }).Float16Array;
  if (typeof maybeFloat16 === 'function') {
    ctors.push(maybeFloat16 as TypedArrayCtor);
  }
  return ctors;
})();

function alignUp(offset: number, alignment: number): number {
  const rem = offset % alignment;
  return rem === 0 ? offset : offset + (alignment - rem);
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function typedArrayConstructorOf(value: unknown): TypedArrayCtor | null {
  if (!ArrayBuffer.isView(value) || value instanceof DataView) {
    return null;
  }
  if (!(value.buffer instanceof ArrayBuffer)) {
    return null;
  }
  for (const ctor of TYPED_ARRAY_CTORS) {
    if (value instanceof ctor) {
      return ctor;
    }
  }
  return null;
}

function asByteView(view: TypedArray): Uint8Array<ArrayBuffer> {
  if (
    view instanceof Uint8Array &&
    view.buffer instanceof ArrayBuffer &&
    view.byteOffset === 0 &&
    view.byteLength === view.buffer.byteLength
  ) {
    // ADR: `instanceof Uint8Array` により TS は `ArrayBufferLike` に広げるが、
    // 直前で `view.buffer instanceof ArrayBuffer` を検査済みのため安全。
    return view as Uint8Array<ArrayBuffer>;
  }
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function isWritableProperty(target: object, property: string): boolean {
  let current: object | null = target;
  while (current !== null) {
    const desc = Object.getOwnPropertyDescriptor(current, property);
    if (desc !== undefined) {
      return 'value' in desc ? desc.writable === true : typeof desc.set === 'function';
    }
    current = Object.getPrototypeOf(current);
  }
  return true;
}

function isSpecialUnsupportedTexture(texture: Texture): boolean {
  const flags = texture as unknown as {
    isRenderTargetTexture?: unknown;
    isDepthTexture?: unknown;
    isStorageTexture?: unknown;
    isExternalTexture?: unknown;
    isVideoTexture?: unknown;
    isHTMLTexture?: unknown;
    isCubeTexture?: unknown;
  };
  if (
    flags.isRenderTargetTexture === true ||
    flags.isDepthTexture === true ||
    flags.isStorageTexture === true ||
    flags.isExternalTexture === true ||
    flags.isVideoTexture === true ||
    flags.isHTMLTexture === true
  ) {
    return true;
  }
  // 非圧縮 CubeTexture（6枚の外部画像等）は対象外とする。
  return flags.isCubeTexture === true && !isCompressedTexture(texture);
}

/** ミップ配列を検査して記述子列とスタブ配列を作る。無効要素があれば `null` を返す。 */
function buildMipPlan(
  mipmaps: readonly unknown[],
  startOffset: number,
): {
  readonly descs: MipDescriptor[];
  readonly stubs: MipStub[];
  readonly byteLength: number;
  readonly endOffset: number;
} | null {
  if (mipmaps.length === 0) {
    return null;
  }
  const descs: MipDescriptor[] = [];
  const stubs: MipStub[] = [];
  let offset = startOffset;
  let byteLength = 0;
  for (const raw of mipmaps) {
    if (typeof raw !== 'object' || raw === null) {
      return null;
    }
    const mip = raw as { width?: unknown; height?: unknown; depth?: unknown; data?: unknown };
    if (!isPositiveFinite(mip.width) || !isPositiveFinite(mip.height)) {
      return null;
    }
    const ctor = typedArrayConstructorOf(mip.data);
    if (ctor === null) {
      return null;
    }
    const typed = mip.data as TypedArray;
    if (typed.byteLength <= 0) {
      return null;
    }
    offset = alignUp(offset, ctor.BYTES_PER_ELEMENT);
    const depth = isPositiveFinite(mip.depth) ? mip.depth : undefined;
    descs.push({
      width: mip.width,
      height: mip.height,
      ...(depth !== undefined ? { depth } : {}),
      byteOffset: offset,
      byteLength: typed.byteLength,
      ctor,
    });
    const stub: MipStub = {
      data: null,
      width: mip.width,
      height: mip.height,
      ...(depth !== undefined ? { depth } : {}),
    };
    recordSpilledMipBytes(stub, typed.byteLength);
    stubs.push(stub);
    offset += typed.byteLength;
    byteLength += typed.byteLength;
  }
  return { descs, stubs, byteLength, endOffset: offset };
}

/**
 * 2D/Array `CompressedTexture` およびミップ付き `DataTexture` 用アダプタ。
 *
 * ADR: `sliceCompressedTexture` は複数レベル間で `CompressedTextureMipmap` オブジェクトを共有する。
 * 既存のミップオブジェクトの `data` を書き換えず、`texture.mipmaps` 配列ごとスタブ配列へ差し替えることで、
 * 他のピン留め中レベルが参照するミップデータを破壊しない。
 */
class MipmapListAdapter implements SpillAdapter {
  readonly byteLength: number;
  private readonly primary: Texture;
  private readonly source: Texture['source'];
  private readonly descs: readonly MipDescriptor[];
  private readonly stubs: readonly MipStub[];
  private readonly packedByteLength: number;
  private readonly syncImageData: WritableDataImage | null;
  private readonly textures = new Set<Texture>();

  constructor(
    primary: Texture,
    descs: readonly MipDescriptor[],
    stubs: readonly MipStub[],
    byteLength: number,
    packedByteLength: number,
    syncImageData: WritableDataImage | null,
  ) {
    this.primary = primary;
    this.source = primary.source;
    this.descs = descs;
    this.stubs = stubs;
    this.byteLength = byteLength;
    this.packedByteLength = packedByteLength;
    this.syncImageData = syncImageData;
    this.textures.add(primary);
  }

  trackTexture(texture: Texture, isDetached: boolean): void {
    this.textures.add(texture);
    if (isDetached) {
      (texture as unknown as { mipmaps: MipStub[] }).mipmaps = this.stubs.slice();
    }
  }

  detach(needBytes: boolean): DetachResult {
    const rawMips = this.primary.mipmaps as unknown;
    if (!Array.isArray(rawMips) || rawMips.length !== this.descs.length) {
      return { status: 'invalid' };
    }
    const views: TypedArray[] = [];
    for (let i = 0; i < this.descs.length; i++) {
      const desc = this.descs[i];
      const mip = rawMips[i] as { data?: unknown } | null | undefined;
      const data = mip?.data;
      if (
        !(data instanceof desc.ctor) ||
        !(data.buffer instanceof ArrayBuffer) ||
        data.byteLength !== desc.byteLength
      ) {
        return { status: 'invalid' };
      }
      views.push(data);
    }
    const previousImageData = this.syncImageData !== null ? this.syncImageData.data : undefined;
    if (this.syncImageData !== null && previousImageData !== views[0]) {
      return { status: 'invalid' };
    }
    let bytes: Uint8Array<ArrayBuffer> | undefined;
    if (needBytes) {
      if (views.length === 1) {
        bytes = asByteView(views[0]);
      } else {
        const packed = new Uint8Array(this.packedByteLength);
        for (let i = 0; i < views.length; i++) {
          packed.set(asByteView(views[i]), this.descs[i].byteOffset);
        }
        bytes = packed;
      }
    }
    const mipmapsByTexture = new Map<Texture, unknown[]>();
    for (const tex of this.textures) {
      mipmapsByTexture.set(tex, (tex.mipmaps as unknown[]).slice());
      (tex as unknown as { mipmaps: MipStub[] }).mipmaps = this.stubs.slice();
    }
    if (this.syncImageData !== null) {
      this.syncImageData.data = null;
    }
    return {
      status: 'ok',
      snapshot: { mipmapsByTexture, previousImageData },
      ...(bytes !== undefined ? { bytes } : {}),
    };
  }

  reattach(snapshot: unknown): void {
    const saved = snapshot as {
      readonly mipmapsByTexture: Map<Texture, unknown[]>;
      readonly previousImageData: unknown;
    };
    for (const [tex, mipmaps] of saved.mipmapsByTexture) {
      (tex as unknown as { mipmaps: unknown[] }).mipmaps = mipmaps;
    }
    if (this.syncImageData !== null) {
      this.syncImageData.data = saved.previousImageData;
    }
  }

  restore(buffer: ArrayBuffer): boolean {
    if (buffer.byteLength !== this.packedByteLength) {
      return false;
    }
    const restored = this.descs.map((desc) => ({
      data: new desc.ctor(buffer, desc.byteOffset, desc.byteLength / desc.ctor.BYTES_PER_ELEMENT),
      width: desc.width,
      height: desc.height,
      ...(desc.depth !== undefined ? { depth: desc.depth } : {}),
    }));
    for (const tex of this.textures) {
      (tex as unknown as { mipmaps: unknown[] }).mipmaps = restored.slice();
      tex.needsUpdate = true;
    }
    if (this.syncImageData !== null) {
      this.syncImageData.data = restored[0].data;
    }
    this.source.needsUpdate = true;
    return true;
  }
}

/**
 * `CompressedCubeTexture` 用アダプタ。全6面のミップを1エントリにまとめて退避・復元する。
 */
class CompressedCubeAdapter implements SpillAdapter {
  readonly byteLength: number;
  private readonly source: Texture['source'];
  private readonly faces: readonly CubeFaceLike[];
  private readonly faceDescs: readonly (readonly MipDescriptor[])[];
  private readonly faceStubs: readonly (readonly MipStub[])[];
  private readonly packedByteLength: number;
  private readonly textures = new Set<Texture>();

  constructor(
    primary: Texture,
    faces: readonly CubeFaceLike[],
    faceDescs: readonly (readonly MipDescriptor[])[],
    faceStubs: readonly (readonly MipStub[])[],
    byteLength: number,
    packedByteLength: number,
  ) {
    this.source = primary.source;
    this.faces = faces;
    this.faceDescs = faceDescs;
    this.faceStubs = faceStubs;
    this.byteLength = byteLength;
    this.packedByteLength = packedByteLength;
    this.textures.add(primary);
  }

  trackTexture(texture: Texture): void {
    this.textures.add(texture);
  }

  detach(needBytes: boolean): DetachResult {
    const faceViews: TypedArray[][] = [];
    for (let f = 0; f < this.faces.length; f++) {
      const face = this.faces[f];
      const descs = this.faceDescs[f];
      if (!Array.isArray(face.mipmaps) || face.mipmaps.length !== descs.length) {
        return { status: 'invalid' };
      }
      const views: TypedArray[] = [];
      for (let m = 0; m < descs.length; m++) {
        const desc = descs[m];
        const mip = face.mipmaps[m] as { data?: unknown } | null | undefined;
        const data = mip?.data;
        if (
          !(data instanceof desc.ctor) ||
          !(data.buffer instanceof ArrayBuffer) ||
          data.byteLength !== desc.byteLength
        ) {
          return { status: 'invalid' };
        }
        views.push(data);
      }
      faceViews.push(views);
    }
    let bytes: Uint8Array<ArrayBuffer> | undefined;
    if (needBytes) {
      const packed = new Uint8Array(this.packedByteLength);
      for (let f = 0; f < faceViews.length; f++) {
        const views = faceViews[f];
        const descs = this.faceDescs[f];
        for (let m = 0; m < views.length; m++) {
          packed.set(asByteView(views[m]), descs[m].byteOffset);
        }
      }
      bytes = packed;
    }
    const previousFaces = this.faces.map((face) => face.mipmaps);
    for (let f = 0; f < this.faces.length; f++) {
      this.faces[f].mipmaps = this.faceStubs[f].slice();
    }
    return {
      status: 'ok',
      snapshot: previousFaces,
      ...(bytes !== undefined ? { bytes } : {}),
    };
  }

  reattach(snapshot: unknown): void {
    const previousFaces = snapshot as readonly unknown[][];
    for (let f = 0; f < this.faces.length; f++) {
      this.faces[f].mipmaps = previousFaces[f];
    }
  }

  restore(buffer: ArrayBuffer): boolean {
    if (buffer.byteLength !== this.packedByteLength) {
      return false;
    }
    for (let f = 0; f < this.faces.length; f++) {
      this.faces[f].mipmaps = this.faceDescs[f].map((desc) => ({
        data: new desc.ctor(buffer, desc.byteOffset, desc.byteLength / desc.ctor.BYTES_PER_ELEMENT),
        width: desc.width,
        height: desc.height,
        ...(desc.depth !== undefined ? { depth: desc.depth } : {}),
      }));
    }
    for (const tex of this.textures) {
      tex.needsUpdate = true;
    }
    this.source.needsUpdate = true;
    return true;
  }
}

/**
 * `DataTexture` 等、`{ data: TypedArray, width, height }` を持つ画像用アダプタ。
 *
 * `Uint8Array` に加え `Float32Array`（GLSL 用パラメータテクスチャ等）・`Uint16Array` 等も扱う。
 */
class DataImageAdapter implements SpillAdapter {
  readonly byteLength: number;
  private readonly source: Texture['source'];
  private readonly image: WritableDataImage;
  private readonly ctor: TypedArrayCtor;
  private readonly textures = new Set<Texture>();

  constructor(
    primary: Texture,
    image: WritableDataImage,
    ctor: TypedArrayCtor,
    byteLength: number,
  ) {
    this.source = primary.source;
    this.image = image;
    this.ctor = ctor;
    this.byteLength = byteLength;
    this.textures.add(primary);
  }

  trackTexture(texture: Texture): void {
    this.textures.add(texture);
  }

  detach(needBytes: boolean): DetachResult {
    const data = this.image.data;
    // ADR: 登録時に確認済みだが、利用者が別の型や長さへ差し替えた場合は以後退避しない。
    if (
      !(data instanceof this.ctor) ||
      !(data.buffer instanceof ArrayBuffer) ||
      data.byteLength !== this.byteLength
    ) {
      return { status: 'invalid' };
    }
    const bytes = needBytes ? asByteView(data) : undefined;
    this.image.data = null;
    return {
      status: 'ok',
      snapshot: data,
      ...(bytes !== undefined ? { bytes } : {}),
    };
  }

  reattach(snapshot: unknown): void {
    this.image.data = snapshot;
  }

  restore(buffer: ArrayBuffer): boolean {
    if (buffer.byteLength !== this.byteLength) {
      return false;
    }
    this.image.data = new this.ctor(buffer);
    for (const tex of this.textures) {
      tex.needsUpdate = true;
    }
    this.source.needsUpdate = true;
    return true;
  }
}

function getCanvas2dContext(
  canvas: HTMLCanvasElement | OffscreenCanvas,
): Canvas2DContext | null {
  return canvas.getContext('2d') as Canvas2DContext | null;
}

function createTemp2dCanvas(
  width: number,
  height: number,
): { readonly canvas: HTMLCanvasElement | OffscreenCanvas; readonly ctx: Canvas2DContext } | null {
  if (typeof OffscreenCanvas !== 'undefined') {
    const offscreen = new OffscreenCanvas(width, height);
    const ctx = getCanvas2dContext(offscreen);
    if (ctx !== null) {
      return { canvas: offscreen, ctx };
    }
  }
  if (typeof document !== 'undefined') {
    const el = document.createElement('canvas');
    el.width = width;
    el.height = height;
    const ctx = getCanvas2dContext(el);
    if (ctx !== null) {
      return { canvas: el, ctx };
    }
  }
  return null;
}

function createRestoreCanvas(
  preferHtmlCanvas: boolean,
  width: number,
  height: number,
): { readonly canvas: HTMLCanvasElement | OffscreenCanvas; readonly ctx: Canvas2DContext } | null {
  if (preferHtmlCanvas && typeof document !== 'undefined') {
    const el = document.createElement('canvas');
    el.width = width;
    el.height = height;
    const ctx = getCanvas2dContext(el);
    if (ctx !== null) {
      return { canvas: el, ctx };
    }
  }
  if (typeof OffscreenCanvas !== 'undefined') {
    const offscreen = new OffscreenCanvas(width, height);
    const ctx = getCanvas2dContext(offscreen);
    if (ctx !== null) {
      return { canvas: offscreen, ctx };
    }
  }
  if (!preferHtmlCanvas && typeof document !== 'undefined') {
    const el = document.createElement('canvas');
    el.width = width;
    el.height = height;
    const ctx = getCanvas2dContext(el);
    if (ctx !== null) {
      return { canvas: el, ctx };
    }
  }
  return null;
}

function canCreate2dCanvas(): boolean {
  const probe = createTemp2dCanvas(1, 1);
  if (probe === null) {
    return false;
  }
  probe.canvas.width = 0;
  probe.canvas.height = 0;
  return true;
}

/**
 * `ImageBitmap` / `HTMLImageElement` / `HTMLCanvasElement` / `OffscreenCanvas` / `ImageData` 用アダプタ。
 *
 * 退避中は `source.data` を `{ width, height }` へ差し替えることで、`estimateTextureBytes` と
 * `texture.width` / `texture.height` の算出値を維持する。
 */
class RasterImageAdapter implements SpillAdapter {
  readonly byteLength: number;
  private readonly source: Texture['source'];
  private readonly kind: RasterKind;
  private readonly width: number;
  private readonly height: number;
  private readonly placeholder: { readonly width: number; readonly height: number };
  private readonly textures = new Set<Texture>();

  constructor(primary: Texture, kind: RasterKind, width: number, height: number) {
    this.source = primary.source;
    this.kind = kind;
    this.width = width;
    this.height = height;
    this.byteLength = width * height * 4;
    this.placeholder = { width, height };
    this.textures.add(primary);
  }

  trackTexture(texture: Texture): void {
    this.textures.add(texture);
  }

  detach(needBytes: boolean): DetachResult {
    const current: unknown = this.source.data;
    if (!this.matchesCurrent(current)) {
      return { status: 'invalid' };
    }
    let bytes: Uint8Array<ArrayBuffer> | undefined;
    if (needBytes) {
      try {
        bytes = this.extractRgbaBytes(current);
      } catch {
        return { status: 'error' };
      }
      if (bytes === undefined || bytes.byteLength !== this.byteLength) {
        return { status: 'error' };
      }
    }
    this.source.data = this.placeholder;
    return {
      status: 'ok',
      snapshot: current,
      ...(bytes !== undefined ? { bytes } : {}),
    };
  }

  reattach(snapshot: unknown): void {
    this.source.data = snapshot;
  }

  releaseSnapshot(snapshot: unknown): void {
    // ADR: `ImageBitmap.close()` はストア書き込み完了後（または再退避時）にだけ呼ぶ。
    // 書き込み中の同期復元や失敗ロールバック時に閉じた ImageBitmap を戻さないためである。
    if (
      this.kind === 'image-bitmap' &&
      typeof ImageBitmap !== 'undefined' &&
      snapshot instanceof ImageBitmap
    ) {
      snapshot.close();
    }
  }

  async restore(buffer: ArrayBuffer): Promise<boolean> {
    if (buffer.byteLength !== this.byteLength || typeof ImageData === 'undefined') {
      return false;
    }
    const imageData = new ImageData(new Uint8ClampedArray(buffer), this.width, this.height);
    if (this.kind === 'image-data') {
      this.source.data = imageData;
    } else if (this.kind === 'image-bitmap') {
      if (typeof createImageBitmap !== 'function') {
        return false;
      }
      // ADR: three.js は ImageBitmap の flipY / premultiplyAlpha をアップロード時に無視するため、
      // 読み込み時と同じ非変換設定で再生成する。
      this.source.data = await createImageBitmap(imageData, {
        premultiplyAlpha: 'none',
        colorSpaceConversion: 'none',
      });
    } else {
      // ADR: HTMLImageElement は ImageBitmap へ戻すと classic WebGLRenderer が flipY を無視して
      // 上下反転するため、HTMLCanvasElement（非DOM環境では OffscreenCanvas）で復元する。
      const preferHtml = this.kind !== 'offscreen-canvas';
      const created = createRestoreCanvas(preferHtml, this.width, this.height);
      if (created === null) {
        return false;
      }
      created.ctx.putImageData(imageData, 0, 0);
      this.source.data = created.canvas;
    }
    for (const tex of this.textures) {
      tex.needsUpdate = true;
    }
    this.source.needsUpdate = true;
    return true;
  }

  private matchesCurrent(current: unknown): boolean {
    if (current === null || typeof current !== 'object') {
      return false;
    }
    switch (this.kind) {
      case 'image-data':
        return (
          typeof ImageData !== 'undefined' &&
          current instanceof ImageData &&
          current.width === this.width &&
          current.height === this.height
        );
      case 'image-bitmap':
        return (
          typeof ImageBitmap !== 'undefined' &&
          current instanceof ImageBitmap &&
          current.width === this.width &&
          current.height === this.height
        );
      case 'html-image':
        return (
          typeof HTMLImageElement !== 'undefined' &&
          current instanceof HTMLImageElement &&
          current.complete &&
          (current.naturalWidth || current.width) === this.width &&
          (current.naturalHeight || current.height) === this.height
        );
      case 'html-canvas':
        return (
          typeof HTMLCanvasElement !== 'undefined' &&
          current instanceof HTMLCanvasElement &&
          current.width === this.width &&
          current.height === this.height
        );
      case 'offscreen-canvas':
        return (
          typeof OffscreenCanvas !== 'undefined' &&
          current instanceof OffscreenCanvas &&
          current.width === this.width &&
          current.height === this.height
        );
    }
  }

  private extractRgbaBytes(current: unknown): Uint8Array<ArrayBuffer> | undefined {
    if (this.kind === 'image-data') {
      const data = (current as ImageData).data;
      return data.buffer instanceof ArrayBuffer
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
    }
    if (this.kind === 'html-canvas' || this.kind === 'offscreen-canvas') {
      const directCtx = getCanvas2dContext(current as HTMLCanvasElement | OffscreenCanvas);
      if (directCtx !== null) {
        const imageData = directCtx.getImageData(0, 0, this.width, this.height);
        return imageData.data.buffer instanceof ArrayBuffer
          ? new Uint8Array(
              imageData.data.buffer,
              imageData.data.byteOffset,
              imageData.data.byteLength,
            )
          : new Uint8Array(imageData.data);
      }
    }
    const temp = createTemp2dCanvas(this.width, this.height);
    if (temp === null) {
      return undefined;
    }
    try {
      temp.ctx.globalCompositeOperation = 'copy';
      temp.ctx.drawImage(current as CanvasImageSource, 0, 0);
      const imageData = temp.ctx.getImageData(0, 0, this.width, this.height);
      return imageData.data.buffer instanceof ArrayBuffer
        ? new Uint8Array(
            imageData.data.buffer,
            imageData.data.byteOffset,
            imageData.data.byteLength,
          )
        : new Uint8Array(imageData.data);
    } finally {
      temp.canvas.width = 0;
      temp.canvas.height = 0;
    }
  }
}

function resolveRasterAdapter(texture: Texture): AdapterResolution {
  const data: unknown = texture.source.data;
  if (typeof data !== 'object' || data === null) {
    return { kind: 'unsupported' };
  }
  if (typeof ImageData !== 'undefined' && data instanceof ImageData) {
    if (!isPositiveFinite(data.width) || !isPositiveFinite(data.height)) {
      return { kind: 'unsupported' };
    }
    return {
      kind: 'supported',
      adapter: new RasterImageAdapter(texture, 'image-data', data.width, data.height),
    };
  }
  if (typeof ImageBitmap !== 'undefined' && data instanceof ImageBitmap) {
    if (
      !isPositiveFinite(data.width) ||
      !isPositiveFinite(data.height) ||
      typeof createImageBitmap !== 'function' ||
      typeof ImageData === 'undefined' ||
      !canCreate2dCanvas()
    ) {
      return { kind: 'unsupported' };
    }
    return {
      kind: 'supported',
      adapter: new RasterImageAdapter(texture, 'image-bitmap', data.width, data.height),
    };
  }
  if (typeof HTMLImageElement !== 'undefined' && data instanceof HTMLImageElement) {
    if (!data.complete) {
      return { kind: 'defer' };
    }
    const width = data.naturalWidth || data.width;
    const height = data.naturalHeight || data.height;
    if (
      !isPositiveFinite(width) ||
      !isPositiveFinite(height) ||
      typeof ImageData === 'undefined' ||
      !canCreate2dCanvas()
    ) {
      return { kind: 'unsupported' };
    }
    return {
      kind: 'supported',
      adapter: new RasterImageAdapter(texture, 'html-image', width, height),
    };
  }
  if (typeof HTMLCanvasElement !== 'undefined' && data instanceof HTMLCanvasElement) {
    if (
      !isPositiveFinite(data.width) ||
      !isPositiveFinite(data.height) ||
      typeof ImageData === 'undefined' ||
      !canCreate2dCanvas()
    ) {
      return { kind: 'unsupported' };
    }
    return {
      kind: 'supported',
      adapter: new RasterImageAdapter(texture, 'html-canvas', data.width, data.height),
    };
  }
  if (typeof OffscreenCanvas !== 'undefined' && data instanceof OffscreenCanvas) {
    if (
      !isPositiveFinite(data.width) ||
      !isPositiveFinite(data.height) ||
      typeof ImageData === 'undefined' ||
      !canCreate2dCanvas()
    ) {
      return { kind: 'unsupported' };
    }
    return {
      kind: 'supported',
      adapter: new RasterImageAdapter(texture, 'offscreen-canvas', data.width, data.height),
    };
  }
  return { kind: 'unsupported' };
}

function resolveDataImageAdapter(texture: Texture): AdapterResolution {
  const image: unknown = texture.source.data;
  if (typeof image !== 'object' || image === null) {
    return { kind: 'unsupported' };
  }
  if (!('data' in image) || !('width' in image) || !('height' in image)) {
    return { kind: 'unsupported' };
  }
  const { data, width, height } = image as {
    data: unknown;
    width: unknown;
    height: unknown;
  };
  if (!isPositiveFinite(width) || !isPositiveFinite(height)) {
    return { kind: 'unsupported' };
  }
  if (!isWritableProperty(image, 'data')) {
    return { kind: 'unsupported' };
  }
  const ctor = typedArrayConstructorOf(data);
  if (ctor === null) {
    return { kind: 'unsupported' };
  }
  const typed = data as TypedArray;
  if (typed.byteLength <= 0) {
    return { kind: 'unsupported' };
  }
  // ADR: 直前で `data` の型・`width`・`height`・書き込み可能性を検証済み。
  return {
    kind: 'supported',
    adapter: new DataImageAdapter(
      texture,
      image as WritableDataImage,
      ctor,
      typed.byteLength,
    ),
  };
}

/**
 * テクスチャの構造を検査し、対応する退避・復元アダプタを生成する。
 */
export function createSpillAdapter(texture: Texture): AdapterResolution {
  if (isSpecialUnsupportedTexture(texture)) {
    return { kind: 'unsupported' };
  }

  const flags = texture as unknown as {
    isCompressedCubeTexture?: unknown;
    isDataTexture?: unknown;
  };

  if (isCompressedTexture(texture) && flags.isCompressedCubeTexture === true) {
    const rawFaces: unknown = texture.source.data;
    if (!Array.isArray(rawFaces) || rawFaces.length === 0) {
      return { kind: 'unsupported' };
    }
    const faces: CubeFaceLike[] = [];
    const faceDescs: MipDescriptor[][] = [];
    const faceStubs: MipStub[][] = [];
    let offset = 0;
    let totalByteLength = 0;
    for (const rawFace of rawFaces) {
      if (typeof rawFace !== 'object' || rawFace === null) {
        return { kind: 'unsupported' };
      }
      const faceMips = (rawFace as { mipmaps?: unknown }).mipmaps;
      if (!Array.isArray(faceMips)) {
        return { kind: 'unsupported' };
      }
      const plan = buildMipPlan(faceMips, offset);
      if (plan === null) {
        return { kind: 'unsupported' };
      }
      faces.push(rawFace as CubeFaceLike);
      faceDescs.push(plan.descs);
      faceStubs.push(plan.stubs);
      offset = plan.endOffset;
      totalByteLength += plan.byteLength;
    }
    return {
      kind: 'supported',
      adapter: new CompressedCubeAdapter(
        texture,
        faces,
        faceDescs,
        faceStubs,
        totalByteLength,
        offset,
      ),
    };
  }

  const hasMipmaps = Array.isArray(texture.mipmaps) && texture.mipmaps.length > 0;
  if (isCompressedTexture(texture) || (flags.isDataTexture === true && hasMipmaps)) {
    if (!hasMipmaps) {
      return { kind: 'unsupported' };
    }
    const plan = buildMipPlan(texture.mipmaps, 0);
    if (plan === null) {
      return { kind: 'unsupported' };
    }
    let syncImageData: WritableDataImage | null = null;
    if (flags.isDataTexture === true) {
      const img: unknown = texture.source.data;
      if (
        typeof img === 'object' &&
        img !== null &&
        'data' in img &&
        isWritableProperty(img, 'data') &&
        (img as { data: unknown }).data === (texture.mipmaps[0] as { data?: unknown }).data
      ) {
        syncImageData = img as WritableDataImage;
      }
    }
    return {
      kind: 'supported',
      adapter: new MipmapListAdapter(
        texture,
        plan.descs,
        plan.stubs,
        plan.byteLength,
        plan.endOffset,
        syncImageData,
      ),
    };
  }

  if (hasMipmaps) {
    // 手動ミップを持つ通常の Texture 等は対象外。
    return { kind: 'unsupported' };
  }

  // `ImageData` は `data` が読み取り専用ゲッターのため、データ画像より先に判定する。
  const raster = resolveRasterAdapter(texture);
  if (raster.kind !== 'unsupported') {
    return raster;
  }

  return resolveDataImageAdapter(texture);
}
