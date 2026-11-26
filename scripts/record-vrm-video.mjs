// VRMデモで「メモリ予算に応じて選択 LOD が変わる様子」を紹介動画として録画する。
//
// 前提:
// - `pnpm models:fetch` と `pnpm build` 済み
// - ffmpeg が PATH にある（`FFMPEG_PATH` で上書き可）
// - 実ディスプレイ上で実行する（Xvfb では WebGPU が SwiftShader になり、紹介に使えるフレームレートが出ない）
//
// 出力: artifacts/video/vrm-budget-lod.mp4（1920x1080, 30fps, H.264）
//
// 録画は CDP の Page.startScreencast で行う。Playwright の recordVideo は VP8 の固定低ビットレートで
// テクスチャの粗さの差が潰れるため、JPEG フレームを受け取り ffmpeg で可変間隔から 30fps に変換する。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
// スモーク（4176）と同時に走らせても衝突しないポート
const PORT = 4177;
const CHROME_PATH = process.env.CHROME_PATH ?? '/run/current-system/sw/bin/google-chrome';
const FFMPEG_PATH = process.env.FFMPEG_PATH ?? 'ffmpeg';
const OUT_DIR = resolve(ROOT, 'artifacts/video');
const FRAMES_DIR = resolve(OUT_DIR, 'frames');
const OUT_FILE = resolve(OUT_DIR, 'vrm-budget-lod.mp4');
const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;

// 24 体・アトラス 2048 は予算なしで約 170 MiB を常駐し、L0〜L4 の解像度差（2048〜256px）が画面上で判別できる。
// 体数を増やすと遠景がほぼ全員 L3/L4 になり、予算による変化が見えにくくなる。
// 粗さはデモのクローズアップ（`?closeup=1` で B の上半身を右下の小窓に出す）で見せる。
// 服の柄は顔より細かく、解像度の差がわかりやすい。徘徊を止めて小窓の構図を固定する。
const DEMO_QUERY = 'avatars=24&atlas=2048&hud=0&wander=0&closeup=1';
// A・B が小窓や左上のパネルと重ならず、奥の群衆まで入る位置（目視で決めた値）
const CAMERA = { z: 7, x: 2.5 };

/**
 * 演出の台本。`budgetMB` が 0 のとき予算なし（距離のみで LOD を選ぶ）。
 * `rampTo` があるステップは `seconds` かけて予算を線形に動かす。
 * 各値は probe で確認した切り替わり点（96 / 64 / 32 / 16 / 8MB で選択レベル分布が変わる）に合わせている。
 */
const SCRIPT = [
  { seconds: 6, budgetMB: 0, caption: '予算なし: 距離だけで解像度を選択' },
  { seconds: 5, budgetMB: 96, caption: '予算 96 MB: しきい値を縮めて遠景から落とす' },
  { seconds: 5, budgetMB: 64, caption: '予算 64 MB: 最高 Tier を 1024px に制限' },
  { seconds: 5, budgetMB: 32, caption: '予算 32 MB: 大半が 256px へ' },
  { seconds: 5, budgetMB: 16, caption: '予算 16 MB' },
  { seconds: 5, budgetMB: 8, caption: '予算 8 MB: 全員が最粗レベル' },
  { seconds: 12, budgetMB: 8, rampTo: 160, caption: '予算を徐々に増やす: 近いアバターから解像度が戻る' },
  { seconds: 7, budgetMB: 0, caption: '予算解除: 距離ベースの選択に復帰' },
];

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', rejectRun);
    child.on('exit', (code) =>
      code === 0 ? resolveRun() : rejectRun(new Error(`${command} が終了コード ${code} で失敗`)),
    );
  });
}

/**
 * 画面上部にキャプション、左上に予算・常駐量・レベル分布を大きく出すオーバーレイ。
 * デモの HUD は等幅の小さい文字で動画では読めないため、録画専用にページへ注入する。
 * レベル色はリング・3D ラベル（labels.ts）と同じ色を使い、画面内の色と対応させる。
 */
