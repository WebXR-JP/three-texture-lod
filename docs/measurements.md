# 計測記録

各デモのパイプライン共有・常駐メモリ・フレーム時間に関する実測値の記録です。

## 計測条件と単位

- 容量の単位はすべて `stats()` のバイト値を $1024^2$ で割った **MiB** です（URL パラメータ `?budget` や GUI 表示の MB とは単位が異なります）。
- Xvfb 環境での観測です。WebGPU はソフトウェア実装（SwiftShader）、WebGL2 は `--use-angle=vulkan`（NVIDIA RTX 3090）または同環境で計測しています。

## 板ポリデモ（60 板・3 レベル）

`renderer._pipelines` の観測値（WebGPU / WebGL2 共通）。基準値は `?lod=0` の新規ページで数フレーム後に取得し、有効化後・近↔遠往復後と比較しています。

| 時点 | `caches` | `programs.fragment` |
| --- | --- | --- |
| LOD 無効時の基準値 | 2 | 2 |
| LOD 有効化後（全板に再付与） | 2 | 2 |
| 近↔遠往復後 | 2 | 2 |

切替前後でパイプラインは増加していません。

## VRM デモ（1024px アトラス）

WebGPU / WebGL2 ともスモーク通過時の実測値です（代表値は WebGPU 基準）。

| 計測項目 | 実測値・結果 |
| --- | --- |
| 最適化前 → 後（1 体） | mesh 90 → 12、material 26 → 4 |
| アトラス使用スロット | `map`, `shadeMultiplyTexture`, `normalMap`, `emissiveMap` |
| `map` 実幅（5 レベル） | `[1024, 1024, 1024, 512, 256]`（L0–L2 は同一テクスチャを共有） |
| `normalMap` 実幅（5 レベル） | `[512, 512, 512, 512, 256]`（L0–L3 は同一テクスチャを共有） |
| 1 体の `atlasBytes` | 約 13.3 MiB（13,982,037 B） |
| 1 体の全レベル常駐（`keep-all` で L0→L4 到達後） | 約 17.3 MiB（18,175,317 B、atlas の約 1.30 倍） |
| 1 体 `evict`（近景 L0 → 遠景 L3 → 復帰 L0 → 最遠 L4） | 14.7 MiB → 6.7 MiB → 14.7 MiB → 1.3 MiB（`evictCount` 増加、L4 では `textureCount` も 21 → 17 に減少） |
| 復帰時の中央領域輝度比 | WebGPU 38.87 → 38.63（比 0.994）、WebGL 38.20 → 38.43（比 1.006） |
| パイプライン（1 体、L0↔L4 複数往復） | `caches` 12 → 12、`fragment` 12 → 12 |
| ヒステリシス（1 体、`T=[0,3,6,12,24]`, `h=0.15`） | 16 点系列＋上側バンド保持 4 点一致（L4 遷移 28.0m、保持 25.5m）、バンド内 6 往復で切替 0、`h=0` で 10 回切替 |
| 4 ソース（A,B,C,A・L0/L1/L2/L3 各 1 体） | 常駐 50.7 MiB（full 53.3 MiB の 0.95 倍） |
| 複製（ソース 1 + 複製 3・L0/L1/L2/L3 各 1 体） | 最適化 1 回、常駐 17.3 MiB（ソース 1 体分 13.3 MiB の約 1.30 倍） |
| 既定（3 ソース + 複製 1） | mesh 319 → 36（rendered 48）、material 272 → 12、atlas 40.0 MiB、常駐 46.7 MiB |
| 上限キャッシュ単独（3 ソース+複製 1、`adaptive=0`, `evictDelay=10000`） | `required < budget < total` の中間予算設定でレベル不変のまま `resident <= budget`・`over = 0`・`evict` 増加。8MB 締め時は `resident === required`・`over > 0` でレベル `[0,1,2,3]` を維持し、解除で `over = 0` |
| 予算適応 2 軸（3 ソース+複製 1、`?budget=32`） | `scale` 0.42（`lower=1`, `cap=0`）で `required` 22.7 MiB ≤ 32MB・`over = 0`・`levelCounts [0,0,1,1,2]`。2MB 締めで `scale=0.05`, `finest=4`, `required=4.0 MiB`（`FLOOR`）。解除で約 23〜25 秒で `scale=1`, `finest=0` に復帰し 5 秒静定。0→8MB 再適用は世代番号不変で `required=4.0 MiB` に収束 |

## VRM デモ（100 体群衆・1024px）

3 ソース + 複製 97 体構成の実測値です。

