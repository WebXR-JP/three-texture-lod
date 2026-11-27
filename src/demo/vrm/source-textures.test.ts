import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D, ShaderMaterial, Texture } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { collectSceneTextures, releaseReplacedTextures } from './source-textures.js';

/** close() の呼び出しを記録する ImageBitmap 代わりの画像。 */
function fakeBitmap(): { closed: number; close(): void } {
  return {
    closed: 0,
    close() {
      this.closed++;
    },
  };
}

function textureWith(data: unknown): Texture {
  const texture = new Texture();
  texture.source.data = data;
  return texture;
}

describe('collectSceneTextures', () => {
  // classic MToon は uniforms にテクスチャを持つので、プロパティと uniforms の両方から拾えること。
  it('マテリアルのプロパティと uniforms の両方からテクスチャを集める', () => {
    const map = textureWith(fakeBitmap());
    const shade = textureWith(fakeBitmap());
    const root = new Object3D();
    root.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial({ map })));
    root.add(new Mesh(new BoxGeometry(), new ShaderMaterial({ uniforms: { shadeMultiplyTexture: { value: shade } } })));

    expect(collectSceneTextures(root)).toEqual(new Set([map, shade]));
  });
});

describe('releaseReplacedTextures', () => {
  // 最適化後のシーンが参照しない元テクスチャだけ画素を手放し、使い続けるものは壊さないこと。
  it('置き換えられたテクスチャだけ close して画素を外す', () => {
    const replacedImage = fakeBitmap();
    const replaced = textureWith(replacedImage);
    const keptImage = fakeBitmap();
    const kept = textureWith(keptImage);
    const after = new Object3D();
    after.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial({ map: kept })));

    const released = releaseReplacedTextures(new Set([replaced, kept]), after);

    expect(released).toBe(1);
    expect(replacedImage.closed).toBe(1);
    expect(replaced.source.data).toBeNull();
    expect(keptImage.closed).toBe(0);
    expect(kept.source.data).toBe(keptImage);
  });

  // 同じ画像を残すテクスチャと共有している場合、画素を外すと残す側が描画できなくなる。
  it('残すテクスチャと画像を共有していれば画素は残す', () => {
    const shared = fakeBitmap();
    const kept = textureWith(shared);
    const replaced = new Texture();
    replaced.source = kept.source;
    const after = new Object3D();
    after.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial({ map: kept })));

    releaseReplacedTextures(new Set([replaced]), after);

    expect(shared.closed).toBe(0);
    expect(kept.source.data).toBe(shared);
  });
});