function installOverlay() {
  const COLORS = ['#6ee7c8', '#ffe066', '#ffa94d', '#ff6b6b', '#c77dff'];
  const style = document.createElement('style');
  style.textContent = `
    .lil-gui { display: none !important; }
    #rec-caption { position: fixed; top: 32px; left: 50%; transform: translateX(-50%);
      padding: 14px 32px; border-radius: 12px; background: rgba(8, 14, 24, 0.78);
      color: #e8f0fa; font: 600 34px/1.3 system-ui, sans-serif; white-space: nowrap; }
    #rec-panel { position: fixed; left: 40px; top: 120px; width: 860px;
      padding: 20px 28px; border-radius: 14px; background: rgba(8, 14, 24, 0.82);
      color: #e8f0fa; font: 500 24px/1.4 system-ui, sans-serif; }
    #rec-panel .row { display: flex; align-items: center; gap: 20px; margin: 6px 0; }
    #rec-panel .label { width: 150px; color: #9aa9bb; }
    #rec-panel .bar { position: relative; flex: 1; height: 30px; border-radius: 6px;
      background: rgba(255, 255, 255, 0.08); overflow: hidden; display: flex; }
    #rec-panel .value { width: 240px; text-align: right; font-variant-numeric: tabular-nums; }
    #rec-resident { background: #4dabf7; transition: width 0.25s; }
    #rec-budget-mark { position: absolute; top: 0; bottom: 0; width: 4px; background: #fff; }
    #rec-levels > div { transition: flex-grow 0.25s; }
    #rec-legend { display: flex; gap: 24px; margin-left: 170px; font-size: 20px; color: #c4d0de; }
    #rec-legend span::before { content: ''; display: inline-block; width: 14px; height: 14px;
      margin-right: 8px; border-radius: 3px; background: var(--c); }
  `;
  document.head.append(style);

  const caption = document.createElement('div');
  caption.id = 'rec-caption';
  const panel = document.createElement('div');
  panel.id = 'rec-panel';
  panel.innerHTML = `
    <div class="row"><div class="label">メモリ予算</div>
      <div class="bar"><div id="rec-resident"></div><div id="rec-budget-mark"></div></div>
      <div class="value" id="rec-memory"></div></div>
    <div class="row"><div class="label">選択レベル</div>
      <div class="bar" id="rec-levels"></div><div class="value" id="rec-scale"></div></div>
    <div id="rec-legend"></div>`;
  document.body.append(caption, panel);

  const stats = window.__vrmDemo.stats();
  const widths = stats.avatars[0].levelWidths;
  const levels = panel.querySelector('#rec-levels');
  const legend = panel.querySelector('#rec-legend');
  for (let level = 0; level < COLORS.length; level++) {
    const segment = document.createElement('div');
    segment.style.background = COLORS[level];
    levels.append(segment);
    // アトラス解像度を超える Tier は最大解像度にクランプされ、同じ解像度の凡例が並ぶため 1 つにまとめる
    if (level > 0 && widths[level] === widths[level - 1]) {
      legend.lastChild.textContent = `L${level - 1}–${level} ${widths[level]}px`;
      continue;
    }
    const item = document.createElement('span');
    item.style.setProperty('--c', COLORS[level]);
    item.textContent = `L${level} ${widths[level]}px`;
    legend.append(item);
  }

  // バーの全幅に相当する容量。予算なしの常駐量（約 170 MiB）と演出の最大予算 160MB が収まる値。
  const SCALE_MB = 180;
  const resident = panel.querySelector('#rec-resident');
  const mark = panel.querySelector('#rec-budget-mark');
  const memory = panel.querySelector('#rec-memory');
  const scale = panel.querySelector('#rec-scale');
  const update = () => {
    const s = window.__vrmDemo.stats();
    const residentMB = s.manager.residentBytes / 1048576;
    resident.style.width = `${Math.min(100, (residentMB / SCALE_MB) * 100)}%`;
    mark.style.display = s.budgetMB > 0 ? '' : 'none';
    mark.style.left = `${Math.min(100, (s.budgetMB / SCALE_MB) * 100)}%`;
    memory.textContent =
      s.budgetMB > 0
        ? `${residentMB.toFixed(0)} / ${s.budgetMB} MB`
        : `${residentMB.toFixed(0)} MB（無制限）`;
    s.levelCounts.forEach((count, level) => {
      levels.children[level].style.flexGrow = String(count);
    });
    scale.textContent = `scale ${s.scale.toFixed(2)}`;
  };
  update();
  // stats() は全アバターを走査するため毎フレームではなく 10Hz で更新する
  setInterval(update, 100);
}

