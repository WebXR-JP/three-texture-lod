/**
 * VRMデモのステージ（床・グリッド・背景・ライト・レベルリング）。
 *
 * ライティングは MToon の見え方に合わせて、環境光 + 2灯のディレクショナルで構成する。
 * 床は PBR の MeshStandardMaterial で、LODの対象外（テクスチャを持たない）。
 */
import {
  CanvasTexture,
  Color,
  DirectionalLight,
  DoubleSide,
  Fog,
  GridHelper,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  RingGeometry,
  SRGBColorSpace,
  type Scene,
} from 'three/webgpu';

export interface Environment {
  root: Group;
  update(delta: number): void;
}

const LEVEL_COLORS = [
  new Color('#6ee7c8'),
  new Color('#ffe066'),
  new Color('#ffa94d'),
  new Color('#ff6b6b'),
  new Color('#5b6b7d'),
] as const;

/** レベルに対応するリング色。共有インスタンスを返す（呼び出し側で copy する）。 */
export function levelColor(level: number | null): Color {
  if (level === null) return LEVEL_COLORS[4];
  return LEVEL_COLORS[Math.min(3, level)];
}

/** 背景用のグラデーションを作る（外部アセットを持たない）。 */
function createBackdropTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context を取得できません');
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, '#182738');
  gradient.addColorStop(0.45, '#0d1621');
  gradient.addColorStop(1, '#070a0f');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 中央のぼんやりした光。アバターのシルエットを拾いやすくする。
  const glow = ctx.createRadialGradient(
    canvas.width * 0.5,
    canvas.height * 0.42,
    20,
    canvas.width * 0.5,
    canvas.height * 0.42,
    canvas.width * 0.42,
  );
  glow.addColorStop(0, 'rgba(90, 160, 220, 0.28)');
  glow.addColorStop(1, 'rgba(90, 160, 220, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** 足元のレベルリング。 */
export function createLevelRing(): Mesh {
  const geometry = new RingGeometry(0.52, 0.62, 64);
  const material = new MeshBasicMaterial({
    color: levelColor(null).clone(),
    transparent: true,
    opacity: 0.9,
    side: DoubleSide,
    depthWrite: false,
  });
  const ring = new Mesh(geometry, material);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.012;
  ring.renderOrder = 1;
  return ring;
}

/** リングの色をレベルに合わせる。 */
export function setRingLevel(ring: Mesh, level: number | null): void {
  const material = ring.material as MeshBasicMaterial;
  material.color.copy(levelColor(level));
}

export function createEnvironment(scene: Scene): Environment {
  const root = new Group();
  scene.add(root);

  scene.background = new Color('#0b0f15');
  scene.fog = new Fog('#0b0f15', 24, 66);

  const floor = new Mesh(
    new PlaneGeometry(90, 90),
    new MeshStandardMaterial({
      color: '#162231',
      roughness: 0.72,
      metalness: 0.35,
    }),
  );
  floor.rotation.x = -Math.PI / 2;
  root.add(floor);

  const grid = new GridHelper(90, 90, '#2b4a68', '#162433');
  grid.position.y = 0.003;
  const gridMaterial = grid.material as unknown as MeshBasicMaterial;
  gridMaterial.transparent = true;
  gridMaterial.opacity = 0.5;
  gridMaterial.depthWrite = false;
  root.add(grid);

  const backdrop = new Mesh(
    new PlaneGeometry(80, 30),
    new MeshBasicMaterial({ map: createBackdropTexture(), depthWrite: false }),
  );
  backdrop.position.set(0, 12, -24);
  root.add(backdrop);

  const hemi = new HemisphereLight('#a9c9ff', '#141a22', 1.9);
  root.add(hemi);

  const key = new DirectionalLight('#ffffff', 2.4);
  key.position.set(5, 9, 7);
  root.add(key);

  const rim = new DirectionalLight('#9ec8ff', 1.35);
  rim.position.set(-6, 4, -7);
  root.add(rim);

  const warm = new DirectionalLight('#ffd2a6', 0.9);
  warm.position.set(-3, 2.5, 4);
  root.add(warm);

  // ゆっくりした光の揺れ。静止画で陰影が固まりすぎないようにする。
  let elapsed = 0;
  return {
    root,
    update(delta: number) {
      elapsed += delta;
      key.position.x = 5 + Math.sin(elapsed * 0.25) * 0.8;
      rim.position.z = -7 + Math.cos(elapsed * 0.2) * 0.6;
    },
  };
}
