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
 * LOD切替の対象になるテクスチャスロット。
 *
 * MeshStandardMaterial 系が持つ代表的なマップに限定する。
 * `colorNode` 等で独自に `texture()` を組んでいるマテリアルは自動LOD化の対象外であり、
 * {@link TextureLodSetOptions.createVariant} で個別に対応する。
 */
export type TextureSlot =
  | 'map'
  | 'normalMap'
  | 'roughnessMap'
  | 'metalnessMap'
  | 'aoMap'
  | 'emissiveMap'
  | 'alphaMap';

/**
 * 1段階分のLOD定義。解像度の異なる別テクスチャの組を表す。
 */
export interface TextureLodLevel {
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
  readonly textures: Readonly<Partial<Record<TextureSlot, Texture>>>;
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
  readonly levels: readonly TextureLodLevel[];
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
  readonly createVariant?: (base: M, level: TextureLodLevel, levelIndex: number) => M;
}

/**
 * 使われていないテクスチャの扱い。
 *
 * - `keep-all`: 何も破棄しない。VRAMに余裕がある場合や、切替時の再アップロードを避けたい場合。
 * - `evict`: 一定時間使われなかったテクスチャを破棄する。最粗レベルのテクスチャは常駐する。
 */
export type ResidencyMode = 'keep-all' | 'evict';

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
   * @defaultValue `5000`（`TextureLodManager` が補う）。
   */
  readonly evictDelayMs?: number;
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
  /** 登録中のオブジェクト数。 */
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
}
