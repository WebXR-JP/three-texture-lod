/**
 * VRM × テクスチャLOD デモ。
 *
 * 流れ:
 * 1. VRM を classic MToonMaterial で読み込む
 * 2. avatar-optimizer でアトラス化・マテリアル統合（MToonAtlasNodeMaterial へ）
 * 3. アトラスを 1/2 ずつ縮小した4レベルを作り、1体ぶんを1グループとして登録
 * 4. 毎フレーム、アバターの距離で全マテリアルを同じレベルへ切り替える
 * 5. 複製は最適化を再実行せず、テンプレートのアトラス・セットを共有して体数を増やす
 *
 * URLパラメータ:
 * - `?models=A,B,C` 読み込むモデル（既定、A/B/C はサンプル、それ以外は /models/<name>.vrm か URL）
 * - `?avatars=4` 総体数（既定4、最大12。不足分は最適化済みモデルの複製で補う）
 * - `?backend=webgl` WebGL2 バックエンドを強制
 * - `?lod=0` LODを無効化（最密テクスチャのみ）
 * - `?h=0.15` ヒステリシス幅
 * - `?atlas=1024` アトラス解像度
 * - `?auto=0` 自動カメラを停止
 * - `?residency=keep-all` 常駐モード
 * - `?evictDelay=1000` evict の猶予ms
 */
import GUI from 'lil-gui';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  ACESFilmicToneMapping,
  Mesh,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  type Material,
} from 'three/webgpu';
import { WebGPURenderer } from 'three/webgpu';
import {
  TextureLodManager,
  computeLodDistance,
  type ResidencyMode,
} from '../../lib/index.js';
import {
  LOD_DISTANCES,
  instantiateAvatar,
  loadAvatar,
  type AvatarHandle,
  type AvatarTemplate,
} from './avatar.js';
import { createEnvironment, createLevelRing, setRingLevel } from './environment.js';
import { createAvatarLabel, type AvatarLabel } from './labels.js';

const canvas = document.getElementById('scene');
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('#scene canvas がありません');
}

const params = new URLSearchParams(location.search);
const forceWebGL = params.get('backend') === 'webgl';
const atlasResolution = clampNumber(Number(params.get('atlas') ?? 1024), 256, 2048, 1024);
let hysteresis = clampNumber(Number(params.get('h') ?? 0.15), 0, 0.3, 0.15);
let residency: ResidencyMode = params.get('residency') === 'keep-all' ? 'keep-all' : 'evict';
let evictDelayMs = clampNumber(Number(params.get('evictDelay') ?? 1000), 0, 10000, 1000);
let lodEnabled = params.get('lod') !== '0';
let autoCamera = params.get('auto') !== '0';

const modelSpecs = (params.get('models') ?? 'A,B,C')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
// ソース上限は最適化時の一時 WebGLRenderer のため。複製は最適化を再実行しないので無関係。
const MAX_SOURCES = 4;
const MAX_AVATARS = 12;
// 総体数。不足分は最適化済みモデルの複製で補う。既定4（A,B,C + Aの複製1）。
const targetAvatars = clampNumber(Math.round(Number(params.get('avatars') ?? 4)), 1, MAX_AVATARS, 4);
const MAX_LOD_LEVEL = LOD_DISTANCES.length - 1;

const LAYOUT = [
  { x: 0.9, z: 4.2 },
  { x: -1.3, z: 1.6 },
  { x: 1.7, z: -4.0 },
  { x: -1.5, z: -9.5 },
] as const;

const CAMERA_CENTER = new Vector3(0, 1.05, -3);

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------- renderer

const renderer = new WebGPURenderer({ canvas, antialias: true, forceWebGL });
await renderer.init();
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.02;

const scene = new Scene();
const camera = new PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 150);
camera.position.set(0, 1.55, 7.5);
camera.lookAt(CAMERA_CENTER);

const environment = createEnvironment(scene);

// ユーザーがドラッグで距離を変えられるようにする。自動カメラ中は無効化する。
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(CAMERA_CENTER);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.enablePan = false;
controls.minDistance = 1.2;
controls.maxDistance = 40;
controls.maxPolarAngle = Math.PI * 0.55;
controls.update();

const errors: string[] = [];
window.addEventListener('error', (event) => errors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)));
const originalConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  errors.push(args.map((value) => String(value)).join(' '));
  originalConsoleError(...args);
};

// ---------------------------------------------------------------- state

