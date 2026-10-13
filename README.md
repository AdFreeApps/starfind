# Starfind（仮称）— スマホを空にかざす星空マップ

ブラウザだけで動く星空ガイドです。iPhone Safari（HTTPS）を主な対象にしています。
素の HTML / CSS / JavaScript（ES modules）で、ビルド手順も外部ライブラリもありません。

## 動かし方（ローカル）

```sh
cd skymap
python -m http.server 8000
# → http://localhost:8000/ をブラウザで開く
```

`file://` では動きません（ES modules と fetch のため）。
センサー（DeviceOrientation）と位置情報は **HTTPS か localhost** でしか使えません。
スマホ実機で試すときは GitHub Pages に置くのが簡単です（下記）。

テスト用 URL パラメータ（例）:
`index.html?t=2026-10-15T20:00:00%2B09:00&lat=34.57&lon=135.48&mode=manual&target=Cyg&az=327&alt=70&fov=60&lang=ja`
（`t` 時刻, `lat`/`lon`, `az`/`alt`/`fov` 視線, `target` 案内先（`con:Cyg`, `star:Albireo`, `planet:saturn`, `ast:ST` …）,
`select` 情報カード, `panel=search`, `night=1`, `lang=en`, `twinkle=0`, `onboard=0|1`）

## 主な機能

- センサーモード（スマホを空にかざす）と手動モード（ドラッグ・ピンチ・ホイール・矢印キー・ダブルクリック）。端末の機能で自動判定（UA は見ない）。PC は手動・広い視野で起動
- 表示切替：星、星の名前、星座、メシエ天体（110）と南天の天体、惑星、太陽・月、流星群（13、活動中を強調）、天の川、地平線と地面、方位・高度の線、赤道・黄道、星座の境界
- 検索（星・星座・惑星・メシエ天体・流星群・星の並び）と案内（矢印・円・「あと右へ◯°・上へ◯°」）
- 検索を開くと「今夜見えるおすすめ」：その場所・時刻の空から計算（南半球・赤道付近・高緯度にも対応）。星の並び（夏の大三角、冬のダイヤモンド、北斗七星、南天のポインター、天の南極の見つけ方など）は選ぶと専用の線で表示
- 情報カード（明るさ・距離・星座・いまの位置・出入り）、時間移動（日時指定・±1時間/日・早送り・時刻を戻す）
- 夜間モード（赤）、画面を暗く、画面の点灯維持（Wake Lock）、太陽に向けた時の警告
- 多言語（ja / en、天体名は zh-Hant / zh-Hans / ko も）
- 初回だけ、いま一番見やすい天体を案内するデモと「ほかの星もさがせます」の吹き出し

## テスト

```sh
node test/astro_test.js        # 天文計算（Meeus の例題と JPL Horizons の値で照合）
node test/orientation_test.js  # 端末の向き → 視線方向の計算
```

`test/screenshots/cygnus_2026-10-15_2000_sakai.png` は Edge headless（DPR 3）で撮った確認用画像です
（2026-10-15 20:00 JST・堺、はくちょう座）。

## ファイル構成

| パス | 内容 |
|---|---|
| `index.html`, `style.css` | 画面。文字列はすべて `i18n/*.json` から入る |
| `js/astro.js` | 天文計算（恒星時、歳差、赤道→地平、太陽・月・惑星、出没、星座判定）。DOM 不使用 |
| `js/orientation.js` | DeviceOrientation → 視線ベクトル、iOS コンパス補正、平滑化。天文計算とは独立 |
| `js/render.js` | 2D キャンバス（星・線・名前・惑星・月・案内） |
| `js/skygl.js` | WebGL 背景（空の色、天の川、地面）。WebGL が無い時は render.js が代わりに描く |
| `js/catalog.js` | データ読み込み、星の並び（アステリズム）、南天の天体、検索 |
| `js/i18n.js`, `i18n/*.json` | 多言語（ja / en は全文、zh-Hant / zh-Hans / ko は天体名のみ） |
| `js/app.js` | UI・状態・入力・おすすめ・初回案内 |
| `data/` | 変換済みデータ（下記） |
| `tools/build_data.py`, `tools/build_milkyway.py`, `tools/names_ja.py` | データ変換スクリプトと日本語名 |
| `test/` | Node テストとスクリーンショット |
| `licenses/` | 第三者ライセンス文 |

