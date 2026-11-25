# src/demo AGENTS.md

デモアプリ全体の構成と、板ポリデモ（`index.html` / `main.ts` / `textures.ts`）の仕様です。VRM デモについては [vrm/AGENTS.md](vrm/AGENTS.md) を参照してください。

## デモ全体の共通事項

- `vite.config.ts` がルートの `index.html` と `vrm.html` をエントリとして `dist/demo/` へビルドします。`dist/lib/` と出力先を分けているため共存します。
- `renderer._pipelines` の観測はデモ専用の内部参照であり公開 API ではないため、three.js のバージョン更新時は内部構造の変化を確認してください。

## 板ポリデモ（`index.html` / `main.ts`）

- 60 枚の板ポリゴンに 3 レベル（境界 `0 / 10 / 25`）の LOD を適用し、カメラを `z: 6 → -70 → 6` で自動往復させる基本デモです。
- **GUI 操作**: `autoMove` / `speed` / 再構築系（`hysteresis`, `residency`, `evictDelayMs`, `maxResidentBytes`, `distanceMode`）/ `LOD有効` / `近距離へ`（`z=0`）/ `遠距離へ`（`z=30`）/ `h=0で往復テスト`。再構築系を変更するとマネージャとセットを作り直し、切替カウンタはリセットされます。
- **URL パラメータ**: `?backend=webgl`、`?auto=0`、`?h=0.2`、`?residency=keep-all`、`?z=-30`、`?lod=0`
- **スモーク用公開 API（`window.__lodDemo`）**: `ready`, `stats()`, `setCameraZ(z)`, `setAutoMove(on)`, `setSettings(partial)`, `setProbeDistance(d)`, `probeLevel()`, `meshCount`。
  - `stats().textureCount` は three r187 では `dispose()` 直後に減らないことがあるため参考値とし、解放確認には `residentBytes` を使います。
  - `center` モードで距離 0 にプローブ板を置くとエッジオンで暗くなるため、近景の輝度検証は `setCameraZ(0)` を使います。
