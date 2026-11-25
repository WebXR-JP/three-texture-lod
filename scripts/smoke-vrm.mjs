// VRMデモのE2Eスモーク。WebGPU / WebGL2 の両バックエンドで検証する。
//
// 前提:
// - `pnpm models:fetch` で public/models/AvatarSample_A.vrm を取得済み
// - `pnpm build` 済み（public/models が dist/demo にコピーされる）
// Chrome は headed で起動する（headless では WebGPU の adapter が取れないため）。
// 表示できない環境では `xvfb-run -a pnpm smoke:vrm` のように Xvfb 経由で実行する。
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
  // surface 距離と4段（T=[0,3,6,12]）、h=0.15 の系列。
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
  ];
  const actual = [];
  for (const [distance, expected] of series) {
    await setDistance(page, distance);
    const level = await levelOf(page);
    const meshLevels = await page.evaluate(() => window.__vrmDemo.meshLevels(0));
    actual.push({ distance, expected, actual: level, meshLevels });
    assert(
      level === expected,
      `ヒステリシス系列: d=${distance} の期待 L${expected} に対して L${level}`,
    );
    assert(
      meshLevels.every((value) => value === level),
      `d=${distance} でメッシュ間のレベルが不一致: ${JSON.stringify(meshLevels)}`,
    );
  }
  const holds = [
    { from: 1.5, at: 3.2, expected: 0 },
    { from: 4.0, at: 6.5, expected: 1 },
    { from: 9.0, at: 12.5, expected: 2 },
  ];
  const held = [];
  for (const item of holds) {
    await setDistance(page, item.from);
    await setDistance(page, item.at);
    const level = await levelOf(page);
    const meshLevels = await page.evaluate(() => window.__vrmDemo.meshLevels(0));
    held.push({ ...item, actual: level, meshLevels });
    assert(
      level === item.expected,
      `上側バンド保持: d=${item.at} の期待 L${item.expected} に対して L${level}`,
    );
    assert(
      meshLevels.every((value) => value === level),
      `上側バンド保持 d=${item.at} でメッシュ間のレベルが不一致: ${JSON.stringify(meshLevels)}`,
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

  // デバッグ用のレベル固定と、auto への復帰。
  await page.evaluate(() => window.__vrmDemo.setSettings({ forceLevel: 3 }));
  await waitFrames(page, 3);
  const forced = await page.evaluate(() => window.__vrmDemo.meshLevels(0));
  assert(forced.length > 0 && forced.every((level) => level === 3), `forceLevel=3 が全メッシュに効いていない: ${forced}`);
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
    near: { level: nearStats.avatars[0]?.level, resident: nearStats.manager.residentBytes, brightness: near },
    far: { level: farStats.avatars[0]?.level, resident: farStats.manager.residentBytes, brightness: far },
    recovered: {
      level: recoveredStats.avatars[0]?.level,
      resident: recoveredStats.manager.residentBytes,
      brightness: recovered,
    },
    textureCount: { near: nearStats.textureCount, far: farStats.textureCount, recovered: recoveredStats.textureCount },
  };
  assert(nearStats.avatars[0]?.level === 0, '近景で L0 になっていない');
  assert(farStats.avatars[0]?.level === 3, '遠景で L3 になっていない');
  assert(
    farStats.manager.residentBytes < nearStats.manager.residentBytes / 2,
    `evict で residentBytes が半分未満にならない: near=${nearStats.manager.residentBytes}, far=${farStats.manager.residentBytes}`,
  );
  // 推定値だけでなく、three が保持するテクスチャ数でも解放を確認する。
  assert(
    farStats.textureCount < nearStats.textureCount,
    `evict 後も GPU テクスチャ数が減らない: near=${nearStats.textureCount}, far=${farStats.textureCount}`,
  );
  assert(near > 20, `近景の輝度が低すぎる: ${near}`);
  assert(
    Math.abs(recovered / near - 1) < 0.1,
    `evict 復帰後の輝度比が 10% を超えた: near=${near}, recovered=${recovered}`,
  );
  assert(recoveredStats.avatars[0]?.level === 0, '復帰後に L0 へ戻っていない');
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
      `${BASE_URL}/vrm.html?models=A,B,C,A&avatars=4&auto=0${backend === 'webgl' ? '&backend=webgl' : ''}`,
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
      JSON.stringify(stats.manager.levelCounts) === JSON.stringify([1, 1, 1, 1]),
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
    assert(
      stats.manager.residentBytes < fullAtlas * 0.5,
      `${backend} (4体): 常駐量が全アトラスの半分未満にならない: ${stats.manager.residentBytes} / ${fullAtlas}`,
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
      `${BASE_URL}/vrm.html?${query}${backend === 'webgl' ? '&backend=webgl' : ''}`,
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
      JSON.stringify(stats.manager.levelCounts) === JSON.stringify([1, 1, 1, 1]),
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
    // resident は複数レベル分で full を超えうるため、1.5倍未満で見る。
    const fullAtlas = stats.avatars.reduce((sum, avatar) => sum + avatar.atlasBytes, 0);
    result.resident = stats.manager.residentBytes;
    result.fullAtlas = fullAtlas;
    assert(
      stats.manager.residentBytes < fullAtlas * 1.5,
      `${backend} (${slug}): 常駐量が全アトラスの1.5倍未満にならない: ${stats.manager.residentBytes} / ${fullAtlas}`,
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
    const head0 = await page.evaluate((i) => window.__vrmDemo.cloneHeadQuaternion(i), cloneIndex);
    const inSkeleton = await page.evaluate((i) => window.__vrmDemo.cloneHeadInSkeleton(i), cloneIndex);
    await sleep(450);
    const head1 = await page.evaluate((i) => window.__vrmDemo.cloneHeadQuaternion(i), cloneIndex);
    assert(
      Array.isArray(head0) && Array.isArray(head1),
      `${backend} (${slug}): 頭ボーン quaternion が取れない: ${JSON.stringify(head0)} / ${JSON.stringify(head1)}`,
    );
    const dot =
      head0[0] * head1[0] + head0[1] * head1[1] + head0[2] * head1[2] + head0[3] * head1[3];
    const angle = 2 * Math.acos(Math.min(1, Math.abs(dot)));
    assert(inSkeleton === true, `${backend} (${slug}): raw 頭ボーンが SkinnedMesh の skeleton に無い`);
    assert(angle > 1e-3, `${backend} (${slug}): 頭ボーンの回転差が小さすぎる: ${angle}`);
    result.headMotion = { before: head0, after: head1, angle, inSkeleton };

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
      `${BASE_URL}/vrm.html?models=A&avatars=1&auto=0&h=0.15${backend === 'webgl' ? '&backend=webgl' : ''}`,
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
    const expectedWidths = [1024, 512, 256, 128];
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

    // 4ソース・複製は最適化時の一時WebGLRendererが多く、直前のページのコンテキストと合わせると
    // 上限に達することがある。1体・4ソース・複製はそれぞれ新しいChromeで検証する。
    const launchBrowser = () =>
      chromium.launch({
        executablePath: CHROME_PATH,
        headless: false,
        args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--no-sandbox'],
      });

    const results = [];
    for (const backend of ['webgpu', 'webgl']) {
      const singleBrowser = await launchBrowser();
      let single;
      try {
        single = await checkBackend(singleBrowser, backend);
      } finally {
        await singleBrowser.close();
      }

      const defaultBrowser = await launchBrowser();
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

      const clonesBrowser = await launchBrowser();
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

      // 4ソースは最適化時の一時WebGLRendererが36個分になり、WebGLでは
      // コンテキスト上限に触れて Device Lost することがある（既知の制約）。
      // 4ソースの最適化・マテリアル統合はWebGPUで検証し、WebGLは既定の3ソース+複製で見る。
      let fourSources;
      if (backend === 'webgpu') {
        const fourBrowser = await launchBrowser();
        try {
          fourSources = await checkFourSources(fourBrowser, backend);
        } finally {
          await fourBrowser.close();
        }
      } else {
        fourSources = {
          backend,
          ok: true,
          skipped: '4-source optimization exceeds the WebGL context budget; verified on WebGPU',
        };
      }

      single.fourSources = fourSources;
      single.default = defaultPage;
      single.clones = clones;
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
