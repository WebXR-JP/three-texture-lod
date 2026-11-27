/**
 * VRMの読み込み → avatar-optimizer でのアトラス化・マテリアル統合 → テクスチャLODセットの構築。
 *
 * WebGPURenderer では three-vrm の MToonNodeMaterial が three r187 と互換でないため、
 * 読み込みは classic MToonMaterial で行い、最適化後の描画だけを
 * `MToonAtlasNodeMaterial`（TSL）へ置き換える。
 * classic のマテリアルは最適化で全て置き換わるので、WebGPURenderer では描画されない。
 */
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import { UastcQuality, loadVRM, optimizeModel } from '@webxr-jp/avatar-optimizer';
import { MToonAtlasNodeMaterial } from '@webxr-jp/mtoon-atlas/nodes';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { Mesh, Quaternion, Vector3, type Material, type Object3D, type Texture } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import {
  createTextureLodSet,
  estimateTextureBytes,
  isCompressedTexture,
  type TextureLodBinding,
  type TextureLodLevel,
  type TextureLodSet,
  type TextureSlotOf,
} from '../../lib/index.js';
import {
  createDownscaledTexture,
  createTierTexturesForSlot,
  enableMipmaps,
  type DownsampleKind,
} from './downscale.js';
import { LOD_DISTANCES, LOD_TIERS } from './tiers.js';

/** アトラス化される MToon のテクスチャスロット。matcap はUV非依存なので対象外。 */
const ATLAS_SLOTS = [
  'map',
  'shadeMultiplyTexture',
  'normalMap',
  'emissiveMap',
  'shadingShiftTexture',
  'rimMultiplyTexture',
  'uvAnimationMaskTexture',
] as const;

type AtlasSlot = (typeof ATLAS_SLOTS)[number];

// 複製の頭ボーン揺れ用（setFromAxisAngle の一時オブジェクトを毎フレーム作らない）。
const HEAD_YAW_AXIS = new Vector3(0, 1, 0);
const headYaw = new Quaternion();

// レンダラー単位で KTX2Loader を 1 つだけ保持し、Worker・WASM の重複生成と警告を防ぐ。
const ktx2Loaders = new WeakMap<WebGPURenderer, KTX2Loader>();

function getKtx2Loader(renderer: WebGPURenderer): KTX2Loader {
  let loader = ktx2Loaders.get(renderer);
  if (!loader) {
    loader = new KTX2Loader();
    loader.detectSupport(renderer);
    ktx2Loaders.set(renderer, loader);
  }
  return loader;
}

/** LODの距離境界（surface距離、メートル）は `tiers.ts` の定義を使う。 */
export { LOD_DISTANCES };

/** 最適化前後の比較用。 */
export interface SceneStats {
  meshes: number;
  materials: number;
  textures: number;
  triangles: number;
}

export interface AvatarStats {
  before: SceneStats;
  after: SceneStats;
  optimizeMs: number;
  atlasBytes: number;
  usedSlots: AtlasSlot[];
  compressedSlots: AtlasSlot[];
  atlasResolution: number;
}

/**
 * 最適化済みモデルの共有元。アトラス・テクスチャ・マテリアル・LODセットを所有する。
 *
 * ソースと複製のハンドルはこのテンプレートのセットを共有し、
 * メッシュごとの束縛だけを個別に持つ。`sets` と `materialSets` は
 * `rebuild` で差し替えられるため、都度読み取って使うこと。
 */
