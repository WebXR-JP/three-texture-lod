/**
 * TextureSpillCache と、それを使う TextureLodManager の仕様固定テスト。
 *
 * キャッシュ単体では、退避・読み戻しの状態遷移、書き込み済み内容の再利用、失敗時の扱い、
 * 対象外の画像と共有 Source を確かめる。マネージャ連携では、破棄に連動した退避と、
 * 読み戻しが済むまで現在のレベルを保つこと（再退避との取り合いで切り替わらなくならないことを含む）を確かめる。
 * ストアは完了時期をテスト側で決めるメモリ実装を使う。
 */
import { describe, expect, it } from 'vitest';
import {
  CanvasTexture,
  DataTexture,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  type Texture,
} from 'three';
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

  it('Uint8Array を持たない画像は退避せず、常に準備済みとして扱う', () => {
    const store = new ManualPixelStore();
    const cache = new TextureSpillCache(store);
    const canvas = { width: 4, height: 4 };
    // ADR: Node 環境に HTMLCanvasElement がないため、幅と高さだけを持つ画像で代用する。
    // キャッシュは `image.data` の有無と型だけで判定するため、代用で判定の対象は変わらない。
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
});
