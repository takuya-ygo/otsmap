# 遊戯王 OTS 自動更新マップ

KONAMI CARD GAME NETWORKの店舗検索画面をPlaywrightで確認し、日本の店舗をJSON化してGoogle Maps JavaScript APIで表示する構成です。GitHub Actionsを毎日実行し、店舗の追加・削除・変更を地図へ反映します。

> **重要** 公式ページには掲載データの無断転用・転載を禁じる表示があります。公開・第三者配布を行う前に、KONAMIへ利用目的と取得頻度を伝えて許可条件を確認してください。本プロジェクトは、許可済みの利用または個人検証を前提とする技術テンプレートです。

## 仕組み

1. GitHub Actionsが毎日03:17（日本時間）に起動
2. Playwrightが店舗検索ページを開き、画面上の店舗リンクとJSON通信を収集
3. 店舗ID・名称・住所・電話・座標を正規化
4. 座標がない新規店舗だけGoogle Geocoding APIで住所から座標化
5. `docs/stores.json`を更新し、GitHub PagesのGoogleマップへ反映
6. 取得件数が50件未満になった場合は異常とみなし、既存地図を上書きしない

## 導入手順

### 1. GitHubへ登録

このフォルダー一式を新しいGitHubリポジトリへアップロードします。公開範囲は、利用条件に合わせて設定してください。

### 2. Google Maps Platformを設定

Google Cloudで次を有効化します。

- Maps JavaScript API
- Geocoding API（KONAMI側から緯度経度を取得できない店舗用）

APIキーは2本に分けることを推奨します。

#### ブラウザ用キー

`docs/config.js`の `YOUR_BROWSER_API_KEY` を置換します。HTTPリファラー制限を設定し、次のようにGitHub PagesのURLだけを許可します。

```text
https://ユーザー名.github.io/リポジトリ名/*
```

API制限は **Maps JavaScript API** のみにします。ブラウザ用キーはWebページから閲覧できるため、リファラー制限が必須です。

#### Geocoding用キー

GitHubリポジトリの **Settings → Secrets and variables → Actions → New repository secret** で次を登録します。

```text
Name: GEOCODING_API_KEY
Value: Google Geocoding API用キー
```

このキーのAPI制限は **Geocoding API** のみにします。GitHub ActionsのIPは固定ではないため、IP制限よりAPI制限と使用量上限を設定してください。

### 3. 初回取得

GitHubの **Actions → Update OTS map → Run workflow** を実行します。

成功すると以下が更新されます。

- `data/raw-stores.json`: 取得した店舗一覧
- `data/geocode-cache.json`: 住所から座標を取得した結果
- `docs/stores.json`: 地図表示用データ

失敗時はActions実行画面の `ots-map-diagnostics` に、画面キャプチャ・HTML・通信候補・途中取得店舗が保存されます。

### 4. GitHub Pagesを公開

リポジトリの **Settings → Pages** で以下を設定します。

- Source: Deploy from a branch
- Branch: `main`
- Folder: `/docs`

表示URLは通常、次の形式です。

```text
https://ユーザー名.github.io/リポジトリ名/
```

## ローカル確認

Node.js 20以上を使用します。

```bash
npm install
npx playwright install chromium
npm run scrape
GEOCODING_API_KEY=キー npm run geocode
npm run validate
```

地図画面はローカルHTTPサーバーで確認します。

```bash
python -m http.server 8000 --directory docs
```

ブラウザで `http://localhost:8000` を開きます。ブラウザ用Google Mapsキーには、必要に応じて `http://localhost:8000/*` もリファラー許可してください。

## サイト改修時の調整

KONAMI側の画面構造や通信形式が変わると取得が停止する可能性があります。安全のため、最低件数を下回る場合は更新処理全体が失敗します。

主な調整箇所：

- `config/scrape.json`: 候補URL、最低件数、待機時間
- `scripts/scrape.mjs`: 同意ボタン・国選択・検索・ページ送り
- `scripts/lib.mjs`: JSON項目名の候補

検索結果が非常に少ない地域だけを対象にする場合は、`.github/workflows/update-map.yml` と `config/scrape.json` の最低件数を同じ値へ変更してください。

## Google マイマップを使わない理由

Google マイマップはCSVやスプレッドシートを読み込めますが、更新時はレイヤーの「再インポート」を手動で行う方式です。毎日の完全自動更新には、データJSONを直接読み込めるMaps JavaScript APIの方が適しています。

## 注意事項

- GitHub Actionsの定期実行は、混雑時に遅れる場合があります。
- 公開リポジトリは長期間活動がないと、定期ワークフローが停止する場合があります。
- Google Maps PlatformはAPIキーと請求先設定が必要です。予算アラート・API上限を設定してください。
- 取得頻度は1日1回に抑えています。短時間の大量アクセスへ変更しないでください。
- 店舗名・住所等の利用条件、商標表記、プライバシー、データ保持条件は権利者と各APIの規約に従ってください。
