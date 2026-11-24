import { defineConfig } from 'vitest/config';

// デモアプリ（ルートの index.html + src/demo）をビルドする。
// ライブラリ自体は src/lib/index.ts から公開し、テストは src を直接参照する。
// ADR: デモの出力先は `dist/demo` に固定し、`dist/lib`（ライブラリ配布物）と共存させる。
// 既定の `dist` のままでは `pnpm build` が `dist` 全体を空にして `dist/lib` を消してしまう。
export default defineConfig({
  build: {
    outDir: 'dist/demo',
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
