/**
 * 距離ベース・テクスチャLODの公開型。
 *
 * このモジュールは型宣言のみを持ち、実行時の three への依存は発生しない。
 * ライブラリ全体が three のクラスを値importしない設計であり、
 * WebGPU/WebGL2 両対応と GPU なし環境でのテストを可能にしている。
 *
 * @packageDocumentation
 */
import type { Camera, Material, Mesh, Object3D, Texture } from 'three';

/**
 * LOD切替の対象になる既知のテクスチャスロット。
 *
 * マテリアル型からスロットを導出できない場合（`Material` 基底型など）のフォールバック。
 * `MeshStandardMaterial` 系が持つ代表的なマップを並べている。
 * `colorNode` 等で独自に `texture()` を組んでいるマテリアルは自動LOD化の対象外であり、
 * {@link TextureLodSetOptions.createVariant} で個別に対応する。
 */
export type KnownTextureSlot =
  | 'map'
  | 'normalMap'
  | 'roughnessMap'
  | 'metalnessMap'
  | 'aoMap'
  | 'emissiveMap'
  | 'alphaMap';

/**
 * 後方互換のための別名。既知スロット集合と同じである。
 */
export type TextureSlot = KnownTextureSlot;

/**
 * マテリアル型から導出したテクスチャスロット名。
 *
 * `M` のキーのうち、値の型が `Texture | null | undefined` に代入可能なものを抽出する。
 * プロトタイプ上のアクセサで定義された `NodeMaterial` 系のスロットも型上はキーとして拾える。
 * 1件もなければ（`Material` 基底型など）既知スロットにフォールバックする。
 *
 * @typeParam M - 対象マテリアルの型。`Material` のサブタイプ。
 */
export type TextureSlotOf<M extends Material = Material> = [Extract<TextureKeyOf<M>, string>] extends [
  never,
]
  ? KnownTextureSlot
  : Extract<TextureKeyOf<M>, string>;

/**
 * テクスチャ値を持つプロパティ名だけを抜き出す中間型。
 *
 * ADR: `any` 型のプロパティ（`0 extends (1 & T)` で判定）は除外する。
 * `any` は条件型の両分岐を通るため、含めると `userData` のような非テクスチャまで
 * スロット扱いになり、`Material` 基底型でのフォールバックが壊れる。
 */
type TextureKeyOf<M extends Material> = {
  [K in keyof M]: 0 extends 1 & M[K] ? never : M[K] extends Texture | null | undefined ? K : never;
}[keyof M];

/**
 * 1段階分のLOD定義。解像度の異なる別テクスチャの組を表す。
 *
 * @typeParam M - 対象マテリアルの型。`Material` のサブタイプ。既定は `Material` であり、
 * その場合は既知スロットと同じになる。
 */
export interface TextureLodLevel<M extends Material = Material> {
  /**
   * このレベルに切り替わる距離（カメラからのメートル）。
   *
   * 先頭レベルは 0 であること。昇順に並べること。
   */
  readonly distance: number;
  /**
   * このレベルのスロットとテクスチャの組。
   *
   * 全レベルで同じスロット集合にすること。空集合は不可。
   */
  readonly textures: Readonly<Partial<Record<TextureSlotOf<M>, Texture>>>;
}

/**
 * 距離の測り方。
 *
 * - `center`: バウンディング球の中心からカメラまでの直線距離。
 * - `surface`: 中心距離からバウンディング球のワールド半径を引いた値（0でクランプ）。
 *   大きなオブジェクトがカメラに迫ったときに粗いLODへ落ちるのを防ぐ。
 */
export type DistanceMode = 'surface' | 'center';

/**
 * LODセットの生成オプション。
 *
 * @typeParam M - 対象マテリアルの型。`Material` のサブタイプ。
 */
