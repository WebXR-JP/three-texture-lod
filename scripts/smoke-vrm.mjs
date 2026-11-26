// VRMデモのE2Eスモーク。WebGPU / WebGL2 の両バックエンドで検証する。
//
// 前提:
// - `pnpm models:fetch` で public/models/AvatarSample_A.vrm を取得済み
// - `pnpm build` 済み（public/models が dist/demo にコピーされる）
// Chrome は headed で起動する（headless では WebGPU の adapter が取れないため）。
// 表示できない環境では `xvfb-run -a pnpm smoke:vrm` のように Xvfb 経由で実行する。
// Xvfb では WebGPU が SwiftShader になる。`SMOKE_REQUIRE_HW_GPU=1` でソフトウェア描画を失敗扱いにする。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = 4176;
const BASE_URL = `http://localhost:${PORT}`;
const CHROME_PATH = process.env.CHROME_PATH ?? '/run/current-system/sw/bin/google-chrome';
const REQUIRE_HW_GPU = process.env.SMOKE_REQUIRE_HW_GPU === '1';
const ARTIFACTS_DIR = resolve(ROOT, 'artifacts/vrm');
const MODEL_NAMES = ['A', 'B', 'C'];
const MODEL_PATHS = MODEL_NAMES.map((name) => ({
  public: resolve(ROOT, `public/models/AvatarSample_${name}.vrm`),
  dist: resolve(ROOT, `dist/demo/models/AvatarSample_${name}.vrm`),
}));
const DIST_HTML = resolve(ROOT, 'dist/demo/vrm.html');

const failures = [];
function assert(condition, message) {
  if (!condition) failures.push(message);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** 2つの quaternion のなす角（rad）。同一姿勢なら 0 になる。 */
function quatAngle(a, b) {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  return 2 * Math.acos(Math.min(1, Math.abs(dot)));
}

async function waitFor(page, predicate, arg, timeoutMs = 20000) {
  await page.waitForFunction(predicate, arg, { timeout: timeoutMs, polling: 100 });
}

async function frameOf(page) {
  return page.evaluate(() => window.__vrmDemo.frame);
}

async function waitFrames(page, n, timeoutMs = 30000) {
  const start = await frameOf(page);
  await waitFor(page, (o) => window.__vrmDemo.frame >= o.start + o.n, { start, n }, timeoutMs);
}

async function statsOf(page) {
  return page.evaluate(() => window.__vrmDemo.stats());
}

async function levelOf(page) {
  const stats = await statsOf(page);
  return stats.avatars[0]?.level ?? null;
}

async function setDistance(page, distance) {
  const ok = await page.evaluate((d) => window.__vrmDemo.setAvatarSurfaceDistance(0, d), distance);
  assert(ok, `setAvatarSurfaceDistance(${distance}) が false を返した`);
  await waitFrames(page, 6);
}

function centerBrightness(png) {
  const { width, height, data } = png;
  const x0 = Math.floor(width * 0.3);
  const x1 = Math.ceil(width * 0.7);
  const y0 = Math.floor(height * 0.12);
  const y1 = Math.ceil(height * 0.92);
  let sum = 0;
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
      count++;
    }
  }
  return count === 0 ? 0 : sum / count;
}

async function screenshot(page, name) {
  const buffer = await page.screenshot();
  await writeFile(resolve(ARTIFACTS_DIR, name), buffer);
  return centerBrightness(PNG.sync.read(buffer));
}

async function checkHysteresis(page, result) {
  // surface 距離と5段（T=[0,3,6,12,24]）、h=0.15 の系列。
  // L4への遷移には T4*(1+h)=27.6 を超える必要があるため、28.0で遷移させてから
  // 25.0/23.0の上側バンド保持を確認し、19.0でL3へ戻す（T4*(1-h)=20.4）。
  const series = [
    [1.5, 0],
    [3.6, 1],
    [3.0, 1],
    [2.4, 0],
    [4.0, 1],
    [7.0, 2],
    [6.0, 2],
    [4.9, 1],
    [9.0, 2],
    [14.0, 3],
    [11.0, 3],
    [9.9, 2],
    [28.0, 4],
    [25.0, 4],
    [23.0, 4],
    [19.0, 3],
  ];
  const actual = [];
  for (const [distance, expected] of series) {
    await setDistance(page, distance);
    const level = await levelOf(page);
    const meshLevels = await page.evaluate(() => window.__vrmDemo.meshLevels(0));
    const matches = await page.evaluate(() => window.__vrmDemo.appliedVariantMatches(0));
    actual.push({ distance, expected, actual: level, meshLevels, matches });
    assert(
      level === expected,
      `ヒステリシス系列: d=${distance} の期待 L${expected} に対して L${level}`,
    );
    // L0-L2は同一Textureを共有するため、メッシュ名はcanonical（グループ先頭）になる。
    // 数値一致ではなく、全メッシュ一致＋適用マテリアル一致で同期を確認する。
    assert(
      meshLevels.length > 0 && new Set(meshLevels).size === 1 && meshLevels.every((value) => value >= 0),
      `d=${distance} でメッシュ間のレベルが不一致: ${JSON.stringify(meshLevels)}`,
    );
    assert(
      matches === true,
      `d=${distance} で適用マテリアルが現行レベルと不一致: L${level} vs ${JSON.stringify(meshLevels)}`,
    );
  }
  const holds = [
    { from: 1.5, at: 3.2, expected: 0 },
    { from: 4.0, at: 6.5, expected: 1 },
    { from: 9.0, at: 12.5, expected: 2 },
    { from: 14.0, at: 25.5, expected: 3 },
  ];
  const held = [];
  for (const item of holds) {
    await setDistance(page, item.from);
    await setDistance(page, item.at);
    const level = await levelOf(page);
    const meshLevels = await page.evaluate(() => window.__vrmDemo.meshLevels(0));
    const matches = await page.evaluate(() => window.__vrmDemo.appliedVariantMatches(0));
    held.push({ ...item, actual: level, meshLevels, matches });
    assert(
      level === item.expected,
      `上側バンド保持: d=${item.at} の期待 L${item.expected} に対して L${level}`,
    );
    assert(
      meshLevels.length > 0 && new Set(meshLevels).size === 1 && meshLevels.every((value) => value >= 0),
      `上側バンド保持 d=${item.at} でメッシュ間のレベルが不一致: ${JSON.stringify(meshLevels)}`,
    );
    assert(
      matches === true,
      `上側バンド保持 d=${item.at} で適用マテリアルが不一致: L${level} vs ${JSON.stringify(meshLevels)}`,
    );
  }
  result.hysteresis = actual;
  result.hysteresisHolds = held;
}

async function checkBands(page, result) {
  // T1=3 のバンド内（2.55〜3.45）を往復して切替が起きないこと。
  // h=0 なら 3.0 をまたぐため、ヒステリシスが壊れれば switchCount が増える。
  await setDistance(page, 2.9);
  const before = (await statsOf(page)).manager.switchCount;
  for (let i = 0; i < 6; i++) {
    await setDistance(page, 3.2);
    await setDistance(page, 2.9);
  }
  const after = (await statsOf(page)).manager.switchCount;
  result.bandSwitchDelta = after - before;
  assert(after === before, `バンド内往復で switchCount が ${before} → ${after} に増えた`);
}

async function checkHysteresisZero(page, result) {
  await page.evaluate(() => window.__vrmDemo.setSettings({ hysteresis: 0 }));
  await setDistance(page, 2.9);
  const start = (await statsOf(page)).manager.switchCount;
  const levels = [];
  for (let i = 0; i < 5; i++) {
    await setDistance(page, 3.1);
    levels.push(await levelOf(page));
    await setDistance(page, 2.9);
    levels.push(await levelOf(page));
  }
  const delta = (await statsOf(page)).manager.switchCount - start;
  result.hysteresisZero = { levels, switchDelta: delta };
  assert(levels.every((level, index) => level === (index % 2 === 0 ? 1 : 0)), `h=0 の系列が想定外: ${levels}`);
  assert(delta === 10, `h=0 の境界往復で switchCount が10増えない: ${delta}`);
  await page.evaluate(() => window.__vrmDemo.setSettings({ hysteresis: 0.15 }));

  // デバッグ用のレベル固定と、auto への復帰。L3に加えて最粗L4も確認する。
  await page.evaluate(() => window.__vrmDemo.setSettings({ forceLevel: 3 }));
  await waitFrames(page, 3);
  const forced = await page.evaluate(() => window.__vrmDemo.meshLevels(0));
  assert(forced.length > 0 && forced.every((level) => level === 3), `forceLevel=3 が全メッシュに効いていない: ${forced}`);
  await page.evaluate(() => window.__vrmDemo.setSettings({ forceLevel: 4 }));
  await waitFrames(page, 3);
  const forced4 = await page.evaluate(() => window.__vrmDemo.meshLevels(0));
  assert(forced4.length > 0 && forced4.every((level) => level === 4), `forceLevel=4 が全メッシュに効いていない: ${forced4}`);
  await page.evaluate(() => window.__vrmDemo.setSettings({ forceLevel: null }));
  await waitFrames(page, 6);
  const afterAuto = await levelOf(page);
  assert(afterAuto === 0, `forceLevel 解除後に auto の L0 へ戻っていない: L${afterAuto}`);
}

async function checkPipelines(page, result) {
  await page.evaluate(() => window.__vrmDemo.setSettings({ lodEnabled: true, forceLevel: null }));
  for (const distance of [2.5, 4.5, 7.5, 15, 2.5]) {
    await setDistance(page, distance);
  }
  const baseline = await statsOf(page);
  for (let i = 0; i < 3; i++) {
    for (const distance of [2.5, 15, 4.5, 15]) {
      await setDistance(page, distance);
    }
  }
  const after = await statsOf(page);
  result.pipelines = {
    baseline: { caches: baseline.pipelineCaches, fragment: baseline.fragmentPrograms },
    after: { caches: after.pipelineCaches, fragment: after.fragmentPrograms },
  };
  assert(
    baseline.pipelineCaches > 0 && baseline.fragmentPrograms > 0,
    `パイプライン数が0（_pipelines の構造変更？）: caches=${baseline.pipelineCaches}, fragment=${baseline.fragmentPrograms}`,
  );
  assert(
    after.pipelineCaches <= baseline.pipelineCaches,
    `パイプライン caches が増えた: ${baseline.pipelineCaches} → ${after.pipelineCaches}`,
  );
  assert(
    after.fragmentPrograms <= baseline.fragmentPrograms,
    `fragment programs が増えた: ${baseline.fragmentPrograms} → ${after.fragmentPrograms}`,
  );
}

async function checkEvict(page, backend, result) {
  await page.evaluate(() =>
    window.__vrmDemo.setSettings({ residency: 'evict', evictDelayMs: 0, forceLevel: null }),
  );
  await setDistance(page, 2.5);
  const nearStats = await statsOf(page);
  const near = await screenshot(page, `${backend}-near.png`);

  await setDistance(page, 20);
  await sleep(800);
  const farStats = await statsOf(page);
  const far = await screenshot(page, `${backend}-far.png`);

  await setDistance(page, 2.5);
  await sleep(500);
  const recoveredStats = await statsOf(page);
  const recovered = await screenshot(page, `${backend}-recovered.png`);

  result.evict = {
    near: { level: nearStats.avatars[0]?.level, resident: nearStats.manager.residentBytes, brightness: near, evictCount: nearStats.manager.evictCount },
    far: { level: farStats.avatars[0]?.level, resident: farStats.manager.residentBytes, brightness: far, evictCount: farStats.manager.evictCount },
    recovered: {
      level: recoveredStats.avatars[0]?.level,
      resident: recoveredStats.manager.residentBytes,
      brightness: recovered,
    },
    textureCount: { near: nearStats.textureCount, far: farStats.textureCount, recovered: recoveredStats.textureCount },
  };
  assert(nearStats.avatars[0]?.level === 0, '近景で L0 になっていない');
  // 20mは12〜24mの帯のためL3のまま。
  assert(farStats.avatars[0]?.level === 3, '遠景(20m)で L3 になっていない');
  assert(
    farStats.manager.residentBytes < nearStats.manager.residentBytes / 2,
    `evict で residentBytes が半分未満にならない: near=${nearStats.manager.residentBytes}, far=${farStats.manager.residentBytes}`,
  );
  // 解放の証拠は evictCount の増加と residentBytes の半減で見る。
  // textureCount（`renderer.info.memory.textures`）は L0-L2 の共有テクスチャが
  // DataTexture 実体を保つため枚数が減らず、厳密な減少は成立しない。
  // そのため枚数は「増加しない」ことだけを確認する。
  assert(
    farStats.manager.evictCount > nearStats.manager.evictCount,
    `evict で破棄が起きていない: near=${nearStats.manager.evictCount} → far=${farStats.manager.evictCount}`,
  );
  assert(
    farStats.textureCount <= nearStats.textureCount,
    `evict 後に GPU テクスチャ数が増えた: near=${nearStats.textureCount}, far=${farStats.textureCount}`,
  );
  assert(near > 20, `近景の輝度が低すぎる: ${near}`);
  assert(
    Math.abs(recovered / near - 1) < 0.1,
    `evict 復帰後の輝度比が 10% を超えた: near=${near}, recovered=${recovered}`,
  );
  assert(recoveredStats.avatars[0]?.level === 0, '復帰後に L0 へ戻っていない');
  // 30mでL4も確認する（27.6m超で遷移）。
  // L4は最粗pinのみが残るため、resident はさらに減り、evictCount は増える。
  // textureCount は L0-L2 共有と同様に枚数が減らないため、増加しないことだけを見る。
  try {
    await setDistance(page, 30);
    await sleep(400);
    const veryFar = await statsOf(page);
    result.evict.veryFar = {
      level: veryFar.avatars[0]?.level,
      resident: veryFar.manager.residentBytes,
      textureCount: veryFar.textureCount,
      evictCount: veryFar.manager.evictCount,
    };
    assert(veryFar.avatars[0]?.level === 4, `最遠景(30m)で L4 になっていない: L${veryFar.avatars[0]?.level}`);
    assert(
      veryFar.manager.residentBytes < farStats.manager.residentBytes,
      `最遠景(30m)で residentBytes が減らない: far=${farStats.manager.residentBytes} → veryFar=${veryFar.manager.residentBytes}`,
    );
    assert(
      veryFar.manager.evictCount >= farStats.manager.evictCount,
      `最遠景(30m)で破棄が進んでいない: far=${farStats.manager.evictCount} → veryFar=${veryFar.manager.evictCount}`,
    );
    // L4では現用が最粗pinのみになるため、GPUテクスチャ数は厳密に減る（実測21→17）。
    // 近景→遠景（L0→L3）ではL0-L2の共有テクスチャがDataTexture実体を保つため枚数は減らない。
    assert(
      veryFar.textureCount < farStats.textureCount,
      `最遠景(30m)で GPU テクスチャ数が減らない: far=${farStats.textureCount} → veryFar=${veryFar.textureCount}`,
    );
    await setDistance(page, 2.5);
    await sleep(500);
  } catch (error) {
    assert(false, `最遠景(30m)の確認で例外: ${String(error)}`);
  }
}

