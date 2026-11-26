/**
 * VRM × テクスチャLOD デモ。
 *
 * 流れ:
 * 1. VRM を classic MToonMaterial で読み込む
 * 2. avatar-optimizer でアトラス化・マテリアル統合（MToonAtlasNodeMaterial へ）
 * 3. アトラスを絶対解像度Tier（4096/2048/1024/512/256）の5レベルに縮小し、1体ぶんを1グループとして登録
 * 4. 毎フレーム、アバターの距離で全マテリアルを同じレベルへ切り替える
 * 5. 複製は最適化を再実行せず、テンプレートのアトラス・セットを共有して体数を増やす
 *
 * URLパラメータ:
 * - `?models=A,B,C` 読み込むモデル（既定、A/B/C はサンプル、それ以外は /models/<name>.vrm か URL）
 * - `?avatars=4` 総体数（既定4、最大100。不足分は最適化済みモデルの複製で補う）
 * - `?backend=webgl` WebGL2 バックエンドを強制
 * - `?lod=0` LODを無効化（最密テクスチャのみ）
 * - `?top=1024` Tier上限（これより細かくしない手動下限。4096/2048/1024/512/256。非Tier値はその値以下で最大のTierに丸める。非数値は無視。`?lod=0`・手動レベル固定では無効）
 * - `?wander=0` 徘徊を無効化（全員を配置位置に固定）
 * - `?h=0.15` ヒステリシス幅
 * - `?atlas=1024` アトラス解像度（256〜4096、既定1024）
 * - `?auto=0` 自動カメラを停止
 * - `?residency=keep-all` 常駐モード
 * - `?evictDelay=1000` evict の猶予ms
 * - `?budget=32` 常駐上限MB（0で無効、既定0。0〜4096）
 * - `?spill=1` 破棄したテクスチャの画素データを OPFS へ退避する（既定は無効）
 * - `?adaptive=0` 予算適応の距離しきい値スケールを無効化（既定は有効）
 * - `?scale=0.5` 固定の距離しきい値倍率（0.05〜4。範囲外はクランプ、非数値は無視。指定時は adaptive より優先）
 * - `?hud=0` HUDを折りたたんで起動（`?hud=1` で展開。一時的な上書きで localStorage には保存されない。既定は展開）
 */
import GUI from 'lil-gui';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  ACESFilmicToneMapping,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
} from 'three/webgpu';
import { WebGPURenderer } from 'three/webgpu';
import {
  TextureLodManager,
  TextureSpillCache,
  computeLodDistance,
  openOpfsPixelStore,
  type ResidencyMode,
} from '../../lib/index.js';
import {
  instantiateAvatar,
  loadAvatar,
  type AvatarHandle,
  type AvatarTemplate,
} from './avatar.js';
import { LOD_DISTANCES, LOD_TIERS, tierIndexForResolution } from './tiers.js';
import { createEnvironment, createLevelRings } from './environment.js';
import { buildSlots } from './layout.js';
import { createAvatarLabel, type AvatarLabel } from './labels.js';
import {
  WANDER_TUNING,
  applyWander,
  createWander,
  setHome,
  stepWander,
  type WanderState,
} from './wander.js';

const canvas = document.getElementById('scene');
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('#scene canvas がありません');
}

const params = new URLSearchParams(location.search);
const forceWebGL = params.get('backend') === 'webgl';
const atlasResolution = clampNumber(Math.round(Number(params.get('atlas') ?? 1024)), 256, 4096, 1024);
let hysteresis = clampNumber(Number(params.get('h') ?? 0.15), 0, 0.3, 0.15);
let residency: ResidencyMode = params.get('residency') === 'keep-all' ? 'keep-all' : 'evict';
let evictDelayMs = clampNumber(Number(params.get('evictDelay') ?? 1000), 0, 10000, 1000);
let budgetMB = clampNumber(Math.round(Number(params.get('budget') ?? 0)), 0, 4096, 0);
let lodEnabled = params.get('lod') !== '0';
// 退避先を開けない環境（非セキュアコンテキスト等）では退避なしで続ける。
const spillCache = params.get('spill') === '1' ? await openSpillCache() : null;
let autoCamera = params.get('auto') !== '0';
let wanderEnabled = params.get('wander') !== '0';
// 予算適応の距離しきい値スケール。既定で有効（予算0では実質無効。
// 予算がなくても manager には adaptive を渡し、後から `setMaxResidentBytes` で
// 予算を設定できる（作り直し不要）。`?adaptive=0` で無効。
// `?scale` 指定時は固定倍率を優先し、adaptive を無効化する。
let adaptiveEnabled = params.get('adaptive') !== '0';
const scaleParamRaw = params.get('scale');
// `?scale` が範囲外なら 0.05〜4 にクランプする。非数値・空文字は無視して adaptive のままにする。
let fixedScale: number | null = null;
if (scaleParamRaw !== null && scaleParamRaw.trim() !== '') {
  const parsed = Number(scaleParamRaw);
  if (Number.isFinite(parsed)) fixedScale = clampNumber(parsed, 0.05, 4, parsed);
}
if (fixedScale !== null) adaptiveEnabled = false;