export interface AvatarTemplate {
  /** ソースの表示名。複製の命名元にも使う。 */
  readonly name: string;
  /** 最適化直後（rest pose）の複製元。シーンには追加しない。 */
  readonly root: Object3D;
  /** 距離基準メッシュの名前。複製側で同名のメッシュを探すために使う。 */
  readonly anchorName: string;
  /**
   * 頭の raw ボーン名。無いモデルでは null。
   *
   * ADR: normalized ボーン（`Normalized_` 接頭辞）を複製側で動かしても、
   * `vrm.update()` が無い複製では skinning に反映されない。raw ボーンを直接動かす。
   */
  readonly headRawBoneName: string | null;
  /** 腰の raw ボーン名。無いモデルでは null。クローズアップの枠取りで頭ボーンと組にして使う。 */
  readonly hipsRawBoneName: string | null;
  /** 最適化の実測値。複製は所有しないため、集計はテンプレート単位で行う。 */
  readonly stats: AvatarStats;
  /**
   * 5段の map 実幅（px）。複数セットがある場合は各レベルの最大幅。
   *
   * clone と共有する。`rebuild` では幅は同じだが参照を新しくする。
   */
  readonly levelWidths: readonly number[];
  /** 現在のLODセット。共有のため `rebuild` で差し替わる。 */
  sets: TextureLodSet<MToonAtlasNodeMaterial>[];
  /** ベースマテリアルからセットを引く索引。複製の束縛作りに使う。 */
  materialSets: Map<Material, TextureLodSet<MToonAtlasNodeMaterial>>;
  /** バリアントのマテリアルを破棄する。テクスチャはマネージャ/呼び出し側の管理。 */
  disposeVariants(): void;
  /** 新しい hysteresis でセットを作り直す。束縛の作り直しは各ハンドルの `rebind` が行う。 */
  rebuild(hysteresis: number): void;
}

export interface AvatarHandle {
  readonly name: string;
  /** ソースはVRMを持つ。複製はVRMマネージャを持たないため null。 */
  readonly vrm: VRM | null;
  readonly root: Object3D;
  readonly anchor: Mesh;
  readonly meshes: Mesh[];
  /** 現在の束縛。テンプレートの `rebuild` 後は `rebind` で作り直す。 */
  bindings: TextureLodBinding[];
  /** テンプレート共有のセット。実体は `template.sets`。 */
  readonly sets: TextureLodSet<MToonAtlasNodeMaterial>[];
  readonly baseMaterials: Map<Mesh, Material>;
  /** 共有する最適化済みモデルの所有元。 */
  readonly template: AvatarTemplate;
  /** 最適化を再実行せずに複製したものか。 */
  readonly isClone: boolean;
  readonly stats: AvatarStats;
  update(delta: number): void;
  /**
   * テンプレートを作り直して自ハンドルの束縛も張り替える。
   * 同じテンプレートを共有する他のハンドルも `rebind` が必要になる。
   * 一括の作り直しはテンプレート単位で行うこと。
   */
  rebuild(hysteresis: number): void;
  /** バリアントのマテリアルを破棄する。所有はテンプレートのため何もしない。 */
  disposeVariants(): void;
  /** 自メッシュと現在の `template.materialSets` から束縛を作り直す。 */
  rebind(): void;
}

function isTexture(value: unknown): value is Texture {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { isTexture?: unknown }).isTexture === true
  );
}

function materialsOf(mesh: Mesh): Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

/** 最適化後は1メッシュ1マテリアルになっている前提で取り出す。 */
function materialOf(mesh: Mesh): Material {
  const materials = materialsOf(mesh);
  if (materials.length !== 1) {
    throw new Error(
      `${mesh.name || 'mesh'} は複数マテリアルです。VRMデモは1メッシュ1マテリアルを前提にしています`,
    );
  }
  return materials[0];
}

/** アウトラインかどうか。距離基準の候補から外すために使う。 */
function isOutline(mesh: Mesh): boolean {
  return (materialOf(mesh) as unknown as { isOutline?: boolean }).isOutline === true;
}

/**
 * 距離の基準にするメッシュを選ぶ。同名の優先候補があればそれを使い、
 * 無ければ最大の非アウトラインメッシュにする。
 */
function pickAnchor(meshes: Mesh[], preferredName?: string): Mesh {
  if (preferredName !== undefined) {
    const named = meshes.find((mesh) => mesh.name === preferredName);
    if (named) return named;
  }
  let anchor = meshes.find((mesh) => !isOutline(mesh)) ?? meshes[0];
  for (const mesh of meshes) {
    if (isOutline(mesh)) continue;
    if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
    if (
      (mesh.geometry.boundingSphere?.radius ?? 0) >
      (anchor.geometry.boundingSphere?.radius ?? 0)
    ) {
      anchor = mesh;
    }
  }
  if (!anchor) {
    throw new Error('メッシュが無く anchor を選べません');
  }
  return anchor;
}