async function checkKeepAll(page, result) {
  await page.evaluate(() => window.__vrmDemo.setSettings({ residency: 'keep-all' }));
  await setDistance(page, 2.5);
  const near = await statsOf(page);
  await setDistance(page, 20);
  await sleep(400);
  const far = await statsOf(page);
  result.keepAll = { near: near.manager.residentBytes, far: far.manager.residentBytes };
  assert(
    far.manager.residentBytes >= near.manager.residentBytes * 0.95,
    `keep-all で residentBytes が減った: ${near.manager.residentBytes} → ${far.manager.residentBytes}`,
  );
  assert(
    far.textureCount >= near.textureCount,
    `keep-all で GPU テクスチャ数が減った: ${near.textureCount} → ${far.textureCount}`,
  );
  await page.evaluate(() => window.__vrmDemo.setSettings({ residency: 'evict' }));
}

async function checkFourSources(browser, backend) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
  const messages = [];
  page.on('console', (message) => messages.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => messages.push(`pageerror: ${String(error)}`));
  const result = { backend, ok: false };
  try {
    await page.goto(
      `${BASE_URL}/vrm.html?models=A,B,C,A&avatars=4&auto=0&wander=0${backend === 'webgl' ? '&backend=webgl' : ''}`,
      { waitUntil: 'load' },
    );
    await page.waitForFunction(
      () => window.__vrmDemo?.status === 'ready' || window.__vrmDemo?.status === 'error',
      null,
      { timeout: 300000 },
    );
    const status = await page.evaluate(() => window.__vrmDemo.status);
    result.status = status;
    if (status !== 'ready') {
      assert(false, `${backend} (4体): デモが ready にならなかった（status=${status}）`);
      return result;
    }
    // evictDelay(既定1000ms) 後の常駐量まで待ってから測る。
    await waitFrames(page, 20);
    await sleep(1400);
    const stats = await statsOf(page);
    result.stats = stats;
    assert(stats.avatars.length === 4, `${backend} (4体): アバター数が ${stats.avatars.length}`);
    assert(stats.manager.objectCount === 4, `${backend} (4体): objectCount が ${stats.manager.objectCount}`);
    assert(
      JSON.stringify(stats.manager.levelCounts) === JSON.stringify([1, 1, 1, 1, 0]),
      `${backend} (4体): levelCounts が ${JSON.stringify(stats.manager.levelCounts)}`,
    );
    assert(
      stats.avatars.map((avatar) => avatar.level).join(',') === '0,1,2,3',
      `${backend} (4体): 初期レベルの並びが ${stats.avatars.map((avatar) => avatar.level).join(',')}`,
    );
    assert(stats.loadFailures.length === 0, `${backend} (4体): 読み込み失敗 ${stats.loadFailures.join(',')}`);
    assert(stats.errors.length === 0, `${backend} (4体): stats.errors ${stats.errors.join(' | ')}`);
    const fullAtlas = stats.avatars.reduce((sum, avatar) => sum + avatar.atlasBytes, 0);
    result.resident = stats.manager.residentBytes;
    result.fullAtlas = fullAtlas;
    // L0-L2は同一Textureを共有するため、L0/L1/L2が各1体でもフルサイズが3体分常駐する。
    // 実測0.95のため、1.1倍未満で見る。
    assert(
      stats.manager.residentBytes < fullAtlas * 1.1,
      `${backend} (4体): 常駐量が全アトラスの1.1倍未満にならない: ${stats.manager.residentBytes} / ${fullAtlas}`,
    );

    for (const [index] of stats.avatars.entries()) {
      const meshLevels = await page.evaluate((i) => window.__vrmDemo.meshLevels(i), index);
      assert(
        meshLevels.length > 0 && new Set(meshLevels).size === 1,
        `${backend} (4体): アバター${index}のメッシュ間レベルが不一致: ${JSON.stringify(meshLevels)}`,
      );
    }

    result.brightness = await screenshot(page, `${backend}-4avatars.png`);
    const consoleErrors = messages.filter(
      (message) => message.startsWith('pageerror:') || message.startsWith('error:'),
    );
    const noise = messages.filter((message) =>
      /Too many active WebGL contexts|WebGPU|destroyed|THREE\./i.test(message),
    );
    result.consoleErrors = consoleErrors;
    result.webgpuNoise = noise;
    assert(consoleErrors.length === 0, `${backend} (4体): コンソールエラー ${consoleErrors.join(' | ')}`);
    assert(noise.length === 0, `${backend} (4体): GPU関連の警告 ${noise.join(' | ')}`);
    result.ok = failures.length === 0;
  } catch (error) {
    result.error = String(error?.stack ?? error);
    assert(false, `${backend} (4体): 例外: ${String(error)}`);
  } finally {
    result.messages = messages.slice(-20);
    await page.close();
  }
  return result;
}

async function checkInstances(browser, backend, config) {
  const { query, expectedSource, expectedClone, slug } = config;
  const expectedTotal = expectedSource + expectedClone;
  const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
  const messages = [];
  page.on('console', (message) => messages.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => messages.push(`pageerror: ${String(error)}`));
  const result = { backend, ok: false };
  try {
    await page.goto(
      `${BASE_URL}/vrm.html?${query}&wander=0${backend === 'webgl' ? '&backend=webgl' : ''}`,
      { waitUntil: 'load' },
    );
    await page.waitForFunction(
      () => window.__vrmDemo?.status === 'ready' || window.__vrmDemo?.status === 'error',
      null,
      { timeout: 300000 },
    );
    const status = await page.evaluate(() => window.__vrmDemo.status);
    result.status = status;
    if (status !== 'ready') {
      assert(false, `${backend} (${slug}): デモが ready にならなかった（status=${status}）`);
      return result;
    }
    // evictDelay(既定1000ms) 後の常駐量まで待ってから測る。
    await waitFrames(page, 20);
    await sleep(1400);
    const stats = await statsOf(page);
    result.stats = stats;
    assert(stats.avatars.length === expectedTotal, `${backend} (${slug}): アバター数が ${stats.avatars.length}`);
    assert(stats.sourceCount === expectedSource, `${backend} (${slug}): sourceCount が ${stats.sourceCount}`);
    assert(stats.cloneCount === expectedClone, `${backend} (${slug}): cloneCount が ${stats.cloneCount}`);
    assert(stats.manager.objectCount === expectedTotal, `${backend} (${slug}): objectCount が ${stats.manager.objectCount}`);
    assert(
      JSON.stringify(stats.manager.levelCounts) === JSON.stringify([1, 1, 1, 1, 0]),
      `${backend} (${slug}): levelCounts が ${JSON.stringify(stats.manager.levelCounts)}`,
    );
    assert(
      stats.avatars.map((avatar) => avatar.level).join(',') === '0,1,2,3',
      `${backend} (${slug}): 初期レベルの並びが ${stats.avatars.map((avatar) => avatar.level).join(',')}`,
    );
    assert(stats.loadFailures.length === 0, `${backend} (${slug}): 読み込み失敗 ${stats.loadFailures.join(',')}`);
    assert(stats.errors.length === 0, `${backend} (${slug}): stats.errors ${stats.errors.join(' | ')}`);
    assert(
      stats.avatars.filter((avatar) => avatar.optimizeMs > 0).length === expectedSource,
      `${backend} (${slug}): 最適化回数が ${expectedSource} でない`,
    );
    assert(
      stats.avatars.filter((avatar) => avatar.isClone).every((avatar) => avatar.optimizeMs === 0),
      `${backend} (${slug}): 複製の optimizeMs が 0 でない`,
    );
    // 複製の atlasBytes は0のため、fullAtlas はソース分のみ。
    // resident は複数レベル分で full を超えうる。実測は複製1+3で1.30倍、既定で1.17倍のため1.4倍未満で見る。
    const fullAtlas = stats.avatars.reduce((sum, avatar) => sum + avatar.atlasBytes, 0);
    result.resident = stats.manager.residentBytes;
    result.fullAtlas = fullAtlas;
    assert(
      stats.manager.residentBytes < fullAtlas * 1.4,
      `${backend} (${slug}): 常駐量が全アトラスの1.4倍未満にならない: ${stats.manager.residentBytes} / ${fullAtlas}`,
    );

    for (const [index] of stats.avatars.entries()) {
      const meshLevels = await page.evaluate((i) => window.__vrmDemo.meshLevels(i), index);
      assert(
        meshLevels.length > 0 && new Set(meshLevels).size === 1,
        `${backend} (${slug}): アバター${index}のメッシュ間レベルが不一致: ${JSON.stringify(meshLevels)}`,
      );
      assert(
        (await page.evaluate((i) => window.__vrmDemo.appliedVariantMatches(i), index)) === true,
        `${backend} (${slug}): アバター${index}の適用マテリアルが現行セットのvariantと不一致`,
      );
    }

    const cloneIndex = stats.avatars.findIndex((avatar) => avatar.isClone);
    assert(cloneIndex >= 0, `${backend} (${slug}): 複製が1体もない`);

    result.brightness = await screenshot(page, `${backend}-${slug}.png`);

    // 複製は raw 頭ボーンを揺らす（normalized ボーンでは skinning に反映されない）。
    // sin 波のピーク付近では1点比較が停滞するため、1秒間5サンプルで最大差を見る。
    const headSamples = [];
    for (let i = 0; i < 5; i++) {
      if (i > 0) await sleep(250);
      headSamples.push(
        await page.evaluate((idx) => window.__vrmDemo.cloneHeadQuaternion(idx), cloneIndex),
      );
    }
    const inSkeleton = await page.evaluate((i) => window.__vrmDemo.cloneHeadInSkeleton(i), cloneIndex);
    assert(
      headSamples.every((sample) => Array.isArray(sample)),
      `${backend} (${slug}): 頭ボーン quaternion が取れない: ${JSON.stringify(headSamples)}`,
    );
    const angles = headSamples.map((sample) => quatAngle(headSamples[0], sample));
    const maxAngle = Math.max(...angles);
    assert(inSkeleton === true, `${backend} (${slug}): raw 頭ボーンが SkinnedMesh の skeleton に無い`);
    assert(maxAngle > 1e-3, `${backend} (${slug}): 頭ボーンの回転差が小さすぎる: ${maxAngle}`);
    result.headMotion = { samples: headSamples, angles, maxAngle, inSkeleton };

    // GUIボタンと同じAPIで追加・削除ができ、マネージャのグループ数も追従すること。
    const added = await page.evaluate(() => window.__vrmDemo.addClone());
    await waitFrames(page, 6);
    const afterAdd = await statsOf(page);
    assert(added === true, `${backend} (${slug}): addClone が false`);
    assert(afterAdd.avatars.length === expectedTotal + 1, `${backend} (${slug}): 追加後のアバター数が ${afterAdd.avatars.length}`);
    assert(afterAdd.manager.objectCount === expectedTotal + 1, `${backend} (${slug}): 追加後の objectCount が ${afterAdd.manager.objectCount}`);

    const removed = await page.evaluate(() => window.__vrmDemo.removeClone());
    await waitFrames(page, 6);
    const afterRemove = await statsOf(page);
    assert(removed === true, `${backend} (${slug}): removeClone が false`);
    assert(afterRemove.avatars.length === expectedTotal, `${backend} (${slug}): 削除後のアバター数が ${afterRemove.avatars.length}`);
    assert(afterRemove.manager.objectCount === expectedTotal, `${backend} (${slug}): 削除後の objectCount が ${afterRemove.manager.objectCount}`);
    result.addRemove = { added: afterAdd.avatars.length, removed: afterRemove.avatars.length };

    // h変更でテンプレートのセットを作り直し、全インスタンスがrebindされること。
    await page.evaluate(() => window.__vrmDemo.setSettings({ hysteresis: 0.1 }));
    await waitFrames(page, 8);
    const afterH = await statsOf(page);
    assert(afterH.manager.objectCount === expectedTotal, `${backend} (${slug}): h変更後の objectCount が ${afterH.manager.objectCount}`);
    for (const [index] of afterH.avatars.entries()) {
      const meshLevels = await page.evaluate((i) => window.__vrmDemo.meshLevels(i), index);
      assert(
        meshLevels.length > 0 && new Set(meshLevels).size === 1,
        `${backend} (${slug}): h変更後にアバター${index}のメッシュ間レベルが不一致: ${JSON.stringify(meshLevels)}`,
      );
      assert(
        (await page.evaluate((i) => window.__vrmDemo.appliedVariantMatches(i), index)) === true,
        `${backend} (${slug}): h変更後にアバター${index}の適用マテリアルが新セットのvariantと不一致`,
      );
    }
    result.hysteresisRebind = { objectCount: afterH.manager.objectCount, levels: afterH.avatars.map((a) => a.level) };

    const consoleErrors = messages.filter(
      (message) => message.startsWith('pageerror:') || message.startsWith('error:'),
    );
    const noise = messages.filter((message) =>
      /Too many active WebGL contexts|WebGPU|destroyed|THREE\./i.test(message),
    );
    result.consoleErrors = consoleErrors;
    result.webgpuNoise = noise;
    assert(consoleErrors.length === 0, `${backend} (${slug}): コンソールエラー ${consoleErrors.join(' | ')}`);
    assert(noise.length === 0, `${backend} (${slug}): GPU関連の警告 ${noise.join(' | ')}`);
    result.ok = failures.length === 0;
  } catch (error) {
    result.error = String(error?.stack ?? error);
    assert(false, `${backend} (${slug}): 例外: ${String(error)}`);
  } finally {
    result.messages = messages.slice(-20);
    await page.close();
  }
  return result;
}

