/**
 * 登録グループの毎フレームLOD更新とテクスチャ常駐管理。
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
} from './types.js';

/**
 * マネージャがセットに求める最小の構造。
 *
 * ADR: `add` を `TextureLodSet<M>` に対して総称化しつつ、内部ではこの構造型で保持する。
 * 具象マテリアル型ごとに `Map` を分けずに済み、`variant()` の戻りは `Material` として扱える。
 * `TextureLodSet<M>` は `baseMaterial`・`variant()` の共変位置のみで `M` を露出するため、
 * この構造への代入に追加の型主張は要らない。
 * グループ内の複数セットが具象型をまたいでも（例: 結合メッシュ用と顔用の別型）、
 * `Material` までの共変で同一グループに載せられる。
 */
export interface TextureLodSetContract<M extends Material = Material> {
  /** 複製元マテリアル。 */
  readonly baseMaterial: M;
  /**
   * レベル定義。グループ内では全セットで境界・段数が一致していること。
   *
   * ADR: ここだけ `TextureLodLevel<M>` ではなく文字列キーの構造にしている。
   * `TextureLodLevel<M>` の `Partial<Record<TextureSlotOf<M>, ...>>` は
   * 共通キーを持たないカスタム Material では weak type 判定に掛かり、
   * `addGroup` が型エラーになるためである。実行時の値は set 生成時に検証済み。
   */
  readonly levels: readonly {
    readonly distance: number;
    readonly textures: Readonly<Partial<Record<string, Texture>>>;
  }[];
  /** `levels` から導出した境界配列。 */
  readonly thresholds: readonly number[];
  /** ヒステリシス幅。グループ内では全セットで一致していること。 */
  readonly hysteresis: number;
  /**
   * レベル番号に対応するマテリアルバリアントを返す。
   *
   * @param level - レベル番号。`0 <= level < levels.length`。
   */
  variant(level: number): M;
}

/**
 * グループ内の1束縛。mesh の material を set のバリアントへ切り替える。
 *
 * @typeParam M - セットの対象マテリアル型。既定は `Material` であり、
 * `TextureLodSet<MToon>` のような具象セットも共変で代入できる。
 */
export interface TextureLodBinding<M extends Material = Material> {
  /** 管理対象メッシュ。 */
  readonly mesh: Mesh;
  /** そのメッシュ用のLODセット。 */
  readonly set: TextureLodSetContract<M>;
}

/**
 * グループ登録時の選択肢。
 */
export interface TextureLodGroupOptions {
  /**
   * 距離計算の基準。
   *
   * 省略時は `bindings[0].mesh`。bindings に含まれなくてもよい。
   */
  readonly anchor?: Mesh;
}

/** 内部保持する1束縛。公開の束縛を `Material` までの共変で読み替えたものである。 */
interface ManagedBinding {
  readonly mesh: Mesh;
  readonly set: TextureLodSetContract<Material>;
}

/** 内部保持する1グループ。レベルはグループ全体で1つだけ持つ。 */
interface ManagedGroup {
  /** 距離計算の基準。bindings に含まれなくてもよい。 */
  readonly anchor: Mesh;
  readonly bindings: readonly ManagedBinding[];
  /** 全束縛セットで一致していることが登録時に検証済みの境界。 */
  readonly thresholds: readonly number[];
  /** 全束縛セットで一致していることが登録時に検証済みのヒステリシス幅。 */
  readonly hysteresis: number;
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
 * `maxResidentBytes` を指定すると、常駐推定バイト数に上限を設け、
 * 超過分を未参照テクスチャから古い順に破棄する（現用中と最粗レベルは守る）。
 * 毎フレーム描画前に {@link TextureLodManager.update} を呼ぶこと。
 * ヒステリシス幅・境界はセット側が保持し（レベル定義とバンドは不可分でset生成時に検証できるため）、
 * マネージャは判定の実行と参照カウントのみを担当する。
 * 同一距離で連動させる複数メッシュは {@link TextureLodManager.addGroup} で1グループに束ねる。
 * グループ内では anchor 1件の距離からレベルを1つだけ決め、全束縛に同じレベルを適用する。
 */
export class TextureLodManager {
  private readonly distanceMode: DistanceMode;
  private readonly residency: ResidencyMode;
  private readonly evictDelayMs: number;
  private readonly maxResidentBytes: number | null;
  private evictCount = 0;
  private readonly now: () => number;
  private readonly groups = new Set<ManagedGroup>();
  private readonly groupOfMesh = new Map<Mesh, ManagedGroup>();
  /** ADR: 異なるsetが同じ Texture オブジェクトを共有しても参照カウントが壊れないよう、追跡は Texture 単位で行う。 */
  private readonly tracked = new Map<Texture, TrackedTexture>();
  /**
   * setごとの使用束縛数。
   *
   * ADR: `remove` 後も追跡が残り続けないよう、set単位の登録数を数える。
   * 同じsetを使う束縛が1件でも残る間はテクスチャを追跡し続け、
   * 0件になったら登録を解除する（テクスチャの破棄はしない）。
   */
  private readonly setRefs = new Map<TextureLodSetContract<Material>, number>();
  private switchCount = 0;

