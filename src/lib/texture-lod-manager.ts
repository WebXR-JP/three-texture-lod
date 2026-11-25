/**
 * 登録グループの毎フレームLOD更新とテクスチャ常駐管理。
 *
 * @packageDocumentation
 */
import { computeLodDistance } from './lod-distance.js';
import { selectLevel } from './select-level.js';
import {
  DEFAULT_MAX_SCALE,
  DEFAULT_MIN_SCALE,
  DEFAULT_RAISE_COOLDOWN_MS,
  DEFAULT_RAISE_HEADROOM,
  DEFAULT_RAISE_INTERVAL_MS,
  DEFAULT_STEPS_PER_OCTAVE,
  buildScaleLadder,
  stepLodBudget,
  validateScaleOptions,
} from './threshold-scale.js';
import type { LodBudgetState } from './threshold-scale.js';
import type { TextureLodSet } from './texture-lod-set.js';
import type { Camera, Material, Mesh, Texture } from 'three';
import type {
  AdaptiveThresholdScaleOptions,
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
  /**
   * 直近の `update()` の pass1 で測った距離。`null` は維持を表す。
   *
   * `anchor.visible === false` または非有限距離のとき `null` になり、
   * pass2 の判定と予測の両方で現在レベルを保つ。
   */
  distance: number | null;
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
  private maxResidentBytes: number | null;
  /**
   * 現在の距離しきい値スケール。判定は `distance / scale` で行う。
   *
   * ADR: しきい値配列を掛け算で書き換えず距離側を割るのは、`addGroup` の base thresholds
   * 一致検証をそのまま保つためである。`scale = 1` のとき `d / 1` は厳密に `d` であり、
   * 既定挙動はビット単位で不変になる（`thresholds[0] === 0` も不変）。
   */
  private thresholdScaleValue: number;
  /**
   * 自動スケールの正規化済み調整値。非自動時は `null`。
   *
   * ADR: `Required<...>` に正規化して保持するのは、`update()` 内の毎フレーム判定で
   * 既定値の補完を繰り返さないためである。検証は生成時に済ませる。
   */
  private readonly adaptiveOptions: Required<AdaptiveThresholdScaleOptions> | null;
  /** 自動スケール用のラダー。非自動時は `null`。 */
  private readonly scaleLadder: readonly number[] | null;
  /** 自動スケール用の制御状態。非自動時は `null`。 */
  private scaleState: LodBudgetState | null;
  private scaleLowerCount = 0;
  private scaleRaiseCount = 0;
  private evictCount = 0;
  /**
   * 選択できる最も細かいレベル。既定は `0`。
   *
   * ADR: ライブラリは解像度を知らないためレベル番号で上限をかける。
   * 予算適応時はこの値を下限とする自動上限の起点になり、
   * 予測・選択・保持のすべてに一貫して適用する。
   */
  private finestLevelValue: number;
  /** 上限を粗くした累計回数（`cap` 増加時）。非自動時は `0`。 */
  private levelCapLowerCount = 0;
  /** 上限を細かく戻した累計回数（`cap` 減少時）。非自動時は `0`。 */
  private levelCapRaiseCount = 0;
  /**
   * 効果のある上限候補。昇順、先頭は手動下限、末尾は最粗である。
   *
   * ADR: 前後で予測が変わらない上限は候補に入れない。引き上げ時に
   * 効果のない段を踏むと予測が同じで `hold` が続き、収束判定がぶれるためである。
   * 登録・解除・`setFinestLevel` で汚し、次の `update` 前に作り直す。
   */
  private budgetCaps: readonly number[] = [0];
  /** `budgetCaps` を作り直す必要がある場合に `true`。 */
  private capsDirty = true;
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
    const adaptiveRaw = options?.adaptiveThresholdScale;
    // ADR: `null` は `false` と同じく無効扱いにする。型上は `boolean | オブジェクト` だが、
    // 実行時に `null` が渡っても分かりにくく落ちないよう、明示的に無効として受け入れる。
    const adaptiveEnabled =
      adaptiveRaw !== undefined && adaptiveRaw !== false && adaptiveRaw !== null;
    if (adaptiveEnabled && this.residency === 'keep-all') {
      throw new Error("adaptiveThresholdScale は residency: 'keep-all' と併用できません");
    }
    if (options?.thresholdScale !== undefined && adaptiveEnabled) {
      throw new Error('thresholdScale と adaptiveThresholdScale は同時指定できません');
    }
    if (options?.thresholdScale !== undefined) {
      if (!Number.isFinite(options.thresholdScale) || options.thresholdScale <= 0) {
        throw new RangeError(
          `thresholdScale は0より大きい有限値である必要があります: ${String(options.thresholdScale)}`,
        );
      }
    }
    // 直接比較で書くのは、後段の分岐で `adaptiveRaw` の型絞り込みを保つためである。
    if (adaptiveRaw === undefined || adaptiveRaw === false || adaptiveRaw === null) {
      this.adaptiveOptions = null;
      this.scaleLadder = null;
      this.scaleState = null;
      this.thresholdScaleValue = options?.thresholdScale ?? 1;
    } else {
      const source: AdaptiveThresholdScaleOptions = adaptiveRaw === true ? {} : adaptiveRaw;
      const normalized: Required<AdaptiveThresholdScaleOptions> = {
        minScale: source.minScale ?? DEFAULT_MIN_SCALE,
        maxScale: source.maxScale ?? DEFAULT_MAX_SCALE,
        stepsPerOctave: source.stepsPerOctave ?? DEFAULT_STEPS_PER_OCTAVE,
        raiseIntervalMs: source.raiseIntervalMs ?? DEFAULT_RAISE_INTERVAL_MS,
        raiseCooldownMs: source.raiseCooldownMs ?? DEFAULT_RAISE_COOLDOWN_MS,
        raiseHeadroom: source.raiseHeadroom ?? DEFAULT_RAISE_HEADROOM,
        levelCap: source.levelCap ?? true,
      };
      // ADR: `buildScaleLadder` 経由の検証にするのは、不正な刻みでもラダー生成と同じ
      // `RangeError` で弾くためである。残りの範囲は `validateScaleOptions` で検査する。
      validateScaleOptions(normalized);
      this.adaptiveOptions = normalized;
      this.scaleLadder = buildScaleLadder(
        normalized.minScale,
        normalized.maxScale,
        normalized.stepsPerOctave,
      );
      this.scaleState = { index: 0, cap: 0, lastLowerAt: null, lastRaiseCheckAt: null };
      this.thresholdScaleValue = this.scaleLadder[0] as number;
    }
    this.now = options?.now ?? (() => performance.now());
    const finestLevel = options?.finestLevel ?? 0;
    if (!Number.isInteger(finestLevel) || finestLevel < 0) {
      throw new RangeError(`finestLevel は0以上の整数である必要があります: ${String(finestLevel)}`);
    }
    this.finestLevelValue = finestLevel;
    if (this.adaptiveOptions !== null) {
      this.refreshBudgetCaps();
    }
  }

  /**
   * 選択できる最も細かいレベルを変える。次の `update()` から有効になる。
   *
   * 設定だけでは `levelOf` は変わらない。非表示で保持中のグループにも
   * 次の `update()` で上限をかける。
   *
   * @param level - 上限レベル番号。整数かつ `0` 以上。
   * @throws `RangeError` — 非整数または負の場合。
   */
  setFinestLevel(level: number): void {
    if (!Number.isInteger(level) || level < 0) {
      throw new RangeError(`finestLevel は0以上の整数である必要があります: ${String(level)}`);
    }
    this.finestLevelValue = level;
    if (this.adaptiveOptions !== null) {
      // ADR: 手動下限の上昇で旧 `cap` が下限より細く残らないよう、候補を作り直して寄せる。
      // 下降時は旧 `cap` を保ち、次の `update` での収束に任せる。
      this.refreshBudgetCaps();
    }
  }

  /**
   * グループに効く上限を求める。
   *
   * ADR: レベル数の少ないセットでは最粗（`length - 1`）でクランプする。
   * 上限番号より粗い側だけを使うための措置であり、範囲外レベルを作らない。
   */
  private effectiveCap(thresholdsLength: number): number {
    const cap =
      this.adaptiveOptions !== null && this.scaleState !== null
        ? this.scaleState.cap
        : this.finestLevelValue;
    return Math.min(cap, thresholdsLength - 1);
  }

  /**
   * 統計に載せる実効上限を求める。
   *
   * グループがないときは候補の起点である手動値そのままを返し、空の上限を指さない。
   * グループがあるときは適応中であれば `caps` に正規化された自動状態の値を返し、
   * 非適応時は手動値を最大レベルで丸めた値を返す。
   */
  private currentFinestLevel(): number {
    // ADR: `stats()` は表示用の純粋計算だけを行い、次回 update の状態を変えない。
    // 汚れていても `budgetCaps` / `scaleState.cap` を書き換えず、その場で候補を求めて丸める。
    // HUD が高頻度で `stats()` を呼んでも、体数操作の前後で `update` の判定は変わらない。
    if (this.groups.size === 0) {
      return this.finestLevelValue;
    }
    if (this.adaptiveOptions !== null && this.scaleState !== null) {
      const caps = this.capsDirty ? this.computeBudgetCaps() : this.budgetCaps;
      const current = this.scaleState.cap;
      let next = caps[0] as number;
      for (const c of caps) {
        if (c <= current) {
          next = c;
        } else {
          break;
        }
      }
      return next;
    }
    let maxLevel = 0;
    for (const group of this.groups) {
      maxLevel = Math.max(maxLevel, group.thresholds.length - 1);
    }
    return Math.min(this.finestLevelValue, maxLevel);
  }

  /**
   * 効果のある上限候補を求める（純粋計算）。
   *
   * グループがあるときは実効 `maxLevel`（グループの段数の最大-1）と
   * `base = min(finestLevel, maxLevel)` を起点に、`base+1..maxLevel` のうち
   * いずれかの登録setで前段と1スロットでも異なる段だけを残す。
   * グループがないときは `maxLevel` を使わず `base = finestLevel` とし、`caps=[base]` にする。
   * 候補が空の上限を指さないための措置である。
   * `levelCap: false` のときはグループ有無にかかわらず `[base]` 固定でスケールのみにする。
   */
  private computeBudgetCaps(): readonly number[] {
    if (this.groups.size === 0) {
      return [this.finestLevelValue];
    }
    let maxLevel = 0;
    for (const group of this.groups) {
      maxLevel = Math.max(maxLevel, group.thresholds.length - 1);
    }
    const base = Math.min(this.finestLevelValue, maxLevel);
    if (this.adaptiveOptions !== null && this.adaptiveOptions.levelCap === false) {
      return [base];
    }
    const effective: number[] = [base];
    for (let c = base + 1; c <= maxLevel; c++) {
      if (this.isEffectiveCap(c)) {
        effective.push(c);
      }
    }
    return effective;
  }

  /**
   * 効果のある上限候補を作り直して状態に確定する。
   *
   * `computeBudgetCaps` で求めた候補を `budgetCaps` に置き、
   * `state.cap` を「候補以下で最大」に寄せる。`update()` の先頭などで呼ぶ。
   */
  private refreshBudgetCaps(): void {
    const caps = this.computeBudgetCaps();
    this.budgetCaps = caps;
    this.capsDirty = false;
    if (this.scaleState !== null) {
      const current = this.scaleState.cap;
      let next = caps[0] as number;
      for (const c of caps) {
        if (c <= current) {
          next = c;
        } else {
          break;
        }
      }
      if (next !== current) {
        this.scaleState = { ...this.scaleState, cap: next };
      }
    }
  }

  /**
   * 上限 `c` が前段と実質的に異なるかを判定する。
   *
   * いずれかの登録setで `levels[c]` と `levels[c-1]` のテクスチャが
   * 1スロットでも異なれば効果ありとする。段数不足のsetは対象外である。
   *
   * @param c - 判定する上限レベル番号。
   * @returns 効果があれば `true`。
   */
  private isEffectiveCap(c: number): boolean {
    for (const set of this.setRefs.keys()) {
      if (c >= set.levels.length || c - 1 < 0) {
        continue;
      }
      const current = set.levels[c].textures as Readonly<Partial<Record<string, unknown>>>;
      const prev = set.levels[c - 1].textures as Readonly<Partial<Record<string, unknown>>>;
      const keys = new Set([...Object.keys(current), ...Object.keys(prev)]);
      for (const key of keys) {
        if (current[key] !== prev[key]) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * 固定の距離しきい値スケールを変える。次の `update()` から有効になる。
   *
   * @param scale - 有限かつ `0` より大きいこと。
   * @throws `RangeError` — 非有限または `0` 以下の場合。
   * @throws `Error` — 自動スケール (`adaptiveThresholdScale`) 有効時の場合。
   */
  setThresholdScale(scale: number): void {
    if (this.adaptiveOptions !== null) {
      throw new Error('adaptiveThresholdScale 有効時は setThresholdScale を使えません');
    }
    if (!Number.isFinite(scale) || scale <= 0) {
      throw new RangeError(`thresholdScale は0より大きい有限値である必要があります: ${String(scale)}`);
    }
    this.thresholdScaleValue = scale;
  }

  /**
   * 常駐上限を変える。次の `update()` から有効になる。
   *
   * @param bytes - `0` 以上の有限値、または上限なしの `null`。
   * @throws `RangeError` — 負・非有限の場合。
   * @throws `Error` — `residency: 'keep-all'` で非 `null` の場合。
   */
  setMaxResidentBytes(bytes: number | null): void {
    if (bytes !== null) {
      if (!Number.isFinite(bytes) || bytes < 0) {
        throw new RangeError(`maxResidentBytes は0以上の有限値である必要があります: ${String(bytes)}`);
      }
      if (this.residency === 'keep-all') {
        throw new Error("maxResidentBytes は residency: 'keep-all' と併用できません");
      }
    }
    this.maxResidentBytes = bytes;
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
      distance: null,
    };
    this.groups.add(group);
    for (const binding of bindings) {
      this.groupOfMesh.set(binding.mesh, group);
    }
    if (this.adaptiveOptions !== null) {
      this.capsDirty = true;
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
    if (this.adaptiveOptions !== null) {
      this.capsDirty = true;
    }
  }

  /**
   * 全グループのレベル判定を行い、変化があればマテリアルを差し替える。描画前に毎フレーム呼ぶ。
   *
   * 処理は3段である。pass1で全グループの `computeLodDistance` を測って保持し、
   * 自動スケール時は `stepThresholdScale` を1回だけ呼んでスケールを決め、
   * pass2で `distance / scale` の判定に従来どおり retain/release/差し替えを行う。最後に掃引する。
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
    // pass1: 距離の計測。維持の場合は `distance` に `null` を残す。
    for (const group of this.groups) {
      // ADR: ワールド行列の更新はマネージャ側で行う。
      // アプリの render 呼び出し前に update される保証はなく、古い行列で判定すると
      // 1フレーム遅れではなく誤ったLODに張り付く恐れがあるため、判定の前提として自前で更新する。
      group.anchor.updateWorldMatrix(true, false);
      if (group.anchor.visible === false) {
        group.distance = null;
        continue;
      }
      const distance = computeLodDistance(group.anchor, camera, this.distanceMode);
      // ADR: NaN 座標の anchor 1件で `selectLevel` の RangeError がループ全体を中断し、
      // 後続グループが更新されなくなるのを防ぐため、非有限距離はスキップする。
      // 不正な transform は本来シーン側のバグだが、1グループで全LOD更新を止めない。
      if (!Number.isFinite(distance)) {
        group.distance = null;
        continue;
      }
      group.distance = distance;
    }
    // 自動スケール: 予測常駐量と予算を比べて2軸で1回だけ切り替える。
    if (this.adaptiveOptions !== null && this.scaleLadder !== null && this.scaleState !== null) {
      if (this.capsDirty) {
        this.refreshBudgetCaps();
      }
      const caps = this.budgetCaps;
      // ADR: `set.levels` は登録後に不変のため、レベルごとのテクスチャ配列を update 内で使い回す。
      // `predict` は走査で複数回呼ばれるため、毎回の `Object.values` 走査を抑える。
      // 過度な最適化はせず、update を抜けたら捨てる一時キャッシュに留める。
      const levelCache = new Map<TextureLodSetContract<Material>, (readonly Texture[])[]>();
      const texturesOfLevel = (
        set: TextureLodSetContract<Material>,
        level: number,
      ): readonly Texture[] => {
        let perLevel = levelCache.get(set);
        if (perLevel === undefined) {
          perLevel = [];
          levelCache.set(set, perLevel);
        }
        let cached = perLevel[level];
        if (cached === undefined) {
          cached = [...TextureLodManager.texturesOf(set, level)];
          perLevel[level] = cached;
        }
        return cached;
      };
      // ADR: 予算未設定時は `predict` が呼ばれず段階上げだけになるため Map は作られない。
      // 予算ありでは超過判定で現位置を必ず1回予測するため、初回呼び出し時に作る。
      let bytesOf: Map<Texture, number> | null = null;
      // ADR: `(scaleIndex, cap)` をキーに update 内でメモ化する。下げ走査で同じ候補を
      // 繰り返し予測しても `estimateBytes` の合計を重複計算しないための措置である。
      const predictCache = new Map<string, number>();
      const predict = (scale: number, cap: number): number => {
        const key = `${scale}|${cap}`;
        const hit = predictCache.get(key);
        if (hit !== undefined) {
          return hit;
        }
        // ADR: 候補レベルのテクスチャと全 set の最粗（pins 常駐分）の和集合で予測する。
        // `release` 後に参照0になったテクスチャも `pins` が残れば常駐するため、
        // 最粗分は候補によらず必ず含める。
        const union = new Set<Texture>();
        for (const group of this.groups) {
          const levelCap = Math.min(cap, group.thresholds.length - 1);
          let predicted: number | null;
          if (group.distance === null) {
            // ADR: 上限は資源制約のため、隠れている間の保持レベルにもかける。
            // 適用しないと held のまま上限超過が残る。初回（`null`）は維持する。
            predicted = group.level === null ? null : Math.max(group.level, levelCap);
          } else {
            const scaled = (group.distance as number) / scale;
            // ADR: 極小スケールでは `distance / scale` が非有限になり得る。
            // `selectLevel` の RangeError で1グループのために全LOD更新を止めないよう、
            // pass2 と同じく現レベル維持として予測に含める。
            // いずれも上限は `max` で一貫してかける。
            const raw = Number.isFinite(scaled)
              ? selectLevel(group.level, scaled, group.thresholds, group.hysteresis)
              : group.level;
            predicted = raw === null ? null : Math.max(raw, levelCap);
          }
          for (const binding of group.bindings) {
            if (predicted !== null) {
              for (const texture of texturesOfLevel(binding.set, predicted)) {
                union.add(texture);
              }
            }
            const coarsest = binding.set.levels.length - 1;
            for (const texture of texturesOfLevel(binding.set, coarsest)) {
              union.add(texture);
            }
          }
        }
        if (bytesOf === null) {
          bytesOf = new Map<Texture, number>();
          for (const texture of this.tracked.keys()) {
            bytesOf.set(texture, estimateBytes(texture));
          }
        }
        let total = 0;
        for (const texture of union) {
          total += bytesOf.get(texture) ?? estimateBytes(texture);
        }
        predictCache.set(key, total);
        return total;
      };
      const beforeIndex = this.scaleState.index;
      const beforeCap = this.scaleState.cap;
      const result = stepLodBudget(
        this.scaleLadder,
        { ...this.scaleState, cap: beforeCap },
        { now: at, budgetBytes: this.maxResidentBytes, caps, predict },
        this.adaptiveOptions,
      );
      this.scaleState = result.state;
      this.thresholdScaleValue = this.scaleLadder[result.state.index] as number;
      // ADR: 回数は軸ごとに実際に動いたときだけ数える。末尾での連続 `floor` は変化なしのため数えない。
      // ラダーは先頭が最大のため、下げは index 増加・上げは index 減少になる。
      // `cap-lower` でスケールが先頭へ戻るときは両軸が動くため、両方を数える。
      if (result.state.index > beforeIndex) {
        this.scaleLowerCount++;
      } else if (result.state.index < beforeIndex) {
        this.scaleRaiseCount++;
      }
      if (result.state.cap > beforeCap) {
        this.levelCapLowerCount++;
      } else if (result.state.cap < beforeCap) {
        this.levelCapRaiseCount++;
      }
    }
    // pass2: `distance / scale` の判定に上限をかける。保持グループにも上限を適用する。
    for (const group of this.groups) {
      const cap = this.effectiveCap(group.thresholds.length);
      const applyLevel = (next: number): void => {
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
      };
      const distance = group.distance;
      if (distance === null) {
        // ADR: 上限は資源制約のため、非表示・非有限距離の保持レベルにもかける。
        // かけないと held のまま上限より細かいレベルが残る。初回（`null`）は維持する。
        if (group.level !== null) {
          applyLevel(Math.max(group.level, cap));
        }
        continue;
      }
      const scaled = (distance as number) / this.thresholdScaleValue;
      // ADR: 極小スケール（例: 1e-310）では `distance / scale` が非有限になり得る。
      // `selectLevel` の RangeError で1グループのために全LOD更新を止めないよう、
      // 予測と同じく現レベル維持として扱い、上限だけはかける。
      if (!Number.isFinite(scaled)) {
        if (group.level !== null) {
          applyLevel(Math.max(group.level, cap));
        }
        continue;
      }
      // 初回（`level === null`）も同じ式で上限をかける。段数の少ないセットは
      // `effectiveCap` 側で最粗に丸めてあるため、範囲外レベルにならない。
      // `release`/`retain` は上限適用後のレベルで行う。
      const next = Math.max(selectLevel(group.level, scaled, group.thresholds, group.hysteresis), cap);
      applyLevel(next);
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
   * @returns 登録数・切替回数・レベル別台数・常駐推定バイト数・上限と破棄回数・スケールと必要量・
   * Tier上限とピン留め量。適応時は `finestLevel` が実効上限（`cap`）になる。
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
    let requiredBytes = 0;
    let pinnedBytes = 0;
    for (const [texture, tracked] of this.tracked) {
      if (!tracked.evicted) {
        const bytes = estimateBytes(texture);
        residentBytes += bytes;
        // ADR: `release` 後に参照0になったテクスチャも `pins` が残れば常駐のため、
        // 必要量には `refs > 0 || pins > 0` の両方を含める。set の最粗テクスチャは
        // `pins` で常駐し、予測の和集合にも必ず含まれる側である。
        if (tracked.refs > 0 || tracked.pins > 0) {
          requiredBytes += bytes;
        }
        if (tracked.pins > 0) {
          pinnedBytes += bytes;
        }
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
      thresholdScale: this.thresholdScaleValue,
      requiredBytes,
      scaleLowerCount: this.scaleLowerCount,
      scaleRaiseCount: this.scaleRaiseCount,
      finestLevel: this.currentFinestLevel(),
      pinnedBytes,
      levelCapLowerCount: this.levelCapLowerCount,
      levelCapRaiseCount: this.levelCapRaiseCount,
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
    if (this.adaptiveOptions !== null) {
      this.capsDirty = true;
    }
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