async function checkBudget(browser, backend) {
  // 上限キャッシュの段2（上限破棄）を直接検証する。手順:
  // 1. budgetなし・既定3ソース＋複製1・evictDelay=10000（段1は10秒猶予のため動かない）で起動し、
  //    全レベル常駐の total と現用＋最粗の required を測る（total > required*1.05）。
  // 2. required < budget < total になる予算を動的に決めて設定し、段2だけが掃引して
  //    resident<=budget・over==0・レベル不変になることを確認する（段2の証拠）。
  // 3. 8MBに締めて resident===required・over>0・レベル不変を確認する。
  // 4. 解除で上限なし・over 0を確認する。
  const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
  const messages = [];
  page.on('console', (message) => messages.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => messages.push(`pageerror: ${String(error)}`));
  const result = { backend, ok: false };
  try {
    await page.goto(
      `${BASE_URL}/vrm.html?auto=0&evictDelay=10000&wander=0&adaptive=0${backend === 'webgl' ? '&backend=webgl' : ''}`,
      { waitUntil: 'load' },
    );
    await page.waitForFunction(
      () => window.__vrmDemo?.status === 'ready' || window.__vrmDemo?.status === 'error',
      null,
      { timeout: 300000 },
    );
    const status = await page.evaluate(() => window.__vrmDemo.status);
    result.status = status;
    if (status !== 'ready') {
      assert(false, `${backend} (budget): デモが ready にならなかった（status=${status}）`);
      return result;
    }
    // 既定構成（3ソース＋Aの複製1）は段1混入の心配がない。Aのテンプレートは
    // ソースがL0・複製がL3に付くため全グループが現用か最粗pinで、未参照テクスチャを持たない。
    // すなわち古い登録時刻のAには段1の対象が存在せず、段1の候補（B・Cの未使用L3群）は
    // B・Cのロード直後の登録で fresh のため、ready からの経過で段1（10秒猶予）を排除できる。
    // なお 1ソース＋複製3（`?models=A&avatars=4`）では4体がL0〜L3を埋めて
    // total===required になり、未使用レベルが存在しないため段2の検証自体ができない。
    // （2026-11-26の試行で total=required=18175317 を実測し、仕様どおり失敗することを確認）
    const readyAt = Date.now();
    await waitFrames(page, 20);
    await sleep(1400);
    const before = await statsOf(page);
    assert(
      before.sourceCount === 3,
      `${backend} (budget): sourceCount が 3 でない: ${before.sourceCount}`,
    );
    assert(
      before.cloneCount === 1,
      `${backend} (budget): cloneCount が 1 でない: ${before.cloneCount}`,
    );
    assert(
      before.avatars.length === 4,
      `${backend} (budget): アバター数が 4 でない: ${before.avatars.length}`,
    );
    assert(
      before.evictDelayMs === 10000,
      `${backend} (budget): evictDelayMs が 10000 でない: ${before.evictDelayMs}`,
    );
    assert(
      before.manager.budgetBytes === null,
      `${backend} (budget): 起動時の budgetBytes が null でない: ${before.manager.budgetBytes}`,
    );
    const total = before.manager.residentBytes;
    const required = before.manager.requiredBytes;
    result.total = total;
    result.required = required;
    result.evictDelayMs = before.evictDelayMs;
    assert(
      total > required * 1.05,
      `${backend} (budget): 未使用レベルが無い（total が required の1.05倍以下）: total=${total} / required=${required}`,
    );

    // 動的に予算を決める: required < budget < total の中間値（MiB単位）。
    // 下限は required を1MiB切り上げて1MiB余裕を見た値、上限側は total と required の中間。
    const MIB = 1048576;
    const budgetMB = Math.max(
      Math.ceil(required / MIB) + 1,
      Math.floor((total + required) / 2 / MIB),
    );
    assert(budgetMB >= 1 && budgetMB <= 4096, `${backend} (budget): 動的予算が範囲外: ${budgetMB}`);
    // required 以下では段2が不要、total 以上では段2が動かない。中間でなければ検証にならない。
    assert(
      budgetMB * MIB > required,
      `${backend} (budget): 動的予算が required 以下で段2が不要: ${budgetMB * MIB} <= ${required}`,
    );
    assert(
      budgetMB * MIB < total,
      `${backend} (budget): 動的予算が total 以上で段2が動かない: ${budgetMB * MIB} >= ${total}`,
    );
    result.selectedBudget = budgetMB;
    const levelsBefore = before.avatars.map((avatar) => avatar.level);
    const evictBefore = before.manager.evictCount;
    const setOk = await page.evaluate((mb) => window.__vrmDemo.setSettings({ budgetMB: mb }), budgetMB);
    assert(setOk === true, `${backend} (budget): setSettings({ budgetMB: ${budgetMB} }) が false`);
    // 段2は update 内で同期に走るため、数フレーム＋短い待機で十分。15秒ポーリングは不要。
    await waitFrames(page, 6);
    await sleep(300);
    const tight = await statsOf(page);
    result.tight = {
      budgetBytes: tight.manager.budgetBytes,
      overBudgetBytes: tight.manager.overBudgetBytes,
      residentBytes: tight.manager.residentBytes,
      requiredBytes: tight.manager.requiredBytes,
      evictCount: tight.manager.evictCount,
      levels: tight.avatars.map((avatar) => avatar.level),
      elapsedMs: Date.now() - readyAt,
    };
    assert(
      tight.manager.budgetBytes === budgetMB * MIB,
      `${backend} (budget): budgetBytes が ${budgetMB}MB でない: ${tight.manager.budgetBytes}`,
    );
    assert(
      tight.manager.residentBytes <= tight.manager.budgetBytes,
      `${backend} (budget): residentBytes が上限以下にならない: ${tight.manager.residentBytes} / ${tight.manager.budgetBytes}`,
    );
    assert(
      tight.manager.overBudgetBytes === 0,
      `${backend} (budget): overBudgetBytes が 0 でない: ${tight.manager.overBudgetBytes}`,
    );
    assert(
      tight.manager.evictCount > evictBefore,
      `${backend} (budget): 掃引が起きていない (evictCount=${evictBefore} → ${tight.manager.evictCount})`,
    );
    // 段1なら未参照は全部消えて resident===required になるが、段2は上限で止まるため
    // required より上に残る。この差が段2の証拠になる。
    assert(
      tight.manager.residentBytes > tight.manager.requiredBytes,
      `${backend} (budget): 段2で止まらず resident が required まで落ちた: resident=${tight.manager.residentBytes} / required=${tight.manager.requiredBytes}`,
    );
    // ready から tight 取得までが evictDelay=10000 を超えると段1が混ざる。10秒未満であること。
    assert(
      (result.tight.elapsedMs ?? Infinity) < 10000,
      `${backend} (budget): 計測に10秒以上かかり段1混入の疑い: elapsedMs=${result.tight.elapsedMs}`,
    );
    assert(
      JSON.stringify(tight.avatars.map((avatar) => avatar.level)) === JSON.stringify(levelsBefore),
      `${backend} (budget): 上限設定でレベルが変化した: ${JSON.stringify(levelsBefore)} → ${JSON.stringify(tight.avatars.map((avatar) => avatar.level))}`,
    );

    // 上限を 8MB に締める。現用・最粗は守られるため超過が残り、レベル分布は変わらない。
    const evictTight = tight.manager.evictCount;
    const setVeryOk = await page.evaluate(() => window.__vrmDemo.setSettings({ budgetMB: 8 }));
    assert(setVeryOk === true, `${backend} (budget): setSettings({ budgetMB: 8 }) が false`);
    await waitFrames(page, 6);
    const veryTight = await statsOf(page);
    result.veryTight = {
      budgetBytes: veryTight.manager.budgetBytes,
      overBudgetBytes: veryTight.manager.overBudgetBytes,
      residentBytes: veryTight.manager.residentBytes,
      requiredBytes: veryTight.manager.requiredBytes,
      evictCount: veryTight.manager.evictCount,
      levels: veryTight.avatars.map((avatar) => avatar.level),
    };
    assert(
      veryTight.manager.budgetBytes === 8 * 1048576,
      `${backend} (budget): 締め後の budgetBytes が 8MB でない: ${veryTight.manager.budgetBytes}`,
    );
    assert(
      veryTight.manager.overBudgetBytes > 0,
      `${backend} (budget): 締め後に overBudgetBytes > 0 にならない: ${veryTight.manager.overBudgetBytes}`,
    );
    assert(
      veryTight.manager.evictCount > evictTight,
      `${backend} (budget): 締め後の破棄が起きていない (evictCount=${evictTight} → ${veryTight.manager.evictCount})`,
    );
    // 予算 < 必要量なので、破棄可能（未参照・非最粗）はすべて消え、
    // resident と required が一致する。
    // 浮動小数の和の順序差に備え、絶対差 1 バイト未満で比較する。
    assert(
      Math.abs(veryTight.manager.residentBytes - veryTight.manager.requiredBytes) < 1,
      `${backend} (budget): resident と required が不一致: ${veryTight.manager.residentBytes} / ${veryTight.manager.requiredBytes}`,
    );
    assert(
      JSON.stringify(veryTight.avatars.map((avatar) => avatar.level)) === JSON.stringify(levelsBefore),
      `${backend} (budget): 上限変更でレベルが変化した: ${JSON.stringify(levelsBefore)} → ${JSON.stringify(veryTight.avatars.map((avatar) => avatar.level))}`,
    );
    // evictDelay=10000 のため段1は動かない。350ms 待って2回読んでも増え続けないこと。
    await sleep(350);
    const settled1 = (await statsOf(page)).manager.evictCount;
    await sleep(350);
    const settled2 = (await statsOf(page)).manager.evictCount;
    result.settled = { first: settled1, second: settled2 };
    assert(
      settled2 === settled1,
      `${backend} (budget): evictCount が増え続ける: ${settled1} → ${settled2}`,
    );

    // 上限を外す。例外なく無効化されること。
    const unsetOk = await page.evaluate(() => window.__vrmDemo.setSettings({ budgetMB: 0 }));
    assert(unsetOk === true, `${backend} (budget): setSettings({ budgetMB: 0 }) が false`);
    await waitFrames(page, 6);
    const unset = await statsOf(page);
    result.unset = {
      budgetBytes: unset.manager.budgetBytes,
      overBudgetBytes: unset.manager.overBudgetBytes,
    };
    assert(
      unset.manager.budgetBytes === null,
      `${backend} (budget): 解除後の budgetBytes が null でない: ${unset.manager.budgetBytes}`,
    );
    assert(
      unset.manager.overBudgetBytes === 0,
      `${backend} (budget): 解除後の overBudgetBytes が 0 でない: ${unset.manager.overBudgetBytes}`,
    );

    const consoleErrors = messages.filter(
      (message) => message.startsWith('pageerror:') || message.startsWith('error:'),
    );
    const noise = messages.filter((message) =>
      /Too many active WebGL contexts|WebGPU|destroyed|THREE\./i.test(message),
    );
    result.consoleErrors = consoleErrors;
    result.webgpuNoise = noise;
    assert(consoleErrors.length === 0, `${backend} (budget): コンソールエラー ${consoleErrors.join(' | ')}`);
    assert(noise.length === 0, `${backend} (budget): GPU関連の警告 ${noise.join(' | ')}`);
    result.ok = failures.length === 0;
  } catch (error) {
    result.error = String(error?.stack ?? error);
    assert(false, `${backend} (budget): 例外: ${String(error)}`);
  } finally {
    result.messages = messages.slice(-20);
    await page.close();
  }
  return result;
}

