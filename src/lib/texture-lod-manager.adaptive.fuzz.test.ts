/**
 * 予算適応スケールの不変条件ファズテスト。
 *
 * `predict` と pass2 の判定一致（ヒステリシス・最粗pins・維持グループの扱い）を
 * 固定シードの乱択で検査する。次の不変条件を毎 update 後に確かめる。
 * `stats().requiredBytes <= budget || stats().thresholdScale === minScale`。
 *
 * 背景: ミューテーション検査で、予測が現用レベルとずれる実装（ヒステリシス無視・
 * 最粗pins抜き・維持グループ除外）が既存テストをすり抜けたため、このファイルで守る。
 */
import { describe, expect, it } from 'vitest';
import { DataTexture, Mesh, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry } from 'three';
import { createTextureLodSet } from './texture-lod-set.js';
import { TextureLodManager } from './texture-lod-manager.js';

/** 固定シードの疑似乱数。実行ごとに同じ系列を返す。 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** 一辺 size の正方形 DataTexture を作る。 */
function dataTexture(size: number): DataTexture {
  const texture = new DataTexture(new Uint8Array(4), size, size);
  texture.needsUpdate = true;
  return texture;
}

describe('TextureLodManager adaptive fuzz', () => {
  it('40,000 update で required<=budget || scale===min を保つ（seed 7）', () => {
    const random = seededRandom(7);
    // ADR: ジオメトリとカメラは全試行で使い回す。距離はメッシュ位置だけで変える。
    // `center` 測距のため、バウンディング球の大きさは結果に影響しない。
    const geometry = new PlaneGeometry(0.01, 0.01);
    const camera = new PerspectiveCamera();
    const minScale = 0.05;
    let updates = 0;
    let floorFrames = 0;
    const startedAt = Date.now();
    for (let trial = 0; trial < 200; trial++) {
      let now = 0;
      const manager = new TextureLodManager({
        distanceMode: 'center',
        now: () => now,
        evictDelayMs: random() < 0.5 ? 1_000_000_000 : 200,
        maxResidentBytes: 1 + random() * 3000,
        adaptiveThresholdScale: {
          stepsPerOctave: 1 + Math.floor(random() * 6),
          raiseCooldownMs: random() * 500,
          raiseIntervalMs: random() * 200,
        },
      });
      // ADR: `normalMap` をセット間で共有し、テクスチャ共有時の参照カウントずれも同時に踏む。
      // ヒステリシス 0.25 は予測と実判定のずれ（M1 検出用）に効く幅である。
      const shared = dataTexture(6);
      const sets: { set: ReturnType<typeof createTextureLodSet>; base: MeshStandardMaterial }[] =
        [];
      for (let s = 0; s < 4; s++) {
        const base = new MeshStandardMaterial();
        const levels = [8, 5, 3, 1].map((size, i) => ({
          distance: [0, 3, 6, 12][i] as number,
          textures: {
            map: dataTexture(size),
            normalMap: i === 1 || i === 3 ? shared : dataTexture(size),
          },
        }));
        sets.push({
          set: createTextureLodSet({ material: base, levels, hysteresis: 0.25 }),
          base,
        });
      }
      const anchors: Mesh[] = [];
      for (let g = 0; g < 6; g++) {
        const first = sets[g % 4] as { set: ReturnType<typeof createTextureLodSet>; base: MeshStandardMaterial };
        const second = sets[(g + 1) % 4] as { set: ReturnType<typeof createTextureLodSet>; base: MeshStandardMaterial };
        const meshA = new Mesh(geometry, first.base);
        const meshB = new Mesh(geometry, second.base);
        manager.addGroup([
          { mesh: meshA, set: first.set },
          { mesh: meshB, set: second.set },
        ]);
        anchors.push(meshA);
      }
      try {
        for (let frame = 0; frame < 200; frame++) {
          now += 16;
          for (const anchor of anchors) {
            if (random() < 0.3) {
              anchor.position.z = -random() * 30;
            }
            anchor.visible = random() > 0.05;
          }
          if (random() < 0.02) {
            manager.setMaxResidentBytes(random() < 0.2 ? null : 1 + random() * 3000);
          }
          manager.update(camera);
          updates++;
          const stats = manager.stats();
          if (stats.thresholdScale === minScale) {
            floorFrames++;
          }
          if (stats.budgetBytes !== null) {
            // 不変条件: 予算内に収めるか、下限で頭打ちのどちらかである。
            expect(stats.requiredBytes <= stats.budgetBytes || stats.thresholdScale === minScale).toBe(
              true,
            );
          }
        }
      } finally {
        manager.dispose();
      }
    }
    const elapsedMs = Date.now() - startedAt;
    // eslint-disable-next-line no-console
    console.log(`adaptive fuzz: updates=${updates} floorFrames=${floorFrames} elapsedMs=${elapsedMs}`);
  });

  it('予算が十分なら scale===min のフレームは 0 になる（seed 123）', () => {
    // 過大評価（常に下限へ落とす実装など）はここで落ちる。
    // 予算は試行ごとの全テクスチャ合計（約3860）の1.3倍弱に抑え、
    // 二重計上の変異では必要量が2倍に見えて下限へ落ちるようにする。
    const random = seededRandom(123);
    const geometry = new PlaneGeometry(0.01, 0.01);
    const camera = new PerspectiveCamera();
    const minScale = 0.05;
    const budget = 5_000;
    let floorFrames = 0;
    for (let trial = 0; trial < 50; trial++) {
      let now = 0;
      const manager = new TextureLodManager({
        distanceMode: 'center',
        now: () => now,
        evictDelayMs: 1_000_000_000,
        maxResidentBytes: budget,
        adaptiveThresholdScale: {
          stepsPerOctave: 1 + Math.floor(random() * 6),
          raiseCooldownMs: random() * 500,
          raiseIntervalMs: random() * 200,
        },
      });
      const shared = dataTexture(6);
      // ADR: 4セットを使い回し、試行ごとの全テクスチャ合計を約3860に抑える（予算5000で収まる）。
      const sets: ReturnType<typeof createTextureLodSet>[] = [];
      const bases: MeshStandardMaterial[] = [];
      for (let s = 0; s < 4; s++) {
        const base = new MeshStandardMaterial();
        bases.push(base);
        sets.push(
          createTextureLodSet({
            material: base,
            levels: [8, 5, 3, 1].map((size, i) => ({
              distance: [0, 3, 6, 12][i] as number,
              textures: {
                map: dataTexture(size),
                normalMap: i === 1 || i === 3 ? shared : dataTexture(size),
              },
            })),
            hysteresis: 0.25,
          }),
        );
      }
      const anchors: Mesh[] = [];
      for (let g = 0; g < 6; g++) {
        const first = sets[g % 4] as ReturnType<typeof createTextureLodSet>;
        const second = sets[(g + 1) % 4] as ReturnType<typeof createTextureLodSet>;
        const meshA = new Mesh(geometry, bases[g % 4] as MeshStandardMaterial);
        const meshB = new Mesh(geometry, bases[(g + 1) % 4] as MeshStandardMaterial);
        manager.addGroup([
          { mesh: meshA, set: first },
          { mesh: meshB, set: second },
        ]);
        anchors.push(meshA);
      }
      try {
        for (let frame = 0; frame < 200; frame++) {
          now += 16;
          for (const anchor of anchors) {
            if (random() < 0.3) {
              anchor.position.z = -random() * 30;
            }
            anchor.visible = random() > 0.05;
          }
          manager.update(camera);
          const stats = manager.stats();
          if (stats.thresholdScale === minScale) {
            floorFrames++;
          }
          expect(stats.thresholdScale).toBe(1);
          expect(stats.requiredBytes).toBeLessThanOrEqual(budget);
        }
      } finally {
        manager.dispose();
      }
    }
    expect(floorFrames).toBe(0);
  });
});
