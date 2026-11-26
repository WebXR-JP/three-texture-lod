/**
 * TextureSpillCache と、それを使う TextureLodManager の仕様固定テスト。
 *
 * キャッシュ単体では、退避・読み戻しの状態遷移、書き込み済み内容の再利用、失敗時の扱い、
 * 対象外の画像と共有 Source を確かめる。加えて、`DataTexture`（各 TypedArray・ミップ付き）、
 * `CompressedTexture`（2D / Array / Cube・共有ミップ非破壊・`estimateTextureBytes` 維持）、
 * `ImageBitmap`・`HTMLImageElement`・`HTMLCanvasElement`・`OffscreenCanvas`・`ImageData` の
 * 退避・復元契約を確かめる。
 * マネージャ連携では、破棄に連動した退避と、読み戻しが済むまで現在のレベルを保つこと、
 * 圧縮テクスチャの予算適応と組み合わせても予測が壊れないことを確かめる。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CanvasTexture,
  CompressedArrayTexture,
  CompressedCubeTexture,
  CompressedTexture,
  DataTexture,
  FloatType,
  HalfFloatType,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  RGBAFormat,
  RGBA_BPTC_Format,
  Texture,
  UnsignedByteType,
  type CompressedTextureMipmap,
} from 'three';
import {
  createCompressedTextureMipLevels,
  estimateTextureBytes,
} from './compressed-texture.js';
import { createTextureLodSet } from './texture-lod-set.js';
import { TextureLodManager } from './texture-lod-manager.js';
import { TextureSpillCache } from './texture-spill-cache.js';
import type { TexturePixelStore } from './texture-spill-cache.js';
import type { TextureLodLevel } from './types.js';

interface PendingJob {
  readonly kind: 'write' | 'read';
  readonly key: string;
  readonly run: (fail: boolean) => void;
}

/** 完了を手動で進めるメモリ上のストア。 */
class ManualPixelStore implements TexturePixelStore {
  readonly files = new Map<string, Uint8Array>();
  writeCount = 0;
  readCount = 0;
  private readonly jobs: PendingJob[] = [];

  write(key: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    this.writeCount++;
    return new Promise((resolve, reject) => {
      this.jobs.push({
        kind: 'write',
        key,
        run: (fail) => {
          if (fail) {
            reject(new Error('write failed'));
            return;
          }
          this.files.set(key, bytes.slice());
          resolve();
        },
      });
    });
  }

  read(key: string): Promise<ArrayBuffer> {
    this.readCount++;
    return new Promise((resolve, reject) => {
      this.jobs.push({
        kind: 'read',
        key,
        run: (fail) => {
          const file = this.files.get(key);
          if (fail || file === undefined) {
            reject(new Error('read failed'));
            return;
          }
          resolve(file.slice().buffer);
        },
      });
    });
  }

  /** 保留中の処理数。 */
  get pendingCount(): number {
    return this.jobs.length;
  }

  /**
   * 条件に合う保留中の処理を完了させ、完了通知の処理が終わるまで待つ。
   *
   * @param options - `kind`・`key` で対象を絞る。`fail` が `true` なら失敗として完了させる。
   */
  async settle(options?: { kind?: 'write' | 'read'; key?: string; fail?: boolean }): Promise<void> {
    const remaining: PendingJob[] = [];
    const targets: PendingJob[] = [];
    for (const job of this.jobs.splice(0)) {
      const matches =
        (options?.kind === undefined || job.kind === options.kind) &&
        (options?.key === undefined || job.key === options.key);
      (matches ? targets : remaining).push(job);
    }
    this.jobs.push(...remaining);
    for (const job of targets) {
      job.run(options?.fail === true);
    }
    // 完了通知（`then` のコールバック）はマイクロタスクで走るため、マクロタスク1回分待つ。
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** 一辺 size の正方形 DataTexture を、位置で決まる画素値で作る。 */
function dataTexture(size: number): DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < data.length; i++) {
    data[i] = (i * 7 + size) % 256;
  }
  return new DataTexture(data, size, size);
}

/** テクスチャの画素データ。退避中は `null`。 */
function pixels(texture: Texture): Uint8Array | null {
  return (texture.image as { data: Uint8Array | null }).data;
}

/** 複数ミップを持つ 2D `CompressedTexture` を作る。 */
function compressedMipTexture(
  baseWidth: number,
  baseHeight = baseWidth,
  minSize = 4,
  useUint16 = false,
): CompressedTexture {
  const mipmaps: CompressedTextureMipmap[] = [];
  let w = baseWidth;
  let h = baseHeight;
  let seed = 1;
  while (true) {
    const blocksW = Math.max(1, Math.ceil(w / 4));
    const blocksH = Math.max(1, Math.ceil(h / 4));
    if (useUint16) {
      const data = new Uint16Array(blocksW * blocksH * 8);
      for (let i = 0; i < data.length; i++) {
        data[i] = (i * 17 + seed * 31) % 65535;
      }
      mipmaps.push({ data: data as unknown as Uint8Array, width: w, height: h });
    } else {
      const data = new Uint8Array(blocksW * blocksH * 16);
      for (let i = 0; i < data.length; i++) {
        data[i] = (i * 13 + seed * 29) % 256;
      }
      mipmaps.push({ data, width: w, height: h });
    }
    seed++;
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
    useUint16 ? HalfFloatType : UnsignedByteType,
  );
  tex.needsUpdate = true;
  return tex;
}

/** 決定的な RGBA8 画素列を作る。 */
function patternRgba(width: number, height: number, seed = 3): Uint8ClampedArray<ArrayBuffer> {
  const buf = new ArrayBuffer(width * height * 4);
  const data = new Uint8ClampedArray(buf);
  for (let i = 0; i < data.length; i++) {
    data[i] = (i * 11 + seed * 19) % 256;
  }
  return data;
}