async function checkAdaptiveBudget(browser, backend) {
  // 予算適応の2軸（thresholdScale＋finestLevel）。`?budget=32` で予測常駐が必要量以下に収まるまで
  // cap/scale が下がり、解除後は両方が戻ることを検証する。
  const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
  const messages = [];
  page.on('console', (message) => messages.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => messages.push(`pageerror: ${String(error)}`));
  const result = { backend, ok: false };
  try {
    await page.goto(
      `${BASE_URL}/vrm.html?auto=0&wander=0&budget=32&evictDelay=1000${backend === 'webgl' ? '&backend=webgl' : ''}`,
      { waitUntil: 'load' },
    );
    await page.waitForFunction(
      () => window.__vrmDemo?.status === 'ready' || window.__vrmDemo?.status === 'error',
      null,
      { timeout: 300000 },
    );
    const status = await page.evaluate(() => window.__vrmDemo.status);
    result.status = status;
    if (status !== 'ready') {
      assert(false, `${backend} (adaptive): デモが ready にならなかった（status=${status}）`);
      return result;
    }
    const adaptiveFlag = await page.evaluate(() => window.__vrmDemo.stats().adaptiveEnabled);
    assert(adaptiveFlag === true, `${backend} (adaptive): adaptiveEnabled が true でない: ${adaptiveFlag}`);

    // 収束を最大15秒待つ。下げは即時・複数段のため、数秒で落ち着く想定。
    // 下限張り付きの判定に下限値の直書きは使わない。収束条件を満たさず
    // required が pinned と一致したままなら、下限で頭打ちとみなす。
    let converged = null;
    const convergeStart = Date.now();
    while (Date.now() - convergeStart < 15000) {
      const sample = await statsOf(page);
      const m = sample.manager;
      const adapted = m.thresholdScale < 1 || m.finestLevel > 0;
      if (
        adapted &&
        m.requiredBytes <= (m.budgetBytes ?? Infinity) &&
        m.overBudgetBytes === 0
      ) {
        converged = sample;
        break;
      }
      // 下限状態: 必要量がピン留め量と一致（これ以上下げられない）。
      if (Math.abs(m.requiredBytes - m.pinnedBytes) < 1 && m.requiredBytes > (m.budgetBytes ?? Infinity)) {
        converged = sample;
        break;
      }
      await sleep(500);
    }
    const stats = converged ?? (await statsOf(page));
    // 下限張り付き: 収束条件を満たさなくても、required が pinned と一致したまま予算超過なら
    // 下限で頭打ちとみなして受け入れる。
    const floored = Math.abs(stats.manager.requiredBytes - stats.manager.pinnedBytes) < 1 &&
      stats.manager.requiredBytes > (stats.manager.budgetBytes ?? Infinity);
    if (converged === null && stats.manager.requiredBytes > (stats.manager.budgetBytes ?? Infinity)) converged = stats;
    result.initial = {
      budgetBytes: stats.manager.budgetBytes,
      requiredBytes: stats.manager.requiredBytes,
      residentBytes: stats.manager.residentBytes,
      overBudgetBytes: stats.manager.overBudgetBytes,
      thresholdScale: stats.manager.thresholdScale,
      finestLevel: stats.manager.finestLevel,
      pinnedBytes: stats.manager.pinnedBytes,
      scaleLowerCount: stats.manager.scaleLowerCount,
      scaleRaiseCount: stats.manager.scaleRaiseCount,
      levelCapLowerCount: stats.manager.levelCapLowerCount,
      levelCapRaiseCount: stats.manager.levelCapRaiseCount,
      levelCounts: stats.levelCounts,
      managerGeneration: stats.managerGeneration,
      waitMs: Date.now() - convergeStart,
    };
    assert(converged !== null, `${backend} (adaptive): 15秒で収束しなかった: ${JSON.stringify(result.initial)}`);
    assert(
      stats.manager.budgetBytes === 32 * 1048576,
      `${backend} (adaptive): budgetBytes が 32MB でない: ${stats.manager.budgetBytes}`,
    );
    assert(
      stats.manager.requiredBytes <= stats.manager.budgetBytes || floored,
      `${backend} (adaptive): required が予算以下にならない: ${stats.manager.requiredBytes} / ${stats.manager.budgetBytes}`,
    );
    if (!floored) {
      assert(
        stats.manager.overBudgetBytes === 0,
        `${backend} (adaptive): overBudgetBytes が 0 でない: ${stats.manager.overBudgetBytes}`,
      );
    }
    // 2軸のどちらかが下がったこと。
    assert(
      stats.manager.scaleLowerCount > 0 || stats.manager.levelCapLowerCount > 0,
      `${backend} (adaptive): lower カウンタが両方 0 のまま: scale=${stats.manager.scaleLowerCount}, cap=${stats.manager.levelCapLowerCount}`,
    );
    // 全員が最粗L4に落ちていないこと。
    assert(
      stats.levelCounts[4] !== stats.avatars.length,
      `${backend} (adaptive): 全員が最粗L4まで粗くなった: ${JSON.stringify(stats.levelCounts)}`,
    );

    // 手順2: 予算を 2MB に締めて強制的に下げる。2軸のどちらかが下がり、
    // required≤予算（または下限状態）になるまで最大15秒待つ。下限状態では all L4 を許容する。
    const forceOk = await page.evaluate(() => window.__vrmDemo.setSettings({ budgetMB: 2 }));
    assert(forceOk === true, `${backend} (adaptive): setSettings({ budgetMB: 2 }) が false`);
    await waitFrames(page, 6);
    let forcedSample = null;
    let lastForcedKey = null;
    let lastForcedKeyAt = Date.now();
    const forceStart = Date.now();
    while (Date.now() - forceStart < 15000) {
      const sample = await statsOf(page);
      const m = sample.manager;
      const adapted = m.thresholdScale < 1 || m.finestLevel > 0;
      if (
        adapted &&
        m.requiredBytes <= (m.budgetBytes ?? Infinity) &&
        m.overBudgetBytes === 0
      ) {
        forcedSample = sample;
        break;
      }
      const pinnedFloor = Math.abs(m.requiredBytes - m.pinnedBytes) < 1 &&
        m.requiredBytes > (m.budgetBytes ?? Infinity);
      if (pinnedFloor) {
        forcedSample = sample;
        break;
      }
      // 下限張り付き: scale/finest が2秒間変わらず required が超過のままなら頭打ちとみなす。
      const key = `${m.thresholdScale}:${m.finestLevel}`;
      if (key !== lastForcedKey) {
        lastForcedKey = key;
        lastForcedKeyAt = Date.now();
      } else if (
        m.requiredBytes > (m.budgetBytes ?? Infinity) &&
        Date.now() - lastForcedKeyAt >= 2000
      ) {
        forcedSample = sample;
        break;
      }
      await sleep(500);
    }
    const forced = forcedSample ?? (await statsOf(page));
    const forcedFloored = Math.abs(forced.manager.requiredBytes - forced.manager.pinnedBytes) < 1 &&
      forced.manager.requiredBytes > (forced.manager.budgetBytes ?? Infinity);
    result.forced = {
      budgetBytes: forced.manager.budgetBytes,
      requiredBytes: forced.manager.requiredBytes,
      residentBytes: forced.manager.residentBytes,
      overBudgetBytes: forced.manager.overBudgetBytes,
      thresholdScale: forced.manager.thresholdScale,
      finestLevel: forced.manager.finestLevel,
      pinnedBytes: forced.manager.pinnedBytes,
      scaleLowerCount: forced.manager.scaleLowerCount,
      scaleRaiseCount: forced.manager.scaleRaiseCount,
      levelCapLowerCount: forced.manager.levelCapLowerCount,
      levelCapRaiseCount: forced.manager.levelCapRaiseCount,
      levelCounts: forced.levelCounts,
      waitMs: Date.now() - forceStart,
    };
    assert(forcedSample !== null, `${backend} (adaptive): 2MB 締めで15秒待っても適応後に required≤予算/下限にならない: ${JSON.stringify(result.forced)}`);
    assert(
      forced.manager.budgetBytes === 2 * 1048576,
      `${backend} (adaptive): 締め後の budgetBytes が 2MB でない: ${forced.manager.budgetBytes}`,
    );
    assert(
      forced.manager.requiredBytes <= forced.manager.budgetBytes || forcedFloored,
      `${backend} (adaptive): 2MB 締めで required が予算以下にならない: ${forced.manager.requiredBytes} / ${forced.manager.budgetBytes}`,
    );
    if (!forcedFloored) {
      assert(
        forced.manager.overBudgetBytes === 0,
        `${backend} (adaptive): 2MB 締め後の overBudgetBytes が 0 でない: ${forced.manager.overBudgetBytes}`,
      );
    }

    // 手順3: 予算を解除し、scale === 1 && finestLevel === 0 になるまで最大60秒待つ（2軸の復帰）。
    // capの上げは1段/秒＋冷却3秒のため余裕を持たせる。
    const raiseBeforeRestore = forced.manager.scaleRaiseCount;
    const capRaiseBeforeRestore = forced.manager.levelCapRaiseCount;
    const unsetOk = await page.evaluate(() => window.__vrmDemo.setSettings({ budgetMB: 0 }));
    assert(unsetOk === true, `${backend} (adaptive): setSettings({ budgetMB: 0 }) が false`);
    let restored = null;
    const restoreStart = Date.now();
    while (Date.now() - restoreStart < 60000) {
      const sample = await statsOf(page);
      if (sample.manager.thresholdScale === 1 && sample.manager.finestLevel === 0) {
        restored = sample;
        break;
      }
      await sleep(500);
    }
    const after = restored ?? (await statsOf(page));
    result.restored = {
      thresholdScale: after.manager.thresholdScale,
      finestLevel: after.manager.finestLevel,
      pinnedBytes: after.manager.pinnedBytes,
      scaleRaiseCount: after.manager.scaleRaiseCount,
      scaleRaiseDelta: after.manager.scaleRaiseCount - raiseBeforeRestore,
      levelCapRaiseCount: after.manager.levelCapRaiseCount,
      levelCapRaiseDelta: after.manager.levelCapRaiseCount - capRaiseBeforeRestore,
      scaleLowerCount: after.manager.scaleLowerCount,
      levelCapLowerCount: after.manager.levelCapLowerCount,
      requiredBytes: after.manager.requiredBytes,
      overBudgetBytes: after.manager.overBudgetBytes,
      levelCounts: after.levelCounts,
      waitMs: Date.now() - restoreStart,
    };
    assert(restored !== null, `${backend} (adaptive): 60秒で scale=1/finest=0 に戻らなかった: ${JSON.stringify(result.restored)}`);
    assert(
      after.manager.thresholdScale === 1 && after.manager.finestLevel === 0,
      `${backend} (adaptive): 解除後の scale/finest が 1/0 でない: ${after.manager.thresholdScale}/${after.manager.finestLevel}`,
    );
    assert(
      after.manager.scaleRaiseCount > raiseBeforeRestore || after.manager.levelCapRaiseCount > capRaiseBeforeRestore,
      `${backend} (adaptive): 解除後に raise カウンタが増えていない: scale ${raiseBeforeRestore} → ${after.manager.scaleRaiseCount}, cap ${capRaiseBeforeRestore} → ${after.manager.levelCapRaiseCount}`,
    );

    // 手順4: 解除後に5秒間、scale/finest・4カウンタ・切替が不変であること。
    const stableAnchor = {
      thresholdScale: after.manager.thresholdScale,
      finestLevel: after.manager.finestLevel,
      scaleLowerCount: after.manager.scaleLowerCount,
      scaleRaiseCount: after.manager.scaleRaiseCount,
      levelCapLowerCount: after.manager.levelCapLowerCount,
      levelCapRaiseCount: after.manager.levelCapRaiseCount,
      switchCount: after.manager.switchCount,
    };
    await sleep(5000);
    const stableSample = await statsOf(page);
    result.stable = {
      thresholdScale: stableSample.manager.thresholdScale,
      finestLevel: stableSample.manager.finestLevel,
      scaleLowerCount: stableSample.manager.scaleLowerCount,
      scaleRaiseCount: stableSample.manager.scaleRaiseCount,
      levelCapLowerCount: stableSample.manager.levelCapLowerCount,
      levelCapRaiseCount: stableSample.manager.levelCapRaiseCount,
      switchCount: stableSample.manager.switchCount,
      requiredBytes: stableSample.manager.requiredBytes,
      residentBytes: stableSample.manager.residentBytes,
      overBudgetBytes: stableSample.manager.overBudgetBytes,
      pinnedBytes: stableSample.manager.pinnedBytes,
      levelCounts: stableSample.levelCounts,
    };
    assert(
      stableSample.manager.thresholdScale === stableAnchor.thresholdScale,
      `${backend} (adaptive): 解除後5秒で scale が変化した: ${stableAnchor.thresholdScale} → ${stableSample.manager.thresholdScale}`,
    );
    assert(
      stableSample.manager.finestLevel === stableAnchor.finestLevel,
      `${backend} (adaptive): 解除後5秒で finestLevel が変化した: ${stableAnchor.finestLevel} → ${stableSample.manager.finestLevel}`,
    );
    assert(
      stableSample.manager.scaleLowerCount === stableAnchor.scaleLowerCount,
      `${backend} (adaptive): 解除後5秒で scaleLowerCount が変化した: ${stableAnchor.scaleLowerCount} → ${stableSample.manager.scaleLowerCount}`,
    );
    assert(
      stableSample.manager.scaleRaiseCount === stableAnchor.scaleRaiseCount,
      `${backend} (adaptive): 解除後5秒で scaleRaiseCount が変化した: ${stableAnchor.scaleRaiseCount} → ${stableSample.manager.scaleRaiseCount}`,
    );
    assert(
      stableSample.manager.levelCapLowerCount === stableAnchor.levelCapLowerCount,
      `${backend} (adaptive): 解除後5秒で levelCapLowerCount が変化した: ${stableAnchor.levelCapLowerCount} → ${stableSample.manager.levelCapLowerCount}`,
    );
    assert(
      stableSample.manager.levelCapRaiseCount === stableAnchor.levelCapRaiseCount,
      `${backend} (adaptive): 解除後5秒で levelCapRaiseCount が変化した: ${stableAnchor.levelCapRaiseCount} → ${stableSample.manager.levelCapRaiseCount}`,
    );
    assert(
      stableSample.manager.switchCount === stableAnchor.switchCount,
      `${backend} (adaptive): 解除後5秒で switchCount が変化した: ${stableAnchor.switchCount} → ${stableSample.manager.switchCount}`,
    );

    // 手順5: 予算 0→8MB の再適用。`setMaxResidentBytes` で作り直さないため、
    // マネージャ世代番号は進まない。初回割当でも増える switchCount だけでは作り直しを見抜けないため、
    // 世代番号の不変で判定する（作り直していたら世代が進む）。
    const generationBeforeReapply = after.managerGeneration;
    const lowerBeforeReapply = after.manager.scaleLowerCount;
    const switchBeforeReapply = after.manager.switchCount;
    const reapplyOk = await page.evaluate(() => window.__vrmDemo.setSettings({ budgetMB: 8 }));
    assert(reapplyOk === true, `${backend} (adaptive): setSettings({ budgetMB: 8 }) が false`);
    let reapplied = null;
    const reapplyStart = Date.now();
    while (Date.now() - reapplyStart < 10000) {
      const sample = await statsOf(page);
      const m = sample.manager;
      if (m.requiredBytes <= (m.budgetBytes ?? Infinity) && m.overBudgetBytes === 0) {
        reapplied = sample;
        break;
      }
      await sleep(500);
    }
    const reagain = reapplied ?? (await statsOf(page));
    result.reapplied = {
      thresholdScale: reagain.manager.thresholdScale,
      finestLevel: reagain.manager.finestLevel,
      pinnedBytes: reagain.manager.pinnedBytes,
      requiredBytes: reagain.manager.requiredBytes,
      residentBytes: reagain.manager.residentBytes,
      overBudgetBytes: reagain.manager.overBudgetBytes,
      scaleLowerCount: reagain.manager.scaleLowerCount,
      levelCapLowerCount: reagain.manager.levelCapLowerCount,
      switchCount: reagain.manager.switchCount,
      managerGeneration: reagain.managerGeneration,
      waitMs: Date.now() - reapplyStart,
    };
    assert(reapplied !== null, `${backend} (adaptive): 再適用後に10秒で収束しなかった: ${JSON.stringify(result.reapplied)}`);
    assert(
      reagain.managerGeneration === generationBeforeReapply,
      `${backend} (adaptive): 再適用でマネージャ世代が進んだ（作り直しの疑い）: ${generationBeforeReapply} → ${reagain.managerGeneration}`,
    );

    const consoleErrors = messages.filter(
      (message) => message.startsWith('pageerror:') || message.startsWith('error:'),
    );
    const noise = messages.filter((message) =>
      /Too many active WebGL contexts|WebGPU|destroyed|THREE\./i.test(message),
    );
    result.consoleErrors = consoleErrors;
    result.webgpuNoise = noise;
    assert(consoleErrors.length === 0, `${backend} (adaptive): コンソールエラー ${consoleErrors.join(' | ')}`);
    assert(noise.length === 0, `${backend} (adaptive): GPU関連の警告 ${noise.join(' | ')}`);
    result.ok = failures.length === 0;
  } catch (error) {
    result.error = String(error?.stack ?? error);
    assert(false, `${backend} (adaptive): 例外: ${String(error)}`);
  } finally {
    result.messages = messages.slice(-20);
    await page.close();
  }
  return result;
}