const avatars: AvatarHandle[] = [];
const labels: AvatarLabel[] = [];
const rings: Mesh[] = [];
// ソースごとの共有元。複製はここに積まず、ハンドルの template で参照する。
const templates: AvatarTemplate[] = [];

let manager = createManager();
let manualLevel: number | null = null;
let frame = 0;
let elapsed = 0;
let frameTimeMs = 0;
let lastFrameCalls = 0;
let lastHudAt = 0;
let lastErrorAt = 0;
let cameraAngle = 0;
let busy = false;

function createManager(): TextureLodManager {
  return new TextureLodManager({
    distanceMode: 'surface',
    residency,
    evictDelayMs,
  });
}

function addGroup(avatar: AvatarHandle): void {
  manager.addGroup(avatar.bindings, { anchor: avatar.anchor });
}

/** 全メッシュを元のアトラスマテリアルへ戻す。バリアント破棄前の後始末に使う。 */
function restoreBaseMaterials(): void {
  for (const avatar of avatars) {
    for (const mesh of avatar.meshes) {
      const base = avatar.baseMaterials.get(mesh);
      if (base) mesh.material = base;
    }
  }
}

function register(avatar: AvatarHandle, source: boolean): void {
  const slot = layoutSlot(avatars.length);
  avatar.root.position.set(slot.x, 0, slot.z);
  scene.add(avatar.root);

  const label = createAvatarLabel();
  label.sprite.position.set(0, 2.0 + (avatars.length % 2) * 0.28, 0);
  avatar.root.add(label.sprite);

  const ring = createLevelRing();
  ring.position.set(slot.x, 0.012, slot.z);
  scene.add(ring);

  avatars.push(avatar);
  labels.push(label);
  rings.push(ring);
  if (source) templates.push(avatar.template);

  if (lodEnabled && manualLevel === null) addGroup(avatar);
}

/** 配置スロット。4体目までは固定レイアウト、5体目以降は奥へ2列で並べる。 */
function layoutSlot(index: number): { x: number; z: number } {
  if (index < LAYOUT.length) return LAYOUT[index];
  // 5体目以降は奥に4列で並べる。2列だと中央に固まってラベルが重なるため。
  const extra = index - LAYOUT.length;
  const row = Math.floor(extra / 4);
  const column = extra % 4;
  const xs = [-6.0, -2.0, 2.0, 6.0];
  return { x: xs[column], z: -13.0 - row * 4.5 };
}

function layout(): void {
  for (const [index, avatar] of avatars.entries()) {
    const slot = layoutSlot(index);
    avatar.root.position.set(slot.x, 0, slot.z);
    rings[index].position.set(slot.x, 0.012, slot.z);
  }
}

/**
 * 最もインスタンスが少ないテンプレートを複製して1体増やす。
 *
 * @returns 追加できたら true。上限到達やソース無しでは false。
 */
function addClone(): boolean {
  if (avatars.length >= MAX_AVATARS) {
    showToast(`複製は最大 ${MAX_AVATARS} 体までです`);
    return false;
  }
  if (templates.length === 0) {
    showToast('複製元のモデルがありません');
    return false;
  }
  let target = templates[0];
  let count = Infinity;
  for (const template of templates) {
    const instances = avatars.filter((avatar) => avatar.template === template).length;
    if (instances < count) {
      count = instances;
      target = template;
    }
  }
  const clone = instantiateAvatar(target, uniqueName(target.name));
  register(clone, false);
  layout();
  showToast(`${clone.name} を複製しました（${avatars.length}体）`);
  return true;
}

/**
 * 最後の複製を1体削除する。テクスチャ・マテリアルは共有のため破棄しない。
 *
 * @returns 削除できたら true。複製が無ければ false。
 */
function removeClone(): boolean {
  for (let index = avatars.length - 1; index >= 0; index--) {
    if (!avatars[index].isClone) continue;
    const avatar = avatars[index];
    if (lodEnabled && manualLevel === null) manager.remove(avatar.anchor);
    // 複製した骨格のボーンテクスチャを解放する。geometry/material はテンプレートと共有なので触らない。
    const skeletons = new Set<{ dispose(): void }>();
    avatar.root.traverse((object) => {
      const skinned = object as unknown as {
        isSkinnedMesh?: boolean;
        skeleton?: { dispose(): void };
      };
      if (skinned.isSkinnedMesh && skinned.skeleton) skeletons.add(skinned.skeleton);
    });
    for (const skeleton of skeletons) skeleton.dispose();
    scene.remove(avatar.root);
    const label = labels[index];
    label.sprite.material.map?.dispose();
    label.sprite.material.dispose();
    const ring = rings[index];
    scene.remove(ring);
    ring.geometry.dispose();
    (ring.material as Material).dispose();
    avatars.splice(index, 1);
    labels.splice(index, 1);
    rings.splice(index, 1);
    layout();
    showToast(`${avatar.name} を削除しました（${avatars.length}体）`);
    return true;
  }
  showToast('削除できる複製がありません');
  return false;
}

