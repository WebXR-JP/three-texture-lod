/**
 * GPU から外したテクスチャの画素データをメインメモリから外部ストアへ退避する。
 *
 * @packageDocumentation
 */
import type { Texture } from 'three';

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
  /** `spilledCount` に数えた画像の画素データ実バイト数の合計。 */
  readonly spilledBytes: number;
  /** ストアから読み戻し中の画像の数。 */
  readonly restoringCount: number;
  /** 書き込み・読み出しが失敗した累計回数。 */
  readonly failureCount: number;
}

/**
 * 画像1件の退避状態。
 *
 * - `resident`: 画素データがテクスチャ上にある。
 * - `detached`: テクスチャからは外したが、書き込み完了まで `data` を手元に持つ。
 * - `spilled`: 画素データはストアにだけある。
 * - `reading`: ストアから読み戻し中。`done` は読み戻しの成否が確定したときに解決する。
 * - `lost`: 読み戻しに失敗し、画素データを復元できない。
 */
type SpillPhase =
  | { readonly kind: 'resident' }
  | { readonly kind: 'detached'; readonly data: Uint8Array<ArrayBuffer> }
  | { readonly kind: 'spilled' }
  | { readonly kind: 'reading'; readonly done: Promise<void> }
  | { readonly kind: 'lost' };

/** 画像1件分の追跡情報。 */
interface SpillEntry {
  readonly key: string;
  /** 退避対象の画像オブジェクト（`texture.source.data`）。`data` プロパティだけを差し替える。 */
  readonly image: PixelImage;
  readonly byteLength: number;
  phase: SpillPhase;
  /** ストアに現在の内容が書き込み済みなら `true`。再退避で書き直さないために使う。 */
  persisted: boolean;
  /** 書き込みが進行中なら `true`。 */
  writing: boolean;
  /** 書き込みに失敗した画像は以後退避しない。 */
  spillable: boolean;
}

/** `DataTexture` 形式の画像。`data` が `null` の間は退避中を表す。 */
interface PixelImage {
  data: Uint8Array<ArrayBuffer> | null;
  readonly width: number;
  readonly height: number;
}

