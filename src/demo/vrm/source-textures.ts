/**
 * 最適化で使われなくなった元テクスチャの解放。
 *
 * avatar-optimizer はアトラス化したマテリアルへ置き換えるが、デモが保持し続ける `VRM`
 * （firstPerson の meshAnnotations など）が元のメッシュとマテリアルを参照し続けるため、
 * 元テクスチャの画素（多くは `ImageBitmap`）がメインメモリに残る。
 *
 * @packageDocumentation
 */
import type { Material, Object3D, Texture } from 'three/webgpu';

function isTexture(value: unknown): value is Texture {
  return typeof value === 'object' && value !== null && 'isTexture' in value && value.isTexture === true;
}

function isMaterial(value: unknown): value is Material {
  return typeof value === 'object' && value !== null && 'isMaterial' in value && value.isMaterial === true;
}

function hasClose(value: unknown): value is { close(): void } {
  return typeof value === 'object' && value !== null && 'close' in value && typeof value.close === 'function';
}

function addMaterialTextures(material: Material, out: Set<Texture>): void {
  for (const value of Object.values(material)) {
    if (isTexture(value)) out.add(value);
  }
  // ShaderMaterial 系（classic MToon 等）はテクスチャを uniforms に持つ。
  if ('uniforms' in material && typeof material.uniforms === 'object' && material.uniforms !== null) {
    for (const uniform of Object.values(material.uniforms)) {
      const value: unknown = typeof uniform === 'object' && uniform !== null && 'value' in uniform ? uniform.value : undefined;
      if (isTexture(value)) out.add(value);
    }
  }
}

/** `root` 以下のオブジェクトのマテリアルが参照するテクスチャを集める。 */
export function collectSceneTextures(root: Object3D): Set<Texture> {
  const out = new Set<Texture>();
  root.traverse((object) => {
    const material: unknown = 'material' in object ? object.material : undefined;
    for (const m of Array.isArray(material) ? material : [material]) {
      if (isMaterial(m)) addMaterialTextures(m, out);
    }
  });
  return out;
}

/**
 * `before` のうち `root` のマテリアルがもう参照しないテクスチャを破棄し、画素データを手放す。
 *
 * @param before - 最適化前に {@link collectSceneTextures} で集めたテクスチャ。
 * @param root - 最適化後のシーン。ここから参照されるテクスチャと、その画像（`Source`）は残す。
 * @returns 解放したテクスチャの数。
 * @remarks
 * 解放したテクスチャは `source.data` を `null` にするため、描画に使うと再アップロードできない。
 * 元のマテリアルを再び描画に使う処理がない前提で呼ぶ。
 */
export function releaseReplacedTextures(before: ReadonlySet<Texture>, root: Object3D): number {
  const kept = collectSceneTextures(root);
  const keptSources = new Set([...kept].map((texture) => texture.source));
  let released = 0;
  for (const texture of before) {
    if (kept.has(texture)) continue;
    texture.dispose();
    released++;
    // 残すテクスチャと画像を共有している場合は、画素を残す。
    if (keptSources.has(texture.source)) continue;
    const data: unknown = texture.source.data;
    // ImageBitmap は GC を待たず close() で画素を解放する。
    if (hasClose(data)) data.close();
    texture.source.data = null;
  }
  return released;
}
