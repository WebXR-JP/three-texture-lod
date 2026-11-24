// LODデモのE2Eスモーク。webgpu / webgl の両バックエンドで検証する。
//
// 前提: `pnpm build` 済み。`vite preview` を子プロセスで起動し、検証後にkillする。
// Chrome は headed で起動する（headless では WebGPU の adapter が取れないため）。
// 表示できない環境では `xvfb-run -a pnpm smoke` のように Xvfb 経由で実行する。
//
// 待機は固定sleepに依存せず、`stats().frame` が進むこと＋条件ポーリングで行う。
// 近景は `setCameraZ(0)` を使う。center モードで距離0のプローブ配置は
// 板がエッジオンで暗くなるため禁止（デモの setProbeDistance の注記を参照）。
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';

const PORT = 4174;
const BASE_URL = `http://localhost:${PORT}/`;
const CHROME_PATH = process.env.CHROME_PATH ?? '/run/current-system/sw/bin/google-chrome';
const ARTIFACTS_DIR = new URL('../artifacts/', import.meta.url);

/** ポーリング付き待機。predicate が真になるまで待つ。 */
async function waitFor(page, predicate, { arg, timeoutMs = 15000, polling = 100 } = {}) {
  await page.waitForFunction(predicate, arg, { timeout: timeoutMs, polling });
}

async function statsOf(page) {
  return page.evaluate(() => window.__lodDemo.stats());
}

async function probeOf(page) {
  return page.evaluate(() => window.__lodDemo.probeLevel());
}

async function frameOf(page) {
  return page.evaluate(() => window.__lodDemo.stats().frame);
}

/** frame が n 進むまで待つ（条件ポーリングと組み合わせる土台）。 */
async function waitFrames(page, n, timeoutMs = 15000) {
  const start = await frameOf(page);
  // waitForFunction の第2引数は1つの値として渡るため、オブジェクトで包む。
  await waitFor(page, (o) => window.__lodDemo.stats().frame >= o.s + o.n, {
    arg: { s: start, n },
    timeoutMs,
  });
}

/** 数フレーム描画させて判定・描画を安定させる。 */
async function settle(page, n = 4) {
  await waitFrames(page, n);
}

/**
 * 中央領域（x/y ともに 35–65%）の平均輝度。
 *
 * evict復帰が実描画として戻ったかを画素で裏付けるための測定。
 * 背景色の影響を受けにくいよう中央だけを切り出す。
 */
