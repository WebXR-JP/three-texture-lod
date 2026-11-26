/**
 * GPU から外したテクスチャの画素・圧縮データをメインメモリから外部ストアへ退避する。
 *
 * @packageDocumentation
 */
import type { Texture } from 'three';
import { createSpillAdapter, type SpillAdapter } from './texture-spill-adapters.js';

/**
 * 退避先の永続ストア。キーごとにバイト列を1件保持する。
 *
 * 実装者は次を守ること。
 * - `write` の完了後は、同じキーの `read` が書いた内容と同じバイト列を返す。
 * - 同じキーへの `write` は上書きになる。
 * - 失敗は `Promise` の拒否で伝える。
 */
export interface TexturePixelStore {
  /**
   * バイト列を書き込む。
   *
   * @param key - テクスチャ画像を表すキー。ファイル名として使える英数字とハイフンのみ。
   * @param bytes - 書き込む内容。完了まで呼び出し側は内容を変えない。
   * @returns 書き込みが永続化されたときに解決する。
   */
  write(key: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  /**
   * バイト列を読み出す。
   *
   * @param key - `write` で使ったキー。
   * @returns 書き込んだ内容。未書き込みのキーでは拒否する。
   */
  read(key: string): Promise<ArrayBuffer>;
}

/** 退避状況の統計。 */
export interface TextureSpillStats {
  /** 画素データがメインメモリになく、ストアにだけある画像の数（読み戻し中を含む）。 */
  readonly spilledCount: number;
  /** `spilledCount` に数えた画像の画素・圧縮データ実バイト数の合計。 */
  readonly spilledBytes: number;
  /** ストアから読み戻し中の画像の数。 */
  readonly restoringCount: number;
  /** 書き込み・読み出し・変換が失敗した累計回数。 */
  readonly failureCount: number;
}

/**
 * 画像1件の退避状態。
 *
 * - `resident`: データがテクスチャ上にある。
 * - `detached`: テクスチャからは外したが、書き込み完了まで復元用スナップショットを手元に持つ。
 * - `spilled`: データはストアにだけある。
 * - `reading`: ストアから読み戻し中。`done` は読み戻しの成否が確定したときに解決する。
 * - `lost`: 読み戻しに失敗し、データを復元できない。
 */
type SpillPhase =
  | { readonly kind: 'resident' }
  | { readonly kind: 'detached'; readonly snapshot: unknown }
  | { readonly kind: 'spilled' }
  | { readonly kind: 'reading'; readonly done: Promise<void> }
  | { readonly kind: 'lost' };

/** 画像1件分の追跡情報。 */
interface SpillEntry {
  readonly key: string;
  readonly adapter: SpillAdapter;
  phase: SpillPhase;
  /** ストアに現在の内容が書き込み済みなら `true`。再退避で書き直さないために使う。 */
  persisted: boolean;
  /** 書き込みが進行中なら `true`。 */
  writing: boolean;
  /** 抽出や書き込みに失敗した画像・外部で別形式に差し替えられた画像は以後退避しない。 */
  spillable: boolean;
}

/**
 * テクスチャデータのディスク退避キャッシュ。
 *
 * GPU から破棄済みのテクスチャについて、CPU 側の画素・圧縮データをストアへ書き出して
 * メインメモリから外し、必要になったら非同期に読み戻す。退避と読み戻しは画像
 * （`texture.source`）単位で行うため、`Source` を共有するテクスチャ間でも状態は1つである。
 *
 * 対応するテクスチャ形式は次のとおり。
 * - `DataTexture` 等の TypedArray 画像（`Uint8Array`・`Float32Array`・`Uint16Array` 等、`SharedArrayBuffer` 除く）
 * - `CompressedTexture`（2D / Array / Cube）およびミップ配列を持つ `DataTexture`
 * - `ImageBitmap`・`HTMLImageElement`・`HTMLCanvasElement`・`OffscreenCanvas`・`ImageData` を持つ `Texture`
 *
 * レンダーターゲット・深度・動画・`HTMLTexture`・非圧縮 `CubeTexture`・未対応形式は退避せず、
 * 常に準備済みとして扱う。読み込み未完了の `HTMLImageElement` は完了後に再判定する。
 * 画素内容は登録後に変わらないものとして扱い、一度書き込んだ内容は再退避時に書き直さない。
 *
 * @remarks
 * 退避中のテクスチャは表示用実体を外しているため、そのまま描画すると正しく表示できない。
 * {@link TextureLodManager} に渡すとマネージャが表示前の読み戻しを待つが、
 * マネージャ外でテクスチャを表示する前（LOD 無効化でベースマテリアルへ戻す場合など）は
 * {@link TextureSpillCache.restoreAll} の完了を待つこと。
 * キャッシュは複数のマネージャで使い回せ、マネージャの作り直しをまたいで退避状態を保つ。
 */
export class TextureSpillCache {
  private readonly store: TexturePixelStore;
  /** ADR: `texture.source` をキーにするのは、`clone()` で画像を共有するテクスチャの状態を1つに保つためである。 */
  private readonly entries = new Map<Texture['source'], SpillEntry>();
  /** 退避対象外と判定済みの画像。毎フレームの判定で画像形式の検査を繰り返さないために使う。 */
  private readonly unsupported = new WeakSet<Texture['source']>();
  private failureCount = 0;

