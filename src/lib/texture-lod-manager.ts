/**
 * 登録メッシュの毎フレームLOD更新とテクスチャ常駐管理。
 *
 * @packageDocumentation
 */
import { computeLodDistance } from './lod-distance.js';
import { selectLevel } from './select-level.js';
import type { TextureLodSet } from './texture-lod-set.js';
import type { Camera, Material, Mesh, Texture } from 'three';
import type {
  DistanceMode,
  ResidencyMode,
  TextureLodManagerOptions,
  TextureLodStats,
  TextureLodLevel,
} from './types.js';

/**
 * マネージャがセットに求める最小の構造。
 *
 * ADR: `add` を `TextureLodSet<M>` に対して総称化しつつ、内部ではこの構造型で保持する。
 * 具象マテリアル型ごとに `Map` を分けずに済み、`variant()` の戻りは `Material` として扱える。
 * `TextureLodSet<M>` は `baseMaterial`・`variant()` の共変位置のみで `M` を露出するため、
 * この構造への代入に追加の型主張は要らない。
 */
interface ManagedSet {
  readonly baseMaterial: Material;
  readonly levels: readonly TextureLodLevel[];
  readonly thresholds: readonly number[];
  readonly hysteresis: number;
  variant(level: number): Material;
}

interface ManagedEntry {
  readonly set: ManagedSet;
  level: number | null;
}

/** 追跡中のテクスチャ1件分の常駐状態。 */
interface TrackedTexture {
  /** 現在いくつの割当レベルから参照されているか。 */
  refs: number;
  /** 最後に使われた（または登録された）時刻。`now()` 基準のミリ秒。 */
  lastUsedAt: number;
  /** このテクスチャを最粗レベルに使う登録済みset数。0より大きければ常駐し、破棄対象にならない。 */
  pins: number;
  /** このテクスチャを含む登録済みset数。0になったら追跡から外す。 */
  registeredBy: number;
  /** 破棄済みなら true。再使用時に false へ戻す（再アップロードは three に任せる）。 */
  evicted: boolean;
}

/**
 * テクスチャLODマネージャ。複数メッシュのレベル判定と常駐管理を受け持つ。
 *
 * 毎フレーム描画前に {@link TextureLodManager.update} を呼ぶこと。
 * ヒステリシス幅・境界はセット側が保持し（レベル定義とバンドは不可分でset生成時に検証できるため）、
 * マネージャは判定の実行と参照カウントのみを担当する。
 */
export class TextureLodManager {
  private readonly distanceMode: DistanceMode;
  private readonly residency: ResidencyMode;
  private readonly evictDelayMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<Mesh, ManagedEntry>();
  /** ADR: 異なるsetが同じ Texture オブジェクトを共有しても参照カウントが壊れないよう、追跡は Texture 単位で行う。 */
  private readonly tracked = new Map<Texture, TrackedTexture>();
  /**
   * setごとの使用メッシュ数。
   *
   * ADR: `remove` 後も追跡が残り続けないよう、set単位の登録数を数える。
   * 同じsetを使うメッシュが1件でも残る間はテクスチャを追跡し続け、
   * 0件になったら登録を解除する（テクスチャの破棄はしない）。
   */
  private readonly setRefs = new Map<ManagedSet, number>();
  private switchCount = 0;

  /**
   * @param options - 動作オプション。省略時は既定値（surface / evict / 5000ms）が補われる。
   */
  constructor(options?: TextureLodManagerOptions) {
    this.distanceMode = options?.distanceMode ?? 'surface';
    this.residency = options?.residency ?? 'evict';
    this.evictDelayMs = options?.evictDelayMs ?? 5000;
    this.now = options?.now ?? (() => performance.now());
  }

  /**
   * メッシュとセットを登録する。初回 `update` まではマテリアルに触れない。
   *
   * @param mesh - 管理対象メッシュ。
   * @param set - そのメッシュ用のLODセット。
   * @throws `Error` — `mesh` が登録済みの場合。
   */
  add<M extends Material>(mesh: Mesh, set: TextureLodSet<M>): void {
    if (this.entries.has(mesh)) {
      throw new Error('mesh は既に登録されています');
    }
    const at = this.now();
    const using = this.setRefs.get(set) ?? 0;
    // ADR: 同じsetの2件目以降は追跡への登録を重ねない。
    // テクスチャの登録はset単位であり、メッシュ数では増やさないためである。
    if (using === 0) {
      this.registerSet(set, at);
    }
    this.setRefs.set(set, using + 1);
    this.entries.set(mesh, { set, level: null });
  }

