import GUI from 'lil-gui';
import {
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  WebGPURenderer,
} from 'three/webgpu';
import { createTextureLodSet, TextureLodManager } from '../lib/index.js';
import type { TextureLodSet } from '../lib/index.js';
import type { DistanceMode, ResidencyMode } from '../lib/index.js';
import { createLodTextures } from './textures.js';

/**
 * LODデモの動作設定。
 *
 * 再構築対象（hysteresis / residency / evictDelayMs / distanceMode）の変更は
 * マネージャとセットを作り直す。切替カウンタはリセットされる。
 */
interface DemoSettings {
  autoMove: boolean;
  speed: number;
  hysteresis: number;
  residency: ResidencyMode;
  evictDelayMs: number;
  distanceMode: DistanceMode;
  lodEnabled: boolean;
}

/** スモーク用の公開API。`window.__lodDemo` として出す。 */
interface LodDemoApi {
  ready: boolean;
  stats: () => {
    objectCount: number;
    switchCount: number;
    levelCounts: number[];
    residentBytes: number;
    backend: string;
    pipelineCaches: number;
    fragmentPrograms: number;
    drawCalls: number;
    frameTimeMs: number;
    /** tick ごとに1ずつ増える通し番号。スモークがフレーム進行を待つために使う。 */
    frame: number;
    /** 参考値。r187では dispose 直後に減らないことがあるため検証には使わない。 */
    textureCount: number;
  };
  setCameraZ: (z: number) => void;
  setAutoMove: (on: boolean) => void;
  setSettings: (partial: {
    hysteresis?: number;
    residency?: ResidencyMode;
    evictDelayMs?: number;
    distanceMode?: DistanceMode;
    lodEnabled?: boolean;
  }) => void;
  setProbeDistance: (distance: number) => void;
  probeLevel: () => number | null;
  meshCount: number;
}

declare global {
  interface Window {
    __lodDemo: LodDemoApi;
  }
}

/** カメラ高さと注視点（全板と共有する）。 */
const CAM_Y = 1.6;
const LOOK_TARGET: readonly [number, number, number] = [0, 1.6, -100];
/** プローブ板のワールド座標。グリッドの1枚（x=0, row=8）を兼ねる。 */
const PROBE_POS: readonly [number, number, number] = [0, 1.6, -60];
/** LOD境界距離。 */
const THRESHOLDS = [0, 10, 25] as const;
/** 自動往復の範囲（カメラz）。 */
const AUTO_MIN_Z = -70;
const AUTO_MAX_Z = 6;
/** 列x座標と行z（-4〜-81）。 */
const COL_XS = [-3.2, -1.6, 0, 1.6, 3.2] as const;
const ROW_COUNT = 12;
const ROW_START_Z = -4;
const ROW_STEP = 7;

const url = new URLSearchParams(location.search);
const forceWebGL = url.get('backend') === 'webgl';

/**
 * ヒステリシス幅を lil-gui と同じ 0〜0.3 に収める。
 *
 * 範囲外のまま `createTextureLodSet` に渡すとバンド重なりで throw し、
 * 再構築の途中でマネージャとセットが壊れた状態になるため、入口で丸める。
 * 不正値は既定の 0.1 に戻す。
 */
function clampHysteresis(value: unknown, fallback = 0.1): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(0.3, Math.max(0, value));
}

const settings: DemoSettings = {
  autoMove: url.get('auto') !== '0',
  speed: 8,
  hysteresis: clampHysteresis(Number(url.get('h') ?? 0.1)),
  residency: url.get('residency') === 'keep-all' ? 'keep-all' : 'evict',
  evictDelayMs: 5000,
  distanceMode: 'surface',
  // `?lod=0` で初期状態からLODを無効化する（ベースマテリアルのみ描画）。
  lodEnabled: url.get('lod') !== '0',
};

const canvas = document.getElementById('scene');
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('#scene canvasがありません');
}

