# scripts AGENTS.md

スモークテストとアセット取得スクリプトの運用ルールです。

## 実行前提と共通仕様

- `pnpm smoke` / `pnpm smoke:vrm` は `pnpm build` 済み（`dist/demo/` 生成済み）を前提とし、`vite preview` を子プロセスで起動して検証後に終了します。VRM スモークは `pnpm models:fetch` も必要です。
- WebGPU の adapter を取得するため、Playwright（`playwright-core`）で **headed Chrome** を起動します。画面がない環境では `xvfb-run -a pnpm smoke` のように Xvfb 経由で実行します。
- 実 GPU で WebGPU を検証したいときは、Xvfb を使わず実ディスプレイ（X / Wayland セッション）上で実行します。Xvfb では WebGPU が SwiftShader になり、headless では adapter 自体が取れません。
- 描画に使った GPU は結果 JSON の `gpu`（`adapter` と、ソフトウェア実装なら true になる `software`）に出ます。`SMOKE_REQUIRE_HW_GPU=1` を付けると、ソフトウェア描画のバックエンドを失敗扱いにします。
- Chrome のパスは環境変数 `CHROME_PATH` で上書きできます（既定: `/run/current-system/sw/bin/google-chrome`）。
- 待機は固定 sleep に頼らず `stats().frame` の進行と条件ポーリングで行います（群衆徘徊の待ち時間は模擬時間 `stats().elapsed` を基準にします）。
- 結果は JSON で標準出力し、アサーション失敗時は exit 1 で終了します。スクリーンショットは `artifacts/` および `artifacts/vrm/` に保存します。

## `scripts/smoke.mjs`（`pnpm smoke`）

WebGPU / WebGL2 の両バックエンドで板ポリデモを検証します。

- `window.__lodDemo.ready` 待機、pageerror / console.error のゼロ確認
- `?lod=0` 別ページ基準からのパイプライン（`caches` / `programs.fragment`）非増加
- 近距離での `L0`・`L2` 混在と遠距離での全 `L2` 化
- ヒステリシス厳密系列（`h=0.2, center` で `5→L0, 12.1→L1, 9→L1, 7.9→L0, 9→L0, 11.9→L0, 12.1→L1`）、バンド内往復（`9.5↔10.5`）での切替 0、対照 `h=0` での境界追従
- テレポート（`setProbeDistance(40)` で `frame+2` 以内に L2）
- `evict` 即時破棄での `residentBytes` 半減、近景中央輝度 `> 30` と復帰時の両側輝度比 `|recovered / near - 1| < 0.1`（`pngjs` 判定）、`keep-all` での非減

## `scripts/smoke-vrm.mjs`（`pnpm smoke:vrm`）

WebGPU / WebGL2 の両バックエンドで VRM デモを検証します。

- **1 体詳細**: 最適化前後のメッシュ・マテリアル数、使用スロット、実テクスチャ幅（`[1024, 1024, 1024, 512, 256]`）、ヒステリシス 16 点＋上側バンド保持 4 点＋バンド内 0 切替＋`h=0` 対照＋`forceLevel` 3/4＋メッシュ間同期、L0↔L4 往復後のパイプライン非増加、`evict` 常駐減（20m/30m、30m では実 GPU テクスチャ数減少も確認）と輝度復帰、`keep-all` 非減、クローズアップ有効時（20m）のレベル・draw calls 不変
- **既定（3 ソース + 複製 1） / 複製（1 ソース + 複製 3） / 4 ソース**: `sourceCount` / `cloneCount`、初期レベル `[0,1,2,3]`、最適化回数、常駐倍率、複製頭ボーンの揺れ、追加/削除・`h` 変更後の再バインド、WebGL での 4 ソースコンテキスト無警告
- **100 体群衆**: `objectCount` / `ringCount` 100、L3+L4 が 80 体以上、静止 3 秒のフレーム性能計測、徘徊 ON（模擬時間 7 秒で 9 割移動・home 誤差 0.75 以内・最小間隔 0.4 以上）、徘徊 OFF での home 一致（`1e-6`）、`4 ↔ 100` 体往復後のパイプライン非増加
- **上限キャッシュと予算適応**: 予算なし（`?evictDelay=10000&adaptive=0`）から動的予算を設定した際のレベル不変キャッシュ掃引、8MB 締めでの `resident === required` 維持と解除、予算適応 `?budget=32` での 2 軸制御（scale＋finestLevel）・2MB 締めでの下限到達・解除後 60 秒以内の復帰と 5 秒静定・世代番号不変の再適用
- **ディスク退避**（`?spill=1&evictDelay=0` および `?compress=1&spill=1&evictDelay=0`、1 体）: 遠景（20m）で `spilledBytes > 0`（圧縮時は全レベルの `mipmaps.length` 不変）、近景へ戻ると読み戻し後に L0 へ復帰し輝度比 `< 0.1`、退避中の手動 L0 固定・LOD 無効でも輝度比 `< 0.1`・コンソールエラー 0・`failureCount === 0`
- **4096 と Tier 上限**: WebGPU で `?atlas=4096&top=1024`（`topLevel=2`, `finestLevel=2`, map 幅 `[4096,2048,1024,512,256]` 等）と `?atlas=4096&budget=64`（`finestLevel=2`, `scale=1`, 解除 30 秒以内で復帰）、WebGL で軽量 `?atlas=1024&top=1024`
- **圧縮テクスチャ（`?compress=1`）**: WebGPU / WebGL2 で `compressTextures=true`・`compressedSlots`・全レベル `CompressedTexture`・`map` 幅 `[1024,1024,1024,512,256]` とミップ数 `[11,11,11,10,9]`・`atlasBytes` 削減・L0→L3→L4→L0 での `evict` と輝度復帰・パイプライン非増加・エラーゼロを確認

## `scripts/record-vrm-video.mjs`（`pnpm record:vrm`）

VRM デモで、メモリ予算に応じて選択 LOD が変わる様子を紹介動画（`artifacts/video/vrm-budget-lod.mp4`）として録画します。

- 前提はスモークと同じく `pnpm models:fetch` と `pnpm build` 済みであること。加えて ffmpeg が必要で、PATH にないときは `FFMPEG_PATH` で指定するか `nix shell nixpkgs#ffmpeg -c pnpm record:vrm` で実行します。
- 実 GPU の出るディスプレイ上で実行してください。ソフトウェア描画だと録画せずに失敗します。
- 予算の推移とキャプションはスクリプト先頭の `SCRIPT` で決めています。テクスチャの粗さはデモのクローズアップ（`?closeup=1` で B の上半身）で見せるので、カメラ位置（`CAMERA`）や体数を変えたら、A・B が小窓やパネルに隠れないか静止画で確かめてください。

## `scripts/fetch-models.mjs`（`pnpm models:fetch`）

`AvatarSample_A / B / C` を固定コミット URL から取得し、SHA-256 を検証して `public/models/` に保存します（`--models=A,B` で絞り込み、`--force` で再取得）。取得元を更新する場合は、内容とライセンスを確認したうえで SHA-256 ハッシュと [public/models/README.md](../public/models/README.md) をあわせて更新します。
