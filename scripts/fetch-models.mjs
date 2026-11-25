// VRMデモ用のサンプルモデルを public/models/ へ取得する。
//
// モデルはリポジトリに含めない（サイズとライセンスの都合）。
// VRoid Studio のサンプルモデルは無償で利用・再配布できるが CC0 ではないため、
// 取得元とライセンスを public/models/README.md に明記する。
//
// 既定では AvatarSample_A/B/C を取得する。--models=A,B で絞り込める。
// 既に取得済みのファイルはスキップし、--force で再取得する。
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT_DIR = resolve(ROOT, 'public/models');

const MODELS = {
  A: {
    file: 'AvatarSample_A.vrm',
    url: 'https://raw.githubusercontent.com/madjin/vrm-samples/e16eb187100149a315ad92c3c9968f1d5baa6c7d/vroid/stable/AvatarSample_A.vrm',
    sha256: 'b86b0b8a66d48911431d6f920a5211a974226f83aa672eca3f3dfade58ac346e',
  },
  B: {
    file: 'AvatarSample_B.vrm',
    url: 'https://raw.githubusercontent.com/madjin/vrm-samples/e16eb187100149a315ad92c3c9968f1d5baa6c7d/vroid/stable/AvatarSample_B.vrm',
    sha256: '4a271bd3b5a3d19e054fd113ee154635b72e7141f4a8ccbcdba3c7f9cea6ee8d',
  },
  C: {
    file: 'AvatarSample_C.vrm',
    url: 'https://raw.githubusercontent.com/madjin/vrm-samples/e16eb187100149a315ad92c3c9968f1d5baa6c7d/vroid/stable/AvatarSample_C.vrm',
    sha256: '395d5b04696e888f07bc856ae01bf72a974b7e773132c7443dc59d1688045b8a',
  },
};

function parseArgs(argv) {
  const args = { models: 'A,B,C', force: false };
  for (const arg of argv) {
    if (arg === '--force') args.force = true;
    else if (arg.startsWith('--models=')) args.models = arg.slice('--models='.length);
  }
  return args;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

const args = parseArgs(process.argv.slice(2));
const names = args.models
  .split(',')
  .map((name) => name.trim().toUpperCase())
  .filter(Boolean);

if (names.length === 0) {
  console.error('--models が空です。例: --models=A,B');
  process.exit(1);
}
for (const name of names) {
  if (!MODELS[name]) {
    console.error(`未知のモデル: ${name}（A/B/C のいずれか）`);
    process.exit(1);
  }
}

await mkdir(OUT_DIR, { recursive: true });

for (const name of names) {
  const model = MODELS[name];
  const path = resolve(OUT_DIR, model.file);
  if (existsSync(path) && !args.force) {
    const existing = await readFile(path);
    if (sha256(existing) === model.sha256) {
      console.log(`skip: ${model.file}（取得済み。再取得は --force）`);
      continue;
    }
    console.warn(`既存ファイルのSHA-256が一致しません。再取得します: ${model.file}`);
  }

  console.log(`download: ${model.file} ...`);
  const response = await fetch(model.url);
  if (!response.ok) {
    throw new Error(`${model.url} の取得に失敗しました: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const digest = sha256(buffer);
  if (digest !== model.sha256) {
    throw new Error(
      `${model.file} の SHA-256 が一致しません（取得元が更新された可能性があります）\n` +
        `  期待: ${model.sha256}\n  実際: ${digest}\n` +
        '取得元のライセンスと内容を確認してから、scripts/fetch-models.mjs のハッシュを更新してください。',
    );
  }
  // 途中で失敗した壊れたファイルを残さないよう、一時ファイルへ書いてから置換する。
  const temporary = `${path}.tmp`;
  await writeFile(temporary, buffer);
  await rename(temporary, path);
  console.log(`  -> ${path} (${(buffer.byteLength / 1048576).toFixed(1)} MB)`);
}

console.log('');
console.log('モデルのライセンスは public/models/README.md を確認してください。');
console.log('VRoid Studio のサンプルモデルは CC0 ではなく、条件付きで利用・再配布が許可されています。');