  /**
   * 登録を解除し、`mesh.material` をベースマテリアルに戻す。
   *
   * @param mesh - 登録済みメッシュ。
   * @throws `Error` — `mesh` が未登録の場合。
   */
  remove(mesh: Mesh): void {
    const entry = this.entries.get(mesh);
    if (entry === undefined) {
      throw new Error('mesh は登録されていません');
    }
    if (entry.level !== null) {
      this.release(entry.set, entry.level, this.now());
    }
    mesh.material = entry.set.baseMaterial;
    this.entries.delete(mesh);
    // ADR: `release` の後で登録解除する。`registeredBy === 0` で追跡から消すため、
    // 先に消すと参照カウントの減算先がなくなる。
    const using = (this.setRefs.get(entry.set) ?? 0) - 1;
    if (using <= 0) {
      this.setRefs.delete(entry.set);
      this.unregisterSet(entry.set);
    } else {
      this.setRefs.set(entry.set, using);
    }
  }

  /**
   * 全登録メッシュのレベル判定を行い、変化があればマテリアルを差し替える。描画前に毎フレーム呼ぶ。
   *
   * @param camera - 基準カメラ。
   * @remarks
   * 判定前に `mesh.updateWorldMatrix(true, false)` と `camera.updateWorldMatrix(true, false)` を呼ぶ。
   * アプリがまだ行列更新していないタイミングで呼ばれても正しくなるための措置である。
   * `mesh.visible === false` のメッシュは判定を飛ばし、現在のレベルと参照を保持する。
   * 距離が非有限（`NaN`・無限大）のメッシュも判定を飛ばし、現在のレベルと参照を保持する。
   * 不正な transform は本来シーン側のバグだが、1オブジェクトのために全LOD更新を止めないための措置である。
   */
  update(camera: Camera): void {
    const at = this.now();
    camera.updateWorldMatrix(true, false);
    for (const [mesh, entry] of this.entries) {
      // ADR: ワールド行列の更新はマネージャ側で行う。
      // アプリの render 呼び出し前に update される保証はなく、古い行列で判定すると
      // 1フレーム遅れではなく誤ったLODに張り付く恐れがあるため、判定の前提として自前で更新する。
      mesh.updateWorldMatrix(true, false);
      if (mesh.visible === false) {
        continue;
      }
      const distance = computeLodDistance(mesh, camera, this.distanceMode);
      // ADR: NaN 座標のメッシュ1件で `selectLevel` の RangeError がループ全体を中断し、
      // 後続メッシュが更新されなくなるのを防ぐため、非有限距離はスキップする。
      // 不正な transform は本来シーン側のバグだが、1オブジェクトで全LOD更新を止めない。
      if (!Number.isFinite(distance)) {
        continue;
      }
      const next = selectLevel(entry.level, distance, entry.set.thresholds, entry.set.hysteresis);
      if (entry.level !== next) {
        if (entry.level !== null) {
          this.release(entry.set, entry.level, at);
        }
        this.retain(entry.set, next, at);
        mesh.material = entry.set.variant(next);
        entry.level = next;
        this.switchCount++;
      }
    }
    if (this.residency === 'evict') {
      this.sweep(at);
    }
  }

  /**
   * メッシュの現在レベルを返す。
   *
   * @param mesh - 登録済みメッシュ。
   * @returns レベル番号。初回 `update` 前は `null`。
   * @throws `Error` — `mesh` が未登録の場合。
   */
  levelOf(mesh: Mesh): number | null {
    const entry = this.entries.get(mesh);
    if (entry === undefined) {
      throw new Error('mesh は登録されていません');
    }
    return entry.level;
  }

  /**
   * 稼働統計を返す。
   *
   * @returns 登録数・切替回数・レベル別台数・常駐推定バイト数。
   */
  stats(): TextureLodStats {
    let maxLevels = 0;
    for (const entry of this.entries.values()) {
      maxLevels = Math.max(maxLevels, entry.set.levels.length);
    }
    const levelCounts: number[] = new Array<number>(maxLevels).fill(0);
    for (const entry of this.entries.values()) {
      if (entry.level !== null) {
        levelCounts[entry.level]++;
      }
    }
    let residentBytes = 0;
    for (const [texture, tracked] of this.tracked) {
      if (!tracked.evicted) {
        residentBytes += estimateBytes(texture);
      }
    }
    return {
      objectCount: this.entries.size,
      switchCount: this.switchCount,
      levelCounts,
      residentBytes,
    };
  }

  /**
   * 全登録を解除し、追跡を消去する。テクスチャは破棄しない。
   *
   * メッシュのマテリアルはベースに戻す。テクスチャの寿命は利用者が持つ。
   */
  dispose(): void {
    for (const [mesh, entry] of this.entries) {
      mesh.material = entry.set.baseMaterial;
    }
    this.entries.clear();
    this.tracked.clear();
    this.setRefs.clear();
  }

  /** レベルのテクスチャ集合を求める（重複除去）。 */
  private static texturesOf(set: ManagedSet, level: number): Set<Texture> {
    return new Set<Texture>(Object.values(set.levels[level].textures));
  }