  /**
   * @param options - 動作オプション。省略時は既定値（surface / evict / 5000ms）が補われる。
   */
  constructor(options?: TextureLodManagerOptions) {
    this.distanceMode = options?.distanceMode ?? 'surface';
    this.residency = options?.residency ?? 'evict';
    this.evictDelayMs = options?.evictDelayMs ?? 5000;
    const maxResidentBytes = options?.maxResidentBytes;
    if (maxResidentBytes !== undefined) {
      if (!Number.isFinite(maxResidentBytes) || maxResidentBytes < 0) {
        throw new RangeError(
          `maxResidentBytes は0以上の有限値である必要があります: ${String(maxResidentBytes)}`,
        );
      }
      if (this.residency === 'keep-all') {
        throw new Error("maxResidentBytes は residency: 'keep-all' と併用できません");
      }
    }
    this.maxResidentBytes = maxResidentBytes ?? null;
    this.now = options?.now ?? (() => performance.now());
  }

  /**
   * メッシュとセットを登録する。初回 `update` まではマテリアルに触れない。
   *
   * 単一束縛のグループとして {@link TextureLodManager.addGroup} に委譲する。
   *
   * @param mesh - 管理対象メッシュ。
   * @param set - そのメッシュ用のLODセット。
   * @throws `Error` — `mesh` が登録済みの場合。
   */
  add<M extends Material>(mesh: Mesh, set: TextureLodSet<M>): void {
    this.addGroup([{ mesh, set }]);
  }

  /**
   * 複数の束縛を1グループとして登録する。初回 `update` まではマテリアルに触れない。
   *
   * グループ内では anchor 1件の距離からレベルを1つだけ決め、全束縛に同じレベルを適用する。
   * そのため全セットの `thresholds`（長さ・各値）と `hysteresis` が完全一致していること。
   *
   * @param bindings - 1件以上の束縛。各 mesh は未登録であること。
   * @param options - anchor の指定。省略時は `bindings[0].mesh`。
   * @throws `Error` — `bindings` が空の場合。
   * @throws `Error` — 1件でも mesh が登録済みの場合。状態を変更する前に投げ、部分登録は残さない。
   * @throws `Error` — セット間で境界またはヒステリシス幅が違う場合。どちらが違うかを含める。
   */
  addGroup(bindings: readonly TextureLodBinding[], options?: TextureLodGroupOptions): void {
    if (bindings.length === 0) {
      throw new Error('bindings は1件以上必要です');
    }
    // ADR: 部分登録が残ると参照カウントと追跡がずれ、後続の remove で帳尻が合わなくなる。
    // 変更（setRefs・tracked・groups）の前に全件検証し、失敗時は状態を一切変えない。
    const seen = new Set<Mesh>();
    for (const binding of bindings) {
      if (this.groupOfMesh.has(binding.mesh) || seen.has(binding.mesh)) {
        throw new Error('mesh は既に登録されています');
      }
      seen.add(binding.mesh);
    }
    const reference = bindings[0].set;
    for (const binding of bindings) {
      if (
        binding.set.levels.length === 0 ||
        binding.set.levels.length !== binding.set.thresholds.length
      ) {
        throw new Error(
          `セットの levels と thresholds の件数が不正です: levels=${binding.set.levels.length}, thresholds=${binding.set.thresholds.length}`,
        );
      }
      if (
        binding.set.thresholds.length !== reference.thresholds.length ||
        binding.set.thresholds.some((threshold, index) => threshold !== reference.thresholds[index])
      ) {
        throw new Error(
          `グループ内の境界（thresholds）が一致していません: [${reference.thresholds.join(',')}] と [${binding.set.thresholds.join(',')}]`,
        );
      }
      if (binding.set.hysteresis !== reference.hysteresis) {
        throw new Error(
          `グループ内の hysteresis が一致していません: ${reference.hysteresis} と ${binding.set.hysteresis}`,
        );
      }
    }
    const at = this.now();
    for (const binding of bindings) {
      const using = this.setRefs.get(binding.set) ?? 0;
      // ADR: 同じsetの2件目以降は追跡への登録を重ねない。
      // テクスチャの登録はset単位であり、束縛数では増やさないためである。
      if (using === 0) {
        this.registerSet(binding.set, at);
      }
      this.setRefs.set(binding.set, using + 1);
    }
    const group: ManagedGroup = {
      anchor: options?.anchor ?? bindings[0].mesh,
      bindings: bindings.map((binding) => ({ mesh: binding.mesh, set: binding.set })),
      thresholds: reference.thresholds,
      hysteresis: reference.hysteresis,
      level: null,
    };
    this.groups.add(group);
    for (const binding of bindings) {
      this.groupOfMesh.set(binding.mesh, group);
    }
  }

