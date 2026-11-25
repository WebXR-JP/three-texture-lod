/**
 * アバター頭上のラベル（スプライト）。
 *
 * DOMではなくシーン内のスプライトにして、カメラ移動やVRでも同じ位置に出す。
 * 文字は CanvasTexture に描き、レベルが変わったときだけ再描画する。
 */
import {
  CanvasTexture,
  LinearFilter,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
} from 'three/webgpu';

const LEVEL_TEXT = ['L0', 'L1', 'L2', 'L3', 'L4'];
const LEVEL_COLORS = ['#6ee7c8', '#ffe066', '#ffa94d', '#ff6b6b', '#c77dff'] as const;

export interface AvatarLabel {
  readonly sprite: Sprite;
  set(text: string, level: number | null): void;
}

/** 角丸四角とテキストを描く。 */
function draw(canvas: HTMLCanvasElement, text: string, level: number | null): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);

  const color = level === null ? '#9aa9bb' : LEVEL_COLORS[Math.min(LEVEL_COLORS.length - 1, level)];
  const radius = 18;
  ctx.fillStyle = 'rgba(8, 14, 22, 0.82)';
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(3, 3, width - 6, height - 6, radius);
  ctx.fill();
  ctx.stroke();

  ctx.font = '600 34px ui-monospace, Menlo, Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#e6f1ff';
  ctx.fillText(text, width / 2, height / 2 - 1);

  // 左端にレベルの色帯を置く。文字が小さくても色で判別できる。
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(14, height / 2 - 20, 8, 40, 4);
  ctx.fill();
}

export function createAvatarLabel(): AvatarLabel {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 72;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;

  const material = new SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new Sprite(material);
  sprite.scale.set(0.95, 0.21, 1);
  sprite.position.y = 1.9;
  sprite.renderOrder = 20;

  let last = '';
  const set = (text: string, level: number | null) => {
    const key = `${text}|${level}`;
    if (key === last) return;
    last = key;
    const levelText = level === null ? '--' : LEVEL_TEXT[Math.min(LEVEL_TEXT.length - 1, level)];
    draw(canvas, `${text}  ${levelText}`, level);
    texture.needsUpdate = true;
  };
  set('', null);
  return { sprite, set };
}
