/**
 * VRMの読み込み → avatar-optimizer でのアトラス化・マテリアル統合 → テクスチャLODセットの構築。
 *
 * WebGPURenderer では three-vrm の MToonNodeMaterial が three r187 と互換でないため、
 * 読み込みは classic MToonMaterial で行い、最適化後の描画だけを
 * `MToonAtlasNodeMaterial`（TSL）へ置き換える。
 * classic のマテリアルは最適化で全て置き換わるので、WebGPURenderer では描画されない。
 */
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import { loadVRM, optimizeModel } from '@webxr-jp/avatar-optimizer';
import { MToonAtlasNodeMaterial } from '@webxr-jp/mtoon-atlas/nodes';
import { Mesh, type Material, type Object3D, type Texture } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import {
  createTextureLodSet,
  type TextureLodBinding,
  type TextureLodLevel,
  type TextureLodSet,
  type TextureSlotOf,
} from '../../lib/index.js';
import { createDownscaledTexture, enableMipmaps, type DownsampleKind } from './downscale.js';

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

/** LODの距離境界（surface距離、メートル）。解像度は1段あたり2倍。 */
export const LOD_DISTANCES = [0, 3, 6, 12] as const;
/** アトラス解像度に対する縮小率。1024 → 512 → 256 → 128。 */
const LOD_DIVISORS = [1, 2, 4, 8] as const;

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
  atlasResolution: number;
}

export interface AvatarHandle {
  readonly name: string;
  readonly vrm: VRM;
  readonly root: Object3D;
  readonly anchor: Mesh;
  readonly meshes: Mesh[];
  /** 現在の束縛。hysteresis の変更で作り直す。 */
  bindings: TextureLodBinding[];
  /** 現在のセット。hysteresis の変更で作り直す。 */
  sets: TextureLodSet<MToonAtlasNodeMaterial>[];
  readonly baseMaterials: Map<Mesh, Material>;
  readonly stats: AvatarStats;
  update(delta: number): void;
  /** 新しい hysteresis でセットと束縛を作り直す。 */
  rebuild(hysteresis: number): void;
  /** バリアントのマテリアルを破棄する。テクスチャはマネージャ/呼び出し側の管理。 */
  disposeVariants(): void;
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
  onProgress?: (message: string) => void;
}

/**
 * 1体分のVRMを読み込み、最適化し、LODセットと束縛を作る。
 *
 * `manager.addGroup(bindings, { anchor })` は呼び出し側で行う。
 */