- **構成・メモリ**: rendered 1,200 mesh、常駐 52.0 MiB（full 40.0 MiB の 1.30 倍）、レベル分布 `[1, 1, 11, 61, 26]`（L3+L4 が 87 体）、リング数 100、警告 0
- **WebGL2（NVIDIA RTX 3090, `--use-angle=vulkan`）**: 静止時 frame 35.0ms / update 1.1ms / drawCalls 1,046 / pipelines 22、徘徊時 frame 36.8ms / update 1.1ms / drawCalls 1,048
- **WebGPU（SwiftShader）**: 静止時 frame 1814.8ms / update 1.4ms / drawCalls 1,046
- **起動・切替所要時間**: 読込開始〜`ready` 約 3.3〜3.6 秒、`setAvatarCount(4)` 4〜5ms、`setAvatarCount(100)` 44〜87ms

## VRM デモ（4096px アトラス・Tier 上限）

| 条件 | 実測値・結果 |
| --- | --- |
| 4096・1 ソース（WebGPU） | `atlasBytes` 約 213.3 MiB（223,697,237 B）。単一レベル常駐 L0 214.7 MiB / L1 86.7 MiB / L2 22.7 MiB / L3 6.7 MiB / L4 1.3 MiB。全レベル常駐（`keep-all`）約 283.9 MiB（297,796,584 B、atlas の約 1.33 倍） |
| 4096・3 ソース（未計測の規模目安） | 1024px 3 ソース（40.0 MiB）の面積比 16 倍換算で `atlasBytes` 約 640 MiB 級（L0〜L4 の `DataTexture` 用 JS ヒープも同規模消費） |
| `?atlas=4096&top=1024`（1 ソース・WebGPU） | `topLevel=2`, `topResolution=1024`, `finestLevel=2`, 選択 L2。`map` 幅 `[4096,2048,1024,512,256]`, `normalMap` 幅 `[2048,2048,1024,512,256]`, 選択 L2 `map` 幅 1024 |
| `?atlas=4096&budget=64`（1 ソース近距離・WebGPU） | `finestLevel=2`, `scale=1`, `required` 22.7 MiB ≤ 64MB, `over=0`, `levelCapLowerCount=1`, 選択 L2 `map` 幅 1024。解除後 2 秒以内に `finestLevel=0` へ復帰 |
| `?atlas=4096&spill=1&evictDelay=0`（1 ソース・WebGPU・実ディスプレイ、GC 後の `usedJSHeapSize`） | 近景 L0: 301.5 MiB → 249.3 MiB（退避 52.0 MiB）。最遠 L4: 301.5 MiB → 89.8 MiB（退避 212.0 MiB）。L4 から L0 への復帰後は 249.9 MiB で、`spill=0` は距離によらず 301.5 MiB 前後 |
| `?atlas=1024&top=1024`（1 ソース・WebGL） | `topLevel=2`, `topResolution=1024`, `finestLevel=2`, 選択 L2、コンソールエラー 0 |
| 4096・3 ソース・50 体・`?budget=256`・徘徊 ON（WebGPU, Xvfb） | `finestLevel=1`, `scale=1.0`, `requiredBytes` 254.7 MiB, `residentBytes` 254.7 MiB, `over=0`, `levelCapLower=1 / raise=0`, レベル `[0,2,11,37,0]`, frame p50 916.6ms / max 933.3ms（SwiftShader）。証拠画像: `artifacts/vrm/tiers-4096-50-256.png` |

## VRM デモ（iPhone 実機・Safari）

iPhone 11 Pro（iOS 26.6.2）の Safari で、WebGPU を使って計測した値です（`@webxr-jp/avatar-optimizer` 0.7.1）。シミュレータは iOS のメモリ上限を再現しないので、実機で見ています。

- **計測方法**: LAN 上の HTTPS（secure context）で `dist/demo` を配信します。条件ごとに Safari を終了してから開き、ready 後に約 110 秒、`?auto=1` で動かします。
- **ストレージを使う計測**: `devicectl` で Safari を強制終了して開き直すと、5〜8 秒後にこのオリジンのサイトデータ（OPFS・localStorage・IndexedDB）が消え、それより前に取った OPFS のハンドルは `UnknownError` を返します。`?spill=1` を測るときは、再起動後に軽いページを開いて 30 秒ほど待ってから試験の URL を開いてください。
- **合格条件**: タブの再読込（クラッシュ）、WebGPU デバイスの喪失、エラーのいずれも起きないこと。

### テクスチャ予算（`?models=A,B&avatars=50&atlas=4096&auto=1`）

| 予算 | 回数 | 結果 |
| --- | --- | --- |
| なし | 2 | 2 回とも ready 後約 25 秒（約 800 フレーム、常駐は最大 354.7〜397.3 MiB）でタブがクラッシュし、再読込後も同じく落ちる |
| `?budget=128` | 2 | 2 回とも安定。約 5,500 フレーム・17ms 前後、常駐 120.0 MiB、`over=0`、レベル `[0,1,2,27,20]` |
| `?budget=64` | 1 | 安定。約 5,300 フレーム・17ms 前後、常駐 56.0 MiB、`over=0`、レベル `[0,0,13,37,0]`（最細 L2） |

