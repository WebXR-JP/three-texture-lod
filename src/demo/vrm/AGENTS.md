# src/demo/vrm AGENTS.md

VRM × テクスチャ LOD デモ（`vrm.html` / `src/demo/vrm/`）の実装仕様と制約です。

## 読み込みと最適化

- three r187 では `@pixiv/three-vrm` の `MToonNodeMaterial` がバンドル要件と合わないため、読み込みは classic `MToonMaterial` で行い、`@webxr-jp/avatar-optimizer`（0.7.0）でアトラス化・マテリアル統合したあと `@webxr-jp/mtoon-atlas/nodes` の `MToonAtlasNodeMaterial`（TSL）へ置き換えます。
- 使用されているスロット（`map`, `shadeMultiplyTexture`, `normalMap`, `emissiveMap` 等）だけを実サイズでアトラス化し、未使用スロットは 8px に落とします。
- `matcap` は UV 非依存のため LOD 対象外です。また `materialColorBind` / `textureTransformBind` は最適化後のマテリアルには効きません。
- `?compress=1`（既定 OFF）または GUI の `テクスチャ圧縮(KTX2)` トグルで `optimizeModel` に `textureCompression`（UASTC + `generateMipmaps: true`）を渡し、共有 `KTX2Loader`（three 同梱ローカル transcoder）で `CompressedTexture` へトランスコードします。

## 絶対解像度 Tier と縮小（`tiers.ts` / `downscale.ts`）

- 5 段階の絶対解像度 Tier `LOD_TIERS = [4096, 2048, 1024, 512, 256]` と距離境界 `LOD_DISTANCES = [0, 3, 6, 12, 24]`（`surface` 距離、`h = 0.15`）を使います。
- `createTierTexturesForSlot` でスロット単位に `isCompressedTexture` を判定し、圧縮スロットは `createCompressedTextureMipLevels` で埋め込みミップチェーンをスライスし、非圧縮スロットは整数分割 `divisor = max(1, ceil(maxDim / T))` で縮小します（非 2 冪のソース幅でも長辺が Tier 以下に収まる）。ソース解像度が Tier に満たないレベルは最大解像度にクランプし、同一 `Texture` を複数レベルで共有します。
- `?atlas=256` は全 Tier が同一テクスチャになるためデバッグ用途に限定してください。
- 非圧縮スロットは色スロットで sRGB→リニア変換とアルファ重み付け平均、法線でベクトル再正規化を行い、全レベルでミップマップ（`LinearMipmapLinearFilter`・`generateMipmaps = true`）を有効化します。圧縮スロットは `generateMipmaps = false` を維持し、埋め込みミップを使います。
- 最粗 256px ではアトラスのパディングがないため、髪やまつげなどアルファテスト領域で隣接 UV 島の色が滲む場合があります。

## バウンディング球の固定

`SkinnedMesh.boundingSphere` はスキニング後頂点から計算されて実体より大きくずれるため、距離計算とフラスタムカリングを bind pose の geometry 球に固定しています。

## テンプレート共有・複製・配置（`avatar.ts` / `layout.ts` / `wander.ts`）

- **ソース上限と複製**: 読み込むソースは最大 4 体（デモ側の上限）。`avatar-optimizer` 0.6.0 は共有オフスクリーン `WebGLRenderer` を使うため、同時 WebGL コンテキスト数はソース数に比例しません。複製は最適化を再実行せずテンプレートのアトラス・セットを共有し、メッシュと束縛だけを複製ごとに持ちます（総数 1〜100 体、既定は 3 ソース + 複製 1）。
- **複製の骨格制限**: 複製は最適化済みシーンのボーンを clone するため、VRM の `Humanoid` / `SpringBone` / `ExpressionManager` を持たず、rest pose と頭ボーンの揺れのみ動きます。1 体あたり最大 4 マテリアル（opaque / alphaTest / transparent + アウトライン）を `addGroup`（`anchor = 体`）で同期します。
- **配置**: 先頭 4 体は初期距離 2.7 / 5.3 / 10.7 / 16.3m に固定し、5 体目以降は中央の視線レーン（`|x| < 3.0` かつ `z > -12`）を空けた間隔 2.4m のグリッド（最前列 `z = -1.0` から左右へ展開）に配置します。
- **徘徊**: 各アバターは配置位置（`home`）を中心とする半径 0.7m 円内で待機（0.5〜3.0 秒）→ 70% で歩行・30% でその場転回を繰り返します。歩行中は上下動（振幅 0.02m）のみ付け、衝突判定は行いません（配置間隔からセル半径で分離）。OFF にすると `home` に固定し正面・SpringBone リセットを行い、ON に戻すとその場から再開します（`home` がずれた場合は配置円内へ歩き戻ります）。