  /**
   * 登録を解除し、`mesh` が属するグループ全体のマテリアルをベースに戻す。
   *
   * グループ単位の解除であり、同じグループの他メッシュも同時に外れる。
   * 各束縛の参照を解放し、set の登録数を減らす。
   *
   * @param mesh - 登録済みメッシュ。属するグループ全体が解除される。
   * @throws `Error` — `mesh` が未登録の場合。
   */
  remove(mesh: Mesh): void {
    const group = this.groupOfMesh.get(mesh);
    if (group === undefined) {
      throw new Error('mesh は登録されていません');
    }
    const at = this.now();
    if (group.level !== null) {
      for (const binding of group.bindings) {
        this.release(binding.set, group.level, at);
      }
    }
    for (const binding of group.bindings) {
      binding.mesh.material = binding.set.baseMaterial;
      this.groupOfMesh.delete(binding.mesh);
      // ADR: `release` の後で登録解除する。`registeredBy === 0` で追跡から消すため、
      // 先に消すと参照カウントの減算先がなくなる。
      const using = (this.setRefs.get(binding.set) ?? 0) - 1;
      if (using <= 0) {
        this.setRefs.delete(binding.set);
        this.unregisterSet(binding.set);
      } else {
        this.setRefs.set(binding.set, using);
      }
    }
    this.groups.delete(group);
  }

  /**
   * 全グループのレベル判定を行い、変化があればマテリアルを差し替える。描画前に毎フレーム呼ぶ。
   *
   * @param camera - 基準カメラ。
   * @remarks
   * 判定後に `residency: 'evict'` の場合は猶予破棄と上限破棄（`maxResidentBytes` 指定時）を行う。
   * 判定前に anchor と `camera` の `updateWorldMatrix(true, false)` を呼ぶ。
   * アプリがまだ行列更新していないタイミングで呼ばれても正しくなるための措置である。
   * anchor の `visible === false` の間は判定を飛ばし、現在のレベルと参照を保持する。
   * 距離が非有限（`NaN`・無限大）の場合も判定を飛ばし、現在のレベルと参照を保持する。
   * 不正な transform は本来シーン側のバグだが、1グループのために全LOD更新を止めないための措置である。
   */
  update(camera: Camera): void {
    const at = this.now();
    camera.updateWorldMatrix(true, false);
    for (const group of this.groups) {
      // ADR: ワールド行列の更新はマネージャ側で行う。
      // アプリの render 呼び出し前に update される保証はなく、古い行列で判定すると
      // 1フレーム遅れではなく誤ったLODに張り付く恐れがあるため、判定の前提として自前で更新する。
      group.anchor.updateWorldMatrix(true, false);
      if (group.anchor.visible === false) {
        continue;
      }
      const distance = computeLodDistance(group.anchor, camera, this.distanceMode);
      // ADR: NaN 座標の anchor 1件で `selectLevel` の RangeError がループ全体を中断し、
      // 後続グループが更新されなくなるのを防ぐため、非有限距離はスキップする。
      // 不正な transform は本来シーン側のバグだが、1グループで全LOD更新を止めない。
      if (!Number.isFinite(distance)) {
        continue;
      }
      const next = selectLevel(group.level, distance, group.thresholds, group.hysteresis);
      if (group.level !== next) {
        if (group.level !== null) {
          for (const binding of group.bindings) {
            this.release(binding.set, group.level, at);
          }
        }
        for (const binding of group.bindings) {
          this.retain(binding.set, next, at);
          binding.mesh.material = binding.set.variant(next);
        }
        group.level = next;
        this.switchCount++;
      }
    }
    if (this.residency === 'evict') {
      this.sweep(at);
    }
  }

  /**
   * メッシュの属するグループの現在レベルを返す。
   *
   * @param mesh - 登録済みメッシュ。
   * @returns レベル番号。初回 `update` 前は `null`。
   * @throws `Error` — `mesh` が未登録の場合。
   */
  levelOf(mesh: Mesh): number | null {
    const group = this.groupOfMesh.get(mesh);
    if (group === undefined) {
      throw new Error('mesh は登録されていません');
    }
    return group.level;
  }