async function checkTierCap(browser, backend) {
  // Tier上限 `?top=1024` と予算適応のcapを検証する。4096は重いためフル検査はWebGPUのみ。
  // WebGLでは軽い `?atlas=1024&top=1024` 検査（finestLevel===2、エラー0）だけを行う。
  const result = { backend, ok: false };
  const messages = [];
  const collect = (page) => {
    page.on('console', (message) => messages.push(`${message.type()}: ${message.text()}`));
    page.on('pageerror', (error) => messages.push(`pageerror: ${String(error)}`));
  };
  try {
    if (backend === 'webgl') {
      // 一過性の GPU 初期化失敗（Instance dropped / Context Lost）に備え、最大2回試す。
      let attempt = 0;
      for (;;) {
        attempt++;
        const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
        const attemptMessages = [];
        page.on('console', (message) => attemptMessages.push(`${message.type()}: ${message.text()}`));
        page.on('pageerror', (error) => attemptMessages.push(`pageerror: ${String(error)}`));
        const gotoAt = Date.now();
        try {
          await page.goto(
            `${BASE_URL}/vrm.html?models=A&avatars=1&auto=0&wander=0&atlas=1024&top=1024&backend=webgl`,
            { waitUntil: 'load' },
          );
          await page.waitForFunction(
            () => window.__vrmDemo?.status === 'ready' || window.__vrmDemo?.status === 'error',
            null,
            { timeout: 300000 },
          );
          const status = await page.evaluate(() => window.__vrmDemo.status);
          result.lightStatus = status;
          result.lightReadyMs = Date.now() - gotoAt;
          // このブラウザは vulkan フラグなしの WebGL（SwiftShader）のため、ready が極端に
          // 遅い場合はその旨を結果に残す（timeout 300秒は維持）。
          if (result.lightReadyMs > 120000) result.lightSlowReady = true;
          assert(status === 'ready', `${backend} (tierCap): ?atlas=1024&top=1024 で ready にならなかった（status=${status}）`);
          if (status === 'ready') {
            await waitFrames(page, 20);
            const stats = await statsOf(page);
            assert(stats.backend === 'webgl', `${backend} (tierCap): backend が webgl でない: ${stats.backend}`);
            result.light = {
              backend: stats.backend,
              topLevel: stats.topLevel,
              topResolution: stats.topResolution,
              finestLevel: stats.manager.finestLevel,
              level: stats.avatars[0]?.level,
            };
            assert(stats.topLevel === 2, `${backend} (tierCap): topLevel が 2 でない: ${stats.topLevel}`);
            assert(stats.manager.finestLevel === 2, `${backend} (tierCap): finestLevel が 2 でない: ${stats.manager.finestLevel}`);
          }
        } finally {
          await page.close();
        }
        const consoleErrors = attemptMessages.filter(
          (message) => message.startsWith('pageerror:') || message.startsWith('error:'),
        );
        const noise = attemptMessages.filter((message) =>
          /Too many active WebGL contexts|WebGPU|destroyed|THREE\./i.test(message),
        );
        // 値の検証が通ってもコンソールに一過性のエラーが残れば、新しいページで1回だけ取り直す。
        // 1回目で assert 失敗した場合は failures に残る。リトライはコンソールノイズの取り直し用。
        if ((consoleErrors.length > 0 || noise.length > 0) && attempt < 2) continue;
        messages.push(...attemptMessages);
        break;
      }
      const consoleErrors = messages.filter(
        (message) => message.startsWith('pageerror:') || message.startsWith('error:'),
      );
      const noise = messages.filter((message) =>
        /Too many active WebGL contexts|WebGPU|destroyed|THREE\./i.test(message),
      );
      result.consoleErrors = consoleErrors;
      result.webgpuNoise = noise;
      assert(consoleErrors.length === 0, `${backend} (tierCap): コンソールエラー ${consoleErrors.join(' | ')}`);
      assert(noise.length === 0, `${backend} (tierCap): GPU関連の警告 ${noise.join(' | ')}`);
      result.ok = failures.length === 0;
      return result;
    }
    // 前半: `?top=1024`（手動下限）。finestLevel=2に固定され、選択も2以上になる。
    {
      const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
      collect(page);
      try {
        await page.goto(
          `${BASE_URL}/vrm.html?models=A&avatars=1&auto=0&wander=0&atlas=4096&top=1024`,
          { waitUntil: 'load' },
        );
        await page.waitForFunction(
          () => window.__vrmDemo?.status === 'ready' || window.__vrmDemo?.status === 'error',
          null,
          { timeout: 300000 },
        );
        const status = await page.evaluate(() => window.__vrmDemo.status);
        result.topStatus = status;
        assert(status === 'ready', `${backend} (tierCap): ?top=1024 で ready にならなかった（status=${status}）`);
        if (status === 'ready') {
          await waitFrames(page, 20);
          const stats = await statsOf(page);
          result.top = {
            topLevel: stats.topLevel,
            topResolution: stats.topResolution,
            finestLevel: stats.manager.finestLevel,
            level: stats.avatars[0]?.level,
            levelCounts: stats.levelCounts,
          };
          assert(stats.topLevel === 2, `${backend} (tierCap): topLevel が 2 でない: ${stats.topLevel}`);
          assert(stats.manager.finestLevel === 2, `${backend} (tierCap): finestLevel が 2 でない: ${stats.manager.finestLevel}`);
          assert(
            (stats.avatars[0]?.level ?? -1) >= 2,
            `${backend} (tierCap): 選択レベルが2未満: ${stats.avatars[0]?.level}`,
          );
          const mapWidths = await page.evaluate(() => window.__vrmDemo.variantSlotWidths(0, 'map'));
          const normalWidths = await page.evaluate(() => window.__vrmDemo.variantSlotWidths(0, 'normalMap'));
          result.topMapWidths = mapWidths;
          result.topNormalWidths = normalWidths;
          const expectedMap = [4096, 2048, 1024, 512, 256];
          const expectedNormal = [2048, 2048, 1024, 512, 256];
          assert(mapWidths.length > 0, `${backend} (tierCap): map幅が空`);
          for (const row of mapWidths) {
            assert(
              JSON.stringify(row) === JSON.stringify(expectedMap),
              `${backend} (tierCap): map幅が想定外: ${JSON.stringify(row)}`,
            );
          }
          const normalRows = normalWidths.filter((row) => row.some((value) => value !== null));
          assert(normalRows.length > 0, `${backend} (tierCap): normalMap幅が全てnull`);
          for (const row of normalRows) {
            assert(
              JSON.stringify(row) === JSON.stringify(expectedNormal),
              `${backend} (tierCap): normalMap幅が想定外: ${JSON.stringify(row)}`,
            );
          }
          const selected = stats.avatars[0]?.level ?? 2;
          const selectedMapWidth = mapWidths[0]?.[selected];
          // top指定時は近距離でもL2のため、選択レベルのmap幅は1024になる。
          assert(selected === 2, `${backend} (tierCap): 選択レベルがL2でない: L${selected}`);
          assert(selectedMapWidth === 1024, `${backend} (tierCap): L2のmap幅が1024でない: ${selectedMapWidth}`);
        }
      } finally {
        await page.close();
      }
    }

    // 後半: `atlas=4096&budget=64`（topなし、近距離）。予算適応のcapが下がること。
    // 1ソースの必要量は約90MB（L0）〜23MB（L2）のため、64MBではfinest=2まで落ちる。128MBでは収まってしまう。
    {
      const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
      collect(page);
      try {
        await page.goto(
          `${BASE_URL}/vrm.html?models=A&avatars=1&auto=0&wander=0&atlas=4096&budget=64`,
          { waitUntil: 'load' },
        );
        await page.waitForFunction(
          () => window.__vrmDemo?.status === 'ready' || window.__vrmDemo?.status === 'error',
          null,
          { timeout: 300000 },
        );
        const status = await page.evaluate(() => window.__vrmDemo.status);
        result.capStatus = status;
        assert(status === 'ready', `${backend} (tierCap): budget=64 で ready にならなかった（status=${status}）`);
        if (status === 'ready') {
          await waitFrames(page, 20);
          // capが下がるまで最大15秒待つ。
          let capped = null;
          const capStart = Date.now();
          while (Date.now() - capStart < 15000) {
            const sample = await statsOf(page);
            if (sample.manager.finestLevel >= 1) {
              capped = sample;
              break;
            }
            await sleep(500);
          }
          const stats = capped ?? (await statsOf(page));
          result.cap = {
            finestLevel: stats.manager.finestLevel,
            thresholdScale: stats.manager.thresholdScale,
            requiredBytes: stats.manager.requiredBytes,
            residentBytes: stats.manager.residentBytes,
            budgetBytes: stats.manager.budgetBytes,
            overBudgetBytes: stats.manager.overBudgetBytes,
            pinnedBytes: stats.manager.pinnedBytes,
            levelCapLowerCount: stats.manager.levelCapLowerCount,
            levelCapRaiseCount: stats.manager.levelCapRaiseCount,
            level: stats.avatars[0]?.level,
            levelCounts: stats.levelCounts,
            waitMs: Date.now() - capStart,
          };
          assert(capped !== null, `${backend} (tierCap): 15秒で finestLevel>=1 にならない: ${JSON.stringify(result.cap)}`);
          // 実測どおり finestLevel===2・scale===1 に固定で確認する。
          assert(
            stats.manager.finestLevel === 2,
            `${backend} (tierCap): finestLevel が 2 でない: ${stats.manager.finestLevel}`,
          );
          assert(
            stats.manager.thresholdScale === 1,
            `${backend} (tierCap): scale が 1 でない: ${stats.manager.thresholdScale}`,
          );
          assert(
            stats.manager.requiredBytes <= 64 * 1048576,
            `${backend} (tierCap): required が 64MB 以下にならない: ${stats.manager.requiredBytes}`,
          );
          assert(
            stats.manager.overBudgetBytes === 0,
            `${backend} (tierCap): overBudgetBytes が 0 でない: ${stats.manager.overBudgetBytes}`,
          );
          assert(
            stats.manager.levelCapLowerCount > 0,
            `${backend} (tierCap): levelCapLowerCount が 0 のまま: ${stats.manager.levelCapLowerCount}`,
          );
          const mapWidths = await page.evaluate(() => window.__vrmDemo.variantSlotWidths(0, 'map'));
          const selected = stats.avatars[0]?.level ?? 0;
          const selectedMapWidth = mapWidths[0]?.[selected];
          result.capMapWidth = selectedMapWidth;
          assert(
            selected === 2,
            `${backend} (tierCap): 選択レベルがL2でない: L${selected}`,
          );
          assert(
            selectedMapWidth === 1024,
            `${backend} (tierCap): 選択レベルのmap幅が1024でない: L${selected} -> ${selectedMapWidth}`,
          );

          // 予算解除で finestLevel===0 に戻る（cap上げは1段/秒＋冷却3秒のため最大30秒）。
          const unsetOk = await page.evaluate(() => window.__vrmDemo.setSettings({ budgetMB: 0 }));
          assert(unsetOk === true, `${backend} (tierCap): setSettings({ budgetMB: 0 }) が false`);
          let restored = null;
          const restoreStart = Date.now();
          while (Date.now() - restoreStart < 30000) {
            const sample = await statsOf(page);
            if (sample.manager.finestLevel === 0) {
              restored = sample;
              break;
            }
            await sleep(500);
          }
          result.capRestored = {
            finestLevel: (restored ?? (await statsOf(page))).manager.finestLevel,
            waitMs: Date.now() - restoreStart,
          };
          assert(restored !== null, `${backend} (tierCap): 30秒で finestLevel が 0 に戻らなかった: ${JSON.stringify(result.capRestored)}`);
        }
      } finally {
        await page.close();
      }
    }

    const consoleErrors = messages.filter(
      (message) => message.startsWith('pageerror:') || message.startsWith('error:'),
    );
    const noise = messages.filter((message) =>
      /Too many active WebGL contexts|WebGPU|destroyed|THREE\./i.test(message),
    );
    result.consoleErrors = consoleErrors;
    result.webgpuNoise = noise;
    assert(consoleErrors.length === 0, `${backend} (tierCap): コンソールエラー ${consoleErrors.join(' | ')}`);
    assert(noise.length === 0, `${backend} (tierCap): GPU関連の警告 ${noise.join(' | ')}`);
    result.ok = failures.length === 0;
  } catch (error) {
    result.error = String(error?.stack ?? error);
    assert(false, `${backend} (tierCap): 例外: ${String(error)}`);
  }
  return result;
}