### 頂点バッファと構成ごとの可否

頂点バッファ（`mappedAtCreation` でマップした合計）は 3 ソース + 複製で 5.4 MiB、2 ソースで 3.8 MiB と小さく、複製はジオメトリを共有します。

| 構成（予算なし） | 結果 |
| --- | --- |
| 既定（3 ソース + 複製 1・1024px） | 安定 |
| `?models=A,B,C&avatars=50&atlas=1024` | 安定 |
| 2048px で `C` 単独・`A,B`・`A,C`・`B,C`（各 1〜2 体） | 安定（常駐は最大 125.3 MiB） |
| `?models=A,B,C` で 2048px・50 体、4096px・3〜50 体 | 初回描画で WebGPU デバイスを失う（4096px ではタブのクラッシュも起きる） |

最後の構成は `?budget=128` でも同じく失われます。2 ソース・4096px の `?budget=128`（常駐 120.0 MiB）は通るので、GPU 常駐テクスチャ量の差では説明できません。後述のプロセスメモリも上限より十分小さく、原因は特定できていません。iPhone では 3 ソースなら 1024px に留めてください。

### プロセスメモリ

Safari のページからはメモリを取れないので、Mac から次の 2 つで見ます。値は各プロセスの physical footprint です。

- **動作中**: `xcrun xctrace record --device <UDID> --template "Activity Monitor" --all-processes` を ready 後に 5 秒だけ記録し、`sysmon-process` 表を書き出します。ページが重いと、長い記録は保存が終わらなくなります。記録の直前に `xcrun devicectl device info details` で接続を起こしておかないと、`Waiting for device to boot` で止まります。
- **強制終了時**: iOS が残す `JetsamEvent-*.ips` を `xcrun devicectl device copy from --domain-type systemCrashLogs` で取り出し、プロセスごとの `rpages`（16 KiB ページ）と終了理由を読みます。

| 構成 | WebContent | GPU プロセス | 結果 |
| --- | --- | --- | --- |
| `?models=A,B&avatars=50&atlas=4096`（予算なし） | 1,536.0〜1,684.2 MiB | 211.2〜232.0 MiB | WebContent が `highwater` で強制終了（3 回の計測すべてで、再読込後の 2 回目も同様） |
| 同上 `?budget=128` | 1,221.7〜1,227.6 MiB | 222.2〜222.3 MiB | 安定 |
| 同上 `?budget=128&spill=1` | 738.8〜831.9 MiB | — | 安定。12 件・336.0 MiB を退避し、失敗 0。元テクスチャを解放した状態の値で、解放しない場合は 842.8〜1,229.0 MiB |
| 同上 `?spill=1`（予算なし） | — | — | 2 回とも ready 後約 17 秒でクラッシュ。退避は 2 件・128.0 MiB に留まる |
| `?models=A,B,C&avatars=50&atlas=2048`（予算なし / `?budget=128`） | 715.4 / 742.6 MiB | 19.9 / 22.3 MiB | WebGPU デバイスを失う。GPU プロセスの値はデバイス喪失後のもので、GPU プロセスの強制終了は記録されない |

予算なしでのクラッシュは、ページのプロセス（WebContent）が 1 タブあたり約 1.5 GiB の上限に届くことで起きます。GPU プロセスには余裕があります。テクスチャ予算は GPU 常駐量だけでなく WebContent のメモリも 1.2 GiB 台まで下げ、この上限を避けます。

`?spill=1` を予算と組み合わせると、予算で破棄したレベルの画素データが OPFS へ移り、WebContent は退避量（336.0 MiB）と同規模だけ減ります（元テクスチャを解放しない状態で約 385 MiB）。予算なしの行と `?budget=128` の行は、元テクスチャを解放しない状態の値です。予算なしでは距離で破棄されるレベルが少なく、spill だけでは上限を避けられません。

`?budget=128&spill=1` の WebContent（ready 後 120 秒で 738.8 MiB）の内訳の目安は次のとおりです。値は GC の時期で ready 後 25 秒と 120 秒の間に 90 MiB 以上揺れます。

| 中身 | 量 |
| --- | --- |
| デモの土台（ライブラリ・VRM データ・ジオメトリ・WebKit。`?models=A&avatars=1&atlas=1024` で 396.4 MiB） | 約 300〜400 MiB |
| 常駐レベルの画素の CPU 側コピー（GPU 常駐量と同規模） | 約 120 MiB |
| 常駐も退避もされていないレベル（全レベル合計から常駐と退避を引いた残り。中身は未特定） | 約 110 MiB |
| アトラス化の対象外で使い続ける元テクスチャ（matcap など） | 約 34 MiB |

計測の切り替え中に、どの試験のものか分からない 1,607.4 MiB の WebContent が強制終了されることがあります。Safari の再起動時に前回の重いタブが裏で読み直されている可能性があるので（未確認）、計測前に Safari のタブを閉じておいてください。
