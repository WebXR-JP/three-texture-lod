# src/lib AGENTS.md

距離ベース・テクスチャ LOD ライブラリ本体の開発ルールと不変条件です。

## three への依存方針

- `src/lib/` 全体で `three` からの値 import を行わず、`import type` のみを使います。これにより `WebGPURenderer` / WebGL2 両対応と、GPU なし Node 環境でのテストを維持します。
- テクスチャ判定は `instanceof Texture` を使わず、`isTexture === true` のダックタイピングで行います。
- 型定義 `TextureSlotOf<M>` はマテリアル型から `Texture | null | undefined` プロパティを抽出します（`any` 型プロパティは除外）。`colorNode` 等で独自に `texture()` を組むマテリアルは自動抽出対象外のため、`createVariant` フックでレベルごとのノードを組み立てます。

## バリアント共有の契約（`TextureLodSet`）

- 同一内容（全スロットの `Texture` が同一）のレベルは同じマテリアル実体を共有します。共有バリアントの名前は `#lod0-2` のような形式になります。
- `createVariant` フックは共有グループの先頭レベルで 1 回だけ呼ばれ、戻り値のマテリアルがグループ内で共有されます。`canonicalLevel(level)` で属するグループの先頭レベル番号を取得できます。
- `variant(i)` は共有時に同じマテリアル実体を返すため、呼び出し側で共有先のマテリアルを個別に書き換えないでください。
- `syncFromBase()` はカスタムノードを `base` の内容で上書きします。
- ヒステリシスバンドが重なるレベル定義（$T[i](1 + h) \ge T[i + 1](1 - h)$）はセット生成時に `Error` で拒否します。

## グループ管理と距離判定

- `addGroup(bindings, { anchor })` は複数メッシュをアンカー 1 つの距離で連動させ、統計もグループ単位で集計します。グループ内の全セットは距離境界とヒステリシスを一致させる必要があります。
- `computeLodDistance` はカメラのワールド位置とバウンディング球のみを使い、FOV・ズーム・正射影は考慮しません。

## 常駐管理と予算適応（`TextureLodManager`）

- **ピン留めと破棄**: `'evict'` 時も最粗レベルはピン留めされ破棄対象になりません。`texture.dispose()` は GPU 側リソースのみ解放し CPU 側の `image` は残るため、復帰時は再アップロードが走ります。LOD 管理外のメッシュと同じ `Texture` を共有する場合は `'keep-all'` を使います。
- **推定・実測バイト数**: `residentBytes`・`requiredBytes`・`pinnedBytes` は `estimateTextureBytes` により算出します。非圧縮テクスチャは RGBA8（4バイト/画素）× ミップマップ係数 4/3 の推定値、`CompressedTexture`（`isCompressedTexture === true`）は `mipmaps[].data.byteLength` の合算値（Cube 構造時は各面の `mipmaps` 合算）を使い、スロット単位で圧縮・非圧縮が混在してもそのまま合算します。`requiredBytes`（現用＋最粗の必要量）と `overBudgetBytes`（`residentBytes` 基準の超過量）は別指標です。
- **圧縮テクスチャのミップスライス**: `sliceCompressedTexture` は `source.clone()` による `Source` 共有破壊を避けるため `source.constructor` で独立インスタンスを生成し、`needsUpdate = true` を設定します（`mipOffset === 0` は元インスタンスを返却）。`createCompressedTextureMipLevels` は長辺上限配列と `minDimension`（既定 `4`、ブロック圧縮の基底サイズ制約対策）でミップを選び、同一オフセット間でインスタンスを共有します。2D `CompressedTexture` のみ対応（Cube / Array は未対応）。
- **上限キャッシュ（`maxResidentBytes`）**: `update()` 内でのみ適用され、超過分について未参照（`refs === 0`）かつ非ピン（`pins === 0`）のテクスチャを最終使用の古い順（同時刻なら推定バイトの大きい順）に猶予を待たず破棄します。現用中とピン留めは保護するため、上限まで下げられない場合は超過を許容します。`evictDelayMs: Infinity` との併用で時間破棄なしの容量キャッシュになります。
- **予算適応（2軸制御）**: `adaptiveThresholdScale` 有効時は、予測常駐量（`requiredBytes`）が予算内に収まるよう「距離しきい値スケール（判定距離を `d / scale` に読み替え）」と「Tier 上限（`finestLevel`、`levelCap: false` で無効化可）」の 2 軸で制御します。手動設定の `finestLevel` は適応の下限として常に効きます。
- **適応の応答特性**: 引き下げは即時・複数段で行い、引き上げは `predict(1段上) <= 0.9 * budget` のときのみ 1 段/秒（引き下げ後の冷却 3 秒）で行います。予算が最粗レベルの合計より小さい場合などは下限（スケール既定 `0.05`・cap 最粗、`requiredBytes === pinnedBytes`）に張り付き超過が残ります。cap 変更に連動して再予測するため `scaleRaiseCount` が増えることがあります。
- **非表示グループ**: `visible === false` のグループは判定を飛ばして参照を保持するため、上限破棄でも解放できません。
- **併用制限と動的変更**: `'keep-all'` と `maxResidentBytes` / `adaptiveThresholdScale` の併用、および `thresholdScale` と `adaptiveThresholdScale` の同時指定は `Error` になります。`setMaxResidentBytes` / `setThresholdScale` / `setFinestLevel` はマネージャ再構築なしで更新できます（`setFinestLevel` の負値・非整数は `RangeError`、最大レベル超はセットの最粗でクランプ）。