function uniqueName(base: string): string {
  let name = base;
  let suffix = 2;
  while (avatars.some((avatar) => avatar.name === name)) {
    name = `${base}${suffix}`;
    suffix++;
  }
  return name;
}

function nameForSpec(spec: string): string {
  if (/^[A-Za-z]$/.test(spec)) return spec.toUpperCase();
  const file = spec.split('/').pop() ?? spec;
  return file.replace(/\.vrm$/i, '');
}

function sourceForSpec(spec: string): string {
  if (/^[A-Za-z]$/.test(spec)) return `/models/AvatarSample_${spec.toUpperCase()}.vrm`;
  if (spec.startsWith('/') || spec.startsWith('http') || spec.endsWith('.vrm')) return spec;
  return `/models/${spec}.vrm`;
}

// ---------------------------------------------------------------- LOD再構築

/**
 * hysteresis を変えるときは、テンプレート単位でバリアントを破棄してセットを作り直す。
 * アトラステクスチャ（元画像）は共有したまま、マテリアルだけを差し替える。
 * 複製を含む全ハンドルは作り直したセットへ rebind する。
 */
function recreateLod(nextHysteresis: number): boolean {
  if (!(nextHysteresis >= 0 && nextHysteresis < 1)) {
    showToast('ヒステリシスは 0 以上 1 未満で指定してください');
    return false;
  }
  const thresholds = LOD_DISTANCES;
  for (let i = 1; i < thresholds.length - 1; i++) {
    if (!(thresholds[i] * (1 + nextHysteresis) < thresholds[i + 1] * (1 - nextHysteresis))) {
      showToast('ヒステリシス幅が広すぎて境界バンドが重なります');
      return false;
    }
  }
  manager.dispose();
  // 強制レベル中はメッシュがバリアントを掴んでいる。破棄前に必ずbaseへ戻す。
  restoreBaseMaterials();
  const unique = new Set(avatars.map((avatar) => avatar.template));
  for (const template of unique) template.disposeVariants();
  hysteresis = nextHysteresis;
  guiState.hysteresis = nextHysteresis;
  for (const template of unique) template.rebuild(hysteresis);
  for (const avatar of avatars) avatar.rebind();
  manualLevel = null;
  guiState.forceLevel = 'auto';
  manager = createManager();
  if (lodEnabled) for (const avatar of avatars) addGroup(avatar);
  return true;
}

/** 常駐モード・猶予の変更。グループは作り直さずマネージャだけ差し替える。 */
function recreateManager(): void {
  manager.dispose();
  manager = createManager();
  if (lodEnabled && manualLevel === null) {
    for (const avatar of avatars) addGroup(avatar);
  }
}

function setLodEnabled(enabled: boolean): void {
  lodEnabled = enabled;
  guiState.forceLevel = 'auto';
  if (enabled) {
    manualLevel = null;
    recreateManager();
  } else {
    manager.dispose();
    manualLevel = null;
    restoreBaseMaterials();
  }
}

function setForceLevel(level: number | null): void {
  if (level !== null && (!Number.isInteger(level) || level < 0 || level > MAX_LOD_LEVEL)) {
    showToast(`固定レベルは 0〜${MAX_LOD_LEVEL} の整数で指定してください`);
    return;
  }
  if (level === null) {
    manualLevel = null;
    if (lodEnabled) recreateManager();
    else restoreBaseMaterials();
    return;
  }
  manualLevel = level;
  manager.dispose();
  for (const avatar of avatars) {
    const sets = avatar.template.sets;
    const max = sets[0]?.levels.length ? sets[0].levels.length - 1 : 3;
    const clamped = Math.min(level, max);
    for (const binding of avatar.bindings) {
      binding.mesh.material = binding.set.variant(clamped);
    }
  }
}

// ---------------------------------------------------------------- カメラ

function setCamera(z: number, x = 0, y = 1.55): void {
  autoCamera = false;
  guiState.autoCamera = false;
  camera.position.set(x, y, z);
  controls.target.copy(CAMERA_CENTER);
  controls.update();
}