async function checkCrowd(browser, backend) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
  const messages = [];
  page.on('console', (message) => messages.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => messages.push(`pageerror: ${String(error)}`));
  const result = { backend, ok: false };
  try {
    const loadedAt = Date.now();
    await page.goto(
      `${BASE_URL}/vrm.html?models=A,B,C&avatars=100&auto=0&wander=0${backend === 'webgl' ? '&backend=webgl' : ''}`,
      { waitUntil: 'load' },
    );
    await page.waitForFunction(
      () => window.__vrmDemo?.status === 'ready' || window.__vrmDemo?.status === 'error',
      null,
      { timeout: 300000 },
    );
    result.loadMs = Date.now() - loadedAt;
    const status = await page.evaluate(() => window.__vrmDemo.status);
    result.status = status;
    if (status !== 'ready') {
      assert(false, `${backend} (crowd): デモが ready にならなかった（status=${status}）`);
      return result;
    }
    // evictDelay(既定1000ms) 後の常駐量まで待ってから測る。
    // 低速環境（SwiftShaderのWebGPUなど）では20フレームに50秒以上かかるため最大180秒まで待つ。
    await waitFrames(page, 20, 180000);
    await sleep(1400);
    const stats = await statsOf(page);
    result.stats = stats;
    assert(stats.avatars.length === 100, `${backend} (crowd): アバター数が ${stats.avatars.length}`);
    assert(stats.sourceCount === 3, `${backend} (crowd): sourceCount が ${stats.sourceCount}`);
    assert(stats.cloneCount === 97, `${backend} (crowd): cloneCount が ${stats.cloneCount}`);
    assert(stats.manager.objectCount === 100, `${backend} (crowd): objectCount が ${stats.manager.objectCount}`);
    assert(stats.ringCount === 100, `${backend} (crowd): ringCount が ${stats.ringCount}`);
    assert(
      stats.avatars.slice(0, 4).map((avatar) => avatar.level).join(',') === '0,1,2,3',
      `${backend} (crowd): 先頭4体のレベルが ${stats.avatars.slice(0, 4).map((avatar) => avatar.level).join(',')}`,
    );
    const levelSum = stats.levelCounts.reduce((sum, count) => sum + count, 0);
    assert(levelSum === 100, `${backend} (crowd): levelCounts の合計が ${levelSum}`);
    assert(stats.manager.levelCounts.length === 5, `${backend} (crowd): levelCounts が5要素でない: ${JSON.stringify(stats.manager.levelCounts)}`);
    assert((stats.levelCounts[3] + stats.levelCounts[4]) >= 80, `${backend} (crowd): L3+L4 が ${(stats.levelCounts[3] ?? 0) + (stats.levelCounts[4] ?? 0)} 体しかない`);
    assert(stats.errors.length === 0, `${backend} (crowd): stats.errors ${stats.errors.join(' | ')}`);
    assert(stats.wander === false, `${backend} (crowd): wander が ${stats.wander}`);
    const fullAtlas = stats.avatars.reduce((sum, avatar) => sum + avatar.atlasBytes, 0);
    result.resident = stats.manager.residentBytes;
    result.fullAtlas = fullAtlas;
    // 複製の atlasBytes は0のため、fullAtlas はソース分のみ。実測1.30倍のため1.4倍未満で見る。
    assert(
      stats.manager.residentBytes < fullAtlas * 1.4,
      `${backend} (crowd): 常駐量が全アトラスの1.4倍未満にならない: ${stats.manager.residentBytes} / ${fullAtlas}`,
    );

    // 静止時の性能を3秒間記録する。
    const still = [];
    for (let i = 0; i < 3; i++) {
      await sleep(1000);
      const sample = await statsOf(page);
      still.push({
        frameTimeMs: sample.frameTimeMs,
        updateMs: sample.updateMs,
        drawCalls: sample.drawCalls,
        pipelineCaches: sample.pipelineCaches,
      });
    }
    result.perfStill = {
      frameTimeMs: still.reduce((sum, sample) => sum + sample.frameTimeMs, 0) / still.length,
      updateMs: still.reduce((sum, sample) => sum + sample.updateMs, 0) / still.length,
      drawCalls: still[still.length - 1].drawCalls,
      pipelineCaches: still[still.length - 1].pipelineCaches,
    };

    // 徘徊を有効化する。模擬時間7秒で9割以上が動き出すこと。
    // WebGPU/SwiftShader では frame が1.7秒でも delta が0.05にクランプされるため、
    // 壁時計ではなく模擬時間（stats().elapsed）で待つ。7秒は待機（0.5〜3.0秒）を終えて
    // 歩行に入るまでの余裕を見た値。タイムアウトは300秒（1.7s/frameで約140フレーム＝約238秒）。
    const simStart = (await statsOf(page)).elapsed;
    const wanderSetAt = Date.now();
    const setWanderOk = await page.evaluate(() => window.__vrmDemo.setSettings({ wander: true }));
    assert(setWanderOk === true, `${backend} (crowd): setSettings({ wander: true }) が false`);
    const movedFraction = () =>
      page.evaluate(() => {
        const demo = window.__vrmDemo.stats();
        const moved = demo.avatars.filter(
          (avatar) =>
            Math.hypot(avatar.position.x - avatar.home.x, avatar.position.z - avatar.home.z) > 0.01,
        ).length;
        return { moved: moved / demo.avatars.length, elapsed: demo.elapsed };
      });
    let moved = 0;
    let simWait = 0;
    const wanderDeadline = Date.now() + 300000;
    for (;;) {
      const sample = await movedFraction();
      moved = sample.moved;
      simWait = sample.elapsed - simStart;
      if (moved >= 0.9 && simWait >= 7) break;
      if (Date.now() >= wanderDeadline) break;
      await sleep(1500);
    }
    result.wanderWaitMs = Date.now() - wanderSetAt;
    result.simWait = simWait;
    result.movedFraction = moved;
    assert(
      simWait >= 7,
      `${backend} (crowd): シミュレーションが進まなかった（sim ${simWait.toFixed(2)}秒でタイムアウト）`,
    );
    assert(moved >= 0.9, `${backend} (crowd): 移動した体が ${Math.round(moved * 100)}% しかない`);

    const wandering = await statsOf(page);
    assert(wandering.wander === true, `${backend} (crowd): wander が有効になっていない`);
    const maxOff = Math.max(
      ...wandering.avatars.map((avatar) =>
        Math.hypot(avatar.position.x - avatar.home.x, avatar.position.z - avatar.home.z),
      ),
    );
    result.maxOffHome = maxOff;
    assert(
      wandering.avatars.every(
        (avatar) =>
          Math.hypot(avatar.position.x - avatar.home.x, avatar.position.z - avatar.home.z) <= 0.75,
      ),
      `${backend} (crowd): home からの最大距離が 0.75 を超えた: ${maxOff}`,
    );

    // 0.25秒おきに5回、2体間の最小間隔を確認する。
    let minGap = Infinity;
    for (let i = 0; i < 5; i++) {
      const sample = await statsOf(page);
      const points = sample.avatars.map((avatar) => avatar.position);
      let local = Infinity;
      for (let a = 0; a < points.length; a++) {
        for (let b = a + 1; b < points.length; b++) {
          const gap = Math.hypot(points[a].x - points[b].x, points[a].z - points[b].z);
          if (gap < local) local = gap;
        }
      }
      if (local < minGap) minGap = local;
      await sleep(250);
    }
    result.minGap = minGap;
    assert(minGap >= 0.4, `${backend} (crowd): 2体間の最小間隔が ${minGap}`);
    const wanderPerf = await statsOf(page);
    result.perfWander = {
      frameTimeMs: wanderPerf.frameTimeMs,
      updateMs: wanderPerf.updateMs,
      drawCalls: wanderPerf.drawCalls,
      pipelineCaches: wanderPerf.pipelineCaches,
    };

    // 徘徊を止めると全員が home に戻る（レベルは確認しない）。
    await page.evaluate(() => window.__vrmDemo.setSettings({ wander: false }));
    await waitFrames(page, 6, 180000);
    const settled = await statsOf(page);
    const maxHomeError = Math.max(
      ...settled.avatars.map((avatar) =>
        Math.hypot(avatar.position.x - avatar.home.x, avatar.position.z - avatar.home.z),
      ),
    );
    result.maxHomeError = maxHomeError;
    assert(
      settled.avatars.every(
        (avatar) =>
          Math.abs(avatar.position.x - avatar.home.x) < 1e-6 &&
          Math.abs(avatar.position.z - avatar.home.z) < 1e-6,
      ),
      `${backend} (crowd): 停止後に home へ戻っていない体がある（最大誤差 ${maxHomeError}）`,
    );

    // 体数の一括変更。往復してもパイプラインは増えないこと。
    // 低速環境でも最大180秒まで待つ。
    const to4At = Date.now();
    const to4 = await page.evaluate(() => window.__vrmDemo.setAvatarCount(4));
    result.setAvatarCount4Ms = Date.now() - to4At;
    await waitFrames(page, 6, 180000);
    const stats4 = await statsOf(page);
    assert(to4 === 4, `${backend} (crowd): setAvatarCount(4) が ${to4} を返した`);
    assert(stats4.avatars.length === 4, `${backend} (crowd): 4体化後に ${stats4.avatars.length} 体`);
    assert(stats4.manager.objectCount === 4, `${backend} (crowd): 4体化後の objectCount が ${stats4.manager.objectCount}`);
    assert(stats4.ringCount === 4, `${backend} (crowd): 4体化後の ringCount が ${stats4.ringCount}`);

    const to100At = Date.now();
    const to100 = await page.evaluate(() => window.__vrmDemo.setAvatarCount(100));
    result.setAvatarCount100Ms = Date.now() - to100At;
    await waitFrames(page, 6, 180000);
    const stats100 = await statsOf(page);
    assert(to100 === 100, `${backend} (crowd): setAvatarCount(100) が ${to100} を返した`);
    assert(stats100.avatars.length === 100, `${backend} (crowd): 100体化後に ${stats100.avatars.length} 体`);
    assert(stats100.manager.objectCount === 100, `${backend} (crowd): 100体化後の objectCount が ${stats100.manager.objectCount}`);
    assert(stats100.ringCount === 100, `${backend} (crowd): 100体化後の ringCount が ${stats100.ringCount}`);
    assert(
      stats100.pipelineCaches <= stats.pipelineCaches,
      `${backend} (crowd): 体数往復で pipelineCaches が増えた: ${stats.pipelineCaches} → ${stats100.pipelineCaches}`,
    );
    assert(stats100.errors.length === 0, `${backend} (crowd): 体数往復後に errors ${stats100.errors.join(' | ')}`);

    const consoleErrors = messages.filter(
      (message) => message.startsWith('pageerror:') || message.startsWith('error:'),
    );
    const noise = messages.filter((message) =>
      /Too many active WebGL contexts|WebGPU|destroyed|THREE\./i.test(message),
    );
    result.consoleErrors = consoleErrors;
    result.webgpuNoise = noise;
    assert(consoleErrors.length === 0, `${backend} (crowd): コンソールエラー ${consoleErrors.join(' | ')}`);
    assert(noise.length === 0, `${backend} (crowd): GPU関連の警告 ${noise.join(' | ')}`);
    result.ok = failures.length === 0;
  } catch (error) {
    result.error = String(error?.stack ?? error);
    assert(false, `${backend} (crowd): 例外: ${String(error)}`);
  } finally {
    result.messages = messages.slice(-20);
    await page.close();
  }
  return result;
}

