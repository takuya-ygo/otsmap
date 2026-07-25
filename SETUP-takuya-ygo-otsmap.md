# takuya-ygo/otsmap 導入手順

対象リポジトリ: `takuya-ygo/otsmap`

## 1. ファイル配置

このZIPを展開し、リポジトリ直下へ中身をすべて配置します。

直下に次が見える状態にします。

- `.github/workflows/update-map.yml`
- `config/scrape.json`
- `docs/index.html`
- `docs/config.js`
- `scripts/scrape.mjs`
- `package.json`

## 2. Google Mapsブラウザ用キー

Google Cloudで Maps JavaScript API を有効化し、HTTPリファラー制限を次にします。

`https://takuya-ygo.github.io/otsmap/*`

`docs/config.js`の次の箇所を置換します。

```js
window.OTS_MAP_CONFIG = {
  googleMapsApiKey: 'ここにブラウザ用APIキー',
  mapId: 'DEMO_MAP_ID'
};
```

## 3. Geocoding用キー

Google Cloudで Geocoding API を有効化した別キーを作成します。

GitHubリポジトリで以下を開きます。

`Settings → Secrets and variables → Actions → New repository secret`

- Name: `GEOCODING_API_KEY`
- Secret: Geocoding API用キー

## 4. GitHub Pages

`Settings → Pages → Build and deployment → Source` を **GitHub Actions** にします。

この版は日次更新と同じワークフローからPagesを直接デプロイします。

## 5. 初回実行

`Actions → Update and deploy OTS map → Run workflow → Run workflow`

成功後の公開先:

`https://takuya-ygo.github.io/otsmap/`

## 6. 失敗した場合

Actionsの実行結果から、赤くなったステップ名とログを確認します。`ots-map-diagnostics` が表示された場合はダウンロードすると、画面キャプチャ・HTML・途中取得データを確認できます。