  /**
   * 稼働統計を返す。
   *
   * @returns 登録数・切替回数・レベル別台数・常駐推定バイト数・上限と破棄回数。
   * `objectCount` と `levelCounts` はグループ単位で数える。
   * `maxResidentBytes` 指定時は上限超過分を `overBudgetBytes` で確認できる。
   */
  stats(): TextureLodStats {
    let maxLevels = 0;
    for (const group of this.groups) {
      maxLevels = Math.max(maxLevels, group.thresholds.length);
    }
    const levelCounts: number[] = new Array<number>(maxLevels).fill(0);
    for (const group of this.groups) {
      if (group.level !== null) {
        levelCounts[group.level]++;
      }
    }
    let residentBytes = 0;
    for (const [texture, tracked] of this.tracked) {
      if (!tracked.evicted) {
        residentBytes += estimateBytes(texture);
      }
    }
    return {
      objectCount: this.groups.size,
      switchCount: this.switchCount,
      levelCounts,
      residentBytes,
      budgetBytes: this.maxResidentBytes,
      overBudgetBytes:
        this.maxResidentBytes === null ? 0 : Math.max(0, residentBytes - this.maxResidentBytes),
      evictCount: this.evictCount,
    };
  }

  /**
   * 全登録を解除し、追跡を消去する。テクスチャは破棄しない。
   *
   * 全束縛のマテリアルはベースに戻す。テクスチャの寿命は利用者が持つ。
   */
  dispose(): void {
    for (const group of this.groups) {
      for (const binding of group.bindings) {
        binding.mesh.material = binding.set.baseMaterial;
      }
    }
    this.groups.clear();
    this.groupOfMesh.clear();
    this.tracked.clear();
    this.setRefs.clear();
  }

  /** レベルのテクスチャ集合を求める（重複除去）。 */
  private static texturesOf(set: TextureLodSetContract<Material>, level: number): Set<Texture> {
    const textures = set.levels[level].textures;
    const result = new Set<Texture>();
    for (const texture of Object.values(textures)) {
      if (texture !== undefined) {
        result.add(texture);
      }
    }
    return result;
  }

  /** setの全テクスチャを追跡に登録する（重複除去）。set単位の初回登録時のみ呼ぶ。 */
  private registerSet(set: TextureLodSetContract<Material>, at: number): void {
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
  private unregisterSet(set: TextureLodSetContract<Material>): void {
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
  private static allTexturesOf(set: TextureLodSetContract<Material>): Set<Texture> {
    const all = new Set<Texture>();
    for (const level of set.levels) {
      for (const texture of Object.values(level.textures)) {
        if (texture !== undefined) {
          all.add(texture);
        }
      }
    }
    return all;
  }

  /** 使用開始側の参照カウント操作。破棄済みの再使用は `evicted` を戻すだけにする。 */
  private retain(set: TextureLodSetContract<Material>, level: number, at: number): void {
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

  /** 使用終了側の参照カウント操作。全束縛を release し、その後 retain する。 */
  private release(set: TextureLodSetContract<Material>, level: number, at: number): void {
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

  /** テクスチャを1件破棄し、破棄回数を数える。 */
  private evict(texture: Texture, tracked: TrackedTexture): void {
    texture.dispose();
    tracked.evicted = true;
    this.evictCount++;
  }

  /**
   * 未参照・非常駐テクスチャを破棄する。
   *
   * 段1で猶予切れを破棄し、段2で `maxResidentBytes` 指定時のみ上限超過分を
   * 最終使用の古い順（同時刻なら推定バイトの大きい順）に破棄する。
   * 現用中・ピン留め（最粗レベル）はどちらの段でも守る。
   */
  private sweep(at: number): void {
    // 段1（従来どおり）: 猶予切れの破棄。
    for (const [texture, tracked] of this.tracked) {
      if (tracked.evicted) {
        continue;
      }
      if (tracked.refs === 0 && tracked.pins === 0) {
        if (at - tracked.lastUsedAt >= this.evictDelayMs) {
          this.evict(texture, tracked);
          continue;
        }
      }
    }
    if (this.maxResidentBytes === null) {
      return;
    }
    // 段2: 上限超過分の破棄。段1で残ったものの推定バイトを合計する。
    let resident = 0;
    const candidates: { texture: Texture; tracked: TrackedTexture; bytes: number }[] = [];
    for (const [texture, tracked] of this.tracked) {
      if (tracked.evicted) {
        continue;
      }
      const bytes = estimateBytes(texture);
      resident += bytes;
      if (tracked.refs === 0 && tracked.pins === 0 && bytes > 0) {
        candidates.push({ texture, tracked, bytes });
      }
    }
    const budget = this.maxResidentBytes;
    if (resident <= budget) {
      return;
    }
    candidates.sort((a, b) => a.tracked.lastUsedAt - b.tracked.lastUsedAt || b.bytes - a.bytes);
    for (const candidate of candidates) {
      if (resident <= budget) {
        break;
      }
      this.evict(candidate.texture, candidate.tracked);
      resident -= candidate.bytes;
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