Swift などへ移植しやすいよう、`astro.js` と `orientation.js` は純粋関数中心で、画面や DOM に依存しません。

## このアプリのライセンス

Starfind のプログラムは **MIT ライセンス**です（`LICENSE`）。自由に使い、改造し、配ってかまいません。著作権表示（AdFreeApps）とライセンス文は残してください。星のデータなど第三者のデータは、それぞれのライセンスに従います（下の表）。

## データの出典とライセンス

将来ネイティブアプリ（App Store）にする可能性を考え、CC BY-SA などの継承型ライセンスのデータは使っていません。

| データ | 出典 | ライセンス・注意 |
|---|---|---|
| 恒星（9,096 個、約 6.5 等まで。位置・等級・B−V・HR 番号・視差） | Yale Bright Star Catalogue 5th Revised Ed.（Hoffleit & Warren 1991）, CDS VizieR V/50 <https://cdsarc.cds.unistra.fr/ftp/V/50/> | NASA/CDS が配布するカタログで、一般にパブリックドメイン扱い。出典の明記を推奨 |
| 恒星の固有名（英語）と HR・HIP 対応 | IAU Catalog of Star Names（WGSN）, E. Mamajek 版テキスト <https://www.pas.rochester.edu/~emamajek/WGSN/IAU-CSN.txt>（2022-04-04 版） | 名前は事実情報。IAU は出典明記を求めている（IAU 制作物は CC BY 4.0） |
| 星座線・星座境界・星座の中心・天の川の輪郭・メシエ天体の位置・各国語の星座名（zh, ko, es, fr, de） | d3-celestial（Olaf Frohn）<https://github.com/ofrohn/d3-celestial> の `constellations.lines.json`, `constellations.json`, `constellations.bounds.json`, `mw.json`, `messier.json` | **BSD-3-Clause**。再配布時は著作権表示とライセンス文が必要 → `licenses/d3-celestial-LICENSE.txt`。アプリ内の「使い方」にも記載 |
| 天の川テクスチャ `data/milkyway.jpg` | 上記 `mw.json` の輪郭から `tools/build_milkyway.py` で生成（ノイズと暗黒帯は手続き的に追加） | 派生物（BSD-3-Clause の条件に従う） |
| 惑星の軌道要素 | JPL "Approximate Positions of the Planets"（Standish）<https://ssd.jpl.nasa.gov/planets/approx_pos.html> | 米国政府の著作物（パブリックドメイン） |
| 検証用の基準値 | JPL Horizons API（テストのみで使用。アプリには含まない） | — |
| 日本語の星座名 88、恒星名 約110、メシエ天体の日本語名、解説文、流星群の表（放射点・期間・極大・ZHR）、アステリズムの定義、南天の天体の座標 | このプロジェクトで作成（流星群は IMO の流星群カレンダー等で一般に知られた値を要約した事実情報） | 自作 |

距離（光年）: 主な恒星は現代の値を丸めて手入力（`tools/names_ja.py`）。それ以外は BSC5 の古い三角視差から計算し、
アプリでは「古い測定値」と表示します。

## 確認したこと