export interface TextureLodSetOptions<M extends Material> {
  /** 複製元になるマテリアル。生成後に変更されることはない。 */
  readonly material: M;
  /** LODレベル定義。2件以上、先頭の距離は 0、距離は昇順。 */
  readonly levels: readonly TextureLodLevel<M>[];
  /**
   * ヒステリシス幅（0以上1未満の比率）。
   *
   * @defaultValue `0.1`（`createTextureLodSet` が補う）。
   */
  readonly hysteresis?: number;
  /**
   * バリアント生成処理を差し替えるフック。
   *
   * 省略時は `base.clone()` に各レベルのテクスチャを代入する。
   * `colorNode` 等で独自に `texture()` を組んでいるマテリアルは自動LOD化できないため、
   * このフックでレベルごとのノードグラフを組み直すこと。
   * フック指定時は戻り値がそのままバリアントになる（名前付けもフックの責任）。
   *
   * @param base - 複製元のマテリアル。
   * @param level - レベル定義。
   * @param levelIndex - レベル番号（0が最密）。
   * @returns そのレベル用のマテリアルバリアント。`base` とは別のマテリアルであること。
   * @remarks
   * {@link TextureLodSet.syncFromBase | syncFromBase} はカスタムノードを `base` の内容で
   * 上書きするため、フック利用時はその呼び出しで独自分が消えることに注意する。
   */
  readonly createVariant?: (base: M, level: TextureLodLevel<M>, levelIndex: number) => M;
}

/**
 * 使われていないテクスチャの扱い。
 *
 * - `keep-all`: 何も破棄しない。VRAMに余裕がある場合や、切替時の再アップロードを避けたい場合。
 * - `evict`: 一定時間使われなかったテクスチャを破棄する。最粗レベルのテクスチャは常駐する。
 */
export type ResidencyMode = 'keep-all' | 'evict';

/**
 * 距離しきい値の自動スケールの調整項目。
 *
 * `TextureLodManager` の `adaptiveThresholdScale` に `true` またはこのオブジェクトを渡すと、
 * `update()` ごとに予測常駐量と `maxResidentBytes` を比べてスケールを切り替える。
 * スケール `s` は判定距離を `d/s` に読み替え、境界配列の `s` 倍と等価になる。
 * `s = 1` のとき `d/1` は厳密に `d` のため、既定挙動はビット単位で不変である。
 */
export interface AdaptiveThresholdScaleOptions {
  /**
   * ラダーの下限。`0` より大きく `maxScale` 以下、有限であること。
   *
   * @defaultValue `0.05`
   */
  readonly minScale?: number;
  /**
   * ラダーの上限。有限であり `minScale` 以上であること。
   *
   * @defaultValue `1`
   */
  readonly maxScale?: number;
  /**
   * 1オクターブあたりの段数。`1` 以上 `64` 以下の整数であること。
   *
   * @defaultValue `4`
   */
  readonly stepsPerOctave?: number;
  /**
   * 引き上げ判定の最小間隔（ミリ秒）。`0` 以上の有限値であること。
   *
   * @defaultValue `1000`
   */
  readonly raiseIntervalMs?: number;
  /**
   * 引き下げ後の冷却期間（ミリ秒）。`0` 以上の有限値であること。
   * この期間内は引き上げ判定を行わない。引き下げ自体に間隔制限はない。
   *
   * @defaultValue `3000`
   */
  readonly raiseCooldownMs?: number;
  /**
   * 引き上げ余裕。`predict(1段上) <= raiseHeadroom * budget` のときだけ引き上げる。
   * `(0, 1]` の範囲であること。
   *
   * @defaultValue `0.9`
   */
  readonly raiseHeadroom?: number;
}

/**
 * {@link TextureLodManager} の生成オプション。
 */