## URL パラメータ・GUI・HUD

| パラメータ | 仕様 |
| --- | --- |
| `?models=A,B,C` | 読み込むソース（先頭から `min(4, avatars)` 件。`A/B/C` はサンプル、他は `/models/<name>.vrm` または URL） |
| `?avatars=4` | 総体数（`1〜100`、既定 `4`）。ソース不足分は複製で補う |
| `?backend=webgl` | WebGL2 を強制 |
| `?lod=0` | LOD 無効 |
| `?top=1024` | 手動の Tier 上限（非 Tier 値はその値以下で最大の Tier に丸め、`<= 0` は 256、非数値は無視。`?lod=0`・手動レベル固定時は無効） |
| `?atlas=1024` | アトラス解像度（`256〜4096`、既定 `1024`） |
| `?compress=1` | KTX2 テクスチャ圧縮を有効化（既定無効） |
| `?h=0.15` | ヒステリシス幅（`0〜0.3`） |
| `?residency=keep-all` | 常駐モード（`evict` / `keep-all`） |
| `?evictDelay=1000` | `evict` 猶予 ms（`0〜10000`） |
| `?budget=32` | 常駐上限 MB（`0〜4096`、既定 `0`＝無効） |
| `?spill=1` | 破棄したテクスチャの画素データを OPFS へ退避（既定は無効。OPFS を開けない環境では警告を出して無効のまま続行） |
| `?adaptive=0` | 予算適応を無効化（既定は有効。予算 0 でも manager に渡しておき後から有効化可能） |
| `?scale=0.5` | 固定の距離しきい値倍率（`0.05〜4` でクランプ、非数値は無視。指定時は adaptive より優先） |
| `?auto=0` | 自動カメラ停止 |
| `?wander=0` | 徘徊無効 |
| `?hud=0` | HUD を折りたたんで起動（`?hud=1` で展開。一時上書きで localStorage に保存しない） |

- **退避中のマネージャ外表示**: `?spill=1` では、LOD 無効化と手動レベル固定は `restoreAll()` の完了を待ってから適用します。読み戻しの間は `manager.update` を止め、表示中のバリアントのまま描画します。待つ間に LOD 有効化・自動レベル・`h` 変更が入った場合、待っていた切り替えは捨てます。
- **GUI の更新方針**: `budget` スライダー変更は `setMaxResidentBytes` で反映しマネージャを作り直しません（`adaptive` 切替時のみ再構築）。`avatarCount` スライダーの同期は変更時のみ行い、毎フレームは書き換えません。追加ボタンはインスタンス最小テンプレートを複製し、削除ボタンは最後の複製を外します。
- **HUD 表示仕様**:
  - `models` 行は `sources 3 / avatars 4 (clones 1)` のようにソースと総体数を分けて表示し、最適化・メッシュ・マテリアル集計はソースのみ合算します（`meshes` 行の `(rendered N)` は全ハンドルの合計）。
  - 3D ラベルは先頭 4 体、HUD のアバター行は先頭 12 体（`padEnd(6)` 揃え）まで表示し、残りは `… +N more` にまとめます。
  - 折りたたみはヘッダークリックまたは `H` キーで切り替え、状態を `localStorage` に保存します。
  - `?spill=1` では `spill` 行に退避量（MB）・退避件数・読み戻し中の件数・失敗回数を表示します。
  - 予算有効時の `VRAM` 行には `上限 / 超過 / 破棄回数` に加え、予算適応有効時は `scale`・`top`（`(manual)`/`(auto)`）・`need`（必要量）を表示し、`need` が予算超のまま下限（`requiredBytes === pinnedBytes`）に張り付くと `FLOOR` と表示します。
- **高解像度アトラスの注意**: L0 アトラスと縮小テクスチャ L1〜L4 は `DataTexture` の `Uint8Array` を保持するため、VRAM と同規模の JS ヒープも消費します（`?spill=1` では未使用レベルの分が外れます）。4096 はソース 1 体（または予算制限付き）を前提としてください。
- サンプルモデルのライセンス・配布元は [public/models/README.md](../../../public/models/README.md) を参照してください。