export async function loadAvatar(options: LoadAvatarOptions): Promise<AvatarHandle> {
  const { name, source, renderer, atlasResolution, hysteresis, onProgress } = options;
  onProgress?.(`${name}: VRMを読み込み中`);

  const loaded = await loadVRM(source, {
    // classic MToonMaterial で読み込む。最適化後に全て MToonAtlasNodeMaterial へ置き換わる。
    // 型は GLSL 版のコンストラクタを要求するため、ここだけ境界としてキャストする。
    mtoonAtlasMaterialType: MToonAtlasNodeMaterial as never,
    ktx2Renderer: renderer,
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

  onProgress?.(`${name}: アトラス化・マテリアル統合中（${atlasResolution}px）`);
  const started = performance.now();
  const optimized = await optimizeModel(vrm, {
    atlas: { defaultResolution: atlasResolution, slotResolutions },
    atlasMaterialType: MToonAtlasNodeMaterial as never,
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
  vrm.scene.updateMatrixWorld(true);

  const meshes: Mesh[] = [];
  vrm.scene.traverse((object) => {
    if ((object as Mesh).isMesh) meshes.push(object as Mesh);
  });

  // ADR: avatar-optimizer が結合した SkinnedMesh の own boundingSphere は、
  // スキニング後の頂点から計算されるため実体より大きくずれる（実測 r=2.36、geometry は 0.85）。
  // LOD距離とフラスタムカリングを bind pose の geometry 球に固定する。
  // 手続き的アイドル程度の変形なら、bind pose の球で十分に保守的である。
  for (const mesh of meshes) {
    if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
    const own = (mesh as unknown as { boundingSphere?: unknown }).boundingSphere;
    if (own !== undefined && mesh.geometry.boundingSphere) {
      (mesh as unknown as { boundingSphere: unknown }).boundingSphere =
        mesh.geometry.boundingSphere.clone();
    }
  }

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

  // アトラスは LinearFilter・ミップなしで生成される。全レベルで揃えてミップを有効にする。
  const atlasTextures = new Set<Texture>();
  for (const material of atlasMaterials) {
    for (const slot of ATLAS_SLOTS) {
      const texture = (material as unknown as Record<string, unknown>)[slot];
      if (isTexture(texture)) {
        enableMipmaps(texture);
        atlasTextures.add(texture);
      }
    }
  }
  let atlasBytes = 0;
  for (const texture of atlasTextures) {
    const image = texture.image as { width: number; height: number };
    atlasBytes += (image.width * image.height * 4 * 4) / 3;
  }

  // 同じ元テクスチャからは同じ縮小テクスチャを共有する。
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

  const buildLod = (
    nextHysteresis: number,
  ): { sets: TextureLodSet<MToonAtlasNodeMaterial>[]; bindings: TextureLodBinding[] } => {
    const sets = new Map<MToonAtlasNodeMaterial, TextureLodSet<MToonAtlasNodeMaterial>>();
    const bindings: TextureLodBinding[] = [];

    for (const mesh of meshes) {
      const material = materialOf(mesh) as MToonAtlasNodeMaterial;
      let set = sets.get(material);
      if (!set) {
        const texturesBySlot = ATLAS_SLOTS.map((slot) => {
          const texture = (material as unknown as Record<string, unknown>)[slot];
          if (!isTexture(texture)) return null;
          const image = texture.image as { width?: number; height?: number };
          if ((image.width ?? 0) < 64 || (image.height ?? 0) < 64) return null;
          return { slot, texture, kind: kindOf(slot) };
        }).filter(
          (entry): entry is { slot: AtlasSlot; texture: Texture; kind: DownsampleKind } =>
            entry !== null,
        );

        if (texturesBySlot.length === 0) {
          throw new Error(
            `${name}: ${material.name || 'material'} にLOD可能なアトラステクスチャがありません`,
          );
        }

        const levels: TextureLodLevel<MToonAtlasNodeMaterial>[] = LOD_DISTANCES.map(
          (distance, index) => {
            const textures: Partial<
              Record<TextureSlotOf<MToonAtlasNodeMaterial>, Texture>
            > = {};
            for (const entry of texturesBySlot) {
              textures[entry.slot] = scaled(entry.texture, LOD_DIVISORS[index], entry.kind);
            }
            return { distance, textures };
          },
        );

        set = createTextureLodSet({ material, levels, hysteresis: nextHysteresis });
        sets.set(material, set);
      }
      bindings.push({ mesh, set });
    }

    return { sets: [...sets.values()], bindings };
  };

  // 距離の基準は最も大きい球を持つメッシュ（体の結合メッシュ）。
  // アウトラインは体と同じ球サイズなので、距離基準は体のメッシュを優先する。
  const isOutline = (mesh: Mesh) =>
    (materialOf(mesh) as unknown as { isOutline?: boolean }).isOutline === true;
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

  const baseMaterials = new Map<Mesh, Material>();
  for (const mesh of meshes) baseMaterials.set(mesh, materialOf(mesh));

  let built = buildLod(hysteresis);
  const after = analyze(vrm.scene);
  let elapsed = Math.random() * 10;

  const handle: AvatarHandle = {
    name,
    vrm,
    root: vrm.scene,
    anchor,
    meshes,
    bindings: built.bindings,
    sets: built.sets,
    baseMaterials,
    stats: {
      before,
      after,
      optimizeMs,
      atlasBytes,
      usedSlots: [...used],
      atlasResolution,
    },
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
      built = buildLod(nextHysteresis);
      handle.sets = built.sets;
      handle.bindings = built.bindings;
    },
    disposeVariants() {
      for (const set of handle.sets) set.dispose();
    },
  };

  return handle;
}

export { ATLAS_SLOTS };