  /**
   * @param store - 退避先。
   */
  constructor(store: TexturePixelStore) {
    this.store = store;
  }

  /**
   * テクスチャのデータを退避する。
   *
   * 書き込み済みの画像はただちにメインメモリから外す。未書き込みの画像は書き込みを始め、
   * 完了した時点で外す。対象外の画像・読み戻し中・退避済みの場合は何もしない。
   *
   * @param texture - GPU から破棄済みで、どの描画にも使われていないテクスチャ。
   * @remarks
   * 書き込みに失敗した場合はデータをテクスチャへ戻し、その画像は以後退避しない。
   * 画素抽出に失敗した場合（CORS 汚染など）も元画像を壊さず、以後退避しない。
   */
  spill(texture: Texture): void {
    const entry = this.entryOf(texture);
    if (entry === null) {
      return;
    }
    entry.adapter.trackTexture?.(texture, entry.phase.kind !== 'resident');
    if (entry.phase.kind !== 'resident' || !entry.spillable) {
      return;
    }
    const needBytes = !entry.persisted && !entry.writing;
    const detached = entry.adapter.detach(needBytes);
    if (detached.status === 'invalid') {
      entry.spillable = false;
      return;
    }
    if (detached.status === 'error') {
      entry.spillable = false;
      this.failureCount++;
      return;
    }
    if (entry.persisted) {
      entry.adapter.releaseSnapshot?.(detached.snapshot);
      entry.phase = { kind: 'spilled' };
      return;
    }
    entry.phase = { kind: 'detached', snapshot: detached.snapshot };
    if (!entry.writing && detached.bytes !== undefined) {
      this.write(entry, detached.bytes);
    }
  }

  /**
   * テクスチャのデータがメインメモリ上にあるかを返す。
   *
   * @returns 退避対象外の画像、または一度も退避していない画像では常に `true`。
   */
  isReady(texture: Texture): boolean {
    const entry = this.entries.get(texture.source);
    return entry === undefined || entry.phase.kind === 'resident';
  }

  /**
   * テクスチャのデータの読み戻しを始める。
   *
   * 書き込み中で手元にデータがある場合はその場で戻し、呼び出し直後から {@link isReady} が `true` になる。
   * ストアにだけある場合は読み出しを始め、完了後に `true` になる。
   * 準備済み・読み戻し中・復元不能の場合は何もしない。
   */
  request(texture: Texture): void {
    const entry = this.entries.get(texture.source);
    if (entry !== undefined) {
      entry.adapter.trackTexture?.(texture, entry.phase.kind !== 'resident');
      this.restore(entry);
    }
  }