function updateAutoCamera(delta: number): void {
  if (!autoCamera) {
    controls.update();
    return;
  }
  // 前後にゆっくりドリーし、横に少し揺らす。初期構図から大きく外れない範囲にする。
  cameraAngle += delta * 0.24;
  camera.position.set(
    Math.sin(cameraAngle * 0.7) * 0.55,
    1.55 + Math.sin(cameraAngle * 1.3) * 0.04,
    7.5 + Math.sin(cameraAngle) * 1.1,
  );
  camera.lookAt(CAMERA_CENTER);
}

/** 指定アバターの表面距離が d になる位置へカメラを置く（テスト用）。 */
function setAvatarSurfaceDistance(index: number, distance: number): boolean {
  const avatar = avatars[index];
  if (!avatar) return false;
  autoCamera = false;
  guiState.autoCamera = false;
  avatar.anchor.updateWorldMatrix(true, false);
  if (!avatar.anchor.geometry.boundingSphere) avatar.anchor.geometry.computeBoundingSphere();
  const sphere = avatar.anchor.geometry.boundingSphere;
  if (!sphere) return false;
  const center = sphere.center.clone().applyMatrix4(avatar.anchor.matrixWorld);
  const e = avatar.anchor.matrixWorld.elements;
  const scaleX = Math.hypot(e[0], e[1], e[2]);
  const scaleY = Math.hypot(e[4], e[5], e[6]);
  const scaleZ = Math.hypot(e[8], e[9], e[10]);
  const radius = sphere.radius * Math.max(scaleX, scaleY, scaleZ);
  camera.position.set(center.x, center.y + radius * 0.15, center.z + radius + distance);
  controls.target.copy(center);
  controls.update();
  return true;
}

// ---------------------------------------------------------------- 読み込み

const loadingEl = document.getElementById('loading')!;
const loadingBarEl = document.getElementById('loading-bar')!;
const loadingStatusEl = document.getElementById('loading-status')!;
const loadingLogEl = document.getElementById('loading-log')!;
const hudBodyEl = document.getElementById('hud-body')!;

function setLoading(text: string, progress: number): void {
  loadingStatusEl.textContent = text;
  loadingBarEl.style.width = `${Math.round(progress * 100)}%`;
}

function appendLog(text: string): void {
  loadingLogEl.textContent += `${text}\n`;
  loadingLogEl.scrollTop = loadingLogEl.scrollHeight;
}

function hideLoading(): void {
  loadingEl.classList.add('hidden');
}

function showFatal(text: string): void {
  loadingEl.classList.remove('hidden');
  loadingEl.classList.add('error');
  (loadingEl.querySelector('h1') as HTMLElement | null)?.replaceChildren('読み込みに失敗しました');
  loadingStatusEl.textContent = text;
  loadingBarEl.style.width = '100%';
}

function showToast(text: string): void {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.style.cssText =
      'position:fixed;left:50%;bottom:42px;transform:translateX(-50%);z-index:30;' +
      'padding:10px 16px;border:1px solid #3a5068;border-radius:8px;' +
      'background:rgba(10,16,24,0.92);color:#dce8f8;font-size:12px;' +
      'font-family:ui-monospace,monospace;pointer-events:none;transition:opacity .25s;';
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.style.opacity = '1';
  window.setTimeout(() => {
    if (toast) toast.style.opacity = '0';
  }, 2600);
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function addFromSource(spec: string, index: number, total: number): Promise<void> {
  const name = uniqueName(nameForSpec(spec));
  setLoading(`${index + 1}/${total} ${name} を最適化中...`, (index + 0.1) / total);
  const avatar = await loadAvatar({
    name,
    source: sourceForSpec(spec),
    renderer,
    atlasResolution,
    hysteresis,
    onProgress: (message) => setLoading(message, (index + 0.35) / total),
  });
  register(avatar, true);
  const stats = avatar.template.stats;
  appendLog(
    `${name}: mesh ${stats.before.meshes}→${stats.after.meshes}, ` +
      `mat ${stats.before.materials}→${stats.after.materials}, ` +
      `tri ${stats.before.triangles}→${stats.after.triangles}, ` +
      `atlas ${(stats.atlasBytes / 1048576).toFixed(1)}MB, ${Math.round(stats.optimizeMs)}ms`,
  );
  setLoading(`${name} 完了`, (index + 1) / total);
  await nextFrame();
}

async function addFromFile(file: File): Promise<void> {
  if (busy || status === 'loading') return;
  if (avatars.length >= MAX_AVATARS) {
    showToast(`アバターは最大 ${MAX_AVATARS} 体までです`);
    return;
  }
  if (templates.length >= MAX_SOURCES) {
    showToast(`ソースは最大 ${MAX_SOURCES} 体までです。複製で増やせます`);
    return;
  }
  busy = true;
  try {
    loadingEl.classList.remove('hidden');
    loadingEl.classList.remove('error');
    const name = uniqueName(file.name.replace(/\.vrm$/i, ''));
    setLoading(`${name} を最適化中...`, 0.5);
    const avatar = await loadAvatar({
      name,
      source: file,
      renderer,
      atlasResolution,
      hysteresis,
      onProgress: (message) => setLoading(message, 0.6),
    });
    register(avatar, true);
    layout();
    appendLog(`${name}: 追加しました`);
    if (status === 'error' && avatars.length > 0) status = 'ready';
    hideLoading();
  } catch (error) {
    hideLoading();
    showToast(`VRMを追加できませんでした: ${String((error as Error)?.message ?? error)}`);
  } finally {
    busy = false;
  }
}

function pickFile(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.vrm,application/octet-stream';
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) void addFromFile(file);
  };
  input.click();
}