async function main() {
  if (!existsSync(resolve(ROOT, 'dist/demo/vrm.html'))) {
    throw new Error('dist/demo/vrm.html がありません。先に `pnpm build` を実行してください。');
  }
  await rm(FRAMES_DIR, { recursive: true, force: true });
  await mkdir(FRAMES_DIR, { recursive: true });

  const preview = spawn('pnpm', ['exec', 'vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
    detached: true,
  });
  for (let i = 0; i < 100; i++) {
    const ok = await fetch(`http://localhost:${PORT}/vrm.html`).then((r) => r.ok, () => false);
    if (ok) break;
    await sleep(100);
  }
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: false,
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--no-sandbox'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
    await page.goto(`http://localhost:${PORT}/vrm.html?${DEMO_QUERY}`, { timeout: 30000 });
    await page.waitForFunction(() => window.__vrmDemo?.ready, null, { timeout: 120000 });
    const gpu = await page.evaluate(() => window.__vrmDemo.stats());
    if (gpu.gpuSoftware) {
      throw new Error(`ソフトウェア描画（${gpu.gpuAdapter}）では録画しません。実ディスプレイで実行してください。`);
    }
    await page.evaluate(({ z, x }) => window.__vrmDemo.setCamera(z, x), CAMERA);
    await page.evaluate(installOverlay);
    // 距離 LOD を初期状態に落ち着かせてから録画を始める
    await sleep(2000);

    const frames = [];
    const cdp = await page.context().newCDPSession(page);
    cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      const file = resolve(FRAMES_DIR, `${String(frames.length).padStart(6, '0')}.jpg`);
      frames.push({ file, timestamp: metadata.timestamp, write: writeFile(file, data, 'base64') });
      cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: WIDTH, maxHeight: HEIGHT });

    const setCaption = (text) =>
      page.evaluate((t) => {
        document.getElementById('rec-caption').textContent = t;
      }, text);
    const setBudget = (mb) => page.evaluate((v) => window.__vrmDemo.setSettings({ budgetMB: v }), mb);
    for (const step of SCRIPT) {
      await setCaption(step.caption);
      await setBudget(step.budgetMB);
      if (step.rampTo === undefined) {
        await sleep(step.seconds * 1000);
        continue;
      }
      // 1MB 刻みでは切り替わりが細かすぎて目で追えないため、0.25 秒ごとに更新する
      const ticks = step.seconds * 4;
      for (let i = 1; i <= ticks; i++) {
        await sleep(250);
        await setBudget(Math.round(step.budgetMB + ((step.rampTo - step.budgetMB) * i) / ticks));
      }
    }
    await cdp.send('Page.stopScreencast');
    await Promise.all(frames.map((frame) => frame.write));
    const errors = (await page.evaluate(() => window.__vrmDemo.stats())).errors;
    if (errors.length > 0) throw new Error(`デモでエラーが発生: ${errors.join(', ')}`);

    // スクリーンキャストは画面に変化があったときだけフレームを送るため、各フレームの表示時間を
    // 次フレームとのタイムスタンプ差で与え、ffmpeg で一定フレームレートへ変換する。
    const concat = ['ffconcat version 1.0'];
    frames.forEach((frame, index) => {
      const next = frames[index + 1]?.timestamp ?? frame.timestamp + 1 / FPS;
      concat.push(`file '${frame.file}'`, `duration ${(next - frame.timestamp).toFixed(6)}`);
    });
    const concatFile = resolve(FRAMES_DIR, 'frames.ffconcat');
    await writeFile(concatFile, `${concat.join('\n')}\n`);
    // crf 14 はクローズアップの細部（まつげ・レース）が圧縮で潰れず、L0 と L4 の差が残る画質（目視で決めた値）
    await run(FFMPEG_PATH, [
      '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', concatFile,
      '-vf', `fps=${FPS},format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-movflags', '+faststart', OUT_FILE,
    ]);
    // 1 回の録画で約 900MB になる中間 JPEG は残さない
    await rm(FRAMES_DIR, { recursive: true, force: true });
    console.log(JSON.stringify({ output: OUT_FILE, frames: frames.length, gpu: gpu.gpuAdapter }));
  } finally {
    await browser.close();
    if (preview.pid) process.kill(-preview.pid, 'SIGTERM');
  }
}

await main();