## 画素データの退避（`TextureSpillCache`）

- **退避の契機**: マネージャは `spillCache` 指定時、`evict` で `dispose()` したテクスチャの画素データを退避します。読み戻したまま未参照・非ピンで終わった分は、次の掃引で猶予を待たずに再退避します（書き込み済みならストアへは書き直しません）。
- **表示前の読み戻し待ち**: レベル切替は、そのレベルの全束縛・全スロットの画素データが揃ってから行います。揃うまでは現在のレベル（初回は最粗レベル）を保ち、上限（`cap`）より細かいまま待つ場合があります。待機中のテクスチャは同じ `update()` の掃引で再退避しません。
- **状態の単位と寿命**: 退避状態は `texture.source` 単位でキャッシュが持ち、マネージャの作り直しをまたいで引き継ぎます。新しいマネージャは退避中のテクスチャを破棄済み（`residentBytes` 対象外）として登録します。
- **対象と契約**: 退避対象は次のとおり（画素・圧縮内容は登録後に変わらないものとして扱う）。
  - `DataTexture` 等の TypedArray 画像（`Uint8Array`・`Float32Array`・`Uint16Array` 等、`SharedArrayBuffer` 除く）
  - `CompressedTexture`（2D / Array / Cube）およびミップ配列を持つ `DataTexture`（KTX2 生データ等）。`sliceCompressedTexture` による共有ミップオブジェクトは書き換えず、`mipmaps` 配列をスタブ配列（`recordSpilledMipBytes` で元の実バイト長を保持）へ差し替えることで共有先レベルを壊さず `estimateTextureBytes` を維持する
  - `ImageBitmap`・`HTMLImageElement`・`HTMLCanvasElement`・`OffscreenCanvas`・`ImageData` を持つ通常 `Texture` / `CanvasTexture`（退避中は `source.data = { width, height }` として `estimateTextureBytes` を維持し、`ImageBitmap.close()` は `spilled` 確定時にのみ呼ぶ。`HTMLImageElement` が `complete === false` の間は保留し、復元時は `ImageBitmap` 化せずキャンバスで戻す）
  - レンダーターゲット・深度・動画・`HTMLTexture`・非圧縮 `CubeTexture`・未対応形式は退避しない。抽出や書き込みに失敗した画像は以後退避せず、読み戻しに失敗した画像は準備済みにならないまま `failureCount` に数える。
- **OPFS ストア**: `openOpfsPixelStore` はページごとのセッションディレクトリを Web Locks のロックで示し、開くときにロックのないディレクトリ（閉じたページの残り）を削除します。

## テスト

- 時刻依存のテストは `now` オプションを注入して進めます。
- 予算適応の境界条件・収束性はファズテスト（`texture-lod-manager.adaptive.fuzz.test.ts`）を含め `pnpm test` で検証します。
