/**
 * three.js向け距離ベース・テクスチャLOD。
 *
 * 解像度の異なる別テクスチャをレベルごとに持ち、カメラ距離に応じて
 * 事前生成したマテリアルバリアントを `mesh.material` へ代入して切り替える。
 * ヒステリシス付き3〜4段階・オブジェクト単位の切替と、未使用テクスチャの常駐管理を行う。
 *
 * @packageDocumentation
 */
export type {
  DistanceMode,
  ResidencyMode,
  TextureLodLevel,
  TextureLodManagerOptions,
  TextureLodSetOptions,
  TextureLodStats,
  TextureSlot,
} from './types.js';
export { selectLevel } from './select-level.js';
export { computeLodDistance } from './lod-distance.js';
export { TextureLodSet, createTextureLodSet } from './texture-lod-set.js';
export { TextureLodManager } from './texture-lod-manager.js';