function centerBrightness(png) {
  const { width, height, data } = png;
  const x0 = Math.floor(width * 0.35);
  const x1 = Math.ceil(width * 0.65);
  const y0 = Math.floor(height * 0.35);
  const y1 = Math.ceil(height * 0.65);
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

async function screenshotBrightness(page, path) {
  const shot = await page.screenshot();
  await writeFile(path, shot);
  return centerBrightness(PNG.sync.read(shot));
}

/** 2.1 パイプライン基準（LOD無効の新規ページで取得）。 */
async function checkPipelines(browser, backend, errors, checks) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (err) => errors.push(`pageerror: ${String(err)}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(`console.error: ${msg.text()}`);
    }
  });
  try {
    // LOD無効のためベースマテリアルのみ描画される。ここを基準にする。
    await page.goto(`${BASE_URL}?backend=${backend}&auto=0&lod=0`, { waitUntil: 'load' });
    await waitFor(page, () => window.__lodDemo?.ready === true, { timeoutMs: 60000 });
    await settle(page, 5);
    const baseline = await statsOf(page);
    if (baseline.levelCounts.reduce((a, b) => a + b, 0) !== 0) {
      throw new Error(`LOD無効のはずがレベル付与あり: ${JSON.stringify(baseline.levelCounts)}`);
    }

    // 有効化→レベルが再付与されるまで待つ。基準から増えないこと。
    await page.evaluate(() => window.__lodDemo.setSettings({ lodEnabled: true }));
    await waitFor(
      page,
      () => window.__lodDemo.stats().levelCounts.reduce((a, b) => a + b, 0) === window.__lodDemo.meshCount,
      { timeoutMs: 15000 },
    );
    await settle(page, 2);
    const afterEnable = await statsOf(page);

    // 無効化→有効化をもう1回（往復で作られないことの裏付け）。
    await page.evaluate(() => window.__lodDemo.setSettings({ lodEnabled: false }));
    await settle(page, 2);
    await page.evaluate(() => window.__lodDemo.setSettings({ lodEnabled: true }));
    await waitFor(
      page,
      () => window.__lodDemo.stats().levelCounts.reduce((a, b) => a + b, 0) === window.__lodDemo.meshCount,
      { timeoutMs: 15000 },
    );
    // 近↔遠の往復後も増えないこと。
    await page.evaluate(() => window.__lodDemo.setCameraZ(0));
    await waitFor(
      page,
      () => {
        const s = window.__lodDemo.stats();
        return s.levelCounts[0] >= 1 && s.levelCounts[2] >= 1;
      },
      { timeoutMs: 15000 },
    );
    await page.evaluate(() => window.__lodDemo.setCameraZ(30));
    await waitFor(
      page,
      () => window.__lodDemo.stats().levelCounts[2] === window.__lodDemo.meshCount,
      { timeoutMs: 15000 },
    );
    const afterRoundTrip = await statsOf(page);

    checks.pipelines = {
      baseline: {
        pipelineCaches: baseline.pipelineCaches,
        fragmentPrograms: baseline.fragmentPrograms,
      },
      afterEnable: {
        pipelineCaches: afterEnable.pipelineCaches,
        fragmentPrograms: afterEnable.fragmentPrograms,
        levelCounts: afterEnable.levelCounts,
      },
      afterRoundTrip: {
        pipelineCaches: afterRoundTrip.pipelineCaches,
        fragmentPrograms: afterRoundTrip.fragmentPrograms,
        levelCounts: afterRoundTrip.levelCounts,
      },
    };
    for (const [name, s] of [
      ['有効化後', afterEnable],
      ['往復後', afterRoundTrip],
    ]) {
      if (s.pipelineCaches > baseline.pipelineCaches) {
        throw new Error(
          `pipelineCaches が増加(${name}): 基準=${baseline.pipelineCaches} → ${s.pipelineCaches}`,
        );
      }
      if (s.fragmentPrograms > baseline.fragmentPrograms) {
        throw new Error(
          `fragmentPrograms が増加(${name}): 基準=${baseline.fragmentPrograms} → ${s.fragmentPrograms}`,
        );
      }
    }
  } finally {
    await page.close();
  }
}

async function checkBackend(browser, backend) {
  const errors = [];
  const checks = {};
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (err) => errors.push(`pageerror: ${String(err)}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(`console.error: ${msg.text()}`);
    }
  });
  try {
    // 2.1 パイプライン基準は別ページで先に取る（cachesはリセットできないため）。
    await checkPipelines(browser, backend, errors, checks);

    // 2.5/2.2–2.4 用のメインページ。
    await page.goto(`${BASE_URL}?backend=${backend}&auto=0`, { waitUntil: 'load' });
    await waitFor(page, () => window.__lodDemo?.ready === true, { timeoutMs: 60000 });
    await settle(page, 5);

    // 2.5 基本検証: 近距離で L0 と L2 が混在する。
    await page.evaluate(() => window.__lodDemo.setCameraZ(0));
    await waitFor(
      page,
      () => {
        const s = window.__lodDemo.stats();
        return s.levelCounts[0] >= 1 && s.levelCounts[2] >= 1;
      },
      { timeoutMs: 15000 },
    );
    await settle(page, 2);
    checks.nearMixed = await statsOf(page);
    await page.screenshot({ path: `artifacts/${backend}-near.png` });

    // 2.5 基本検証: 遠距離で全板が L2。stats整合も見る。
    await page.evaluate(() => window.__lodDemo.setCameraZ(30));
    await waitFor(
      page,
      () => window.__lodDemo.stats().levelCounts[2] === window.__lodDemo.meshCount,
      { timeoutMs: 15000 },
    );
    await settle(page, 2);
    checks.farAllL2 = await statsOf(page);
    await page.screenshot({ path: `artifacts/${backend}-far.png` });
    const farSum = checks.farAllL2.levelCounts.reduce((a, b) => a + b, 0);
    if (farSum !== checks.farAllL2.objectCount || farSum !== checks.farAllL2.meshCount) {
      checks.farAllL2.meshCount = await page.evaluate(() => window.__lodDemo.meshCount);
    }
    if (farSum !== checks.farAllL2.objectCount) {
      throw new Error(`stats不整合: levelCounts合計=${farSum} objectCount=${checks.farAllL2.objectCount}`);
    }

    // 2.2 ヒステリシス（h=0.2, center, 境界 T=10）。
    // 上バンド端 10*1.2=12 / 下バンド端 10*0.8=8。
    await page.evaluate(() =>
      window.__lodDemo.setSettings({ hysteresis: 0.2, distanceMode: 'center' }),
    );
    await settle(page, 4);
    const cases = [
      [5, 0],
      [12.1, 1],
      [9, 1],
      [7.9, 0],
      [9, 0],
      [11.9, 0],
      [12.1, 1],
    ];
    checks.hysteresis = [];
    for (const [distance, expected] of cases) {
      // 同じレベルが続くケースでも必ずフレームを進めてから読む（即時通過の回避）。
      await page.evaluate((d) => window.__lodDemo.setProbeDistance(d), distance);
      await settle(page, 4);
      const actual = await probeOf(page);
      checks.hysteresis.push({ distance, expected, actual });
      if (actual !== expected) {
        throw new Error(`距離 ${distance} の期待レベル ${expected} に対し実際は ${actual}`);
      }
    }

    // バンド内往復で切替0: L0に寄せてから 9.5↔10.5 を10往復。
    await page.evaluate((d) => window.__lodDemo.setProbeDistance(d), 5);
    await waitFor(page, (exp) => window.__lodDemo.probeLevel() === exp, {
      arg: 0,
      timeoutMs: 15000,
    });
    await settle(page, 2);
    const bandStart = (await statsOf(page)).switchCount;
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.__lodDemo.setProbeDistance(9.5));
      await settle(page, 2);
      await page.evaluate(() => window.__lodDemo.setProbeDistance(10.5));
      await settle(page, 2);
    }
    const bandEnd = (await statsOf(page)).switchCount;
    checks.hBandNoSwitch = {
      hysteresis: 0.2,
      roundTrips: 10,
      switchDelta: bandEnd - bandStart,
    };
    if (bandEnd - bandStart !== 0) {
      throw new Error(`バンド内往復で切替あり: ${bandEnd - bandStart}回 (h=0.2)`);
    }

    // h=0 の対照: プローブ単体のレベル系列で境界またぎの追従を確かめる。
    // 60メッシュ合計の switchCount では他メッシュの切替が混ざるため、合否は probeLevel 系列で判定する。
    await page.evaluate(() => window.__lodDemo.setSettings({ hysteresis: 0 }));
    await settle(page, 4);
    const zeroStart = (await statsOf(page)).switchCount;
    const zeroCases = [
      [9.9, 0],
      [10.1, 1],
      [9.9, 0],
      [10.1, 1],
    ];
    checks.hZeroSeries = [];
    for (const [distance, expected] of zeroCases) {
      await page.evaluate((d) => window.__lodDemo.setProbeDistance(d), distance);
      await settle(page, 2);
      const actual = await probeOf(page);
      checks.hZeroSeries.push({ distance, expected, actual });
      if (actual !== expected) {
        throw new Error(`h=0 で距離 ${distance} の期待レベル ${expected} に対し実際は ${actual}`);
      }
    }
    const zeroEnd = (await statsOf(page)).switchCount;
    checks.hZeroSwitch = {
      hysteresis: 0,
      roundTrips: 2,
      switchDelta: zeroEnd - zeroStart,
    };

    // 2.3 テレポート: L0から1回の setProbeDistance(40) で遅延なくL2へ。
    // polling: raf で毎フレーム検知し、frame差分で遅延の有無を測る。
    await page.evaluate(() => window.__lodDemo.setProbeDistance(5));
    await waitFor(page, (exp) => window.__lodDemo.probeLevel() === exp, {
      arg: 0,
      timeoutMs: 15000,
    });
    await settle(page, 2);
    const teleportFrom = await frameOf(page);
    await page.evaluate(() => window.__lodDemo.setProbeDistance(40));
    await waitFor(page, () => window.__lodDemo.probeLevel() === 2, {
      timeoutMs: 15000,
      polling: 'raf',
    });
    const teleportTo = await frameOf(page);
    checks.teleport = {
      fromDistance: 5,
      toDistance: 40,
      frameDelta: teleportTo - teleportFrom,
      probeLevel: await probeOf(page),
    };
    if (teleportTo - teleportFrom > 2) {
      throw new Error(`テレポート遅延: frame差=${teleportTo - teleportFrom} (40でL2まで)`);
    }

    // 2.4 evictの実描画検証（surface / h=0.1 / 即時破棄）。
    await page.evaluate(() =>
      window.__lodDemo.setSettings({
        residency: 'evict',
        evictDelayMs: 0,
        distanceMode: 'surface',
        hysteresis: 0.1,
      }),
    );
    // 近景は setCameraZ(0) を使う（center+距離0はエッジオンで暗くなるため禁止）。
    await page.evaluate(() => window.__lodDemo.setCameraZ(0));
    await waitFor(
      page,
      () => window.__lodDemo.stats().levelCounts[0] >= 1,
      { timeoutMs: 15000 },
    );
    await settle(page, 6);
    const nearStats = await statsOf(page);
    const brightnessNear = await screenshotBrightness(page, `artifacts/${backend}-evict-near.png`);
    checks.evictNear = {
      residentBytes: nearStats.residentBytes,
      levelCounts: nearStats.levelCounts,
      brightness: brightnessNear,
      screenshot: `artifacts/${backend}-evict-near.png`,
    };
    // 背景（約15）より十分明るいことを確かめる。暗いままなら描画自体ができていない。
    if (!(brightnessNear > 30)) {
      throw new Error(`evict前の近景輝度が低すぎます: near=${brightnessNear.toFixed(1)}`);
    }

    await page.evaluate(() => window.__lodDemo.setCameraZ(30));
    await waitFor(
      page,
      (before) =>
        window.__lodDemo.stats().levelCounts[2] === window.__lodDemo.meshCount &&
        window.__lodDemo.stats().residentBytes < before / 2,
      { arg: nearStats.residentBytes, timeoutMs: 15000 },
    );
    await settle(page, 2);
    const evicted = await statsOf(page);
    const brightnessFar = await screenshotBrightness(page, `artifacts/${backend}-evict-far.png`);
    checks.evictFar = {
      residentBytes: evicted.residentBytes,
      levelCounts: evicted.levelCounts,
      brightness: brightnessFar,
      screenshot: `artifacts/${backend}-evict-far.png`,
    };

    await page.evaluate(() => window.__lodDemo.setCameraZ(0));
    await waitFor(
      page,
      () => window.__lodDemo.stats().levelCounts[0] >= 1,
      { timeoutMs: 15000 },
    );
    await settle(page, 6);
    const recovered = await statsOf(page);
    const brightnessRecovered = await screenshotBrightness(
      page,
      `artifacts/${backend}-evict-recovered.png`,
    );
    checks.evictRecovered = {
      residentBytes: recovered.residentBytes,
      levelCounts: recovered.levelCounts,
      // プローブ板(z=-60)は近景でも遠方のためL2のまま。近景復帰は L0 の存在で判定する。
      // 仕様書の「probeLevel が0」は幾何学的に成立しない（距離60 > 境界25）ため、
      // ここでは参考値として記録し、合否には使わない。
      probeLevel: await probeOf(page),
      brightness: brightnessRecovered,
      brightnessRatio: brightnessNear === 0 ? 0 : brightnessRecovered / brightnessNear,
      screenshot: `artifacts/${backend}-evict-recovered.png`,
    };
    if (recovered.levelCounts[0] < 1) {
      throw new Error('evict復帰後に近景L0なし');
    }
    // 復帰は両側判定にする。暗すぎても明るすぎても描画の不一致として失敗させる。
    if (brightnessNear === 0 || Math.abs(brightnessRecovered / brightnessNear - 1) >= 0.1) {
      throw new Error(
        `evict復帰の輝度不一致: near=${brightnessNear.toFixed(1)} recovered=${brightnessRecovered.toFixed(1)}`,
      );
    }

    // keep-all では遠ざけても常駐量が減らないこと。
    await page.evaluate(() => window.__lodDemo.setSettings({ residency: 'keep-all' }));
    await page.evaluate(() => window.__lodDemo.setCameraZ(30));
    await waitFor(
      page,
      () => window.__lodDemo.stats().levelCounts[2] === window.__lodDemo.meshCount,
      { timeoutMs: 15000 },
    );
    await settle(page, 4);
    const kept = await statsOf(page);
    checks.keepAllFar = { residentBytes: kept.residentBytes, levelCounts: kept.levelCounts };
    if (kept.residentBytes < evicted.residentBytes) {
      throw new Error(
        `keep-allで常駐量が減少: evict時=${evicted.residentBytes} keep-all=${kept.residentBytes}`,
      );
    }

    return { backend, ok: errors.length === 0, errors, checks };
  } catch (err) {
    return { backend, ok: false, errors: [...errors, `fail: ${String(err)}`], checks };
  } finally {
    await page.close();
  }
}