/**
 * テクスチャ画素データのディスク退避キャッシュ。
 *
 * GPU から破棄済みのテクスチャについて、`image.data`（`Uint8Array`）をストアへ書き出して
 * メインメモリから外し、必要になったら非同期に読み戻す。退避と読み戻しは画像
 * （`texture.source`）単位で行うため、`Source` を共有するテクスチャ間でも状態は1つである。
 *
 * 対象は `image.data` が `Uint8Array` の画像（`DataTexture` 等）に限る。
 * `HTMLCanvasElement`・`ImageBitmap` 等の画像は退避せず、常に準備済みとして扱う。
 * 画素内容は登録後に変わらないものとして扱い、一度書き込んだ内容は再退避時に書き直さない。
 *
 * @remarks
 * 退避中のテクスチャは `image.data === null` になり、描画に使うと three がアップロードに失敗する。
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
   * テクスチャの画素データを退避する。
   *
   * 書き込み済みの画像はただちにメインメモリから外す。未書き込みの画像は書き込みを始め、
   * 完了した時点で外す。対象外の画像・読み戻し中・退避済みの場合は何もしない。
   *
   * @param texture - GPU から破棄済みで、どの描画にも使われていないテクスチャ。
   * @remarks
   * 書き込みに失敗した場合は画素データをテクスチャへ戻し、その画像は以後退避しない。
   */
  spill(texture: Texture): void {
    const entry = this.entryOf(texture);
    if (entry === null || entry.phase.kind !== 'resident' || !entry.spillable) {
      return;
    }
    const data = entry.image.data;
    // ADR: 登録時に `Uint8Array` を確認済みだが、利用者が `image.data` を別の長さの配列へ
    // 差し替えた場合は書き込み済みの内容と食い違うため、以後は退避しない。
    // 同じ長さでの内容の書き換えは検出しない（画素内容は不変という契約に委ねる）。
    if (!(data instanceof Uint8Array) || data.byteLength !== entry.byteLength) {
      entry.spillable = false;
      return;
    }
    entry.image.data = null;
    if (entry.persisted) {
      entry.phase = { kind: 'spilled' };
      return;
    }
    entry.phase = { kind: 'detached', data };
    if (!entry.writing) {
      this.write(entry, data);
    }
  }

  /**
   * テクスチャの画素データがメインメモリ上にあるかを返す。
   *
   * @returns 退避対象外の画像、または一度も退避していない画像では常に `true`。
   */
  isReady(texture: Texture): boolean {
    const entry = this.entries.get(texture.source);
    return entry === undefined || entry.phase.kind === 'resident';
  }

  /**
   * テクスチャの画素データの読み戻しを始める。
   *
   * 書き込み中で手元にデータがある場合はその場で戻し、呼び出し直後から {@link isReady} が `true` になる。
   * ストアにだけある場合は読み出しを始め、完了後に `true` になる。
   * 準備済み・読み戻し中・復元不能の場合は何もしない。
   */
  request(texture: Texture): void {
    const entry = this.entries.get(texture.source);
    if (entry !== undefined) {
      this.restore(entry);
    }
  }

  /**
   * 退避中の全画像を読み戻す。
   *
   * @returns 全画像の画素データがメインメモリへ戻ったときに解決する。
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
        spilledBytes += entry.byteLength;
      }
      if (kind === 'reading') {
        restoringCount++;
      }
    }
    return { spilledCount, spilledBytes, restoringCount, failureCount: this.failureCount };
  }

  /** 追跡情報を返す。初回は画像形式を検査して作り、対象外なら `null` を返す。 */
  private entryOf(texture: Texture): SpillEntry | null {
    const source = texture.source;
    const existing = this.entries.get(source);
    if (existing !== undefined) {
      return existing;
    }
    if (this.unsupported.has(source)) {
      return null;
    }
    const pixels = pixelImageOf(source.data);
    if (pixels === null) {
      this.unsupported.add(source);
      return null;
    }
    const entry: SpillEntry = {
      key: source.uuid,
      image: pixels.image,
      byteLength: pixels.byteLength,
      phase: { kind: 'resident' },
      persisted: false,
      writing: false,
      spillable: true,
    };
    this.entries.set(source, entry);
    return entry;
  }

  /** 書き込みを始める。完了時に `detached` のままなら画素データを手放す。 */
  private write(entry: SpillEntry, data: Uint8Array<ArrayBuffer>): void {
    entry.writing = true;
    this.store.write(entry.key, data).then(
      () => {
        entry.writing = false;
        entry.persisted = true;
        if (entry.phase.kind === 'detached') {
          entry.phase = { kind: 'spilled' };
        }
      },
      () => {
        entry.writing = false;
        entry.spillable = false;
        this.failureCount++;
        if (entry.phase.kind === 'detached') {
          entry.image.data = entry.phase.data;
          entry.phase = { kind: 'resident' };
        }
      },
    );
  }

  /** 読み戻しを始める。`detached` は同期的に戻す。 */
  private restore(entry: SpillEntry): void {
    const phase = entry.phase;
    if (phase.kind === 'detached') {
      entry.image.data = phase.data;
      entry.phase = { kind: 'resident' };
      return;
    }
    if (phase.kind !== 'spilled') {
      return;
    }
    const done = this.store.read(entry.key).then(
      (buffer) => {
        // ADR: 長さの一致だけを確かめる。ストアの契約上は内容も一致するため、
        // ハッシュ照合までは行わない（読み戻しのたびに全画素を走査する負荷を避ける）。
        if (buffer.byteLength !== entry.byteLength) {
          this.failureCount++;
          entry.phase = { kind: 'lost' };
          return;
        }
        entry.image.data = new Uint8Array(buffer);
        entry.phase = { kind: 'resident' };
      },
      () => {
        this.failureCount++;
        entry.phase = { kind: 'lost' };
      },
    );
    entry.phase = { kind: 'reading', done };
  }
}

/**
 * 画像が退避対象の形式なら、画素データを差し替えられる形で返す。
 *
 * `{ data: Uint8Array, width: number, height: number }` を満たし、`data` が
 * `SharedArrayBuffer` を参照しないものだけを対象とする。
 *
 * @returns 画像オブジェクトそのものと画素データのバイト数。対象外なら `null`。
 */
function pixelImageOf(image: unknown): { image: PixelImage; byteLength: number } | null {
  if (
    typeof image !== 'object' ||
    image === null ||
    !('data' in image) ||
    !('width' in image) ||
    !('height' in image)
  ) {
    return null;
  }
  const { data, width, height } = image;
  if (
    !(data instanceof Uint8Array) ||
    !(data.buffer instanceof ArrayBuffer) ||
    typeof width !== 'number' ||
    typeof height !== 'number'
  ) {
    return null;
  }
  // ADR: `data` を書き換えるため元の画像オブジェクトをそのまま使う。
  // 直前の検査で `data`・`width`・`height` の型と `data.buffer` が `ArrayBuffer` であることを
  // 確認済みであり、`PixelImage` として扱える（`buffer` の検査は型引数の絞り込みに反映されない）。
  return { image: image as PixelImage, byteLength: data.byteLength };
}