export interface TextureLodManagerOptions {
  /**
   * 距離の測り方。
   *
   * @defaultValue `'surface'`（`TextureLodManager` が補う）。
   */
  readonly distanceMode?: DistanceMode;
  /**
   * 常駐管理の方針。
   *
   * @defaultValue `'evict'`（`TextureLodManager` が補う）。
   */
  readonly residency?: ResidencyMode;
  /**
   * `evict` 時に最終使用から破棄までの猶予（ミリ秒）。
   *
   * `Infinity` を指定すると時間経過では破棄せず、`maxResidentBytes` による容量のみのキャッシュにできる。
   *
   * @defaultValue `5000`（`TextureLodManager` が補う）。
   */
  readonly evictDelayMs?: number;
  /**
   * 常駐テクスチャ推定バイト数の上限。
   *
   * 超過時は未参照（`refs === 0`）かつ非ピン（`pins === 0`）のテクスチャを、
   * 最終使用の古い順（同時刻なら推定バイトの大きい順）に、猶予 `evictDelayMs` を待たず破棄する。
   * 現用中と最粗レベルのフォールバック先は破棄しないため、上限まで下げられない場合は超過を許容する
   * （{@link TextureLodStats.overBudgetBytes} で確認する）。
   * 判定は {@link TextureLodStats.residentBytes} と同じ推定値で行い、実VRAMではない。適用は `update()` 内のみ。
   * `residency: 'keep-all'` との併用は不可。
   *
   * @defaultValue 上限なし
   */
  readonly maxResidentBytes?: number;
  /**
   * 固定の距離しきい値スケール。有限かつ `0` より大きいこと。
   *
   * 判定距離を `d/scale` に読み替え、`thresholds` の `scale` 倍と等価になる。
   * `1` のとき既定挙動と同一である。設定だけでは `levelOf` は変わらず、次の `update()` から有効になる。
   * `adaptiveThresholdScale` との同時指定は不可。
   *
   * @defaultValue `1`
   */
  readonly thresholdScale?: number;
  /**
   * 距離しきい値の自動スケールの有効化。
   *
   * `true` で既定値による自動スケール、`false`（既定）で無効、オブジェクトで調整値の指定になる。
   * 有効時は予測常駐量が `maxResidentBytes` に収まるようラダー上を移動する。
   * `residency: 'keep-all'` および `thresholdScale` との併用は不可。
   * `maxResidentBytes` 未設定（`null`）の場合は引き上げだけを行う。
   *
   * @defaultValue `false`
   */
  readonly adaptiveThresholdScale?: boolean | AdaptiveThresholdScaleOptions;
  /**
   * 時刻源。テストで時間を操作するために注入する。
   *
   * @defaultValue `() => performance.now()`（`TextureLodManager` が補う）。
   */
  readonly now?: () => number;
}

/**
 * LODの稼働統計。
 */
export interface TextureLodStats {
  /** 登録中のグループ数。単一メッシュの `add` ではメッシュ数と一致する。 */
  readonly objectCount: number;
  /** これまでのレベル切替回数（初回の割当を含む）。 */
  readonly switchCount: number;
  /**
   * レベル番号を添字とするオブジェクト数。セットをまたいで集計する。
   *
   * 一度も更新されていないオブジェクトは含まない。
   */
  readonly levelCounts: readonly number[];
  /**
   * 常駐テクスチャの推定バイト数。
   *
   * RGBA8（1画素4バイト）にミップマップ係数 4/3 を掛けた `w*h*4*4/3` の合計であり、
   * 実測値ではなく推定値である。破棄済みのテクスチャは含まない。
   */
  readonly residentBytes: number;
  /** 設定された上限バイト数。未設定なら `null`。 */
  readonly budgetBytes: number | null;
  /** `max(0, residentBytes - budgetBytes)`。上限未設定なら 0。`stats()` 呼び出し時点の値。 */
  readonly overBudgetBytes: number;
  /**
   * 現在の距離しきい値スケール。
   *
   * 固定時は `thresholdScale`/`setThresholdScale` の値、自動時はラダー上の現在位置の値である。
   * 既定は `1` であり、このとき判定は従来どおりである。
   */
  readonly thresholdScale: number;
  /**
   * 必要常駐量の推定バイト数。
   *
   * 追跡中のうち `!evicted && (refs > 0 || pins > 0)` の `estimateBytes` 合計である。
   * `residentBytes` と違い、未参照の非ピン留めテクスチャ（いずれ破棄される分）を含まない。
   * `update()` 直後の値であり、`update` と `stats()` の間の `addGroup` や画像差し替えでは
   * 一時的に予算を超え得る（次の `update()` で解消する）。
   */
  readonly requiredBytes: number;
  /** 自動スケールで引き下げた累計回数（実際に段が下がった回数）。非自動時は `0`。 */
  readonly scaleLowerCount: number;
  /** 自動スケールで引き上げた累計回数。非自動時は `0`。 */
  readonly scaleRaiseCount: number;
  /** マネージャが `dispose()` したテクスチャの累計回数（猶予による破棄と上限による破棄の合計）。 */
  readonly evictCount: number;
}