async function openSpillCache(): Promise<TextureSpillCache | null> {
  try {
    return new TextureSpillCache(await openOpfsPixelStore('three-texture-lod-vrm-demo'));
  } catch (error) {
    console.warn(`[Texture LOD] OPFS を開けないため退避を無効にします: ${String(error)}`);
    return null;
  }
}

/** adaptive が実際に manager へ渡る条件。固定 scale・keep-all・LOD無効では効かない。
 * 予算0でも adaptive 自体は渡す（引き上げのみで実質無効）。予算の後付けは作り直し不要。 */
function isAdaptiveActive(): boolean {
  return adaptiveEnabled && fixedScale === null && residency === 'evict' && lodEnabled;
}

const modelSpecs = (params.get('models') ?? 'A,B,C')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
// ソース上限は最適化時の一時 WebGLRenderer のため。複製は最適化を再実行しないので無関係。
const MAX_SOURCES = 4;
const MAX_AVATARS = 100;
// 総体数。不足分は最適化済みモデルの複製で補う。既定4（A,B,C + Aの複製1）。
const targetAvatars = clampNumber(Math.round(Number(params.get('avatars') ?? 4)), 1, MAX_AVATARS, 4);
const LEVELS = LOD_TIERS.map((_, index) => index);
const MAX_LOD_LEVEL = LOD_TIERS.length - 1;
/** `?top` の手動下限（Tierのindex）。null は auto/上限なし。非Tier値はその値以下で最大のTierに丸める。 */
let topLevel: number | null = null;
{
  const raw = params.get('top');
  if (raw !== null && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) topLevel = tierIndexForResolution(parsed);
  }
}

// 配置スロットは起動時に一度だけ計算する。先頭4体は固定位置、以降はグリッド。
const slots = buildSlots(MAX_AVATARS);
// ラベルは共有の4枚だけ作り、シーン直下に置く。先頭4体の頭上に付ける。
const MAX_LABELS = 4;

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
const walkers: WanderState[] = [];
const baseYaws: number[] = [];
const labels: AvatarLabel[] = [];
// ソースごとの共有元。複製はここに積まず、ハンドルの template で参照する。
const templates: AvatarTemplate[] = [];
const rings = createLevelRings(MAX_AVATARS);
scene.add(rings.mesh);
for (let index = 0; index < MAX_LABELS; index++) {
  const label = createAvatarLabel();
  scene.add(label.sprite);
  labels.push(label);
}

let manager = createManager();
// マネージャの世代番号。`recreateManager()`/`recreateLod()` で置き換えるたびに進む。
// `setMaxResidentBytes` では進まないため、予算再適用が作り直しか否かの判定に使える。
let managerGeneration = 0;
let manualLevel: number | null = null;
let frame = 0;
let elapsed = 0;
let frameTimeMs = 0;
let updateMs = 0;
let lastFrameCalls = 0;
let lastHudAt = 0;
let lastErrorAt = 0;
let cameraAngle = 0;
let busy = false;
// 退避中の画素データを読み戻している間は true。マネージャの掃引が読み戻した分を再退避しないよう、
// `manager.update` を止めて表示中のバリアントのまま描画する。
let restoringSpill = false;
// マネージャ外表示への切り替え要求の世代。読み戻し中に別の切り替えが入ったら古い要求を捨てる。
let unmanagedRequest = 0;
// 体構成が変わったらラベルを即時更新する。12フレーム周期の更新だけでは
// 追加・削除・配置直後の古い表示が残る。
let labelsDirty = true;