/**
 * 距離とカリングを bind pose の geometry 球に固定する。
 *
 * ADR: avatar-optimizer が結合した SkinnedMesh の own boundingSphere は、
 * スキニング後の頂点から計算されるため実体より大きくずれる（実測 r=2.36、geometry は 0.85）。
 * LOD距離とフラスタムカリングを bind pose の geometry 球に固定する。
 * 手続き的アイドル程度の変形なら、bind pose の球で十分に保守的である。
 * 複製は geometry を共有するため内容は同じだが、clone が own 球を持ち越している場合に備えて付け直す。
 */
function pinBoundingSpheres(meshes: Mesh[]): void {
  for (const mesh of meshes) {
    if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
    const own = (mesh as unknown as { boundingSphere?: unknown }).boundingSphere;
    if (own !== undefined && mesh.geometry.boundingSphere) {
      (mesh as unknown as { boundingSphere: unknown }).boundingSphere =
        mesh.geometry.boundingSphere.clone();
    }
  }
}

/**
 * メッシュ列と共有セット索引から束縛とベース材質表を作る。
 *
 * @param name - エラー表示用のハンドル名。
 * @param meshes - 束縛対象のメッシュ列。
 * @param materialSets - ベースマテリアルからセットを引く索引。
 * @returns メッシュごとの束縛と、メッシュからベースマテリアルへの表。
 * @throws `Error` — 素材が索引に無い場合。共有前提が壊れたサインであり、回復しない。
 */
function createBindings(
  name: string,
  meshes: Mesh[],
  materialSets: Map<Material, TextureLodSet<MToonAtlasNodeMaterial>>,
): { bindings: TextureLodBinding[]; baseMaterials: Map<Mesh, Material> } {
  const bindings: TextureLodBinding[] = [];
  const baseMaterials = new Map<Mesh, Material>();
  for (const mesh of meshes) {
    const material = materialOf(mesh);
    const set = materialSets.get(material);
    if (!set) {
      throw new Error(
        `${name}: ${mesh.name || 'mesh'} のマテリアルが共有セットにありません。` +
          'テンプレートとマテリアル実体を共有していることが前提です。',
      );
    }
    bindings.push({ mesh, set });
    baseMaterials.set(mesh, material);
  }
  return { bindings, baseMaterials };
}

/** 最適化前後のメッシュ・マテリアル・テクスチャ・三角形数を数える。 */
function analyze(root: Object3D): SceneStats {
  const meshes = new Set<Mesh>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  let triangles = 0;

  root.traverse((object) => {
    if (!(object as Mesh).isMesh) return;
    const mesh = object as Mesh;
    meshes.add(mesh);
    for (const material of materialsOf(mesh)) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (isTexture(value)) textures.add(value);
      }
      for (const slot of ATLAS_SLOTS) {
        const value = (material as unknown as Record<string, unknown>)[slot];
        if (isTexture(value)) textures.add(value);
      }
    }
    const geometry = mesh.geometry;
    if (geometry.index) triangles += geometry.index.count / 3;
    else triangles += (geometry.attributes.position?.count ?? 0) / 3;
  });

  return {
    meshes: meshes.size,
    materials: materials.size,
    textures: textures.size,
    triangles: Math.round(triangles),
  };
}

/** 最適化前に、実際に使われているアトラススロットを調べる。 */
function collectUsedSlots(root: Object3D): Set<AtlasSlot> {
  const used = new Set<AtlasSlot>();
  root.traverse((object) => {
    if (!(object as Mesh).isMesh) return;
    for (const raw of materialsOf(object as Mesh)) {
      const material = raw as unknown as Record<string, unknown>;
      for (const slot of ATLAS_SLOTS) {
        const value = material[slot];
        if (!isTexture(value)) continue;
        const image = value.image as { width?: number; height?: number } | undefined;
        if ((image?.width ?? 0) > 16 && (image?.height ?? 0) > 16) used.add(slot);
      }
    }
  });
  return used;
}

/** スロットごとの縮小アルゴリズム。 */
function kindOf(slot: AtlasSlot): DownsampleKind {
  if (slot === 'normalMap') return 'normal';
  if (slot === 'shadingShiftTexture' || slot === 'uvAnimationMaskTexture') return 'scalar';
  return 'color';
}

/**
 * セットの各レベルから map 実幅の最大値を拾う。
 *
 * @param sets - LODセット列。
 * @returns 5段の実幅。map が無いレベルは同レベルの全スロットの最大幅にする。
 */
