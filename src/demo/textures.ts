import { CanvasTexture, SRGBColorSpace, type Texture } from 'three/webgpu';

/**
 * LODデモ用の解像度別テクスチャ3枚。
 *
 * 同一レイアウトを解像度違いで描画し、解像度差が目視できるようにする。
 * 暗色背景に共通し、レベルごとに外周色だけを変える。
 */
export interface LodDemoTextures {
  readonly t0: Texture;
  readonly t1: Texture;
  readonly t2: Texture;
}

/** レベル表示の定義。外周色は L0=緑・L1=青・L2=紫。 */
const LEVEL_STYLE = [
  { label: 'L0', sub: '1024px', size: 1024, border: '#22c55e' },
  { label: 'L1', sub: '256px', size: 256, border: '#3b82f6' },
  { label: 'L2', sub: '64px', size: 64, border: '#a855f7' },
] as const;

/**
 * 1枚分のCanvasを描画する。
 *
 * 解像度差が分かるよう、細かい格子と斜線の高周波パターンを
 * サイズに比例した同一レイアウトで描く。低解像度では潰れて見える。
 *
 * @param size - 一辺の画素数。
 * @param label - 中央に大きく出すレベル名。
 * @param sub - 中央下に小さく出す解像度表記。
 * @param border - 外周のレベル色。
 */
function drawLodCanvas(size: number, label: string, sub: string, border: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    throw new Error('2dコンテキストを取得できません');
  }
  // 暗色背景（全レベル共通）。
  ctx.fillStyle = '#10141c';
  ctx.fillRect(0, 0, size, size);

  // 細かい格子（高周波パターン）。線幅は1px固定ではなくサイズ比例にし、
  // レイアウト自体は全レベルで同一にする。低解像度では線が潰れる。
  const step = size / 64;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.lineWidth = Math.max(1, size / 512);
  ctx.beginPath();
  for (let i = 0; i <= 64; i++) {
    const p = i * step;
    ctx.moveTo(p, 0);
    ctx.lineTo(p, size);
    ctx.moveTo(0, p);
    ctx.lineTo(size, p);
  }
  ctx.stroke();

  // 斜線ハッチング（格子と干渉してモアレが出る高周波成分）。
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
  ctx.beginPath();
  for (let i = -64; i <= 128; i++) {
    const p = i * step;
    ctx.moveTo(p, 0);
    ctx.lineTo(p + size, size);
  }
  ctx.stroke();

  // 中央のレベル表示。
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${size * 0.38}px sans-serif`;
  ctx.fillText(label, size / 2, size * 0.46);
  ctx.font = `${size * 0.09}px sans-serif`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.fillText(sub, size / 2, size * 0.72);

  // レベル色の外周。遠目でもレベルが判別できる目印。
  ctx.strokeStyle = border;
  ctx.lineWidth = Math.max(2, size / 24);
  ctx.strokeRect(0, 0, size, size);
  return canvas;
}

/**
 * LODデモ用の3解像度テクスチャを生成する。
 *
 * @param maxAnisotropy - `renderer.getMaxAnisotropy()` の値。斜めから見た板の滲みを抑える。
 */
export function createLodTextures(maxAnisotropy: number): LodDemoTextures {
  const [t0, t1, t2] = LEVEL_STYLE.map(({ label, sub, size, border }) => {
    const texture = new CanvasTexture(drawLodCanvas(size, label, sub, border));
    texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = maxAnisotropy;
    texture.needsUpdate = true;
    return texture;
  });
  return { t0, t1, t2 };
}