  /**
   * 退避中の全画像を読み戻す。
   *
   * @returns 全画像のデータがメインメモリへ戻ったときに解決する。
   * 読み戻せない画像が1件でもあれば `Error` で拒否する（他の画像の読み戻しは完了している）。
   */
  async restoreAll(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      this.restore(entry);
      if (entry.phase.kind === 'reading') {
        pending.push(entry.phase.done);
      }
    }
    await Promise.all(pending);
    let lost = 0;
    for (const entry of this.entries.values()) {
      if (entry.phase.kind === 'lost') {
        lost++;
      }
    }
    if (lost > 0) {
      throw new Error(`${lost} 件のテクスチャ画像を読み戻せませんでした`);
    }
  }

  /** 退避状況の統計を返す。 */
  stats(): TextureSpillStats {
    let spilledCount = 0;
    let spilledBytes = 0;
    let restoringCount = 0;
    for (const entry of this.entries.values()) {
      const kind = entry.phase.kind;
      if (kind === 'spilled' || kind === 'reading') {
        spilledCount++;
        spilledBytes += entry.adapter.byteLength;
      }
      if (kind === 'reading') {
        restoringCount++;
      }
    }
    return { spilledCount, spilledBytes, restoringCount, failureCount: this.failureCount };
  }

  /** 追跡情報を返す。初回は画像形式を検査して作り、対象外または一時保留なら `null` を返す。 */
  private entryOf(texture: Texture): SpillEntry | null {
    const source = texture.source;
    const existing = this.entries.get(source);
    if (existing !== undefined) {
      return existing;
    }
    if (this.unsupported.has(source)) {
      return null;
    }
    const resolved = createSpillAdapter(texture);
    if (resolved.kind === 'unsupported') {
      this.unsupported.add(source);
      return null;
    }
    if (resolved.kind === 'defer') {
      return null;
    }
    const entry: SpillEntry = {
      key: source.uuid,
      adapter: resolved.adapter,
      phase: { kind: 'resident' },
      persisted: false,
      writing: false,
      spillable: true,
    };
    this.entries.set(source, entry);
    return entry;
  }

  /** 書き込みを始める。完了時に `detached` のままならスナップショットを解放する。 */
  private write(entry: SpillEntry, data: Uint8Array<ArrayBuffer>): void {
    entry.writing = true;
    this.store.write(entry.key, data).then(
      () => {
        entry.writing = false;
        entry.persisted = true;
        if (entry.phase.kind === 'detached') {
          entry.adapter.releaseSnapshot?.(entry.phase.snapshot);
          entry.phase = { kind: 'spilled' };
        }
      },
      () => {
        entry.writing = false;
        entry.spillable = false;
        this.failureCount++;
        if (entry.phase.kind === 'detached') {
          entry.adapter.reattach(entry.phase.snapshot);
          entry.phase = { kind: 'resident' };
        }
      },
    );
  }

  /** 読み戻しを始める。`detached` は同期的に戻す。 */
  private restore(entry: SpillEntry): void {
    const phase = entry.phase;
    if (phase.kind === 'detached') {
      entry.adapter.reattach(phase.snapshot);
      entry.phase = { kind: 'resident' };
      return;
    }
    if (phase.kind !== 'spilled') {
      return;
    }
    const done = (async () => {
      try {
        const buffer = await this.store.read(entry.key);
        const restored = await entry.adapter.restore(buffer);
        if (!restored) {
          this.failureCount++;
          entry.phase = { kind: 'lost' };
          return;
        }
        entry.phase = { kind: 'resident' };
      } catch {
        this.failureCount++;
        entry.phase = { kind: 'lost' };
      }
    })();
    entry.phase = { kind: 'reading', done };
  }
}