// ---------------------------------------------------------------- 初回読み込み

let status: 'loading' | 'ready' | 'error' = 'loading';
const loadFailures: string[] = [];

try {
  setLoading('VRMを読み込み中...', 0);
  const specs = modelSpecs.length > 0 ? modelSpecs.slice(0, Math.min(MAX_SOURCES, targetAvatars)) : ['A'];
  for (const [index, spec] of specs.entries()) {
    try {
      await addFromSource(spec, index, specs.length);
    } catch (error) {
      loadFailures.push(spec);
      appendLog(`失敗: ${String((error as Error)?.message ?? error)}`);
      console.warn(error);
    }
  }
  // 総体数に足りない分は、最適化済みモデルを複製して補う。最適化の再実行はしない。
  while (avatars.length < targetAvatars && templates.length > 0) {
    const template = templates[avatars.length % templates.length];
    register(instantiateAvatar(template, uniqueName(template.name)), false);
  }
  if (avatars.length === 0) {
    throw new Error(
      'モデルを1体も読み込めませんでした。public/models/ にVRMがあるか確認してください。' +
        'サンプルは `pnpm models:fetch` で取得できます。',
    );
  }
  layout();
  hideLoading();
  if (loadFailures.length > 0) {
    showToast(
      `${loadFailures.join(', ')} を読み込めませんでした。pnpm models:fetch を実行してください`,
    );
  }
  status = 'ready';
} catch (error) {
  status = 'error';
  showFatal(String((error as Error)?.message ?? error));
  appendLog('サンプルモデルの取得: pnpm models:fetch');
}

// ---------------------------------------------------------------- GUI

const guiState = {
  lod: lodEnabled,
  hysteresis,
  residency,
  evictDelayMs,
  autoCamera,
  forceLevel: 'auto' as 'auto' | '0' | '1' | '2' | '3',
  add: pickFile,
  addClone,
  removeClone,
  reload: () => location.reload(),
};

// 自動カメラ中でもドラッグ開始で自動を止め、ユーザー操作を優先する。
controls.addEventListener('start', () => {
  if (autoCamera) {
    autoCamera = false;
    guiState.autoCamera = false;
    // 自動カメラ中は controls.update() を呼んでいないため、内部状態を現在のカメラへ同期する。
    controls.target.copy(CAMERA_CENTER);
    controls.update();
  }
});

const gui = new GUI({ title: 'Texture LOD' });
gui.add(guiState, 'lod').name('LOD有効').onChange((value: boolean) => {
  setLodEnabled(value);
  guiState.forceLevel = 'auto';
}).listen();
gui
  .add(guiState, 'hysteresis', 0, 0.3, 0.01)
  .name('ヒステリシス')
  .onFinishChange((value: number) => {
    if (!recreateLod(value)) guiState.hysteresis = hysteresis;
  })
  .listen();
gui
  .add(guiState, 'residency', ['evict', 'keep-all'])
  .name('常駐')
  .onChange((value: ResidencyMode) => {
    residency = value;
    recreateManager();
  })
  .listen();
gui
  .add(guiState, 'evictDelayMs', 0, 5000, 100)
  .name('evict猶予(ms)')
  .onFinishChange((value: number) => {
    evictDelayMs = value;
    recreateManager();
  })
  .listen();
