/**
 * three.js向け距離ベース・テクスチャLOD。
 *
 * 解像度の異なる別テクスチャをレベルごとに持ち、カメラ距離に応じて
 * 事前生成したマテリアルバリアントを `mesh.material` へ代入して切り替える。
 * ヒステリシス付き3〜4段階・オブジェクト単位の切替と、未使用テクスチャの常駐管理を行う。
 * 破棄したテクスチャの画素データはディスク（OPFS 等）へ退避してメインメモリから外せる。
 *
 * @packageDocumentation
 */
export type {
  AdaptiveThresholdScaleOptions,
  DistanceMode,
  KnownTextureSlot,
  ResidencyMode,
  TextureLodLevel,
  TextureLodManagerOptions,
  TextureLodSetOptions,
  TextureLodStats,
  TextureSlot,
  TextureSlotOf,
} from './types.js';
export type {
  TextureLodBinding,
  TextureLodGroupOptions,
  TextureLodSetContract,
} from './texture-lod-manager.js';
export type {
  CompressedMipSliceOptions,
} from './compressed-texture.js';
export {
  createCompressedTextureMipLevels,
  estimateTextureBytes,
  isCompressedTexture,
  sliceCompressedTexture,
} from './compressed-texture.js';
export { selectLevel } from './select-level.js';
export { computeLodDistance } from './lod-distance.js';
export { TextureLodSet, createTextureLodSet } from './texture-lod-set.js';
export { TextureLodManager } from './texture-lod-manager.js';
export type { TexturePixelStore, TextureSpillStats } from './texture-spill-cache.js';
export { TextureSpillCache } from './texture-spill-cache.js';
export { openOpfsPixelStore } from './opfs-pixel-store.js';