function createManager(): TextureLodManager {
  const adaptive = isAdaptiveActive();
  return new TextureLodManager({
    distanceMode: 'surface',
    residency,
    evictDelayMs,
    maxResidentBytes: residency === 'evict' && budgetMB > 0 ? budgetMB * 1048576 : undefined,
    finestLevel: topLevel ?? 0,
    ...(spillCache !== null ? { spillCache } : {}),
    ...(adaptive ? { adaptiveThresholdScale: true as const } : {}),
    ...(!adaptive && fixedScale !== null ? { thresholdScale: fixedScale } : {}),
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

/** アバター名から徘徊乱数の種を作る。同じ名前は同じ初期徘徊になる。 */
function hashName(name: string): number {
  let hash = 2166136261;
  for (let index = 0; index < name.length; index++) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function register(avatar: AvatarHandle, source: boolean): void {
  const slot = layoutSlot(avatars.length);
  const walker = createWander(slot, hashName(avatar.name));
  const baseYaw = avatar.root.rotation.y;
  avatars.push(avatar);
  walkers.push(walker);
  baseYaws.push(baseYaw);
  scene.add(avatar.root);
  applyWander(walker, avatar.root, baseYaw);
  labelsDirty = true;
  if (source) templates.push(avatar.template);

  if (lodEnabled && manualLevel === null) addGroup(avatar);
}

/** 配置スロット。先頭4体は固定位置、5体目以降は `slots` のグリッド。 */
function layoutSlot(index: number): { x: number; z: number } {
  return slots[index];
}

function layout(): void {
  for (const [index] of avatars.entries()) {
    setHome(walkers[index], slots[index], wanderEnabled);
  }
  labelsDirty = true;
  if (!wanderEnabled) {
    for (const [index, avatar] of avatars.entries()) {
      applyWander(walkers[index], avatar.root, baseYaws[index]);
    }
  }
}

/**
 * 最もインスタンスが少ないテンプレートを複製して1体増やす。トーストも配置もしない。
 *
 * @returns 追加できたら true。上限到達やソース無しでは false。
 */
function spawnOne(): boolean {
  if (avatars.length >= MAX_AVATARS) return false;
  if (templates.length === 0) return false;
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
  return true;
}

/**
 * 最後の複製を1体削除する。トーストも配置もしない。
 * テクスチャ・マテリアルは共有のため破棄しない。
 *
 * @returns 削除したハンドル。複製が無ければ null。
 */
function despawnLastClone(): AvatarHandle | null {
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
    avatars.splice(index, 1);
    walkers.splice(index, 1);
    baseYaws.splice(index, 1);
    labelsDirty = true;
    return avatar;
  }
  return null;
}

function syncAvatarCount(): void {
  guiState.avatarCount = avatars.length;
}

/**
 * 最もインスタンスが少ないテンプレートを複製して1体増やす。
 *
 * @returns 追加できたら true。上限到達やソース無しでは false。
 */
function addClone(): boolean {
  // 退避の読み戻し中はマネージャが止まっており、追加した体がベースマテリアルのまま描画されるため待たせる。
  if (busy || restoringSpill) {
    showToast('読み込み中は体数を変更できません');
    return false;
  }
  if (avatars.length >= MAX_AVATARS) {
    showToast(`複製は最大 ${MAX_AVATARS} 体までです`);
    return false;
  }
  if (templates.length === 0) {
    showToast('複製元のモデルがありません');
    return false;
  }
  if (!spawnOne()) return false;
  layout();
  syncAvatarCount();
  showToast(`${avatars[avatars.length - 1].name} を複製しました（${avatars.length}体）`);
  return true;
}

/**
 * 最後の複製を1体削除する。テクスチャ・マテリアルは共有のため破棄しない。
 *
 * @returns 削除できたら true。複製が無ければ false。
 */
function removeClone(): boolean {
  const avatar = despawnLastClone();
  if (!avatar) {
    showToast('削除できる複製がありません');
    return false;
  }
  layout();
  syncAvatarCount();
  showToast(`${avatar.name} を削除しました（${avatars.length}体）`);
  return true;
}

/**
 * 総体数を一度に変える。配置とトーストは最後に1回だけ行う。
 *
 * @param n - 目標体数。ソース数未満には減らず、上限を超えない。
 * @returns 変更後の実際の体数。
 */
function setAvatarCount(n: number): number {
  // 退避の読み戻し中はマネージャが止まっており、追加した体がベースマテリアルのまま描画されるため待たせる。
  if (busy || restoringSpill) {
    showToast('読み込み中は体数を変更できません');
    return avatars.length;
  }
  const rounded = Math.round(n);
  if (!Number.isFinite(rounded) || templates.length === 0) return avatars.length;
  const target = Math.max(templates.length, Math.min(MAX_AVATARS, rounded));
  while (avatars.length < target) {
    if (!spawnOne()) break;
  }
  while (avatars.length > target) {
    if (!despawnLastClone()) break;
  }
  layout();
  syncAvatarCount();
  showToast(`体数を ${avatars.length} にしました`);
  return avatars.length;
}

/** 徘徊の有効・無効を切り替える。無効では全員を配置位置に固定する。 */
function setWanderEnabled(on: boolean): void {
  wanderEnabled = on;
  guiState.wander = on;
  for (const [index, avatar] of avatars.entries()) {
    setHome(walkers[index], slots[index], on);
    if (!on) {
      applyWander(walkers[index], avatar.root, baseYaws[index]);
      // ソースの SpringBone を止め、徘徊再開時の跳ねを抑える。
      avatar.vrm?.springBoneManager?.reset();
    }
  }
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
  cancelUnmanaged();
  manualLevel = null;
  guiState.forceLevel = 'auto';
  manager = createManager();
  managerGeneration++;
  if (lodEnabled) for (const avatar of avatars) addGroup(avatar);
  return true;
}

/** 常駐モード・猶予の変更。グループは作り直さずマネージャだけ差し替える。 */
function recreateManager(): void {
  manager.dispose();
  manager = createManager();
  managerGeneration++;
  if (lodEnabled && manualLevel === null) {
    for (const avatar of avatars) addGroup(avatar);
  }
}

/**
 * マネージャ外でテクスチャを表示する切り替えを、退避中の画素データを全て読み戻してから行う。
 *
 * 退避なしでは `action` をその場で実行する。読み戻しの間に {@link cancelUnmanaged} や
 * 別の要求が入った場合、古い `action` は実行しない。
 */
function whenSpillRestored(action: () => void): void {
  const request = ++unmanagedRequest;
  if (spillCache === null) {
    action();
    return;
  }
  restoringSpill = true;
  spillCache
    .restoreAll()
    .then(
      () => {
        if (request === unmanagedRequest) action();
      },
      (error: unknown) => {
        showToast(`退避したテクスチャを読み戻せません: ${String(error)}`);
      },
    )
    .finally(() => {
      if (request === unmanagedRequest) restoringSpill = false;
    });
}

/** 読み戻し待ちのマネージャ外表示への切り替えを取り消す。 */
function cancelUnmanaged(): void {
  unmanagedRequest++;
  restoringSpill = false;
}

function setLodEnabled(enabled: boolean): void {
  lodEnabled = enabled;
  updateBudgetController();
  guiState.forceLevel = 'auto';
  manualLevel = null;
  if (enabled) {
    cancelUnmanaged();
    recreateManager();
  } else {
    // LOD 無効中は `manager.update` が走らないため、読み戻しの間は現在のバリアントのまま描画する。
    whenSpillRestored(() => {
      manager.dispose();
      restoreBaseMaterials();
    });
  }
}

function setForceLevel(level: number | null): void {
  if (level !== null && (!Number.isInteger(level) || level < 0 || level > MAX_LOD_LEVEL)) {
    showToast(`固定レベルは 0〜${MAX_LOD_LEVEL} の整数で指定してください`);
    return;
  }
  if (level === null) {
    cancelUnmanaged();
    manualLevel = null;
    if (lodEnabled) recreateManager();
    else whenSpillRestored(restoreBaseMaterials);
    return;
  }
  whenSpillRestored(() => {
    manualLevel = level;
    manager.dispose();
    applyManualLevel();
  });
}

/**
 * Tier上限（手動下限）を変える。作り直しは不要。
 *
 * `?lod=0`・手動レベル固定では無効（表示は off）。その場合も値は保持し、
 * LOD有効・自動レベルに戻れば適用される。
 */
function setTopLevel(level: number | null): void {
  topLevel = level;
  guiState.topTier = level === null ? 'auto' : String(LOD_TIERS[level]);
  if (!lodEnabled || manualLevel !== null) return;
  manager.setFinestLevel(level ?? 0);
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
const hudEl = document.getElementById('hud')!;
const hudHeadEl = document.getElementById('hud-head')!;
const hudToggleEl = document.getElementById('hud-toggle')!;
const hudSummaryEl = document.getElementById('hud-summary')!;
const HUD_COLLAPSED_KEY = 'vrm-hud-collapsed';

function readStoredHudCollapsed(): boolean {
  try {
    return window.localStorage.getItem(HUD_COLLAPSED_KEY) === '1';
  } catch {
    // プライベートモード等では保存を読まず、既定（展開）にする。
    return false;
  }
}

// 折りたたみの初期値の優先順: `?hud=0/1` > localStorage > 既定（展開）。
// `?hud` は一時的な上書きで、localStorage には保存しない。
let hudCollapsed: boolean;
{
  const hudParam = params.get('hud');
  if (hudParam === '0') hudCollapsed = true;
  else if (hudParam === '1') hudCollapsed = false;
  else hudCollapsed = readStoredHudCollapsed();
}

/**
 * HUDの折りたたみを切り替える。適用後の状態（true = 折りたたみ）を返す。
 *
 * @param persist - false のとき localStorage へ保存しない（`?hud` による起動時の一時上書き用）。
 */
function setHudCollapsed(collapsed: boolean, persist = true): boolean {
  hudCollapsed = collapsed;
  hudEl.classList.toggle('collapsed', collapsed);
  hudToggleEl.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  hudToggleEl.textContent = collapsed ? '▸' : '▾';
  hudToggleEl.setAttribute('aria-label', collapsed ? 'HUDを展開する' : 'HUDを折りたたむ');
  hudToggleEl.setAttribute('title', 'HUDの折りたたみ (H)');
  if (persist) {
    try {
      window.localStorage.setItem(HUD_COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch {
      // プライベートモード等では保存しない。
    }
  }
  return hudCollapsed;
}

// ヘッダー全体がトグル。ボタンに独自ハンドラは付けず、バブリング1回だけで切り替える。
hudHeadEl.addEventListener('click', () => {
  setHudCollapsed(!hudCollapsed);
});
// `H` キーでトグル。lil-gui の入力中・長押し・修飾キー付きは誤爆しないよう無視する。
window.addEventListener('keydown', (event) => {
  if (event.repeat) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key !== 'h' && event.key !== 'H') return;
  const target = event.target as HTMLElement | null;
  if (
    target &&
    (target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT' ||
      target.isContentEditable)
  ) {
    return;
  }
  setHudCollapsed(!hudCollapsed);
});
// 起動時の適用は保存しない。`?hud` は次回以降の既定を変えない一時的な上書き。
setHudCollapsed(hudCollapsed, false);

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
    // 読み込み中に体数が上限へ達したら、配置せず破棄する（slots の範囲外参照を防ぐ）。
    if (avatars.length >= MAX_AVATARS) {
      // 所有はテンプレートのため、ハンドルの disposeVariants では何も起きない。
      avatar.template.disposeVariants();
      showToast(`アバターは最大 ${MAX_AVATARS} 体までです`);
      hideLoading();
      return;
    }
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
    if (avatars.length % 8 === 0 || avatars.length >= targetAvatars) {
      appendLog(`複製中 ${avatars.length}/${targetAvatars}`);
      setLoading(`複製中 ${avatars.length}/${targetAvatars}`, avatars.length / targetAvatars);
      await nextFrame();
    }
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
  budgetMB,
  adaptive: adaptiveEnabled,
  topTier: (topLevel === null ? 'auto' : String(LOD_TIERS[topLevel])) as string,
  thresholdScaleDisplay: fixedScale !== null ? `fixed ${fixedScale.toFixed(2)}` : '1.000',
  autoCamera,
  avatarCount: avatars.length,
  wander: wanderEnabled,
  forceLevel: 'auto' as 'auto' | '0' | '1' | '2' | '3' | '4',
  add: pickFile,
  addClone,
  removeClone,
  reload: () => location.reload(),
};

/** 予算上限をマネージャへ反映する。作り直しはしない（adaptive 切替時を除く）。 */
function applyBudgetToManager(): void {
  if (!lodEnabled || manualLevel !== null || residency !== 'evict') return;
  try {
    manager.setMaxResidentBytes(budgetMB > 0 ? budgetMB * 1048576 : null);
  } catch (error) {
    // keep-all との併用など。manager 側の条件と食い違う場合は作り直し側に任せる。
    console.warn(`[Texture LOD] setMaxResidentBytes に失敗: ${String(error)}`);
  }
}

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
    updateBudgetController();
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
const budgetController = gui
  .add(guiState, 'budgetMB', 0, 4096, 1)
  .name('メモリ上限(MB)')
  .onFinishChange((value: number) => {
    budgetMB = clampNumber(Math.round(value), 0, 4096, budgetMB);
    guiState.budgetMB = budgetMB;
    applyBudgetToManager();
  })
  .listen();

const adaptiveController = gui
  .add(guiState, 'adaptive')
  .name('自動スケール')
  .onChange((value: boolean) => {
    adaptiveEnabled = value;
    if (adaptiveEnabled) fixedScale = null;
    guiState.thresholdScaleDisplay =
      fixedScale !== null ? `fixed ${fixedScale.toFixed(2)}` : adaptiveEnabled ? guiState.thresholdScaleDisplay : 'off';
    recreateManager();
    updateBudgetController();
  })
  .listen();

const thresholdScaleController = gui
  .add(guiState, 'thresholdScaleDisplay')
  .name('しきい値倍率')
  .disable()
  .listen();

/** `keep-all` 選択中と LOD off 中は上限・自動スケールのスライダーを無効化する。 */
function updateBudgetController(): void {
  if (residency === 'keep-all' || !lodEnabled) {
    budgetController.disable();
    adaptiveController.disable();
  } else {
    budgetController.enable();
    adaptiveController.enable();
  }
  thresholdScaleController.disable();
}
updateBudgetController();
gui.add(guiState, 'autoCamera').name('自動カメラ').onChange((value: boolean) => {
  autoCamera = value;
  if (!value) {
    controls.target.copy(CAMERA_CENTER);
    controls.update();
  }
}).listen();
gui
  .add(guiState, 'forceLevel', ['auto', '0', '1', '2', '3', '4'])
  .name('レベル固定')
  .onChange((value: string) => {
    setForceLevel(value === 'auto' ? null : Number(value));
  })
  .listen();
gui
  .add(guiState, 'topTier', ['auto', '4096', '2048', '1024', '512', '256'])
  .name('Tier上限')
  .onChange((value: string) => {
    setTopLevel(value === 'auto' ? null : tierIndexForResolution(Number(value)));
  })
  .listen();
gui
  .add(guiState, 'avatarCount', 1, MAX_AVATARS, 1)
  .name('体数')
  .onFinishChange(setAvatarCount)
  .listen();
gui
  .add(guiState, 'wander')
  .name('うろちょろ')
  .onChange(setWanderEnabled)
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
    const max = sets[0]?.levels.length ? sets[0].levels.length - 1 : 4;
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
  const updateLabels = labelsDirty || frame % 12 === 0;
  for (let index = 0; index < avatars.length; index++) {
    rings.set(index, walkers[index].x, walkers[index].z, levelOfAvatar(index));
  }
  rings.setCount(avatars.length);
  rings.commit();

  // 共有ラベル4枚を先頭4体の頭上に置く。残りの体はHUDのアバター行で確認する。
  const labeled = Math.min(labels.length, avatars.length);
  for (let index = 0; index < labels.length; index++) {
    const label = labels[index];
    if (index >= labeled) {
      label.sprite.visible = false;
      continue;
    }
    const avatar = avatars[index];
    label.sprite.visible = true;
    label.sprite.position.set(
      avatar.root.position.x,
      avatar.root.position.y + 2.0 + (index % 2) * 0.28,
      avatar.root.position.z,
    );

    // ラベルは距離に比例して大きくし、画面上の見かけの大きさを一定に保つ。
    label.sprite.getWorldPosition(labelWorldPosition);
    const cameraDistance = camera.position.distanceTo(labelWorldPosition);
    const width = Math.min(3.6, Math.max(0.7, cameraDistance * 0.26));
    label.sprite.scale.set(width, width / 4.44, 1);

    if (updateLabels) {
      const distance = computeLodDistance(avatar.anchor, camera, 'surface');
      label.set(`${avatar.name} ${distance.toFixed(1)}m`, levelOfAvatar(index));
    }
  }
  labelsDirty = false;
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
  const counts = LEVELS.map(
    (level) => avatars.filter((_, index) => levelOfAvatar(index) === level).length,
  );
  const levelText = LEVELS.map((level) => `${LOD_TIERS[level]}:${counts[level] ?? 0}`).join('  ');
  const topLine =
    !lodEnabled || manualLevel !== null
      ? 'top      off'
      : (() => {
          const finest = Math.min(stats.finestLevel, MAX_LOD_LEVEL);
          const suffix = topLevel !== null ? '(manual)' : isAdaptiveActive() ? '(auto)' : '(manual)';
          return `top      ${LOD_TIERS[finest]} ${suffix}`;
        })();
  const pipelines = pipelineInfo();
  const resident = manualLevel !== null || !lodEnabled ? atlasBytes : stats.residentBytes;
  // GUIの読み取り専用「しきい値倍率」を250ms HUD更新に合わせて反映する。
  // adaptive が無効な条件（keep-all / LOD無効 / 手動固定 / 固定scale）では古い値を残さず明示する。
  if (fixedScale !== null) guiState.thresholdScaleDisplay = `fixed ${fixedScale.toFixed(2)}`;
  else if (isAdaptiveActive() && manualLevel === null)
    guiState.thresholdScaleDisplay = stats.thresholdScale.toFixed(3);
  else guiState.thresholdScaleDisplay = 'off';
  const rows = avatars.slice(0, 12).map((avatar, index) => {
    const level = levelOfAvatar(index);
    const distance = computeLodDistance(avatar.anchor, camera, 'surface');
    const tierText =
      level === null
        ? '--'
        : (() => {
            const tier = LOD_TIERS[Math.min(level, MAX_LOD_LEVEL)];
            const actual = avatar.template.levelWidths[Math.min(level, MAX_LOD_LEVEL)];
            return actual !== undefined && actual !== tier ? `T${tier}→${actual}` : `T${tier}`;
          })();
    return `  ${avatar.name.padEnd(6)} ${level === null ? '--' : `L${level}`}  ${distance
      .toFixed(1)
      .padStart(5)}m ${tierText}`;
  });
  if (avatars.length > 12) rows.push(`  … +${avatars.length - 12} more`);

  hudBodyEl.textContent = [
    `backend   ${backendName()}`,
    `models    src ${sources} / avatars ${avatars.length} (clones ${clones})`,
    `optimize  ${(optimizeMs / 1000).toFixed(1)}s  atlas ${atlasResolution}px`,
    `meshes    ${before.meshes} → ${after.meshes}  (rendered ${renderedMeshes})`,
    `materials ${before.materials} → ${after.materials}`,
    `atlas     ${(atlasBytes / 1048576).toFixed(1)} MB (full)`,
    `LOD       ${lodEnabled ? 'on' : 'off'}  ${residency}  h=${hysteresis.toFixed(2)}  wander ${wanderEnabled ? 'on' : 'off'}`,
    `levels    ${lodEnabled ? levelText : 'full resolution'}`,
    `${topLine}`,
    lodEnabled &&
    manualLevel === null &&
    residency === 'evict' &&
    budgetMB > 0
      ? isAdaptiveActive()
        ? `VRAM      ${(resident / 1048576).toFixed(1)} / ${budgetMB.toFixed(1)} MB (est.)  over ${(stats.overBudgetBytes / 1048576).toFixed(1)}  evict ${stats.evictCount}  scale ${stats.thresholdScale.toFixed(3)}  need ${(stats.requiredBytes / 1048576).toFixed(1)} MB${stats.requiredBytes > (stats.budgetBytes ?? Infinity) ? ' FLOOR' : ''}`
        : `VRAM      ${(resident / 1048576).toFixed(1)} / ${budgetMB.toFixed(1)} MB (est.)  over ${(stats.overBudgetBytes / 1048576).toFixed(1)}  evict ${stats.evictCount}`
      : residency === 'keep-all' && budgetMB > 0
        ? `VRAM      ${(resident / 1048576).toFixed(1)} MB (est.)  budget off (keep-all)`
        : residency === 'evict' && budgetMB > 0 && !lodEnabled
          ? `VRAM      ${(resident / 1048576).toFixed(1)} MB (est.)  budget off (LOD off)`
          : residency === 'evict' && budgetMB > 0 && manualLevel !== null
            ? `VRAM      ${(resident / 1048576).toFixed(1)} MB (est.)  budget off (manual)`
            : `VRAM      ${(resident / 1048576).toFixed(1)} MB (est.)`,
    ...(spillCache !== null ? [spillLine(spillCache)] : []),
    `switch    ${stats.switchCount}   pipelines ${pipelines.caches}/${pipelines.fragmentPrograms}`,
    `frame     ${frameTimeMs.toFixed(2)}ms upd ${updateMs.toFixed(2)}ms calls ${lastFrameCalls}`,
    '',
    ...rows,
  ].join('\n');

  // 折りたたみ時の1行サマリ。本文の行・数値は変えず、体数・frame・scale/FLOORだけを短く出す。
  // scale/FLOOR は本文のVRAM行と同じ条件（予算あり・adaptive有効・手動固定なし）でのみ出す。
  const summaryScale =
    budgetMB > 0 && isAdaptiveActive() && manualLevel === null
      ? ` · scale ${stats.thresholdScale.toFixed(2)}`
      : '';
  const summaryFloor =
    summaryScale !== '' && stats.requiredBytes > (stats.budgetBytes ?? Infinity)
      ? ' · FLOOR'
      : '';
  hudSummaryEl.textContent =
    `src ${sources} / ${avatars.length}体 · ${frameTimeMs.toFixed(1)}ms${summaryScale}${summaryFloor}`;
}

/** 退避キャッシュの HUD 行。容量は他の行と同じく 1048576 で割った MB 表記にする。 */
function spillLine(cache: TextureSpillCache): string {
  const spill = cache.stats();
  return (
    `spill     ${(spill.spilledBytes / 1048576).toFixed(1)} MB on disk (${spill.spilledCount})` +
    `  restoring ${spill.restoringCount}  fail ${spill.failureCount}`
  );
}

let lastTime = performance.now();

function animate(now: number): void {
  try {
    const rawDelta = (now - lastTime) / 1000;
    const delta = Math.min(0.05, rawDelta);
    lastTime = now;
    elapsed += delta;
    // 平滑化には上限前の生 delta を使い、重いフレームの遅さを隠さない。
    frameTimeMs += (rawDelta * 1000 - frameTimeMs) * 0.1;

    const updateStart = performance.now();
    environment.update(delta);
    for (let index = 0; index < avatars.length; index++) {
      const avatar = avatars[index];
      avatar.update(delta);
      if (wanderEnabled) stepWander(walkers[index], delta);
      applyWander(walkers[index], avatar.root, baseYaws[index]);
    }
    updateAutoCamera(delta);

    if (manualLevel !== null) applyManualLevel();
    else if (lodEnabled && !restoringSpill) manager.update(camera);

    updateVisuals();
    updateMs += (performance.now() - updateStart - updateMs) * 0.1;
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
      budgetMB,
      adaptiveEnabled,
      fixedScale,
      managerGeneration,
      scale: manager.stats().thresholdScale,
      manualLevel,
      topLevel,
      topResolution: topLevel === null ? null : LOD_TIERS[topLevel],
      wander: wanderEnabled,
      wanderRadius: WANDER_TUNING.radius,
      ringCount: rings.mesh.count,
      loadFailures: [...loadFailures],
      sourceCount: templates.length,
      cloneCount: avatars.length - templates.length,
      renderedMeshes: avatars.reduce((acc, avatar) => acc + avatar.meshes.length, 0),
      avatars: avatars.map((avatar, index) => ({
        name: avatar.name,
        isClone: avatar.isClone,
        level: levelOfAvatar(index),
        distance: computeLodDistance(avatar.anchor, camera, 'surface'),
        position: { x: avatar.root.position.x, z: avatar.root.position.z },
        home: { x: walkers[index].homeX, z: walkers[index].homeZ },
        meshes: avatar.meshes.length,
        materials: avatar.template.sets.length,
        optimizeMs: avatar.stats.optimizeMs,
        atlasResolution: avatar.stats.atlasResolution,
        atlasBytes: avatar.stats.atlasBytes,
        usedSlots: avatar.stats.usedSlots,
        levelWidths: [...avatar.template.levelWidths],
        before: avatar.stats.before,
        after: avatar.stats.after,
      })),
      manager: manager.stats(),
      spill: spillCache?.stats() ?? null,
      levelCounts: LEVELS.map(
        (level) => avatars.filter((_, index) => levelOfAvatar(index) === level).length,
      ),
      pipelineCaches: pipeline.caches,
      fragmentPrograms: pipeline.fragmentPrograms,
      drawCalls: lastFrameCalls,
      textureCount: renderer.info.memory.textures,
      frameTimeMs,
      updateMs,
      // 模擬時間（秒）。`delta = min(0.05, rawDelta)` を積んだ値で、壁時計とは異なる。
      // 重い環境では1フレームが数秒でも0.05ずつしか進まないため、徘徊の進行判定は壁時計ではなくこの値で見る。
      elapsed,
      hudCollapsed,
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
  setHudCollapsed: (collapsed: boolean): boolean => {
    // boolean 以外は状態を変えず false を返す。stats().hudCollapsed は常に boolean。
    if (typeof collapsed !== 'boolean') return false;
    return setHudCollapsed(collapsed);
  },
  addClone,
  removeClone,
  setAvatarCount,
  setSettings(partial: {
    hysteresis?: number;
    residency?: ResidencyMode;
    evictDelayMs?: number;
    budgetMB?: number;
    adaptive?: boolean;
    thresholdScale?: number;
    lodEnabled?: boolean;
    forceLevel?: number | null;
    top?: number | null;
    autoCamera?: boolean;
    wander?: boolean;
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
    if (
      partial.budgetMB !== undefined &&
      (!Number.isFinite(partial.budgetMB) || partial.budgetMB < 0 || partial.budgetMB > 4096)
    ) {
      return false;
    }
    if (partial.adaptive !== undefined && typeof partial.adaptive !== 'boolean') {
      return false;
    }
    if (
      partial.thresholdScale !== undefined &&
      (!Number.isFinite(partial.thresholdScale) ||
        partial.thresholdScale < 0.05 ||
        partial.thresholdScale > 4)
    ) {
      return false;
    }
    if (partial.wander !== undefined && typeof partial.wander !== 'boolean') {
      return false;
    }
    if (
      partial.top !== undefined &&
      partial.top !== null &&
      (typeof partial.top !== 'number' || !Number.isFinite(partial.top))
    ) {
      return false;
    }
    // 固定 scale と adaptive の同時指定は不可。固定があれば adaptive は無効扱いになるため、
    // 両方を同時に有効化しようとした場合は拒否する。
    // なお `setSettings({thresholdScale})` 単体は adaptive 有効時も拒否される。
    // `{adaptive: false, thresholdScale}` の同時指定でも拒否されるため、
    // 固定化には `setSettings({adaptive: false})` の後に `setSettings({thresholdScale})` の2段階が必要（非対称だが仕様）。
    if (
      partial.thresholdScale !== undefined &&
      (partial.adaptive === true || (partial.adaptive === undefined && adaptiveEnabled))
    ) {
      return false;
    }
    if (partial.hysteresis !== undefined) {
      if (!recreateLod(partial.hysteresis)) return false;
      guiState.hysteresis = hysteresis;
    }
    if (partial.thresholdScale !== undefined) {
      fixedScale = partial.thresholdScale;
      adaptiveEnabled = false;
      guiState.adaptive = adaptiveEnabled;
      guiState.thresholdScaleDisplay = `fixed ${fixedScale.toFixed(2)}`;
      recreateManager();
      updateBudgetController();
    }
    if (partial.adaptive !== undefined) {
      if (partial.adaptive !== adaptiveEnabled) {
        adaptiveEnabled = partial.adaptive;
        if (adaptiveEnabled) fixedScale = null;
        guiState.adaptive = adaptiveEnabled;
        recreateManager();
        updateBudgetController();
      }
    }
    if (partial.residency !== undefined) {
      residency = partial.residency;
      guiState.residency = residency;
      recreateManager();
      updateBudgetController();
    }
    if (partial.evictDelayMs !== undefined) {
      evictDelayMs = clampNumber(partial.evictDelayMs, 0, 10000, evictDelayMs);
      guiState.evictDelayMs = evictDelayMs;
      recreateManager();
    }
    if (partial.budgetMB !== undefined) {
      budgetMB = clampNumber(Math.round(partial.budgetMB), 0, 4096, budgetMB);
      guiState.budgetMB = budgetMB;
      // 予算の再設定は作り直し不要。adaptive の有効/無効は変わらないため上限だけ差し替える。
      applyBudgetToManager();
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
    if (partial.wander !== undefined) {
      setWanderEnabled(partial.wander);
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
          : (String(partial.forceLevel) as '0' | '1' | '2' | '3' | '4');
    }
    if (partial.top !== undefined) {
      setTopLevel(
        partial.top === null ? null : tierIndexForResolution(partial.top),
      );
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
  /**
   * 指定スロットの各セット・各レベルでのテクスチャ幅を返す（テスト用）。
   *
   * `variantTextureWidths` の汎用版。`map` 以外（`normalMap` など）の
   * Tier別クランプを確認するために使う。
   *
   * @param index - アバター番号。
   * @param slot - テクスチャスロット名（例 `map`、`normalMap`）。
   * @returns セットごとの各レベルの `textures[slot]` の `image.width`。無ければ null。
   */
  variantSlotWidths(index: number, slot: string): (number | null)[][] {
    const avatar = avatars[index];
    if (!avatar) return [];
    return avatar.template.sets.map((set) =>
      set.levels.map((level) => {
        const texture = (level.textures as Record<string, unknown>)[slot] as
          | { image?: { width?: number } }
          | undefined;
        const width = texture?.image?.width;
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
      if (suffix < 0) return -1;
      // 同一内容レベルはマテリアルを共有し、名前に範囲が付く（例 `#lod0-2`）。
      // その場合はグループ先頭（canonical）を返す。数値でなければ -1。
      const range = name.slice(suffix + 4).split('-', 1)[0] ?? '';
      const parsed = Number(range);
      return Number.isInteger(parsed) ? parsed : -1;
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