const renderer = new WebGPURenderer({ canvas, antialias: true, forceWebGL });
await renderer.init();
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const scene = new Scene();
scene.background = new Color(0x0b0f14);
// フォグなし。Hemisphere + Directional のみで影は付けない。
scene.add(new HemisphereLight(0xdfeaff, 0x1a2029, 0.9));
const directional = new DirectionalLight(0xffffff, 1.6);
directional.position.set(2, 5, 10);
scene.add(directional);

const camera = new PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 300);
camera.position.set(0, CAM_Y, Number(url.get('z') ?? 0));
if (!Number.isFinite(camera.position.z)) {
  camera.position.z = 0;
}
camera.lookAt(...LOOK_TARGET);
renderer.setSize(innerWidth, innerHeight);
window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// テクスチャは renderer 初期化後（anisotropy 上限の確定後）に作る。
const { t0, t1, t2 } = createLodTextures(renderer.getMaxAnisotropy());
const baseMaterial = new MeshStandardMaterial({ map: t0, roughness: 0.85, metalness: 0 });
baseMaterial.name = 'lod-demo-base';

const boardGeometry = new PlaneGeometry(1.4, 0.9);
const meshes: Mesh[] = [];
for (let row = 0; row < ROW_COUNT; row++) {
  for (const x of COL_XS) {
    const mesh = new Mesh(boardGeometry, baseMaterial);
    mesh.position.set(x, CAM_Y, ROW_START_Z - row * ROW_STEP);
    scene.add(mesh);
    meshes.push(mesh);
  }
}
// プローブはグリッド内の1枚を兼ねる（z=-60 の板）。余分なメッシュを増やさない。
const foundProbe = meshes.find((m) => m.position.x === 0 && m.position.z === PROBE_POS[2]);
if (foundProbe === undefined) {
  throw new Error('プローブ位置の板がありません');
}
const probe: Mesh = foundProbe;

let lodSet: TextureLodSet<MeshStandardMaterial> | null = null;
let manager = new TextureLodManager({
  distanceMode: settings.distanceMode,
  residency: settings.residency,
  evictDelayMs: settings.evictDelayMs,
});

/**
 * マネージャとセットを再構築する。
 *
 * ヒステリシス・常駐方針・距離モードはセット／マネージャ生成時の固定値のため、
 * 変更時は dispose して作り直す。switchCount 等のカウンタはリセットされる。
 */
function rebuildLod(): void {
  manager.dispose();
  lodSet?.dispose();
  lodSet = createTextureLodSet({
    material: baseMaterial,
    levels: [
      { distance: THRESHOLDS[0], textures: { map: t0 } },
      { distance: THRESHOLDS[1], textures: { map: t1 } },
      { distance: THRESHOLDS[2], textures: { map: t2 } },
    ],
    hysteresis: settings.hysteresis,
  });
  manager = new TextureLodManager({
    distanceMode: settings.distanceMode,
    residency: settings.residency,
    evictDelayMs: settings.evictDelayMs,
  });
  if (settings.lodEnabled) {
    for (const mesh of meshes) {
      manager.add(mesh, lodSet);
    }
  }
}

/** LODの有効／無効を切り替える。無効時は全meshを外してベースマテリアルに戻す。 */
function applyLodEnabled(): void {
  if (lodSet === null) {
    return;
  }
  if (settings.lodEnabled) {
    for (const mesh of meshes) {
      manager.add(mesh, lodSet);
    }
  } else {
    for (const mesh of meshes) {
      manager.remove(mesh);
    }
  }
}

rebuildLod();