gui.add(guiState, 'autoCamera').name('自動カメラ').onChange((value: boolean) => {
  autoCamera = value;
  if (!value) {
    controls.target.copy(CAMERA_CENTER);
    controls.update();
  }
}).listen();
gui
  .add(guiState, 'forceLevel', ['auto', '0', '1', '2', '3'])
  .name('レベル固定')
  .onChange((value: string) => {
    setForceLevel(value === 'auto' ? null : Number(value));
  })
  .listen();
gui.add(guiState, 'add').name('VRMを追加');
gui.add(guiState, 'addClone').name('複製を追加');
gui.add(guiState, 'removeClone').name('複製を削除');
gui.add(guiState, 'reload').name('再読み込み');

// ---------------------------------------------------------------- 毎フレーム

function pipelineInfo(): { caches: number; fragmentPrograms: number } {
  const internal = renderer as unknown as {
    _pipelines?: {
      caches?: { size: number };
      programs?: { fragment?: { size: number } };
    };
  };
  return {
    caches: internal._pipelines?.caches?.size ?? 0,
    fragmentPrograms: internal._pipelines?.programs?.fragment?.size ?? 0,
  };
}

function backendName(): string {
  const backend = renderer.backend as unknown as { isWebGPUBackend?: boolean };
  return backend.isWebGPUBackend === true ? 'webgpu' : 'webgl';
}

function applyManualLevel(): void {
  if (manualLevel === null) return;
  for (const avatar of avatars) {
    const sets = avatar.template.sets;
    const max = sets[0]?.levels.length ? sets[0].levels.length - 1 : 3;
    const clamped = Math.min(manualLevel, max);
    for (const binding of avatar.bindings) {
      binding.mesh.material = binding.set.variant(clamped);
    }
  }
}

function levelOfAvatar(index: number): number | null {
  if (manualLevel !== null) return Math.min(manualLevel, MAX_LOD_LEVEL);
  if (!lodEnabled) return null;
  try {
    return manager.levelOf(avatars[index].anchor);
  } catch {
    return null;
  }
}

const labelWorldPosition = new Vector3();

function updateVisuals(): void {
  const updateLabels = frame % 12 === 0;
  for (const [index, avatar] of avatars.entries()) {
    const level = levelOfAvatar(index);
    setRingLevel(rings[index], level);

    // 体数が多いときは全ラベルを出すと重なるため、先頭4体だけ表示する。
    // 残りはHUDのアバター行で名前・レベル・距離を確認できる。
    labels[index].sprite.visible = index < 4;

    // ラベルは距離に比例して大きくし、画面上の見かけの大きさを一定に保つ。
    labels[index].sprite.getWorldPosition(labelWorldPosition);
    const cameraDistance = camera.position.distanceTo(labelWorldPosition);
    const width = Math.min(3.6, Math.max(0.7, cameraDistance * 0.26));
    labels[index].sprite.scale.set(width, width / 4.44, 1);

    if (updateLabels && index < 4) {
      const distance = computeLodDistance(avatar.anchor, camera, 'surface');
      labels[index].set(`${avatar.name} ${distance.toFixed(1)}m`, level);
    }
  }
}