/**
 * Node テスト用にブラウザの Raster 画像・Canvas API を最小実装で注入する。
 * CORS 汚染シミュレーションと `ImageBitmap.close()` 追跡を備える。
 */
function installRasterGlobals(options?: {
  taintedImage?: boolean;
  failCreateImageBitmap?: boolean;
  omitDocument?: boolean;
}) {
  class FakeImageData {
    private readonly raw: Uint8ClampedArray<ArrayBuffer>;
    readonly width: number;
    readonly height: number;
    constructor(dataOrWidth: Uint8ClampedArray<ArrayBuffer> | number, w: number, h?: number) {
      if (typeof dataOrWidth === 'number') {
        this.width = dataOrWidth;
        this.height = w;
        this.raw = new Uint8ClampedArray(new ArrayBuffer(dataOrWidth * w * 4));
      } else {
        this.raw = new Uint8ClampedArray(
          dataOrWidth.buffer.slice(dataOrWidth.byteOffset, dataOrWidth.byteOffset + dataOrWidth.byteLength),
        );
        this.width = w;
        this.height = h ?? Math.floor(this.raw.byteLength / (w * 4));
      }
    }
    get data(): Uint8ClampedArray<ArrayBuffer> {
      return this.raw;
    }
  }

  class FakeImageBitmap {
    width: number;
    height: number;
    readonly pixels: Uint8ClampedArray<ArrayBuffer>;
    closed = false;
    closeCount = 0;
    constructor(pixelsData: Uint8ClampedArray<ArrayBuffer>, width: number, height: number) {
      this.pixels = new Uint8ClampedArray(pixelsData.slice());
      this.width = width;
      this.height = height;
    }
    close(): void {
      this.closed = true;
      this.closeCount++;
      this.width = 0;
      this.height = 0;
    }
  }

  class FakeHTMLImageElement {
    width: number;
    height: number;
    naturalWidth: number;
    naturalHeight: number;
    complete: boolean;
    readonly pixels: Uint8ClampedArray<ArrayBuffer>;
    readonly tainted: boolean;
    constructor(
      pixelsData: Uint8ClampedArray<ArrayBuffer>,
      width: number,
      height: number,
      complete = true,
      tainted = options?.taintedImage === true,
    ) {
      this.pixels = new Uint8ClampedArray(pixelsData.slice());
      this.width = width;
      this.height = height;
      this.naturalWidth = complete ? width : 0;
      this.naturalHeight = complete ? height : 0;
      this.complete = complete;
      this.tainted = tainted;
    }
  }

  class Fake2DContext {
    globalCompositeOperation = 'source-over';
    private tainted = false;
    constructor(private readonly owner: { width: number; height: number; buffer: Uint8ClampedArray<ArrayBuffer> }) {}

    drawImage(source: unknown, _x: number, _y: number): void {
      if (source instanceof FakeImageBitmap) {
        if (source.closed) {
          throw new Error('ImageBitmap is closed');
        }
        this.owner.buffer.set(source.pixels);
      } else if (source instanceof FakeHTMLImageElement) {
        if (source.tainted) {
          this.tainted = true;
          return;
        }
        this.owner.buffer.set(source.pixels);
      } else if (source instanceof FakeHTMLCanvasElement || source instanceof FakeOffscreenCanvas) {
        this.owner.buffer.set(source.buffer);
      }
    }

    getImageData(_x: number, _y: number, w: number, h: number): FakeImageData {
      if (this.tainted) {
        throw new DOMException('Tainted canvases may not be exported.', 'SecurityError');
      }
      return new FakeImageData(this.owner.buffer.slice(0, w * h * 4), w, h);
    }

    putImageData(imageData: FakeImageData, _x: number, _y: number): void {
      this.owner.buffer.set(imageData.data);
    }
  }

  class FakeCanvasBase {
    private _width = 0;
    private _height = 0;
    buffer = new Uint8ClampedArray(new ArrayBuffer(0));
    private ctx2d: Fake2DContext | null = null;
    constructor(width = 0, height = 0, initial?: Uint8ClampedArray<ArrayBuffer>, private readonly webglOnly = false) {
      this._width = width;
      this._height = height;
      this.buffer = initial
        ? new Uint8ClampedArray(initial.slice())
        : new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
    }
    get width(): number {
      return this._width;
    }
    set width(v: number) {
      this._width = v;
      this.resize();
    }
    get height(): number {
      return this._height;
    }
    set height(v: number) {
      this._height = v;
      this.resize();
    }
    private resize(): void {
      this.buffer = new Uint8ClampedArray(new ArrayBuffer(this._width * this._height * 4));
    }
    getContext(kind: string): Fake2DContext | null {
      if (kind !== '2d' || this.webglOnly) {
        return null;
      }
      if (this.ctx2d === null) {
        this.ctx2d = new Fake2DContext(this);
      }
      return this.ctx2d;
    }
  }

  class FakeHTMLCanvasElement extends FakeCanvasBase {}
  class FakeOffscreenCanvas extends FakeCanvasBase {}

  vi.stubGlobal('ImageData', FakeImageData);
  vi.stubGlobal('ImageBitmap', FakeImageBitmap);
  vi.stubGlobal('HTMLImageElement', FakeHTMLImageElement);
  vi.stubGlobal('HTMLCanvasElement', FakeHTMLCanvasElement);
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
  vi.stubGlobal(
    'createImageBitmap',
    async (source: FakeImageData): Promise<FakeImageBitmap> => {
      if (options?.failCreateImageBitmap) {
        throw new Error('createImageBitmap failed');
      }
      return new FakeImageBitmap(source.data, source.width, source.height);
    },
  );
  if (!options?.omitDocument) {
    vi.stubGlobal('document', {
      createElement: (tag: string) => {
        if (tag !== 'canvas') {
          throw new Error(`unexpected tag: ${tag}`);
        }
        return new FakeHTMLCanvasElement(0, 0);
      },
    });
  } else {
    vi.stubGlobal('document', undefined);
  }

  return {
    FakeImageData,
    FakeImageBitmap,
    FakeHTMLImageElement,
    FakeHTMLCanvasElement,
    FakeOffscreenCanvas,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TextureSpillCache', () => {
  it('書き込み完了でメモリから外れ、読み戻しで同じ内容に戻る', async () => {
    const store = new ManualPixelStore();
    const cache = new TextureSpillCache(store);
    const texture = dataTexture(4);
    const original = pixels(texture)?.slice();
    cache.spill(texture);
    // 書き込み中はテクスチャから外れているが、統計上はまだメモリ上（退避済みに数えない）。
    expect(pixels(texture)).toBeNull();
    expect(cache.isReady(texture)).toBe(false);
    expect(cache.stats().spilledCount).toBe(0);
    await store.settle({ kind: 'write' });
    expect(cache.stats()).toEqual({
      spilledCount: 1,
      spilledBytes: 64,
      restoringCount: 0,
      failureCount: 0,
    });
    cache.request(texture);
    expect(cache.stats().restoringCount).toBe(1);
    expect(cache.isReady(texture)).toBe(false);
    await store.settle({ kind: 'read' });
    expect(cache.isReady(texture)).toBe(true);
    expect(pixels(texture)).toEqual(original);
    expect(cache.stats().spilledCount).toBe(0);
  });

  it('書き込み中に要求すると、手元のデータをその場で戻す', () => {
    // 退避直後に再び必要になっても、ストアの完了を待たずに表示へ戻れることを確かめる。
    const store = new ManualPixelStore();
    const cache = new TextureSpillCache(store);
    const texture = dataTexture(4);
    const data = pixels(texture);
    cache.spill(texture);
    cache.request(texture);
    expect(cache.isReady(texture)).toBe(true);
    expect(pixels(texture)).toBe(data);
    expect(store.readCount).toBe(0);
  });

  it('書き込み中に戻した画像を再び退避しても、書き込みを重ねない', async () => {
    const store = new ManualPixelStore();
    const cache = new TextureSpillCache(store);
    const texture = dataTexture(4);
    cache.spill(texture);
    cache.request(texture);
    cache.spill(texture);
    expect(store.writeCount).toBe(1);
    await store.settle({ kind: 'write' });
    // 進行中だった書き込みの完了で退避済みになる。
    expect(cache.stats().spilledCount).toBe(1);
  });

  it('書き込み済みの画像は再退避でストアへ書き直さない', async () => {
    // 画素内容は不変という前提で、退避と読み戻しを繰り返しても書き込みは1回だけになる。
    const store = new ManualPixelStore();
    const cache = new TextureSpillCache(store);
    const texture = dataTexture(4);
    cache.spill(texture);
    await store.settle({ kind: 'write' });
    cache.request(texture);
    await store.settle({ kind: 'read' });
    cache.spill(texture);
    expect(pixels(texture)).toBeNull();
    expect(cache.stats().spilledCount).toBe(1);
    expect(store.writeCount).toBe(1);
  });

  it('書き込みに失敗するとデータを戻し、以後その画像は退避しない', async () => {
    const store = new ManualPixelStore();
    const cache = new TextureSpillCache(store);
    const texture = dataTexture(4);
    const data = pixels(texture);
    cache.spill(texture);
    await store.settle({ kind: 'write', fail: true });
    expect(pixels(texture)).toBe(data);
    expect(cache.isReady(texture)).toBe(true);
    expect(cache.stats().failureCount).toBe(1);
    cache.spill(texture);
    expect(pixels(texture)).toBe(data);
    expect(store.writeCount).toBe(1);
  });

  it('読み戻しに失敗した画像は準備済みにならず、restoreAll が拒否する', async () => {
    const store = new ManualPixelStore();
    const cache = new TextureSpillCache(store);
    const texture = dataTexture(4);
    cache.spill(texture);
    await store.settle({ kind: 'write' });
    // 拒否の検査は読み出しを失敗させる前に仕掛け、未処理の拒否にしない。
    const rejected = expect(cache.restoreAll()).rejects.toThrow('1 件');
    await store.settle({ kind: 'read', fail: true });
    await rejected;
    expect(cache.isReady(texture)).toBe(false);
    expect(cache.stats().failureCount).toBe(1);
  });

  it('restoreAll は退避中の全画像が戻ったときに解決する', async () => {
    const store = new ManualPixelStore();
    const cache = new TextureSpillCache(store);
    const spilled = dataTexture(4);
    const writing = dataTexture(2);
    cache.spill(spilled);
    await store.settle({ kind: 'write' });
    cache.spill(writing);
    const restoring = cache.restoreAll();
    // 書き込み中の画像はその場で戻り、ストアにだけある画像は読み出しを待つ。
    expect(cache.isReady(writing)).toBe(true);
    expect(cache.isReady(spilled)).toBe(false);
    await store.settle({ kind: 'read' });
    await restoring;
    expect(cache.isReady(spilled)).toBe(true);
  });

  it('既知の画像形式でないオブジェクトは退避せず、常に準備済みとして扱う', () => {
    const store = new ManualPixelStore();
    const cache = new TextureSpillCache(store);
    const canvas = { width: 4, height: 4 };
    // ADR: Node 環境に HTMLCanvasElement がないため、幅と高さだけを持つ画像で代用する。
    const texture = new CanvasTexture(canvas as unknown as HTMLCanvasElement);
    cache.spill(texture);
    expect(texture.image).toBe(canvas);
    expect(cache.isReady(texture)).toBe(true);
    expect(store.writeCount).toBe(0);
  });

  it('Source を共有するテクスチャは退避状態も共有する', async () => {
    // clone() は画像（Source）を共有するため、片方の退避はもう片方の画素データも外す。
    const store = new ManualPixelStore();
    const cache = new TextureSpillCache(store);
    const texture = dataTexture(4);
    const clone = texture.clone();
    cache.spill(texture);
    await store.settle({ kind: 'write' });
    expect(cache.isReady(clone)).toBe(false);
    cache.request(clone);
    await store.settle({ kind: 'read' });
    expect(cache.isReady(texture)).toBe(true);
  });

  describe('TypedArray 全般と非対象バッファ', () => {
    it('Float32Array（parameterTexture 相当）を退避・復元すると元の型と値に戻る', async () => {
      const store = new ManualPixelStore();
      const cache = new TextureSpillCache(store);
      const floats = new Float32Array(9 * 2 * 4);
      for (let i = 0; i < floats.length; i++) {
        floats[i] = (i - 10) * 0.25;
      }
      const original = floats.slice();
      const tex = new DataTexture(floats, 9, 2, RGBAFormat, FloatType);

      cache.spill(tex);
      expect((tex.image as { data: unknown }).data).toBeNull();
      await store.settle({ kind: 'write' });
      expect(cache.stats().spilledBytes).toBe(floats.byteLength);

      cache.request(tex);
      await store.settle({ kind: 'read' });
      const restored = (tex.image as { data: unknown }).data;
      expect(restored).toBeInstanceOf(Float32Array);
      expect(restored).toEqual(original);
    });

    it('Uint16Array・Uint8ClampedArray・非ゼロ byteOffset の subarray を正確に退避・復元する', async () => {
      const store = new ManualPixelStore();
      const cache = new TextureSpillCache(store);

      const backing = new ArrayBuffer(64);
      const subU16 = new Uint16Array(backing, 8, 8);
      for (let i = 0; i < subU16.length; i++) subU16[i] = 1000 + i * 7;
      const expectedU16 = subU16.slice();
      const texU16 = new DataTexture(subU16, 2, 1, RGBAFormat, HalfFloatType);

      const clamped = new Uint8ClampedArray([10, 20, 30, 40, 250, 251, 252, 253]);
      const expectedClamped = clamped.slice();
      const texClamped = new DataTexture(clamped, 2, 1);

      cache.spill(texU16);
      cache.spill(texClamped);
      await store.settle({ kind: 'write' });
      expect(cache.stats().spilledBytes).toBe(expectedU16.byteLength + expectedClamped.byteLength);

      cache.request(texU16);
      cache.request(texClamped);
      await store.settle({ kind: 'read' });

      expect((texU16.image as { data: unknown }).data).toBeInstanceOf(Uint16Array);
      expect((texU16.image as { data: unknown }).data).toEqual(expectedU16);
      expect((texClamped.image as { data: unknown }).data).toBeInstanceOf(Uint8ClampedArray);
      expect((texClamped.image as { data: unknown }).data).toEqual(expectedClamped);
    });

    it('SharedArrayBuffer 由来や特殊テクスチャは退避対象外にする', () => {
      const store = new ManualPixelStore();
      const cache = new TextureSpillCache(store);
      const sab = new SharedArrayBuffer(16);
      const sabTex = new DataTexture(new Uint8Array(sab) as unknown as Uint8Array, 2, 2);
      const videoTex = Object.assign(dataTexture(2), { isVideoTexture: true });
      const rtTex = Object.assign(dataTexture(2), { isRenderTargetTexture: true });

      cache.spill(sabTex);
      cache.spill(videoTex);
      cache.spill(rtTex);

      expect(cache.isReady(sabTex)).toBe(true);
      expect(cache.isReady(videoTex)).toBe(true);
      expect(cache.isReady(rtTex)).toBe(true);
      expect(store.writeCount).toBe(0);
    });
  });

  describe('CompressedTexture とミップ付き DataTexture', () => {
    it('2D CompressedTexture（Uint8Array / Uint16Array）のミップ列を退避・復元し再書き込みしない', async () => {
      const store = new ManualPixelStore();
      const cache = new TextureSpillCache(store);
      const bc7 = compressedMipTexture(16, 16, 4, false);
      const hdr = compressedMipTexture(16, 16, 4, true);
      const bc7Originals = bc7.mipmaps.map((m) => (m.data as Uint8Array).slice());
      const hdrOriginals = hdr.mipmaps.map((m) => (m.data as Uint16Array).slice());
      const expectedBytes = estimateTextureBytes(bc7) + estimateTextureBytes(hdr);

      cache.spill(bc7);
      cache.spill(hdr);
      // 退避中もミップ数と estimateTextureBytes は元の実バイト数を保つ。
      expect(bc7.mipmaps).toHaveLength(bc7Originals.length);
      expect(bc7.mipmaps[0].data).toBeNull();
      expect(estimateTextureBytes(bc7) + estimateTextureBytes(hdr)).toBe(expectedBytes);

      await store.settle({ kind: 'write' });
      expect(cache.stats()).toEqual({
        spilledCount: 2,
        spilledBytes: expectedBytes,
        restoringCount: 0,
        failureCount: 0,
      });

      cache.request(bc7);
      cache.request(hdr);
      await store.settle({ kind: 'read' });

      expect(cache.isReady(bc7)).toBe(true);
      expect(cache.isReady(hdr)).toBe(true);
      for (let i = 0; i < bc7Originals.length; i++) {
        expect(bc7.mipmaps[i].data).toBeInstanceOf(Uint8Array);
        expect(bc7.mipmaps[i].data).toEqual(bc7Originals[i]);
      }
      for (let i = 0; i < hdrOriginals.length; i++) {
        expect(hdr.mipmaps[i].data).toBeInstanceOf(Uint16Array);
        expect(hdr.mipmaps[i].data).toEqual(hdrOriginals[i]);
      }

      // 再退避ではストアへ書き直さない。
      cache.spill(bc7);
      expect(store.writeCount).toBe(2);
      expect(bc7.mipmaps[0].data).toBeNull();
    });

    it('ミップ付き DataTexture（生 KTX2 相当）を退避・復元すると image.data と mipmaps[0].data が同期する', async () => {
      const store = new ManualPixelStore();
      const cache = new TextureSpillCache(store);
      const mip0 = new Uint8Array(8 * 8 * 4).map((_, i) => (i * 5) % 256);
      const mip1 = new Uint8Array(4 * 4 * 4).map((_, i) => (i * 9) % 256);
      const tex = new DataTexture(mip0, 8, 8);
      tex.mipmaps = [
        { data: mip0, width: 8, height: 8 },
        { data: mip1, width: 4, height: 4 },
      ];
      const expected0 = mip0.slice();
      const expected1 = mip1.slice();

      cache.spill(tex);
      expect((tex.image as { data: unknown }).data).toBeNull();
      expect(tex.mipmaps[0].data).toBeNull();
      await store.settle({ kind: 'write' });
      expect(cache.stats().spilledBytes).toBe(expected0.byteLength + expected1.byteLength);

      cache.request(tex);
      await store.settle({ kind: 'read' });
      expect((tex.image as { data: unknown }).data).toBe(tex.mipmaps[0].data);
      expect(tex.mipmaps[0].data).toEqual(expected0);
      expect(tex.mipmaps[1].data).toEqual(expected1);
    });

    it('sliceCompressedTexture でミップを共有する L0 を退避しても、L1/L2 の共有ミップを破壊しない', async () => {
      const store = new ManualPixelStore();
      const cache = new TextureSpillCache(store);
      const source = compressedMipTexture(1024, 1024, 4);
      const levels = createCompressedTextureMipLevels(source, [1024, 512, 256]);
      const [l0, l1, l2] = levels;
      const l2DataBefore = l2.mipmaps.map((m) => (m.data as Uint8Array).slice());
      const l0Bytes = estimateTextureBytes(l0);

      cache.spill(l0);
      cache.spill(l1);
      await store.settle({ kind: 'write' });

      // L0・L1 は退避中でも estimateTextureBytes を保ち、共有先 L2 のデータは一切変わらない。
      expect(estimateTextureBytes(l0)).toBe(l0Bytes);
      expect(l0.mipmaps[0].data).toBeNull();
      expect(l1.mipmaps[0].data).toBeNull();
      expect(cache.isReady(l2)).toBe(true);
      for (let i = 0; i < l2.mipmaps.length; i++) {
        expect(l2.mipmaps[i].data).toBeInstanceOf(Uint8Array);
        expect(l2.mipmaps[i].data).toEqual(l2DataBefore[i]);
      }

      // L0 だけ読み戻しても L2 に影響せず、L0 の元データも戻る。
      cache.request(l0);
      await store.settle({ kind: 'read' });
      expect(cache.isReady(l0)).toBe(true);
      expect(l0.mipmaps[0].width).toBe(1024);
      expect(l0.mipmaps[0].data).toBeInstanceOf(Uint8Array);
      expect(l0.mipmaps[2].data).toEqual(l2DataBefore[0]);
    });

    it('CompressedTexture.clone() の共有 Source でも状態と mipmaps 差し替えが同期する', async () => {
      const store = new ManualPixelStore();
      const cache = new TextureSpillCache(store);
      const tex = compressedMipTexture(16, 16, 4);
      const clone = tex.clone();
      const original0 = (tex.mipmaps[0].data as Uint8Array).slice();

      cache.spill(tex);
      await store.settle({ kind: 'write' });
      expect(cache.isReady(clone)).toBe(false);

      cache.request(clone);
      await store.settle({ kind: 'read' });
      expect(cache.isReady(tex)).toBe(true);
      expect(clone.mipmaps[0].data).toEqual(original0);
      expect(tex.mipmaps[0].data).toEqual(original0);
    });

    it('CompressedArrayTexture と CompressedCubeTexture（6面）を退避・復元しバイト数を維持する', async () => {
      const store = new ManualPixelStore();
      const cache = new TextureSpillCache(store);

      const arrayMips: CompressedTextureMipmap[] = [
        { data: new Uint8Array(64).map((_, i) => i % 256), width: 8, height: 8 },
        { data: new Uint8Array(32).map((_, i) => (i * 3) % 256), width: 4, height: 4 },
      ];
      const arrayTex = new CompressedArrayTexture(arrayMips, 8, 8, 2, RGBA_BPTC_Format);
      const arrayOriginals = arrayMips.map((m) => m.data.slice());
      const arrayBytes = estimateTextureBytes(arrayTex);

      const faceOriginals: Uint8Array[][] = [];
      const faces = Array.from({ length: 6 }, (_, f) => {
        const m0 = new Uint8Array(16).map((_, i) => (i + f * 17) % 256);
        const m1 = new Uint8Array(16).map((_, i) => (i + f * 23 + 5) % 256);
        faceOriginals.push([m0.slice(), m1.slice()]);
        return {
          mipmaps: [
            { data: m0, width: 4, height: 4 },
            { data: m1, width: 2, height: 2 },
          ],
          width: 4,
          height: 4,
        };
      });
      const cubeTex = new CompressedCubeTexture(
        faces as unknown as CompressedTexture[],
        RGBA_BPTC_Format,
      );
      const cubeBytes = estimateTextureBytes(cubeTex);

      cache.spill(arrayTex);
      cache.spill(cubeTex);
      expect(estimateTextureBytes(arrayTex)).toBe(arrayBytes);
      expect(estimateTextureBytes(cubeTex)).toBe(cubeBytes);
      await store.settle({ kind: 'write' });
      expect(cache.stats().spilledBytes).toBe(arrayBytes + cubeBytes);

      cache.request(arrayTex);
      cache.request(cubeTex);
      await store.settle({ kind: 'read' });

      expect(arrayTex.mipmaps[0].data).toEqual(arrayOriginals[0]);
      expect(arrayTex.mipmaps[1].data).toEqual(arrayOriginals[1]);
      for (let f = 0; f < 6; f++) {
        expect(faces[f].mipmaps[0].data).toEqual(faceOriginals[f][0]);
        expect(faces[f].mipmaps[1].data).toEqual(faceOriginals[f][1]);
      }
    });
  });

  describe('ブラウザ Raster 画像・Canvas・ImageData', () => {
    it('ImageBitmap は spilled 確定時にのみ close() し、書き込み中の復元や失敗では閉じない', async () => {
      const { FakeImageBitmap } = installRasterGlobals();
      const store = new ManualPixelStore();
      const cache = new TextureSpillCache(store);
      const rgba = patternRgba(4, 4, 5);
      const bmp = new FakeImageBitmap(rgba, 4, 4);
      const tex = new Texture(bmp as unknown as ImageBitmap);

      // 書き込み中の request() は元の ImageBitmap を閉じずにその場で戻す。
      cache.spill(tex);
      expect(bmp.closed).toBe(false);
      expect(tex.image).toEqual({ width: 4, height: 4 });
      expect(estimateTextureBytes(tex)).toBeCloseTo((4 * 4 * 4 * 4) / 3, 10);
      cache.request(tex);
      expect(tex.image).toBe(bmp);
      expect(bmp.closed).toBe(false);

      // 再退避して書き込みが完了すると初めて close() される。
      cache.spill(tex);
      expect(bmp.closed).toBe(false);
      await store.settle({ kind: 'write' });
      expect(bmp.closed).toBe(true);
      expect(bmp.closeCount).toBe(1);
      expect(cache.stats().spilledBytes).toBe(64);

      // 復元時は新しい ImageBitmap が同じ画素内容で作られ、再退避では即 close() される。
      cache.request(tex);
      await store.settle({ kind: 'read' });
      expect(cache.isReady(tex)).toBe(true);
      const restored = tex.image as InstanceType<typeof FakeImageBitmap>;
      expect(restored).toBeInstanceOf(FakeImageBitmap);
      expect(restored).not.toBe(bmp);
      expect(restored.pixels).toEqual(rgba);

      cache.spill(tex);
      expect(restored.closed).toBe(true);
      expect(store.writeCount).toBe(1);
    });

    it('ImageBitmap の書き込み失敗では閉じずに戻し、createImageBitmap 失敗では lost になる', async () => {
      const { FakeImageBitmap } = installRasterGlobals({ failCreateImageBitmap: true });
      const store = new ManualPixelStore();
      const cache = new TextureSpillCache(store);

      const failWriteTex = new Texture(new FakeImageBitmap(patternRgba(2, 2), 2, 2) as unknown as ImageBitmap);
      const originalBmp = failWriteTex.image as InstanceType<typeof FakeImageBitmap>;
      cache.spill(failWriteTex);
      await store.settle({ kind: 'write', fail: true });
      expect(originalBmp.closed).toBe(false);
      expect(failWriteTex.image).toBe(originalBmp);
      expect(cache.stats().failureCount).toBe(1);

      const failRestoreTex = new Texture(
        new FakeImageBitmap(patternRgba(2, 2), 2, 2) as unknown as ImageBitmap,
      );
      cache.spill(failRestoreTex);
      await store.settle({ kind: 'write', key: failRestoreTex.source.uuid });
      const rejected = expect(cache.restoreAll()).rejects.toThrow('1 件');
      await store.settle({ kind: 'read', key: failRestoreTex.source.uuid });
      await rejected;
      expect(cache.isReady(failRestoreTex)).toBe(false);
      expect(cache.stats().failureCount).toBe(2);
    });

    it('HTMLImageElement は未完了なら保留し、完了後の退避から Canvas へ復元し、CORS 汚染は失敗扱いにする', async () => {
      const { FakeHTMLImageElement, FakeHTMLCanvasElement, FakeImageBitmap } = installRasterGlobals();
      const store = new ManualPixelStore();
      const cache = new TextureSpillCache(store);
      const rgba = patternRgba(4, 4, 9);
      const img = new FakeHTMLImageElement(rgba, 4, 4, false, false);
      const tex = new Texture(img as unknown as HTMLImageElement);

      // 読み込み未完了の間はスキップされ、unsupported にも永久登録されない。
      cache.spill(tex);
      expect(tex.image).toBe(img);
      expect(store.writeCount).toBe(0);

      img.complete = true;
      img.naturalWidth = 4;
      img.naturalHeight = 4;
      cache.spill(tex);
      await store.settle({ kind: 'write' });
      expect(cache.stats().spilledCount).toBe(1);

      cache.request(tex);
      await store.settle({ kind: 'read' });
      // flipY の扱いを変えないため ImageBitmap ではなく HTMLCanvasElement として戻す。
      const restoredImg: unknown = tex.image;
      expect(restoredImg).toBeInstanceOf(FakeHTMLCanvasElement);
      expect(restoredImg).not.toBeInstanceOf(FakeImageBitmap);
      if (restoredImg instanceof FakeHTMLCanvasElement) {
        expect(restoredImg.buffer).toEqual(rgba);
      }

      // CORS 汚染時は元画像を壊さず failureCount を増やし、以後退避しない。
      const taintedImg = new FakeHTMLImageElement(rgba, 4, 4, true, true);
      const taintedTex = new Texture(taintedImg as unknown as HTMLImageElement);
      cache.spill(taintedTex);
      expect(taintedTex.image).toBe(taintedImg);
      expect(cache.isReady(taintedTex)).toBe(true);
      expect(cache.stats().failureCount).toBe(1);
      cache.spill(taintedTex);
      expect(cache.stats().failureCount).toBe(1);
    });

    it('HTMLCanvasElement（WebGL含む）・OffscreenCanvas・ImageData を退避・復元できる', async () => {
      const { FakeHTMLCanvasElement, FakeOffscreenCanvas, FakeImageData } = installRasterGlobals();
      const store = new ManualPixelStore();
      const cache = new TextureSpillCache(store);

      const rgbaCanvas = patternRgba(4, 2, 1);
      const rgbaWebgl = patternRgba(4, 2, 2);
      const rgbaOffscreen = patternRgba(4, 2, 3);
      const rgbaData = patternRgba(4, 2, 4);

      const htmlCanvasTex = new CanvasTexture(
        new FakeHTMLCanvasElement(4, 2, rgbaCanvas, false) as unknown as HTMLCanvasElement,
      );
      const webglCanvasTex = new CanvasTexture(
        new FakeHTMLCanvasElement(4, 2, rgbaWebgl, true) as unknown as HTMLCanvasElement,
      );
      const offscreenTex = new Texture(
        new FakeOffscreenCanvas(4, 2, rgbaOffscreen, false) as unknown as OffscreenCanvas,
      );
      const imageDataTex = new Texture(
        new FakeImageData(rgbaData, 4, 2) as unknown as ImageData,
      );

      cache.spill(htmlCanvasTex);
      cache.spill(webglCanvasTex);
      cache.spill(offscreenTex);
      cache.spill(imageDataTex);
      await store.settle({ kind: 'write' });
      expect(cache.stats().spilledCount).toBe(4);

      cache.request(htmlCanvasTex);
      cache.request(webglCanvasTex);
      cache.request(offscreenTex);
      cache.request(imageDataTex);
      await store.settle({ kind: 'read' });

      const restoredHtml: unknown = htmlCanvasTex.image;
      const restoredWebgl: unknown = webglCanvasTex.image;
      const restoredOffscreen: unknown = offscreenTex.image;
      const restoredData: unknown = imageDataTex.image;
      expect(restoredHtml).toBeInstanceOf(FakeHTMLCanvasElement);
      if (restoredHtml instanceof FakeHTMLCanvasElement) {
        expect(restoredHtml.buffer).toEqual(rgbaCanvas);
      }
      expect(restoredWebgl).toBeInstanceOf(FakeHTMLCanvasElement);
      if (restoredWebgl instanceof FakeHTMLCanvasElement) {
        expect(restoredWebgl.buffer).toEqual(rgbaWebgl);
      }
      expect(restoredOffscreen).toBeInstanceOf(FakeOffscreenCanvas);
      if (restoredOffscreen instanceof FakeOffscreenCanvas) {
        expect(restoredOffscreen.buffer).toEqual(rgbaOffscreen);
      }
      expect(restoredData).toBeInstanceOf(FakeImageData);
      if (restoredData instanceof FakeImageData) {
        expect(restoredData.data).toEqual(rgbaData);
      }
    });
  });
});