  /** setの全テクスチャを追跡に登録する（重複除去）。set単位の初回登録時のみ呼ぶ。 */
  private registerSet(set: ManagedSet, at: number): void {
    const coarsest = TextureLodManager.texturesOf(set, set.levels.length - 1);
    for (const texture of TextureLodManager.allTexturesOf(set)) {
      // Object.values の要素は Texture であることが set 生成時に検証済み。
      const tracked = this.tracked.get(texture);
      if (tracked === undefined) {
        this.tracked.set(texture, {
          refs: 0,
          lastUsedAt: at,
          // ADR: どれか一つのsetで最粗レベルに使われるテクスチャは常駐させる。
          // フォールバック先がGPUから消えると全LODが表示不能になるため、安全側に倒す。
          pins: coarsest.has(texture) ? 1 : 0,
          registeredBy: 1,
          evicted: false,
        });
      } else {
        tracked.registeredBy++;
        if (coarsest.has(texture)) {
          tracked.pins++;
        }
        tracked.lastUsedAt = at;
      }
    }
  }

  /**
   * setの登録を解除する。追跡から外すだけであり、テクスチャは破棄しない。
   *
   * ADR: テクスチャの寿命は利用者が持つ。`remove` は登録解除にすぎないため、
   * `dispose()` は呼ばない（破棄の判断は `evict` の猶予則に任せる）。
   */
  private unregisterSet(set: ManagedSet): void {
    const coarsest = TextureLodManager.texturesOf(set, set.levels.length - 1);
    for (const texture of TextureLodManager.allTexturesOf(set)) {
      const tracked = this.tracked.get(texture);
      if (tracked === undefined) {
        continue;
      }
      if (coarsest.has(texture)) {
        tracked.pins--;
      }
      tracked.registeredBy--;
      if (tracked.registeredBy <= 0) {
        this.tracked.delete(texture);
      }
    }
  }

  /** setの全レベルのテクスチャ集合を求める（重複除去）。 */
  private static allTexturesOf(set: ManagedSet): Set<Texture> {
    const all = new Set<Texture>();
    for (const level of set.levels) {
      for (const texture of Object.values(level.textures)) {
        all.add(texture);
      }
    }
    return all;
  }

  /** 使用開始側の参照カウント操作。破棄済みの再使用は `evicted` を戻すだけにする。 */
  private retain(set: ManagedSet, level: number, at: number): void {
    for (const texture of TextureLodManager.texturesOf(set, level)) {
      const tracked = this.tracked.get(texture);
      if (tracked === undefined) {
        continue;
      }
      tracked.refs++;
      tracked.lastUsedAt = at;
      tracked.evicted = false;
    }
  }

  /** 使用終了側の参照カウント操作。新旧レベルで共有されるテクスチャは差分のみ動かす。 */
  private release(set: ManagedSet, level: number, at: number): void {
    for (const texture of TextureLodManager.texturesOf(set, level)) {
      const tracked = this.tracked.get(texture);
      if (tracked === undefined) {
        continue;
      }
      tracked.refs--;
      // ADR: 時刻は呼び出し元の update と同一の `at` を使う。
      // 1回の update 内で時刻源が進むと破棄猶予の判定がぶれるため、注入時計の値で統一する。
      tracked.lastUsedAt = at;
    }
  }

  /** 猶予を過ぎた未参照・非常駐テクスチャを破棄する。 */
  private sweep(at: number): void {
    for (const [texture, tracked] of this.tracked) {
      if (tracked.refs === 0 && tracked.pins === 0 && !tracked.evicted) {
        if (at - tracked.lastUsedAt >= this.evictDelayMs) {
          texture.dispose();
          tracked.evicted = true;
        }
      }
    }
  }
}

/**
 * 常駐テクスチャの推定バイト数を求める。
 *
 * RGBA8（1画素4バイト）にミップマップ係数 4/3 を掛けた推定値であり、実測値ではない。
 * 画像を持たないテクスチャは 0 とみなす。
 * `texture.mipmaps` 等の個別ミップは考慮しない（係数 4/3 に折り込み済みの概算とする）。
 */
function estimateBytes(texture: Texture): number {
  // ADR: `texture.image` の型は three のバージョンで `any` のため、
  // `as` ではなく `unknown` 経由の絞り込みで幅・高さだけを安全に読む。
  // 幅・高さが数値でなければ 0 とみなし、推定値としての性質を保つ。
  const image: unknown = texture.image;
  let width = 0;
  let height = 0;
  if (typeof image === 'object' && image !== null) {
    const { width: w, height: h } = image as { width?: unknown; height?: unknown };
    if (typeof w === 'number' && Number.isFinite(w)) {
      width = w;
    }
    if (typeof h === 'number' && Number.isFinite(h)) {
      height = h;
    }
  }
  return (width * height * 4 * 4) / 3;
}