/** プローブ板のワールド半径。surface モードのカメラ配置に使う。 */
function probeRadius(): number {
  probe.updateWorldMatrix(true, false);
  const sphere = boardGeometry.boundingSphere;
  if (sphere === null) {
    boardGeometry.computeBoundingSphere();
  }
  const local = boardGeometry.boundingSphere?.radius ?? 0;
  const e = probe.matrixWorld.elements;
  const sx = Math.sqrt(e[0] * e[0] + e[1] * e[1] + e[2] * e[2]);
  const sy = Math.sqrt(e[4] * e[4] + e[5] * e[5] + e[6] * e[6]);
  const sz = Math.sqrt(e[8] * e[8] + e[9] * e[9] + e[10] * e[10]);
  return local * Math.max(sx, sy, sz);
}

/** カメラzを即時設定する。 */
function setCameraZ(z: number): void {
  camera.position.z = z;
}

/** カメラをプローブからちょうど distance の位置へ動かす。
 *
 * center モードで 0 を指定するとカメラが板と同一位置になり、
 * 板はエッジオンで見えなくなる（検証用途では surface か 1 以上を使う）。
 * 挙動自体は変えない（カメラ配置のヘルパーである）。
 */
function setProbeDistance(distance: number): void {
  // 中心が x=0,y=1.6 で揃うため、z差が中心距離に等しい。
  // surface時は半径分だけ余分に離す（computeLodDistance と一致させる）。
  const radius = settings.distanceMode === 'surface' ? probeRadius() : 0;
  camera.position.set(0, CAM_Y, PROBE_POS[2] + distance + radius);
}

/** バックエンド名。`backend` は公開フィールドだが具象フラグは構造で読む。 */
function backendName(): string {
  const backend = renderer.backend as unknown as { isWebGPUBackend?: boolean };
  return backend.isWebGPUBackend === true ? 'webgpu' : 'webgl';
}

/**
 * パイプライン数の取得。
 *
 * デバッグ用の内部アクセス: `_pipelines` は公開APIではなく three の実装詳細である。
 * バリアント切替でパイプラインが再生成されないことの裏付け表示にのみ使う。
 * three の更新で構造が変わったらここだけ直す。
 */
function pipelineInfo(): { caches: number; fragmentPrograms: number } {
  const internal = renderer as unknown as {
    _pipelines: { caches: { size: number }; programs: { fragment: { size: number } } };
  };
  return {
    caches: internal._pipelines.caches.size,
    fragmentPrograms: internal._pipelines.programs.fragment.size,
  };
}

// HUD（DOMオーバーレイ）。250msごとに更新する。
const hud = document.createElement('div');
hud.id = 'hud';
hud.style.cssText =
  'position:fixed;top:12px;left:12px;padding:10px 12px;' +
  'background:rgba(8,12,18,0.78);color:#d7e3f4;font:12px/1.7 monospace;' +
  'border:1px solid #2a3a4f;border-radius:8px;white-space:pre;pointer-events:none;z-index:10;';
hud.textContent = '初期化中…';
document.body.appendChild(hud);

// lil-gui。右上に操作パネルを出す。
const gui = new GUI({ title: 'Texture LOD デモ' });
const params = {
  autoMove: settings.autoMove,
  speed: settings.speed,
  hysteresis: settings.hysteresis,
  residency: settings.residency,
  evictDelayMs: settings.evictDelayMs,
  distanceMode: settings.distanceMode,
  lodEnabled: settings.lodEnabled,
  近距離へ: () => {
    setCameraZ(0);
  },
  遠距離へ: () => {
    setCameraZ(30);
  },
  'h=0で往復テスト': () => {
    void runZeroHysteresisTest();
  },
};
gui.add(params, 'autoMove').name('autoMove').onChange((v: boolean) => {
  settings.autoMove = v;
});
gui.add(params, 'speed', 1, 30).name('speed').onChange((v: number) => {
  settings.speed = v;
});
gui.add(params, 'hysteresis', 0, 0.3, 0.01).name('hysteresis').onFinishChange((v: number) => {
  settings.hysteresis = v;
  rebuildLod();
});
gui
  .add(params, 'residency', ['evict', 'keep-all'])
  .name('residency')
  .onFinishChange((v: ResidencyMode) => {
    settings.residency = v;
    rebuildLod();
  });