function levelWidthsOf(
  sets: TextureLodSet<MToonAtlasNodeMaterial>[],
): readonly number[] {
  return LOD_TIERS.map((_, level) => {
    let max = 0;
    for (const set of sets) {
      const levelDef = set.levels[level];
      if (!levelDef) continue;
      const textures = levelDef.textures as Record<string, unknown>;
      const mapTexture = textures['map'];
      if (isTexture(mapTexture)) {
        const image = mapTexture.image as { width?: number } | undefined;
        if (typeof image?.width === 'number') max = Math.max(max, image.width);
        continue;
      }
      for (const value of Object.values(textures)) {
        if (!isTexture(value)) continue;
        const image = value.image as { width?: number } | undefined;
        if (typeof image?.width === 'number') max = Math.max(max, image.width);
      }
    }
    return max;
  });
}

/** アバターのルート向き。VRM0 は -Z 向きなので 180 度回す。 */
function faceCamera(vrm: VRM): void {
  const version = (vrm.meta as { metaVersion?: string } | undefined)?.metaVersion;
  vrm.scene.rotation.y = version === '1' ? 0 : Math.PI;
}

/** 腕を下ろした自然な立ち姿勢。Tポーズのままではデモとして不自然なため。 */
function applyRestPose(vrm: VRM): void {
  const humanoid = vrm.humanoid;
  if (!humanoid) return;
  const bone = (name: string) => humanoid.getNormalizedBoneNode(name as VRMHumanBoneName);
  const setZ = (name: string, value: number) => {
    const node = bone(name);
    if (node) node.rotation.z = value;
  };
  const setX = (name: string, value: number) => {
    const node = bone(name);
    if (node) node.rotation.x = value;
  };
  setZ('leftUpperArm', 1.25);
  setZ('rightUpperArm', -1.25);
  setZ('leftLowerArm', 0.16);
  setZ('rightLowerArm', -0.16);
  setX('head', 0.03);
  setX('chest', 0.015);
}

export interface LoadAvatarOptions {
  name: string;
  source: string | File;
  renderer: WebGPURenderer;
  atlasResolution: number;
  hysteresis: number;
  compressTextures?: boolean;
  onProgress?: (message: string) => void;
}

/**
 * 1体分のVRMを読み込み、最適化し、LODセットと束縛を作る。
 *
 * `manager.addGroup(bindings, { anchor })` は呼び出し側で行う。
 */