async function checkHud(page, backend, result) {
  const baseQuery = `models=A&avatars=1&auto=0&h=0.15&wander=0${backend === 'webgl' ? '&backend=webgl' : ''}`;
  const baseUrl = `${BASE_URL}/vrm.html?${baseQuery}`;

  async function waitHudReady(label) {
    await page.waitForFunction(
      () => window.__vrmDemo?.status === 'ready' || window.__vrmDemo?.status === 'error',
      null,
      { timeout: 240000 },
    );
    const status = await page.evaluate(() => window.__vrmDemo.status);
    assert(status === 'ready', `${backend} (hud): ${label}で ready にならなかった（status=${status}）`);
  }

  // HUDは既定で展開。ready直後の本文は表示され、サマリは隠れていること。
  await waitFrames(page, 3);
  const expandedHeight = await page.evaluate(
    () => document.getElementById('hud').getBoundingClientRect().height,
  );
  const expandedWidth = await page.evaluate(
    () => document.getElementById('hud').getBoundingClientRect().width,
  );
  const bodyVisible = await page.evaluate(
    () => document.getElementById('hud-body').offsetParent !== null,
  );
  assert(bodyVisible === true, `${backend} (hud): 初期表示で #hud-body が見えていない`);
  const summaryHidden = await page.evaluate(
    () => getComputedStyle(document.getElementById('hud-summary')).display === 'none',
  );
  assert(summaryHidden === true, `${backend} (hud): 展開時に #hud-summary が表示されている`);
  // pre-wrap で長い行が折り返し、横にはみ出さないこと。
  const bodyOverflow = await page.evaluate(() => {
    const body = document.getElementById('hud-body');
    return { scrollWidth: body.scrollWidth, clientWidth: body.clientWidth };
  });
  assert(
    bodyOverflow.scrollWidth <= bodyOverflow.clientWidth + 1,
    `${backend} (hud): #hud-body が横にはみ出している: scrollWidth=${bodyOverflow.scrollWidth}, clientWidth=${bodyOverflow.clientWidth}`,
  );

  // トグルボタンで折りたたみ。stats()1回＋DOM確認で、hudCollapsedの二重確認はしない。
  await page.click('#hud-toggle');
  await waitFrames(page, 2);
  const collapsedStats = await statsOf(page);
  assert(
    collapsedStats.hudCollapsed === true,
    `${backend} (hud): 折りたたみ後に stats().hudCollapsed が true でない`,
  );
  const collapsedFlag = await page.evaluate(() => ({
    bodyHidden: document.getElementById('hud-body').offsetParent === null,
    ariaExpanded: document.getElementById('hud-toggle').getAttribute('aria-expanded'),
    collapsedClass: document.getElementById('hud').classList.contains('collapsed'),
  }));
  assert(
    collapsedFlag.bodyHidden === true,
    `${backend} (hud): 折りたたみ後に #hud-body が表示されたまま`,
  );
  assert(
    collapsedFlag.ariaExpanded === 'false',
    `${backend} (hud): 折りたたみ後の aria-expanded が ${collapsedFlag.ariaExpanded}`,
  );
  assert(
    collapsedFlag.collapsedClass === true,
    `${backend} (hud): 折りたたみ後に .collapsed が付いていない`,
  );
  const collapsedRect = await page.evaluate(() => {
    const rect = document.getElementById('hud').getBoundingClientRect();
    return { height: rect.height, width: rect.width, right: rect.right };
  });
  const collapsedViewportWidth = await page.evaluate(() => window.innerWidth);
  assert(
    collapsedRect.right <= collapsedViewportWidth,
    `${backend} (hud): 折りたたみ時の右端 ${collapsedRect.right} が viewport 幅 ${collapsedViewportWidth} を超えている`,
  );
  assert(
    collapsedRect.height < expandedHeight / 2,
    `${backend} (hud): 折りたたみ時の高さ ${collapsedRect.height} が展開時 ${expandedHeight} の半分未満にならない`,
  );

  // もう一度クリックで展開に戻る。
  await page.click('#hud-toggle');
  await waitFrames(page, 2);
  const reopened = await statsOf(page);
  const reopenedFlag = await page.evaluate(() => ({
    bodyVisible: document.getElementById('hud-body').offsetParent !== null,
    ariaExpanded: document.getElementById('hud-toggle').getAttribute('aria-expanded'),
  }));
  assert(
    reopened.hudCollapsed === false,
    `${backend} (hud): 再展開後に hudCollapsed が false でない`,
  );
  assert(reopenedFlag.bodyVisible === true, `${backend} (hud): 再展開後に #hud-body が見えていない`);
  assert(
    reopenedFlag.ariaExpanded === 'true',
    `${backend} (hud): 再展開後の aria-expanded が ${reopenedFlag.ariaExpanded}`,
  );

  // H キーで折りたたみ・展開。
  await page.keyboard.press('h');
  await waitFrames(page, 2);
  const keyCollapsed = await statsOf(page);
  assert(keyCollapsed.hudCollapsed === true, `${backend} (hud): Hキーで折りたたまれない`);
  await page.keyboard.press('h');
  await waitFrames(page, 2);
  const keyExpanded = await statsOf(page);
  assert(keyExpanded.hudCollapsed === false, `${backend} (hud): 2回目のHキーで展開されない`);

  // 折りたたみ中のサマリ: 空でなく frame(ms) を含み、更新され続けること。
  // このページは予算0のため scale は出ない（本文VRAM行と同条件）。
  await page.click('#hud-toggle');
  await waitFrames(page, 2);
  const summaryBefore = await page.evaluate(
    () => document.getElementById('hud-summary').textContent,
  );
  const frameBefore = (await statsOf(page)).frame;
  assert(
    typeof summaryBefore === 'string' && summaryBefore.length > 0,
    `${backend} (hud): 折りたたみ中のサマリが空`,
  );
  assert(summaryBefore.includes('ms'), `${backend} (hud): サマリに frame 値(ms)が無い: ${summaryBefore}`);
  assert(
    !summaryBefore.includes('scale'),
    `${backend} (hud): 予算0なのにサマリに scale が出ている: ${summaryBefore}`,
  );
  await sleep(600);
  const summaryAfter = await page.evaluate(
    () => document.getElementById('hud-summary').textContent,
  );
  const frameAfter = (await statsOf(page)).frame;
  assert(
    frameAfter > frameBefore,
    `${backend} (hud): 折りたたみ中に frame が進んでいない: ${frameBefore} → ${frameAfter}`,
  );

  // 折りたたみバーが lil-gui と重ならないこと（1200px viewport）。
  const overlap = await page.evaluate(() => {
    const barRight = document.getElementById('hud').getBoundingClientRect().right;
    const root = [...document.querySelectorAll('.lil-gui')].find(
      (element) => element.parentElement === document.body,
    );
    return { barRight, guiLeft: root ? root.getBoundingClientRect().left : null };
  });
  assert(overlap.guiLeft !== null, `${backend} (hud): lil-gui のルートが見つからない`);
  assert(
    overlap.barRight < overlap.guiLeft,
    `${backend} (hud): 折りたたみバーの右端 ${overlap.barRight} が lil-gui の左端 ${overlap.guiLeft} 以上`,
  );

  // 永続化: 折りたたんだままリロード → 復元される。その後 ?hud=1 → 展開される。
  await page.reload({ waitUntil: 'load' });
  await waitHudReady('リロード後');
  const restored = await statsOf(page);
  assert(restored.hudCollapsed === true, `${backend} (hud): リロード後に折りたたみが復元されていない`);
  await page.goto(`${baseUrl}&hud=1`, { waitUntil: 'load' });
  await waitHudReady('?hud=1');
  const urlExpanded = await statsOf(page);
  assert(urlExpanded.hudCollapsed === false, `${backend} (hud): ?hud=1 で展開されていない`);

  // URL指定は保存しない: 空の localStorage で ?hud=0 → 折りたたみ → パラメータなし再読込 → 展開。
  await page.evaluate(() => window.localStorage.clear());
  await page.goto(`${baseUrl}&hud=0`, { waitUntil: 'load' });
  await waitHudReady('?hud=0');
  const urlCollapsed = await statsOf(page);
  assert(urlCollapsed.hudCollapsed === true, `${backend} (hud): ?hud=0 で折りたたまれていない`);
  await page.goto(baseUrl, { waitUntil: 'load' });
  await waitHudReady('パラメータなし再読込');
  const urlDefault = await statsOf(page);
  assert(
    urlDefault.hudCollapsed === false,
    `${backend} (hud): ?hud=0 が保存されて既定が変わっている`,
  );

  // lil-gui の入力中は H を無視すること。
  const inputFocused = await page.evaluate(() => {
    const input = document.querySelector('.lil-gui input');
    if (!input) return false;
    input.focus();
    return document.activeElement === input;
  });
  assert(inputFocused === true, `${backend} (hud): lil-gui の input にフォーカスできない`);
  await page.keyboard.press('h');
  await waitFrames(page, 2);
  const afterInputKey = await statsOf(page);
  assert(
    afterInputKey.hudCollapsed === false,
    `${backend} (hud): 入力中のHキーでトグルされた`,
  );

  result.hud = {
    expandedHeight,
    // 幅は記録のみ。サマリ1行のため折りたたみ時が展開時より広くなる場合がある。
    expandedWidth,
    collapsedHeight: collapsedRect.height,
    collapsedWidth: collapsedRect.width,
    bodyScrollWidth: bodyOverflow.scrollWidth,
    bodyClientWidth: bodyOverflow.clientWidth,
    summary: summaryAfter,
    guiLeft: overlap.guiLeft,
  };
}

async function checkSpill(browser, backend) {
  // 画素データのディスク退避（`?spill=1`）を検証する。猶予0で即時破棄させ、次を確かめる。
  // 1. 遠ざかって破棄した L0〜L2 の画素データが OPFS へ退避される（spilledBytes > 0）。
  // 2. 近づくと読み戻しを待って L0 に戻り、輝度が退避前と一致する（読み戻した内容が正しい）。
  // 3. 退避中に手動レベル固定・LOD 無効へ切り替えても、読み戻してから表示するため描画エラーが出ない。
  const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
  const messages = [];
  page.on('console', (message) => messages.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => messages.push(`pageerror: ${String(error)}`));
  const result = { backend, ok: false };
  const spillOf = async () => (await statsOf(page)).spill;
  const goFarAndSpill = async (label) => {
    await setDistance(page, 20);
    await waitFor(page, () => (window.__vrmDemo.stats().spill?.spilledCount ?? 0) > 0, null, 10000);
    const spill = await spillOf();
    assert(spill.spilledBytes > 0, `${backend} (spill ${label}): 退避量が 0: ${JSON.stringify(spill)}`);
    return spill;
  };
  try {
    await page.goto(
      `${BASE_URL}/vrm.html?models=A&avatars=1&auto=0&wander=0&evictDelay=0&spill=1${backend === 'webgl' ? '&backend=webgl' : ''}`,
      { waitUntil: 'load' },
    );
    await page.waitForFunction(
      () => window.__vrmDemo?.status === 'ready' || window.__vrmDemo?.status === 'error',
      null,
      { timeout: 240000 },
    );
    const status = await page.evaluate(() => window.__vrmDemo.status);
    result.status = status;
    if (status !== 'ready') {
      assert(false, `${backend} (spill): デモが ready にならなかった（status=${status}）`);
      return result;
    }
    assert((await spillOf()) !== null, `${backend} (spill): 退避キャッシュが有効になっていない`);

    await setDistance(page, 2.5);
    const near = await screenshot(page, `${backend}-spill-near.png`);
    result.far = await goFarAndSpill('far');

    await setDistance(page, 2.5);
    await waitFor(page, () => window.__vrmDemo.stats().avatars[0]?.level === 0, null, 10000);
    await waitFrames(page, 6);
    const recovered = await screenshot(page, `${backend}-spill-recovered.png`);
    result.recovered = await spillOf();
    result.brightness = { near, recovered };
    assert(near > 20, `${backend} (spill): 近景の輝度が低すぎる: ${near}`);
    assert(
      Math.abs(recovered / near - 1) < 0.1,
      `${backend} (spill): 読み戻し後の輝度比が 10% を超えた: near=${near}, recovered=${recovered}`,
    );

    await goFarAndSpill('force');
    await page.evaluate(() => window.__vrmDemo.setSettings({ forceLevel: 0 }));
    await waitFor(page, () => window.__vrmDemo.stats().manualLevel === 0, null, 10000);
    await setDistance(page, 2.5);
    const forced = await screenshot(page, `${backend}-spill-forced.png`);
    assert(
      Math.abs(forced / near - 1) < 0.1,
      `${backend} (spill): 手動 L0 の輝度比が 10% を超えた: near=${near}, forced=${forced}`,
    );
    await page.evaluate(() => window.__vrmDemo.setSettings({ forceLevel: null }));

    await goFarAndSpill('lod-off');
    await page.evaluate(() => window.__vrmDemo.setSettings({ lodEnabled: false }));
    await setDistance(page, 2.5);
    await waitFrames(page, 30);
    const lodOff = await screenshot(page, `${backend}-spill-lod-off.png`);
    result.brightness.forced = forced;
    result.brightness.lodOff = lodOff;
    assert(
      Math.abs(lodOff / near - 1) < 0.1,
      `${backend} (spill): LOD 無効の輝度比が 10% を超えた: near=${near}, lodOff=${lodOff}`,
    );
    const final = await spillOf();
    result.final = final;
    assert(final.failureCount === 0, `${backend} (spill): 退避・読み戻しの失敗がある: ${JSON.stringify(final)}`);

    const consoleErrors = messages.filter(
      (message) => message.startsWith('pageerror:') || message.startsWith('error:'),
    );
    result.consoleErrors = consoleErrors;
    assert(consoleErrors.length === 0, `${backend} (spill): コンソールエラー: ${consoleErrors.join(' | ')}`);
    result.ok = failures.length === 0;
  } catch (error) {
    result.error = String(error?.stack ?? error);
    assert(false, `${backend} (spill): 例外: ${String(error)}`);
  } finally {
    result.messages = messages.slice(-20);
    await page.close();
  }
  return result;
}

async function checkBackend(browser, backend) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
  const messages = [];
  page.on('console', (message) => {
    messages.push(`${message.type()}: ${message.text()}`);
  });
  page.on('pageerror', (error) => messages.push(`pageerror: ${String(error)}`));

  const result = { backend, ok: false, messages: [] };
  try {
    await page.goto(
      `${BASE_URL}/vrm.html?models=A&avatars=1&auto=0&h=0.15&wander=0${backend === 'webgl' ? '&backend=webgl' : ''}`,
      { waitUntil: 'load' },
    );
    await page.waitForFunction(
      () => window.__vrmDemo?.status === 'ready' || window.__vrmDemo?.status === 'error',
      null,
      { timeout: 240000 },
    );
    const status = await page.evaluate(() => window.__vrmDemo.status);
    if (status !== 'ready') {
      result.status = status;
      result.messages = messages;
      assert(false, `${backend}: デモが ready にならなかった（status=${status}）`);
      return result;
    }

    const stats = await statsOf(page);
    result.stats = stats;
    assert(stats.backend === backend, `${backend}: backend が ${stats.backend} になっている`);
    // 以降の検証も同じ起動フラグの Chrome で行うため、GPU の判定はここで一度だけ行う。
    result.gpu = { adapter: stats.gpuAdapter, software: stats.gpuSoftware };
    assert(
      !(REQUIRE_HW_GPU && stats.gpuSoftware),
      `${backend}: ソフトウェア実装で描画している: ${stats.gpuAdapter}`,
    );
    assert(stats.avatars.length === 1, `${backend}: アバター数が ${stats.avatars.length}`);
    assert(stats.manager.objectCount === 1, `${backend}: manager.objectCount が ${stats.manager.objectCount}`);

    const avatar = stats.avatars[0];
    assert(
      avatar.before.materials > avatar.after.materials,
      `${backend}: マテリアル数が削減されていない（${avatar.before.materials} → ${avatar.after.materials}）`,
    );
    assert(
      avatar.after.meshes < avatar.before.meshes,
      `${backend}: メッシュ数が削減されていない（${avatar.before.meshes} → ${avatar.after.meshes}）`,
    );
    assert(
      avatar.materials === avatar.after.materials,
      `${backend}: LODセット数(${avatar.materials})と最適化後マテリアル数(${avatar.after.materials})が違う`,
    );
    assert(avatar.usedSlots.includes('map'), `${backend}: map が使用スロットに無い`);
    assert(avatar.usedSlots.includes('shadeMultiplyTexture'), `${backend}: shadeMultiplyTexture が使用スロットに無い`);
    assert(avatar.atlasResolution === 1024, `${backend}: アトラス解像度が ${avatar.atlasResolution}`);
    assert(avatar.atlasBytes > 0, `${backend}: アトラスバイト数が 0`);

    const meshLevels = await page.evaluate(() => window.__vrmDemo.meshLevels(0));
    assert(meshLevels.length === avatar.after.meshes, `${backend}: meshLevels の件数が不一致`);
    assert(meshLevels.every((level) => level >= 0), `${backend}: LOD未適用のメッシュがある: ${meshLevels}`);
    const widths = await page.evaluate(() => window.__vrmDemo.variantTextureWidths(0));
    const expectedWidths = [1024, 1024, 1024, 512, 256];
    assert(widths.length > 0, `${backend}: variantTextureWidths が空`);
    for (const setWidths of widths) {
      assert(
        JSON.stringify(setWidths) === JSON.stringify(expectedWidths),
        `${backend}: バリアントのmap幅が想定外: ${JSON.stringify(setWidths)}`,
      );
    }
    result.variantTextureWidths = widths;

    await checkHysteresis(page, result);
    await checkBands(page, result);
    await checkHysteresisZero(page, result);
    await checkPipelines(page, result);
    await checkEvict(page, backend, result);
    await checkKeepAll(page, result);
    await checkHud(page, backend, result);

    const consoleErrors = messages.filter(
      (message) =>
        message.startsWith('pageerror:') || message.startsWith('error:'),
    );
    const webgpuNoise = messages.filter((message) =>
      /Too many active WebGL contexts|WebGPU|destroyed|THREE\./i.test(message),
    );
    result.consoleErrors = consoleErrors;
    result.webgpuNoise = webgpuNoise;
    assert(consoleErrors.length === 0, `${backend}: コンソールエラー: ${consoleErrors.join(' | ')}`);
    assert(webgpuNoise.length === 0, `${backend}: GPU関連の警告: ${webgpuNoise.join(' | ')}`);

    result.ok = failures.length === 0;
  } catch (error) {
    result.error = String(error?.stack ?? error);
    assert(false, `${backend}: 例外: ${String(error)}`);
  } finally {
    result.messages = messages.slice(-40);
    await page.close();
  }
  return result;
}