gui.add(params, 'evictDelayMs', 0, 10000, 100).name('evictDelayMs').onFinishChange((v: number) => {
  settings.evictDelayMs = v;
  rebuildLod();
});
gui
  .add(params, 'distanceMode', ['surface', 'center'])
  .name('distanceMode')
  .onFinishChange((v: DistanceMode) => {
    settings.distanceMode = v;
    rebuildLod();
  });
gui.add(params, 'lodEnabled').name('LOD有効').onChange((v: boolean) => {
  settings.lodEnabled = v;
  applyLodEnabled();
});
gui.add(params, '近距離へ');
gui.add(params, '遠距離へ');
gui.add(params, 'h=0で往復テスト');

/** GUIの表示値を settings に合わせる（API経由の変更用）。 */
function syncGui(): void {
  params.autoMove = settings.autoMove;
  params.speed = settings.speed;
  params.hysteresis = settings.hysteresis;
  params.residency = settings.residency;
  params.evictDelayMs = settings.evictDelayMs;
  params.distanceMode = settings.distanceMode;
  params.lodEnabled = settings.lodEnabled;
  for (const controller of gui.controllersRecursive()) {
    controller.updateDisplay();
  }
}

/**
 * h=0 での境界往復テスト。
 *
 * ヒステリシスなしで境界 T=10 / 25 をまたぐようプローブ距離を振り、
 * 境界付近で発振なく追従することを目視確認する。二重起動は無視する。
 */
let zeroTestRunning = false;
async function runZeroHysteresisTest(): Promise<void> {
  if (zeroTestRunning) {
    return;
  }
  zeroTestRunning = true;
  const prevAuto = settings.autoMove;
  // 開始前の幅を退避し、終了後に設定と GUI 表示を元に戻す。
  const prevHysteresis = settings.hysteresis;
  settings.autoMove = false;
  settings.hysteresis = 0;
  rebuildLod();
  syncGui();
  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  for (const d of [8, 12, 8, 12, 23, 27, 23, 27]) {
    setProbeDistance(d);
    await wait(450);
  }
  settings.autoMove = prevAuto;
  settings.hysteresis = prevHysteresis;
  rebuildLod();
  syncGui();
  zeroTestRunning = false;
}

// フレーム時間の移動平均（指数平均）。
let frameTimeMs = 0;
let lastTickAt = performance.now();
let moveDirection = -1;
// tick ごとに1ずつ増える通し番号。スモークがフレーム進行を待つために使う。
let frame = 0;

function tick(): void {
  frame += 1;
  const started = performance.now();
  const dt = Math.min((started - lastTickAt) / 1000, 0.1);
  lastTickAt = started;
  if (settings.autoMove) {
    // z を 6 → -70 → 6 と往復する。注視点は固定。
    let z = camera.position.z + moveDirection * settings.speed * dt;
    if (z <= AUTO_MIN_Z) {
      z = AUTO_MIN_Z;
      moveDirection = 1;
    } else if (z >= AUTO_MAX_Z) {
      z = AUTO_MAX_Z;
      moveDirection = -1;
    }
    camera.position.z = z;
  }
  camera.lookAt(...LOOK_TARGET);
  // 毎フレーム: LOD判定 → 描画の順。
  if (settings.lodEnabled) {
    manager.update(camera);
  }
  renderer.render(scene, camera);
  const elapsed = performance.now() - started;
  frameTimeMs = frameTimeMs === 0 ? elapsed : frameTimeMs * 0.95 + elapsed * 0.05;
  if (!hudRefreshed) {
    // 初フレーム直後にHUDを確定させる。スモークのスクリーンショットが初期値のままにならない。
    hudRefreshed = true;
    updateHud();
  }
}