- **天文計算**（`node test/astro_test.js`、全項目合格）
  - グリニッジ恒星時：Meeus 例題 12.a と 0.001° 以内
  - 歳差：Meeus 例題 21.b と 0.002° 以内
  - 天の北極の高度 = 緯度、ポラリスの高度 ≈ 緯度（34.65° vs 34.57°）
  - 2026-10-15 20:00 JST・堺で JPL Horizons と比較：太陽 0.005°、月 0.10°（地心でなく観測地点からの位置）、
    水星〜海王星 0.001〜0.08°。高度・方位も同程度
  - 月の輝面比 21.2%（Horizons 21.1%）、満ちていく月
  - 金星・木星・火星の等級が Horizons と 0.1 等以内
  - 日の出 6:03、日の入り 17:24（堺、10/15）
  - 星座判定（球面上の多角形）：はくちょう座・こぐま座・はちぶんぎ座など 9 点
- **向きの計算**（`node test/orientation_test.js`）：縦持ち・横持ち・平置き・傾き・方位補正の各姿勢で、
  カメラ方向と画面の上方向が期待どおり
- **画面**：Edge headless（DPR 3）と Playwright（390×844、1280×800）で、はくちょう座の夕方の空、南の地平線、
  昼の空と太陽の警告、夜間モード、南半球（シドニー）、検索とおすすめ、情報カード、英語表示を目視確認。
  コンソールエラーなし

**実機のセンサー（ジャイロ・コンパス）は試せていません。** iPhone での向きと方位の正しさは、実機での確認が必要です。

## 既知の制限

- iOS の `webkitCompassHeading` は磁北基準です。磁気偏角（初期値 −7.5°、関西）を足しています。
  iOS が縦持ちでどの軸の方位を返すかは機種や OS で違う可能性があり、ずれる場合はメニューの「微調整」で合わせます。
- 精度は約 0.1〜0.5°（章動・光行差・大気差は省略）。惑星の近似式は 1800〜2050 年が対象です。
- 時刻はスマホのタイムゾーンで表示します（指定した場所の現地時刻ではありません）。
- 恒星は約 6.5 等まで。恒星の固有運動は無視しています。
- 天の川の細かい模様は輪郭データとノイズによる表現で、実際の写真ではありません。
- zh-Hant / zh-Hans / ko は天体名だけで、画面の文は英語になります。
- 流星群の放射点は極大日の位置で固定です。
- オフライン動作（Service Worker）はまだありません。

## GitHub Pages に置くには

1. GitHub に新しいリポジトリを作る（例 `starfind`）。
2. この `skymap/` フォルダの中身をリポジトリのルートに置いて push する
   （`tools/` と `test/` は無くても動きます）。
3. リポジトリの Settings → Pages → "Deploy from a branch" で `main` / `/(root)` を選ぶ。
4. 数分後に `https://<ユーザー名>.github.io/starfind/` で開ける（HTTPS なのでセンサーと位置情報が使える）。
5. iPhone では「空にかざして見る」を押すと、動きと向きの許可、位置情報の許可を順に求められます。
   ホーム画面に追加するとフルスクリーンで使えます。

独自ドメイン（例 starfind.app）を使う場合は、Pages の Custom domain に入れて DNS を設定します。

## プライバシー

広告・解析・追跡なし。実行時の通信はアプリ自身のファイルの読み込みだけです（CSP で他のサイトへの通信を禁止）。
位置情報は端末内の計算だけに使い、保存するときは小数 2 桁（約 1 km）に丸めます。設定は localStorage だけに保存します。

## データを作り直すには

```sh
# ダウンロード（作業用フォルダで）
curl -o bsc5.dat.gz https://cdsarc.cds.unistra.fr/ftp/V/50/catalog.gz && gzip -d bsc5.dat.gz
curl -o iaucsn.txt https://www.pas.rochester.edu/~emamajek/WGSN/IAU-CSN.txt
for f in constellations.lines constellations constellations.bounds mw messier; do
  curl -o $f.json https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/$f.json; done
mv constellations.lines.json lines.json; mv constellations.json cons.json; mv constellations.bounds.json bounds.json
# 変換（numpy と Pillow が必要）
python -I tools/build_data.py <作業用フォルダ> data
python -I tools/build_milkyway.py <作業用フォルダ>/mw.json data/milkyway.jpg
```
