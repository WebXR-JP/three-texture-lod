import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

// デモアプリ（ルートの index.html / vrm.html + src/demo）をビルドする。
// ライブラリ自体は src/lib/index.ts から公開し、テストは src を直接参照する。
// ADR: デモの出力先は `dist/demo` に固定し、`dist/lib`（ライブラリ配布物）と共存させる。
// 既定の `dist` のままでは `pnpm build` が `dist` 全体を空にして `dist/lib` を消してしまう。
export default defineConfig({
  build: {
    outDir: 'dist/demo',
    rollupOptions: {
      // 板ポリのLODデモ（index.html）と、VRMデモ（vrm.html）を両方ビルドする。
      input: {
        main: resolve(root, 'index.html'),
        vrm: resolve(root, 'vrm.html'),
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
