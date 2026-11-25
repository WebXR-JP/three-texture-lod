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
  DynamicDrawUsage,
  Fog,
  GridHelper,
  Group,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
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

/** 足元のレベルリングを1つの InstancedMesh で描く束ね役。 */
export interface LevelRings {
  /** 全体数ぶんのインスタンスを持つメッシュ。`count` で表示数を絞る。 */
  readonly mesh: InstancedMesh;
  /** 表示数を体数に合わせる。次フレームの描画に反映される。 */
  setCount(n: number): void;
  /**
   * 体番号のリング位置と色を積む。行列は純粋な平行移動にする。
   *
   * @param index - 体番号。`capacity` 未満であること。
   * @param x - リング中心の x 座標（メートル）。
   * @param z - リング中心の z 座標（メートル）。
   * @param level - LODレベル。`null` はLOD無効時の色になる。
   */
  set(index: number, x: number, z: number, level: number | null): void;
  /** 積んだ行列と色を GPU へ反映する。 */
  commit(): void;
}

/** リング中心の高さ（メートル）。床との z ファイティングを避ける。 */
const RING_Y = 0.012;

/**
 * 指定容量のリング束ねを作る。`count = 0` から始め、呼び出し側が `set` 後に `commit` する。
 *
 * @param capacity - 最大体数。1 未満でも1枠だけ確保する。
 */
export function createLevelRings(capacity: number): LevelRings {
  const geometry = new RingGeometry(0.52, 0.62, 64);
  // リングの向き（-π/2）は共有ジオメトリ側に焼き付ける。インスタンス行列は
  // メッシュのローカル空間で合成されるため、メッシュ側に回転を持たせると
  // 平行移動まで回って中心がずれる。行列は純粋な平行移動に保つ。
  // ADR: 設計書の `ring.rotation.x = -π/2` と等価な見え方にするための措置。
  geometry.rotateX(-Math.PI / 2);
  const material = new MeshBasicMaterial({
    color: new Color('#ffffff'),
    transparent: true,
    opacity: 0.9,
    side: DoubleSide,
    depthWrite: false,
  });
  const mesh = new InstancedMesh(geometry, material, Math.max(1, capacity));
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  // instanceColor は後付けで確保すると WebGPU に反映されない恐れがあるため、
  // 生成直後に全枠へ白を入れて初期化する。
  const white = new Color('#ffffff');
  for (let index = 0; index < Math.max(1, capacity); index++) mesh.setColorAt(index, white);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  const matrix = new Matrix4();
  return {
    mesh,
    setCount(n: number): void {
      mesh.count = n;
    },
    set(index: number, x: number, z: number, level: number | null): void {
      matrix.makeTranslation(x, RING_Y, z);
      mesh.setMatrixAt(index, matrix);
      mesh.setColorAt(index, levelColor(level));
    },
    commit(): void {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    },
  };
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
