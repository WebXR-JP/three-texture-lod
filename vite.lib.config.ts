import { defineConfig } from 'vite';

// ライブラリ配布用ビルド（`src/lib/index.ts` のみ）。
// デモ（vite.config.ts）とは別物で、three は外部依存のままにする。
// 成果物は `dist/lib/` に出す。
export default defineConfig({
  build: {
    lib: {
      entry: 'src/lib/index.ts',
      formats: ['es'],
      fileName: 'three-texture-lod',
    },
    outDir: 'dist/lib',
    emptyOutDir: false,
    rollupOptions: {
      external: ['three'],
    },
  },
});