export async function loadAvatar(options: LoadAvatarOptions): Promise<AvatarHandle> {
  const {
    name,
    source,
    renderer,
    atlasResolution,
    hysteresis,
    compressTextures = false,
    onProgress,
  } = options;
  onProgress?.(`${name}: VRMを読み込み中`);

  const ktx2Loader = getKtx2Loader(renderer);
  const loaded = await loadVRM(source, {
    // classic MToonMaterial で読み込む。最適化後に全て MToonAtlasNodeMaterial へ置き換わる。
    // 型は GLSL 版のコンストラクタを要求するため、ここだけ境界としてキャストする。
    mtoonAtlasMaterialType: MToonAtlasNodeMaterial as never,
    ktx2Loader,
  });
  if (loaded.isErr()) {
    throw new Error(`${name}: 読み込みに失敗しました: ${JSON.stringify(loaded.error)}`);
  }
  const vrm = loaded.value;
  const before = analyze(vrm.scene);

  const used = collectUsedSlots(vrm.scene);
  const half = Math.max(256, Math.round(atlasResolution / 2));
  const slotResolutions: Record<string, number> = {
    map: atlasResolution,
    shadeMultiplyTexture: atlasResolution,
    normalMap: half,
    emissiveMap: half,
    shadingShiftTexture: half,
    rimMultiplyTexture: half,
    uvAnimationMaskTexture: half,
    outlineWidthMultiplyTexture: 8,
  };
  for (const slot of Object.keys(slotResolutions)) {
    if (!used.has(slot as AtlasSlot)) slotResolutions[slot] = 8;
  }

  onProgress?.(
    `${name}: アトラス化${compressTextures ? '・KTX2圧縮' : ''}・マテリアル統合中（${atlasResolution}px）`,
  );
  const started = performance.now();
  const optimized = await optimizeModel(vrm, {
    atlas: { defaultResolution: atlasResolution, slotResolutions },
    atlasMaterialType: MToonAtlasNodeMaterial as never,
    // ADR: avatar-optimizer 0.7.0 は未指定項目を undefined のまま渡す場合があるため、
    // LOD 用ミップチェーン生成を含め圧縮パラメータを明示する。
    ...(compressTextures
      ? {
          textureCompression: {
            quality: UastcQuality.Default,
            compressionLevel: 3,
            generateMipmaps: true,
            supercompression: true,
          },
          ktx2Loader,
        }
      : {}),
  });
  if (optimized.isErr()) {
    throw new Error(`${name}: 最適化に失敗しました: ${JSON.stringify(optimized.error)}`);
  }
  if (optimized.value.atlasSkipped) {
    throw new Error(
      `${name}: アトラス化がスキップされました（${optimized.value.atlasSkipped.reason}）。` +
        'MToonマテリアルを持つVRMを指定してください。',
    );
  }
  const optimizeMs = performance.now() - started;

  faceCamera(vrm);
  applyRestPose(vrm);
  // 正規化ポーズは vrm.update() で実ボーンへ反映される。複製元をTポーズのまま
  // 複製しないよう、ここで1回適用しておく（delta=0）。
  vrm.update(0);
  vrm.scene.updateMatrixWorld(true);

  const meshes: Mesh[] = [];
  vrm.scene.traverse((object) => {
    if ((object as Mesh).isMesh) meshes.push(object as Mesh);
  });

  pinBoundingSpheres(meshes);

  // classic MToon が1つでも残ると WebGPURenderer では描画できない。
  const atlasMaterials = new Set<MToonAtlasNodeMaterial>();
  for (const mesh of meshes) {
    const material = materialOf(mesh);
    if (
      (material as unknown as { isMToonAtlasNodeMaterial?: boolean }).isMToonAtlasNodeMaterial !==
      true
    ) {
      throw new Error(
        `${name}: ${mesh.name || 'mesh'} に最適化前のマテリアル（${material.type}）が残っています。` +
          'このVRMはWebGPU向けのアトラス化に対応していません。',
      );
    }
    atlasMaterials.add(material as MToonAtlasNodeMaterial);
  }
  if (atlasMaterials.size === 0) {
    throw new Error(`${name}: アトラスマテリアルが生成されませんでした`);
  }

  // 非圧縮アトラスは LinearFilter・ミップなしで生成されるため、全レベルで揃えてミップを有効にする。
  // 圧縮テクスチャは埋め込みミップを使うため generateMipmaps=false を保ち、実バイト数を集計する。
  const atlasTextures = new Set<Texture>();
  const compressedSlotSet = new Set<AtlasSlot>();
  for (const material of atlasMaterials) {
    for (const slot of ATLAS_SLOTS) {
      const texture = (material as unknown as Record<string, unknown>)[slot];
      if (!isTexture(texture)) continue;
      enableMipmaps(texture);
      atlasTextures.add(texture);
      if (isCompressedTexture(texture)) {
        const image = texture.image as { width?: number; height?: number } | undefined;
        if ((image?.width ?? 0) >= 64 && (image?.height ?? 0) >= 64) {
          compressedSlotSet.add(slot);
        }
      }
    }
  }
  let atlasBytes = 0;
  for (const texture of atlasTextures) {
    atlasBytes += estimateTextureBytes(texture);
  }

  // 同じ元テクスチャからは同じ縮小・スライステクスチャを共有する。
  const scaledCache = new Map<Texture, Map<number, Texture>>();
  const scaled = (sourceTexture: Texture, divisor: number, kind: DownsampleKind): Texture => {
    let byDivisor = scaledCache.get(sourceTexture);
    if (!byDivisor) {
      byDivisor = new Map();
      scaledCache.set(sourceTexture, byDivisor);
    }
    let texture = byDivisor.get(divisor);
    if (!texture) {
      texture = createDownscaledTexture(sourceTexture, divisor, kind);
      byDivisor.set(divisor, texture);
    }
    return texture;
  };
  const compressedTierCache = new Map<Texture, readonly Texture[]>();
  const slotTierTextures = (sourceTexture: Texture, kind: DownsampleKind): readonly Texture[] => {
    if (isCompressedTexture(sourceTexture)) {
      let cached = compressedTierCache.get(sourceTexture);
      if (!cached) {
        cached = createTierTexturesForSlot(sourceTexture, LOD_TIERS, kind);
        compressedTierCache.set(sourceTexture, cached);
      }
      return cached;
    }
    return createTierTexturesForSlot(sourceTexture, LOD_TIERS, kind, scaled);
  };

  const buildSets = (
    nextHysteresis: number,
  ): TextureLodSet<MToonAtlasNodeMaterial>[] => {
    const sets = new Map<MToonAtlasNodeMaterial, TextureLodSet<MToonAtlasNodeMaterial>>();

    for (const mesh of meshes) {
      const material = materialOf(mesh) as MToonAtlasNodeMaterial;
      if (sets.has(material)) continue;
      const texturesBySlot = ATLAS_SLOTS.map((slot) => {
        const texture = (material as unknown as Record<string, unknown>)[slot];
        if (!isTexture(texture)) return null;
        const image = texture.image as { width?: number; height?: number };
        if ((image.width ?? 0) < 64 || (image.height ?? 0) < 64) return null;
        return {
          slot,
          texture,
          kind: kindOf(slot),
        };
      }).filter(
        (entry): entry is {
          slot: AtlasSlot;
          texture: Texture;
          kind: DownsampleKind;
        } => entry !== null,
      );

      if (texturesBySlot.length === 0) {
        throw new Error(
          `${name}: ${material.name || 'material'} にLOD可能なアトラステクスチャがありません`,
        );
      }

      const slotLevels = texturesBySlot.map((entry) => ({
        slot: entry.slot,
        textures: slotTierTextures(entry.texture, entry.kind),
      }));

      const levels: TextureLodLevel<MToonAtlasNodeMaterial>[] = LOD_DISTANCES.map(
        (distance, index) => {
          const textures: Partial<
            Record<TextureSlotOf<MToonAtlasNodeMaterial>, Texture>
          > = {};
          for (const entry of slotLevels) {
            textures[entry.slot] = entry.textures[index];
          }
          return { distance, textures };
        },
      );

      const set = createTextureLodSet({ material, levels, hysteresis: nextHysteresis });
      sets.set(material, set);
    }

    return [...sets.values()];
  };

  // 距離の基準は最も大きい球を持つメッシュ（体の結合メッシュ）。
  // アウトラインは体と同じ球サイズなので、距離基準は体のメッシュを優先する。
  const anchor = pickAnchor(meshes);

  const initialSets = buildSets(hysteresis);
  const materialSets = new Map<Material, TextureLodSet<MToonAtlasNodeMaterial>>();
  for (const set of initialSets) materialSets.set(set.baseMaterial, set);

  // アニメーションを1フレームも進める前に、rest pose の複製元を作る。
  // 最適化直後の状態を保ち、シーンには追加しない。geometry・マテリアルは共有される。
  const templateRoot = cloneSkeleton(vrm.scene);
  // 複製には VRM マネージャが無いため、normalized rig は描画にもアニメーションにも寄与しない。
  // ノード数を減らすため、テンプレートからだけ取り除く（ソース側はそのまま）。
  const normalizedRoot = vrm.humanoid?.normalizedHumanBonesRoot;
  if (normalizedRoot?.name) {
    templateRoot.getObjectByName(normalizedRoot.name)?.removeFromParent();
  }
  const headRawBoneName = vrm.humanoid?.getRawBoneNode('head')?.name ?? null;
  const hipsRawBoneName = vrm.humanoid?.getRawBoneNode('hips')?.name ?? null;

  const template: AvatarTemplate = {
    name,
    root: templateRoot,
    anchorName: anchor.name,
    headRawBoneName,
    hipsRawBoneName,
    stats: {
      before,
      after: analyze(vrm.scene),
      optimizeMs,
      atlasBytes,
      usedSlots: [...used],
      compressedSlots: [...compressedSlotSet],
      atlasResolution,
    },
    sets: initialSets,
    materialSets,
    levelWidths: levelWidthsOf(initialSets),
    disposeVariants() {
      for (const set of template.sets) set.dispose();
    },
    rebuild(nextHysteresis: number) {
      const sets = buildSets(nextHysteresis);
      template.sets = sets;
      template.materialSets = new Map<Material, TextureLodSet<MToonAtlasNodeMaterial>>();
      for (const set of sets) template.materialSets.set(set.baseMaterial, set);
      (template as { levelWidths: readonly number[] }).levelWidths = levelWidthsOf(sets);
    },
  };

  const created = createBindings(name, meshes, template.materialSets);
  let elapsed = Math.random() * 10;

  const handle: AvatarHandle = {
    name,
    vrm,
    root: vrm.scene,
    anchor,
    meshes,
    bindings: created.bindings,
    get sets() {
      return template.sets;
    },
    baseMaterials: created.baseMaterials,
    template,
    isClone: false,
    stats: template.stats,
    update(delta: number) {
      elapsed += delta;
      const humanoid = vrm.humanoid;
      const head = humanoid?.getNormalizedBoneNode('head');
      if (head) head.rotation.y = Math.sin(elapsed * 0.4) * 0.1;
      const expression = vrm.expressionManager;
      if (expression) {
        // 4秒に1回、0.12秒だけ瞬きする。表情モーフとLODの共存確認用。
        const phase = elapsed % 4;
        expression.setValue('blink', phase < 0.12 ? 1 : 0);
      }
      vrm.update(delta);
    },
    rebuild(nextHysteresis: number) {
      template.rebuild(nextHysteresis);
      handle.rebind();
    },
    disposeVariants() {
      // 所有はテンプレート。一括破棄はテンプレート単位で行う。
    },
    rebind() {
      handle.bindings = createBindings(name, meshes, template.materialSets).bindings;
    },
  };

  return handle;
}