// HUD更新（250msごと）。切替/秒は区間の差分から求める。
let lastHudAt = performance.now();
let lastSwitchCount = 0;
let hudRefreshed = false;
function updateHud(): void {
  const now = performance.now();
  const stats = manager.stats();
  const pipelines = pipelineInfo();
  const switchesPerSec = ((stats.switchCount - lastSwitchCount) / Math.max(1, now - lastHudAt)) * 1000;
  lastHudAt = now;
  lastSwitchCount = stats.switchCount;
  const counts = [0, 1, 2].map((i) => `L${i}:${stats.levelCounts[i] ?? 0}`).join(' ');
  hud.textContent =
    `backend: ${backendName()}\n` +
    `objects: ${stats.objectCount}  switches: ${stats.switchCount} (${switchesPerSec.toFixed(1)}/s)\n` +
    `levels: ${counts}\n` +
    `resident: ${(stats.residentBytes / 1048576).toFixed(2)} MB\n` +
    `frame: ${frameTimeMs.toFixed(2)} ms  calls: ${renderer.info.render.calls}\n` +
    `pipelines: caches=${pipelines.caches} fragment=${pipelines.fragmentPrograms}\n` +
    `※設定再構築でカウンタはリセットされます`;
}
setInterval(updateHud, 250);
updateHud();

window.__lodDemo = {
  ready: true,
  stats: () => {
    const s = manager.stats();
    const pipelines = pipelineInfo();
    return {
      objectCount: s.objectCount,
      switchCount: s.switchCount,
      levelCounts: [...s.levelCounts],
      residentBytes: s.residentBytes,
      backend: backendName(),
      pipelineCaches: pipelines.caches,
      fragmentPrograms: pipelines.fragmentPrograms,
      drawCalls: renderer.info.render.calls,
      frameTimeMs,
      frame,
      // 参考値。r187では dispose 直後に減らないことがあるため検証には使わない。
      textureCount: renderer.info.memory.textures,
    };
  },
  setCameraZ: (z: number) => {
    setCameraZ(z);
  },
  setAutoMove: (on: boolean) => {
    settings.autoMove = on;
    syncGui();
  },
  setSettings: (partial: {
    hysteresis?: number;
    residency?: ResidencyMode;
    evictDelayMs?: number;
    distanceMode?: DistanceMode;
    lodEnabled?: boolean;
  }) => {
    let rebuild = false;
    if (partial.hysteresis !== undefined) {
      // スモーク等から範囲外が来てもバンド重なりで throw させないよう、GUI と同じ範囲に丸める。
      const clamped = clampHysteresis(partial.hysteresis, settings.hysteresis);
      if (clamped !== settings.hysteresis) {
        settings.hysteresis = clamped;
        rebuild = true;
      }
    }
    if (partial.residency !== undefined && partial.residency !== settings.residency) {
      settings.residency = partial.residency;
      rebuild = true;
    }
    if (partial.evictDelayMs !== undefined && partial.evictDelayMs !== settings.evictDelayMs) {
      settings.evictDelayMs = partial.evictDelayMs;
      rebuild = true;
    }
    if (partial.distanceMode !== undefined && partial.distanceMode !== settings.distanceMode) {
      settings.distanceMode = partial.distanceMode;
      rebuild = true;
    }
    // 同期的に再構築し、次フレームの判定から新設定が効く。
    if (rebuild) {
      rebuildLod();
    }
    if (partial.lodEnabled !== undefined && partial.lodEnabled !== settings.lodEnabled) {
      settings.lodEnabled = partial.lodEnabled;
      applyLodEnabled();
    }
    syncGui();
  },
  setProbeDistance: (distance: number) => {
    setProbeDistance(distance);
  },
  probeLevel: () => {
    if (!settings.lodEnabled) {
      return null;
    }
    try {
      return manager.levelOf(probe);
    } catch {
      return null;
    }
  },
  meshCount: meshes.length,
};

void renderer.setAnimationLoop(tick);