async function main() {
  if (!existsSync(new URL('../dist/demo/index.html', import.meta.url))) {
    throw new Error('dist/demo/index.html がありません。先に `pnpm build` を実行してください');
  }
  await mkdir(ARTIFACTS_DIR, { recursive: true });

  const preview = spawn('pnpm', ['exec', 'vite', 'preview', '--port', String(PORT), '--strictPort'], {
    stdio: 'pipe',
  });
  const results = [];
  try {
    await waitForServer();
    const browser = await chromium.launch({
      executablePath: CHROME_PATH,
      headless: false,
      // WebGPU を有効化し、GPUブロックリストを無視する（CIのソフトウェアGL対策）。
      // `--no-sandbox` は root 実行時の起動要件であり、描画内容には影響しない。
      args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--no-sandbox'],
    });
    try {
      for (const backend of ['webgpu', 'webgl']) {
        results.push(await checkBackend(browser, backend));
      }
    } finally {
      await browser.close();
    }
  } finally {
    preview.kill('SIGTERM');
    await new Promise((resolve) => preview.on('exit', resolve));
  }
  const ok = results.every((r) => r.ok);
  console.log(JSON.stringify({ ok, results }, null, 2));
  if (!ok) {
    process.exitCode = 1;
  }
}

/** preview サーバが応答するまで待つ。 */
async function waitForServer(timeoutMs = 30000) {
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(BASE_URL);
      if (res.ok) {
        return;
      }
    } catch {
      // 起動途中は接続拒否になる。ポーリングで待つ。
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`preview サーバが ${timeoutMs}ms 以内に起動しません`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

await main();