/**
 * テンプレートから複製インスタンスを作る。最適化は再実行しない。
 *
 * アトラス・テクスチャ・マテリアル・LODセットはテンプレートと共有し、
 * メッシュと束縛だけを複製ごとに持つ。`materialSets` に無い素材が出たら
 * 共有前提が壊れているため例外にする。
 *
 * @param template - 複製元の最適化済みモデル。
 * @param name - 複製の表示名。一意であること。
 * @returns VRMマネージャを持たないハンドル（`vrm` は null）。
 * @throws `Error` — 複製にメッシュが無い、または共有セットに無い素材がある場合。
 */
export function instantiateAvatar(template: AvatarTemplate, name: string): AvatarHandle {
  const root = cloneSkeleton(template.root);
  const meshes: Mesh[] = [];
  root.traverse((object) => {
    if ((object as Mesh).isMesh) meshes.push(object as Mesh);
  });
  if (meshes.length === 0) {
    throw new Error(`${name}: テンプレート ${template.name} にメッシュがありません`);
  }
  pinBoundingSpheres(meshes);
  const anchor = pickAnchor(meshes, template.anchorName);
  const created = createBindings(name, meshes, template.materialSets);
  const head = template.headRawBoneName !== null ? root.getObjectByName(template.headRawBoneName) : null;
  const headRest = head ? head.quaternion.clone() : null;
  let elapsed = Math.random() * 10;

  const handle: AvatarHandle = {
    name,
    vrm: null,
    root,
    anchor,
    meshes,
    bindings: created.bindings,
    get sets() {
      return template.sets;
    },
    baseMaterials: created.baseMaterials,
    template,
    isClone: true,
    stats: {
      before: { meshes: 0, materials: 0, textures: 0, triangles: 0 },
      after: { meshes: 0, materials: 0, textures: 0, triangles: 0 },
      optimizeMs: 0,
      atlasBytes: 0,
      usedSlots: [],
      compressedSlots: [],
      atlasResolution: template.stats.atlasResolution,
    },
    update(delta: number) {
      elapsed += delta;
      // VRMマネージャを持たないため、raw 頭ボーンを rest から少しだけ揺らす。瞬きはしない。
      if (head && headRest) {
        headYaw.setFromAxisAngle(HEAD_YAW_AXIS, Math.sin(elapsed * 0.4) * 0.1);
        head.quaternion.copy(headRest).multiply(headYaw);
      }
    },
    rebuild(nextHysteresis: number) {
      // テンプレート単位の作り直し。同じテンプレートの他ハンドルも rebind が必要。
      template.rebuild(nextHysteresis);
      handle.rebind();
    },
    disposeVariants() {
      // 所有はテンプレート。
    },
    rebind() {
      handle.bindings = createBindings(name, meshes, template.materialSets).bindings;
    },
  };

  return handle;
}

export { ATLAS_SLOTS };