function updateHud(): void {
  // 最適化の集計はソース（テンプレート）のみ。複製のゼロ値を足して二重計上しない。
  const before = { meshes: 0, materials: 0 };
  const after = { meshes: 0, materials: 0 };
  let atlasBytes = 0;
  let optimizeMs = 0;
  for (const template of templates) {
    before.meshes += template.stats.before.meshes;
    before.materials += template.stats.before.materials;
    after.meshes += template.stats.after.meshes;
    after.materials += template.stats.after.materials;
    atlasBytes += template.stats.atlasBytes;
    optimizeMs += template.stats.optimizeMs;
  }
  const sources = templates.length;
  const clones = avatars.length - sources;
  const renderedMeshes = avatars.reduce((acc, avatar) => acc + avatar.meshes.length, 0);
  const stats = manager.stats();
  // 手動レベル固定中はマネージャに登録がないため、HUDの内訳は現在の適用レベルから数える。
  const counts = [0, 1, 2, 3].map(
    (level) => avatars.filter((_, index) => levelOfAvatar(index) === level).length,
  );
  const levelText = [0, 1, 2, 3].map((level) => `L${level} ${counts[level] ?? 0}`).join('  ');
  const pipelines = pipelineInfo();
  const resident = manualLevel !== null || !lodEnabled ? atlasBytes : stats.residentBytes;
  const rows = avatars.map((avatar, index) => {
    const level = levelOfAvatar(index);
    const distance = computeLodDistance(avatar.anchor, camera, 'surface');
    return `  ${avatar.name.padEnd(4)} ${level === null ? '--' : `L${level}`}  ${distance
      .toFixed(1)
      .padStart(5)}m`;
  });

  hudBodyEl.textContent = [
    `backend   ${backendName()}`,
    `models    src ${sources} / avatars ${avatars.length} (clones ${clones})`,
    `optimize  ${(optimizeMs / 1000).toFixed(1)}s  atlas ${atlasResolution}px`,
    `meshes    ${before.meshes} → ${after.meshes}  (rendered ${renderedMeshes})`,
    `materials ${before.materials} → ${after.materials}`,
    `atlas     ${(atlasBytes / 1048576).toFixed(1)} MB (full)`,
    `LOD       ${lodEnabled ? 'on' : 'off'}  ${residency}  h=${hysteresis.toFixed(2)}`,
    `levels    ${lodEnabled ? levelText : 'full resolution'}`,
    `VRAM      ${(resident / 1048576).toFixed(1)} MB (est.)`,
    `switch    ${stats.switchCount}   pipelines ${pipelines.caches}/${pipelines.fragmentPrograms}`,
    `frame     ${frameTimeMs.toFixed(2)}ms  calls ${lastFrameCalls}`,
    '',
    ...rows,
  ].join('\n');
}

let lastTime = performance.now();

function animate(now: number): void {
  try {
    const delta = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;
    elapsed += delta;
    frameTimeMs += (delta * 1000 - frameTimeMs) * 0.1;

    environment.update(delta);
    for (const avatar of avatars) avatar.update(delta);
    updateAutoCamera(delta);

    if (manualLevel !== null) applyManualLevel();
    else if (lodEnabled) manager.update(camera);

    updateVisuals();
    if (now - lastHudAt > 250) {
      updateHud();
      lastHudAt = now;
    }

    renderer.render(scene, camera);
    lastFrameCalls = renderer.info.render.drawCalls;
    frame++;
  } catch (error) {
    // 1フレームの例外でループを永久に止めない。連続時はログを1秒に1回へ抑える。
    if (now - lastErrorAt > 1000) {
      lastErrorAt = now;
      console.error(error);
      showToast(`描画中にエラー: ${String((error as Error)?.message ?? error)}`);
    }
  }
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ドラッグ&ドロップで自分のVRMを追加できる。
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => {
  event.preventDefault();
  const file = [...(event.dataTransfer?.files ?? [])].find((value) =>
    value.name.toLowerCase().endsWith('.vrm'),
  );
  if (file) void addFromFile(file);
});

// ---------------------------------------------------------------- テストAPI

