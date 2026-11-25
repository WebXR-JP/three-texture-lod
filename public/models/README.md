# サンプルVRMモデル

このディレクトリの `.vrm` はリポジトリに含めず、`pnpm models:fetch` で取得する。
デモに自分のVRMを使う場合は、このディレクトリへ置くか、デモ画面へドラッグ&ドロップする。

## 取得元

- 配布元リポジトリ: https://github.com/madjin/vrm-samples
- 取得URLは commit `e16eb187100149a315ad92c3c9968f1d5baa6c7d` に固定
- 元モデル: VRoid Studio サンプルモデル AvatarSample_A / B / C（pixiv Inc.）
- モデルページ: https://hub.vroid.com/en/characters/2843975675147313744/models/5644550979324015604
- 利用条件: https://vroid.pixiv.help/hc/ja/articles/4402394424089

## ライセンス上の注意

AvatarSample_A / B / C は **CC0 ではない**。VRoid の利用条件の範囲で、
無償利用・改変・再配布が許可されている。特に次の行為は禁止されている。

- モデルの VRM ライセンスを CC0 に設定すること
- 正当な理由なく有償で再配布すること
- モデルのデータを使ってキャラクター作成サービスを構築すること
- pixiv が推奨・保証していると誤認させる使われ方

デモのスクリーンショットを公開する場合も、この条件に従うこと。
条件を確認できない場合は、自分の権利で利用できるモデルに差し替えること。

## ハッシュ

`scripts/fetch-models.mjs` は取得物の SHA-256 を固定している。
取得元が更新された場合は、内容とライセンスを確認してからハッシュを更新する。