/** 2スロット（map・normalMap）・境界 [0,10,20] の3段階セットを作る。 */
function set3() {
  const base = new MeshStandardMaterial({ name: 'wall' });
  const maps = [dataTexture(8), dataTexture(4), dataTexture(2)];
  const normals = [dataTexture(8), dataTexture(4), dataTexture(2)];
  const levels: TextureLodLevel[] = maps.map((map, i) => ({
    distance: [0, 10, 20][i],
    textures: { map, normalMap: normals[i] },
  }));
  return { set: createTextureLodSet({ material: base, levels }), base, maps, normals };
}

function cameraAt(z: number): PerspectiveCamera {
  const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.set(0, 0, z);
  return camera;
}

/** 猶予0で即時破棄するマネージャと、L0 から L1 へ離れて L0 が退避された状態を作る。 */
async function spilledAtLevel1() {
  const store = new ManualPixelStore();
  const cache = new TextureSpillCache(store);
  const { set, base, maps, normals } = set3();
  let now = 0;
  const manager = new TextureLodManager({ evictDelayMs: 0, spillCache: cache, now: () => now });
  const mesh = new Mesh(new PlaneGeometry(2, 2), base);
  manager.add(mesh, set);
  manager.update(cameraAt(5));
  now = 100;
  manager.update(cameraAt(15));
  await store.settle({ kind: 'write' });
  return {
    store,
    cache,
    set,
    maps,
    normals,
    manager,
    mesh,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('TextureLodManager spillCache', () => {
  it('破棄したテクスチャの画素データを退避する', async () => {
    const { cache, maps, normals, manager, mesh } = await spilledAtLevel1();
    try {
      expect(manager.levelOf(mesh)).toBe(1);
      expect(pixels(maps[0])).toBeNull();
      expect(pixels(normals[0])).toBeNull();
      // 現用の L1 と最粗の L2 は退避しない。
      expect(cache.isReady(maps[1])).toBe(true);
      expect(cache.isReady(maps[2])).toBe(true);
      expect(cache.stats().spilledCount).toBe(2);
    } finally {
      manager.dispose();
    }
  });

  it('読み戻しが済むまで現在のレベルを保ち、済んだ次の update で切り替える', async () => {
    const { store, set, maps, manager, mesh, advance } = await spilledAtLevel1();
    try {
      advance(100);
      manager.update(cameraAt(5));
      expect(manager.levelOf(mesh)).toBe(1);
      expect(mesh.material).toBe(set.variant(1));
      await store.settle({ kind: 'read' });
      advance(100);
      manager.update(cameraAt(5));
      expect(manager.levelOf(mesh)).toBe(0);
      expect(mesh.material).toBe(set.variant(0));
      expect(pixels(maps[0])).not.toBeNull();
    } finally {
      manager.dispose();
    }
  });

  it('一部のスロットだけ戻った間も、戻った分を再退避せず全スロットを待つ', async () => {
    // 先に戻った map を掃引が再退避すると、normalMap が戻るたびに map が欠けて切り替わらなくなる。
    const { store, cache, maps, normals, manager, mesh, advance } = await spilledAtLevel1();
    try {
      advance(100);
      manager.update(cameraAt(5));
      await store.settle({ kind: 'read', key: maps[0].source.uuid });
      advance(100);
      manager.update(cameraAt(5));
      expect(manager.levelOf(mesh)).toBe(1);
      expect(cache.isReady(maps[0])).toBe(true);
      await store.settle({ kind: 'read', key: normals[0].source.uuid });
      advance(100);
      manager.update(cameraAt(5));
      expect(manager.levelOf(mesh)).toBe(0);
    } finally {
      manager.dispose();
    }
  });

  it('読み戻したが不要になった画素データは、書き直さずに再退避する', async () => {
    const { store, cache, maps, manager, mesh, advance } = await spilledAtLevel1();
    const writesBefore = store.writeCount;
    try {
      advance(100);
      manager.update(cameraAt(5));
      // 読み戻し中に遠ざかり、L0 は不要になる。
      advance(100);
      manager.update(cameraAt(15));
      await store.settle({ kind: 'read' });
      advance(100);
      manager.update(cameraAt(15));
      expect(manager.levelOf(mesh)).toBe(1);
      expect(pixels(maps[0])).toBeNull();
      expect(cache.stats().spilledCount).toBe(2);
      expect(store.writeCount).toBe(writesBefore);
    } finally {
      manager.dispose();
    }
  });

  it('別のマネージャが退避したテクスチャは常駐量に数えず、初回は最粗レベルから始める', async () => {
    // マネージャを作り直しても同じキャッシュを渡せば、退避状態を引き継いで表示を欠かさない。
    const { store, cache, set, manager } = await spilledAtLevel1();
    manager.dispose();
    const next = new TextureLodManager({ evictDelayMs: 0, spillCache: cache });
    const mesh = new Mesh(new PlaneGeometry(2, 2), set.baseMaterial);
    try {
      next.add(mesh, set);
      const bytes = (size: number) => (size * size * 4 * 4 * 2) / 3;
      expect(next.stats().residentBytes).toBeCloseTo(bytes(4) + bytes(2), 10);
      next.update(cameraAt(5));
      expect(next.levelOf(mesh)).toBe(2);
      await store.settle({ kind: 'read' });
      next.update(cameraAt(5));
      expect(next.levelOf(mesh)).toBe(0);
    } finally {
      next.dispose();
    }
  });

  it('圧縮テクスチャ + 予算適応で L0 を退避しても予算予測が壊れず、接近時に L0 へ復帰する', async () => {
    const store = new ManualPixelStore();
    const cache = new TextureSpillCache(store);
    const source = compressedMipTexture(64, 64, 4);
    const tiers = createCompressedTextureMipLevels(source, [64, 32, 16]);
    const base = new MeshStandardMaterial({ name: 'ktx2' });
    const set = createTextureLodSet({
      material: base,
      levels: tiers.map((map, i) => ({ distance: [0, 10, 20][i], textures: { map } })),
    });
    const l0Bytes = estimateTextureBytes(tiers[0]);
    const l2Bytes = estimateTextureBytes(tiers[2]);
    let now = 0;
    const manager = new TextureLodManager({
      evictDelayMs: 0,
      maxResidentBytes: l0Bytes + l2Bytes + 1024,
      adaptiveThresholdScale: true,
      spillCache: cache,
      now: () => now,
    });
    const mesh = new Mesh(new PlaneGeometry(2, 2), base);
    try {
      manager.add(mesh, set);
      manager.update(cameraAt(5));
      expect(manager.levelOf(mesh)).toBe(0);

      // 遠景へ移動して L0 を破棄・退避させる。
      now += 100;
      manager.update(cameraAt(25));
      await store.settle({ kind: 'write' });
      expect(manager.levelOf(mesh)).toBe(2);
      expect(cache.isReady(tiers[0])).toBe(false);
      // 退避中も L0 の予測バイト数が 0 にならないため、予算余裕の誤判定が起きない。
      expect(estimateTextureBytes(tiers[0])).toBe(l0Bytes);

      // 接近しても読み戻し完了までは L2 を保ち、完了後の update で L0 へ戻る。
      now += 5000;
      manager.update(cameraAt(5));
      expect(manager.levelOf(mesh)).toBe(2);
      await store.settle({ kind: 'read' });
      now += 100;
      manager.update(cameraAt(5));
      expect(manager.levelOf(mesh)).toBe(0);
      expect(tiers[0].mipmaps[0].data).toBeInstanceOf(Uint8Array);
    } finally {
      manager.dispose();
    }
  });
});