const api = {
  get status() {
    return status;
  },
  get ready() {
    return status === 'ready';
  },
  stats() {
    const pipeline = pipelineInfo();
    return {
      status,
      backend: backendName(),
      frame,
      lodEnabled,
      hysteresis,
      residency,
      evictDelayMs,
      manualLevel,
      loadFailures: [...loadFailures],
      sourceCount: templates.length,
      cloneCount: avatars.length - templates.length,
      renderedMeshes: avatars.reduce((acc, avatar) => acc + avatar.meshes.length, 0),
      avatars: avatars.map((avatar, index) => ({
        name: avatar.name,
        isClone: avatar.isClone,
        level: levelOfAvatar(index),
        distance: computeLodDistance(avatar.anchor, camera, 'surface'),
        meshes: avatar.meshes.length,
        materials: avatar.template.sets.length,
        optimizeMs: avatar.stats.optimizeMs,
        atlasResolution: avatar.stats.atlasResolution,
        atlasBytes: avatar.stats.atlasBytes,
        usedSlots: avatar.stats.usedSlots,
        before: avatar.stats.before,
        after: avatar.stats.after,
      })),
      manager: manager.stats(),
      pipelineCaches: pipeline.caches,
      fragmentPrograms: pipeline.fragmentPrograms,
      drawCalls: lastFrameCalls,
      textureCount: renderer.info.memory.textures,
      frameTimeMs,
      errors: [...errors],
    };
  },
  setCamera,
  setAutoCamera(on: boolean) {
    autoCamera = on;
    guiState.autoCamera = on;
    if (!on) {
      controls.target.copy(CAMERA_CENTER);
      controls.update();
    }
  },
  setAvatarSurfaceDistance,
  addClone,
  removeClone,
  setSettings(partial: {
    hysteresis?: number;
    residency?: ResidencyMode;
    evictDelayMs?: number;
    lodEnabled?: boolean;
    forceLevel?: number | null;
    autoCamera?: boolean;
  }) {
    // 破壊的な適用の前に、単体で検証できる値を弾く。
    if (partial.hysteresis !== undefined && !(partial.hysteresis >= 0 && partial.hysteresis < 1)) {
      return false;
    }
    if (
      partial.forceLevel !== undefined &&
      partial.forceLevel !== null &&
      (!Number.isInteger(partial.forceLevel) ||
        partial.forceLevel < 0 ||
        partial.forceLevel > MAX_LOD_LEVEL)
    ) {
      return false;
    }
    if (partial.hysteresis !== undefined) {
      if (!recreateLod(partial.hysteresis)) return false;
      guiState.hysteresis = hysteresis;
    }
    if (partial.residency !== undefined) {
      residency = partial.residency;
      guiState.residency = residency;
      recreateManager();
    }
    if (partial.evictDelayMs !== undefined) {
      evictDelayMs = clampNumber(partial.evictDelayMs, 0, 10000, evictDelayMs);
      guiState.evictDelayMs = evictDelayMs;
      recreateManager();
    }
    if (partial.lodEnabled !== undefined) {
      lodEnabled = partial.lodEnabled;
      guiState.lod = lodEnabled;
      setLodEnabled(lodEnabled);
    }
    if (partial.autoCamera !== undefined) {
      autoCamera = partial.autoCamera;
      guiState.autoCamera = autoCamera;
      if (!autoCamera) {
        controls.target.copy(CAMERA_CENTER);
        controls.update();
      }
    }
    if (partial.forceLevel !== undefined) {
      if (
        partial.forceLevel !== null &&
        (!Number.isInteger(partial.forceLevel) ||
          partial.forceLevel < 0 ||
          partial.forceLevel > MAX_LOD_LEVEL)
      ) {
        return false;
      }
      setForceLevel(partial.forceLevel);
      guiState.forceLevel =
        partial.forceLevel === null
          ? 'auto'
          : (String(partial.forceLevel) as '0' | '1' | '2' | '3');
    }
    return true;
  },
  variantTextureWidths(index: number): (number | null)[][] {
    const avatar = avatars[index];
    if (!avatar) return [];
    return avatar.template.sets.map((set) =>
      set.levels.map((level, index) => {
        const variant = set.variant(index) as unknown as {
          map?: { image?: { width?: number } };
        };
        const width = variant.map?.image?.width;
        return typeof width === 'number' ? width : null;
      }),
    );
  },
  cloneHeadQuaternion(index: number): number[] | null {
    const avatar = avatars[index];
    if (!avatar || !avatar.isClone) return null;
    const name = avatar.template.headRawBoneName;
    const bone = name ? avatar.root.getObjectByName(name) : null;
    return bone ? bone.quaternion.toArray() : null;
  },
  appliedVariantMatches(index: number): boolean {
    const avatar = avatars[index];
    if (!avatar) return false;
    const level = levelOfAvatar(index);
    if (level === null) return false;
    return avatar.meshes.every((mesh) => {
      const base = avatar.baseMaterials.get(mesh);
      const set = base ? avatar.template.materialSets.get(base) : undefined;
      if (!set) return false;
      const material = Array.isArray(mesh.material) ? null : mesh.material;
      return material === set.variant(level);
    });
  },
  cloneHeadInSkeleton(index: number): boolean {
    const avatar = avatars[index];
    if (!avatar || !avatar.isClone) return false;
    const name = avatar.template.headRawBoneName;
    const bone = name ? avatar.root.getObjectByName(name) : null;
    if (!bone) return false;
    const skinned = avatar.anchor as unknown as {
      skeleton?: { bones?: readonly unknown[] };
    };
    return skinned.skeleton?.bones?.includes(bone) === true;
  },
  meshLevels(index: number): number[] {
    const avatar = avatars[index];
    if (!avatar) return [];
    return avatar.meshes.map((mesh) => {
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      const name = material?.name ?? '';
      const suffix = name.lastIndexOf('#lod');
      return suffix >= 0 ? Number(name.slice(suffix + 4)) : -1;
    });
  },
  optimization(index: number) {
    return avatars[index]?.stats ?? null;
  },
  get frame() {
    return frame;
  },
};

declare global {
  interface Window {
    __vrmDemo: typeof api;
  }
}
window.__vrmDemo = api;