async function checkCompressed(browser, backend) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
  const messages = [];
  page.on('console', (message) => messages.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => messages.push(`pageerror: ${String(error)}`));
  const result = { backend, ok: false, messages: [] };
  try {
    await page.goto(
      `${BASE_URL}/vrm.html?models=A&avatars=1&auto=0&h=0.15&wander=0&compress=1${backend === 'webgl' ? '&backend=webgl' : ''}`,
      { waitUntil: 'load' },
    );
    await page.waitForFunction(
      () => window.__vrmDemo?.status === 'ready' || window.__vrmDemo?.status === 'error',
      null,
      { timeout: 300000 },
    );
    const status = await page.evaluate(() => window.__vrmDemo.status);
    result.status = status;
    if (status !== 'ready') {
      assert(false, `${backend} (compressed): デモが ready にならなかった（status=${status}）`);
      return result;
    }

    const stats = await statsOf(page);
    const avatar = stats.avatars[0];
    assert(stats.compressTextures === true, `${backend} (compressed): compressTextures が true でない`);
    assert(
      avatar?.compressedSlots?.includes('map') &&
        avatar?.compressedSlots?.includes('shadeMultiplyTexture'),
      `${backend} (compressed): compressedSlots が不足: ${JSON.stringify(avatar?.compressedSlots)}`,
    );
    assert(
      avatar?.atlasBytes > 0 && avatar?.atlasBytes < 8 * 1048576,
      `${backend} (compressed): atlasBytes が圧縮サイズ想定外: ${avatar?.atlasBytes}`,
    );

    const slotCompressed = await page.evaluate(() =>
      window.__vrmDemo.variantSlotCompressed(0, 'map'),
    );
    assert(
      slotCompressed.length > 0 &&
        slotCompressed.every((setFlags) => setFlags.every((flag) => flag === true)),
      `${backend} (compressed): map が全セット全レベルで圧縮テクスチャでない: ${JSON.stringify(slotCompressed)}`,
    );

    const mapWidths = await page.evaluate(() => window.__vrmDemo.variantTextureWidths(0));
    const normalWidths = await page.evaluate(() =>
      window.__vrmDemo.variantSlotWidths(0, 'normalMap'),
    );
    const mapMips = await page.evaluate(() => window.__vrmDemo.variantSlotMipCounts(0, 'map'));
    for (const setWidths of mapWidths) {
      assert(
        JSON.stringify(setWidths) === JSON.stringify([1024, 1024, 1024, 512, 256]),
        `${backend} (compressed): map 幅が想定外: ${JSON.stringify(setWidths)}`,
      );
    }
    for (const setWidths of normalWidths) {
      assert(
        JSON.stringify(setWidths) === JSON.stringify([512, 512, 512, 512, 256]),
        `${backend} (compressed): normalMap 幅が想定外: ${JSON.stringify(setWidths)}`,
      );
    }
    for (const setMips of mapMips) {
      assert(
        JSON.stringify(setMips) === JSON.stringify([11, 11, 11, 10, 9]),
        `${backend} (compressed): map ミップ数が想定外: ${JSON.stringify(setMips)}`,
      );
    }

    // evictDelay=0 で L0 → L3 → L4 → L0 の解放・輝度復帰とパイプライン非増加を検証する。
    await page.evaluate(() =>
      window.__vrmDemo.setSettings({ residency: 'evict', evictDelayMs: 0, forceLevel: null }),
    );
    await setDistance(page, 2.5);
    const nearStats = await statsOf(page);
    const nearBrightness = await screenshot(page, `${backend}-compressed-near.png`);

    await setDistance(page, 20);
    await sleep(600);
    const farStats = await statsOf(page);

    await setDistance(page, 30);
    await sleep(400);
    const veryFarStats = await statsOf(page);

    await setDistance(page, 2.5);
    await sleep(500);
    const recoveredStats = await statsOf(page);
    const recoveredBrightness = await screenshot(page, `${backend}-compressed-recovered.png`);

    // 往復してパイプラインが増えないことを確認する。
    for (const d of [30, 2.5, 30, 2.5]) {
      await setDistance(page, d);
    }
    const pipelineAfter = await statsOf(page);

    result.compressed = {
      atlasBytes: avatar.atlasBytes,
      compressedSlots: avatar.compressedSlots,
      mapWidths,
      normalWidths,
      mapMips,
      nearResident: nearStats.manager.residentBytes,
      farResident: farStats.manager.residentBytes,
      veryFarResident: veryFarStats.manager.residentBytes,
      nearBrightness,
      recoveredBrightness,
      pipelines: {
        before: { caches: nearStats.pipelineCaches, fragment: nearStats.fragmentPrograms },
        after: { caches: pipelineAfter.pipelineCaches, fragment: pipelineAfter.fragmentPrograms },
      },
    };

    assert(nearStats.avatars[0]?.level === 0, `${backend} (compressed): 近景で L0 でない`);
    assert(farStats.avatars[0]?.level === 3, `${backend} (compressed): 20m で L3 でない`);
    assert(veryFarStats.avatars[0]?.level === 4, `${backend} (compressed): 30m で L4 でない`);
    assert(
      farStats.manager.residentBytes < nearStats.manager.residentBytes / 2,
      `${backend} (compressed): evict で residentBytes が半分未満にならない: ${nearStats.manager.residentBytes} → ${farStats.manager.residentBytes}`,
    );
    assert(
      farStats.manager.evictCount > nearStats.manager.evictCount,
      `${backend} (compressed): evictCount が増えていない`,
    );
    assert(
      veryFarStats.manager.residentBytes < farStats.manager.residentBytes,
      `${backend} (compressed): L4 で residentBytes がさらに減っていない: ${farStats.manager.residentBytes} → ${veryFarStats.manager.residentBytes}`,
    );
    assert(nearBrightness > 20, `${backend} (compressed): 近景輝度が低すぎる: ${nearBrightness}`);
    assert(
      Math.abs(recoveredBrightness / nearBrightness - 1) < 0.1,
      `${backend} (compressed): 復帰後の輝度比が 10% 超: near=${nearBrightness}, recovered=${recoveredBrightness}`,
    );
    assert(
      recoveredStats.avatars[0]?.level === 0,
      `${backend} (compressed): 復帰後に L0 へ戻っていない`,
    );
    assert(
      pipelineAfter.pipelineCaches <= nearStats.pipelineCaches &&
        pipelineAfter.fragmentPrograms <= nearStats.fragmentPrograms,
      `${backend} (compressed): パイプラインが増えた: ${nearStats.pipelineCaches}/${nearStats.fragmentPrograms} → ${pipelineAfter.pipelineCaches}/${pipelineAfter.fragmentPrograms}`,
    );

    const consoleErrors = messages.filter(
      (message) => message.startsWith('pageerror:') || message.startsWith('error:'),
    );
    const noise = messages.filter((message) =>
      /Too many active WebGL contexts|WebGPU|destroyed|THREE\./i.test(message),
    );
    result.consoleErrors = consoleErrors;
    result.webgpuNoise = noise;
    assert(consoleErrors.length === 0, `${backend} (compressed): コンソールエラー ${consoleErrors.join(' | ')}`);
    assert(noise.length === 0, `${backend} (compressed): GPU関連の警告 ${noise.join(' | ')}`);
    result.ok = failures.length === 0;
  } catch (error) {
    result.error = String(error?.stack ?? error);
    assert(false, `${backend} (compressed): 例外: ${String(error)}`);
  } finally {
    result.messages = messages.slice(-40);
    await page.close();
  }
  return result;
}

async function main() {
  const missingModels = MODEL_PATHS.flatMap(({ public: publicPath, dist }) =>
    [publicPath, dist].filter((path) => !existsSync(path)),
  );
  if (missingModels.length > 0) {
    console.error(
      `サンプルモデルまたはビルド成果物がありません:\n  ${missingModels.join('\n  ')}\n` +
        '`pnpm models:fetch` の後に `pnpm build` を実行してください。',
    );
    process.exit(1);
  }
  if (!existsSync(DIST_HTML)) {
    console.error(`ビルド成果物がありません: ${DIST_HTML}\n先に \`pnpm build\` を実行してください。`);
    process.exit(1);
  }
  await mkdir(ARTIFACTS_DIR, { recursive: true });

  const preview = spawn(
    'pnpm',
    ['exec', 'vite', 'preview', '--port', String(PORT), '--strictPort'],
    { cwd: ROOT, stdio: 'ignore', detached: true },
  );

  try {
    for (let i = 0; i < 100; i++) {
      try {
        const response = await fetch(`${BASE_URL}/vrm.html`);
        if (response.ok) break;
      } catch {
        // 起動待ち
      }
      await sleep(100);
    }

    // 検証ごとに状態を分離するため、1体・既定・複製・4ソース・budget・adaptive・crowd・tierCap は
    // それぞれ新しい Chrome で実行する（0.6.0 の共有レンダラーでコンテキスト数はソース数に比例しない）。
    // WebGLのみ `--use-angle=vulkan` を付ける。WebGPUと併用すると Device Lost になるため分けている。
    // 素の `--ignore-gpu-blocklist` だけでは WebGL が SwiftShader になり、100体で数秒/フレームまで落ちる。
    const launchBrowser = (backend) =>
      chromium.launch({
        executablePath: CHROME_PATH,
        headless: false,
        args:
          backend === 'webgl'
            ? ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--no-sandbox', '--use-angle=vulkan']
            : ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--no-sandbox'],
      });

    const results = [];
    for (const backend of ['webgpu', 'webgl']) {
      const singleBrowser = await launchBrowser(backend);
      let single;
      try {
        single = await checkBackend(singleBrowser, backend);
      } finally {
        await singleBrowser.close();
      }

      const defaultBrowser = await launchBrowser(backend);
      let defaultPage;
      try {
        defaultPage = await checkInstances(defaultBrowser, backend, {
          query: 'auto=0',
          expectedSource: 3,
          expectedClone: 1,
          slug: 'default',
        });
      } finally {
        await defaultBrowser.close();
      }

      const clonesBrowser = await launchBrowser(backend);
      let clones;
      try {
        clones = await checkInstances(clonesBrowser, backend, {
          query: 'models=A&avatars=4&auto=0',
          expectedSource: 1,
          expectedClone: 3,
          slug: 'clones',
        });
      } finally {
        await clonesBrowser.close();
      }

      // 0.6.0 の共有レンダラーにより、WebGL でも4ソースを検証する。
      const fourBrowser = await launchBrowser(backend);
      let fourSources;
      try {
        fourSources = await checkFourSources(fourBrowser, backend);
      } finally {
        await fourBrowser.close();
      }

      const budgetBrowser = await launchBrowser(backend);
      let budget;
      try {
        budget = await checkBudget(budgetBrowser, backend);
      } finally {
        await budgetBrowser.close();
      }

      const adaptiveBrowser = await launchBrowser(backend);
      let adaptive;
      try {
        adaptive = await checkAdaptiveBudget(adaptiveBrowser, backend);
      } finally {
        await adaptiveBrowser.close();
      }

      const crowdBrowser = await launchBrowser(backend);
      let crowd;
      try {
        crowd = await checkCrowd(crowdBrowser, backend);
      } finally {
        await crowdBrowser.close();
      }

      // Tier上限の検査はcheckBackendとは別のChromeで行う。
      // 4096のフル検査は重いためWebGPUのみ、WebGLは軽い `?atlas=1024&top=1024` だけ行う。
      // WebGLの軽い検査は1体のみのため、vulkanフラグなしでも十分速い。
      // `--use-angle=vulkan` とWebGPU初期化がVulkanデバイスを取り合う一過性の
      // Device Lost を避けるため、フラグを外して起動する。
      let tierCap = null;
      {
        const tierCapBrowser =
          backend === 'webgl'
            ? await chromium.launch({
                executablePath: CHROME_PATH,
                headless: false,
                args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--no-sandbox'],
              })
            : await launchBrowser(backend);
        try {
          tierCap = await checkTierCap(tierCapBrowser, backend);
        } finally {
          await tierCapBrowser.close();
        }
      }

      const spillBrowser = await launchBrowser(backend);
      let spill;
      try {
        spill = await checkSpill(spillBrowser, backend);
      } finally {
        await spillBrowser.close();
      }

      single.fourSources = fourSources;
      single.default = defaultPage;
      single.clones = clones;
      single.budget = budget;
      single.adaptive = adaptive;
      single.crowd = crowd;
      single.tierCap = tierCap;
      single.spill = spill;

      const compressedBrowser = await launchBrowser(backend);
      let compressed;
      try {
        compressed = await checkCompressed(compressedBrowser, backend);
      } finally {
        await compressedBrowser.close();
      }
      single.compressed = compressed;
      single.ok = failures.length === 0;
      results.push(single);
    }

    const ok = failures.length === 0;
    console.log(JSON.stringify({ ok, failures, results }, null, 2));
    if (!ok) process.exitCode = 1;
  } finally {
    // pnpm の子プロセス（vite）も残らないよう、プロセスグループごと終了する。
    if (preview.pid) {
      try {
        process.kill(-preview.pid, 'SIGTERM');
      } catch {
        preview.kill('SIGTERM');
      }
    }
    await Promise.race([
      new Promise((resolveExit) => preview.on('exit', resolveExit)),
      sleep(2000),
    ]);
  }
}

await main();
