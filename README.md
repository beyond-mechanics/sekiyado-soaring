# SEKIYADO SOARING — 関宿グライダーシミュレーター デスクトップ版 v5

HTML 版（v4）を、インストールして使うデスクトップアプリとして作り直したものです。
Electron + three.js（WebGL2）で動き、Windows・Mac・Linux に対応します。

## インストール

| OS | ファイル | 手順 |
|---|---|---|
| Windows 10/11（64bit） | `SekiyadoSoaring-5.0.0-win-x64.exe` | ダブルクリックして画面の指示に従います。署名なしのため「Windows によって PC が保護されました」と出たら「詳細情報」→「実行」。 |
| macOS | `SekiyadoSoaring-5.0.0-mac-universal.dmg`（GitHub Actions で作成） | 開いてアプリを「アプリケーション」へ。初回は右クリック →「開く」。 |
| Linux | `SekiyadoSoaring-5.0.0-linux-x86_64.AppImage` | 実行権限を付けて起動します。 |

推奨環境：独立 GPU か、最近の内蔵 GPU（Intel Iris Xe / Apple M シリーズ以上）。重い場合はメニューの「画質」を「標準」か「軽量」に。

## v4 からの主な変更

**見た目**
- 大気散乱の空。太陽の位置は関宿の緯度経度・日付・時刻から計算（時刻 6:00〜17:30 を選択可）
- 機体周辺の高解像度の影（樹木・格納庫・機体）、ポストエフェクト（ブルーム、MSAA）
- 航空写真の霞を除去して色を自然に補正。近くでは草や土の細かな模様を重ねて表示
- 航空写真から木立を自動検出し、約 5,000〜15,000 本の樹木（広葉樹・針葉樹）を配置
- 約 300 km 四方の遠景地形（地球の丸みを反映）。筑波山・日光連山・秩父・富士山が地平線に見える
- 上昇気流の上にできる積雲、空を映す川面、風で向きが変わる吹き流し
- 機体を作り直し：翼型断面のある主翼、動く補助翼・昇降舵・方向舵・エアブレーキ・車輪・プロペラ、搭乗者
- コックピット視点：速度計（色帯つき）・TE 昇降計・高度計・回転計／コンパス、ヨーストリング

**飛行モデル**
- 機体の重量・翼面積・揚力傾斜・抗力極曲線から揚力と抗力を計算（グライダー最良滑空比 約 33、Super Dimona 約 24）
- スティックは迎角を指示します。手を離すとトリム速度（`[` `]` で調整）に戻る、実機と同じ速度安定
- 失速と片翼落ち、バンク時の荷重倍数、地面効果、横滑り（ラダー Z/X）
- 風は高度とともに強くなり（対数則）、乱気流あり。上昇気流は周囲に下降気流をともない、風下へ傾きます
- 昇降計は総エネルギー補正（TE）付き。電子音も TE で鳴ります
- 接地速度・沈下率・中心線からのずれ・接地位置で着陸を評価

**操作**
- キーボード、ゲームパッド、ジョイスティック（スロットル軸つきも可）
- 視点 4 種：追尾／コックピット／外部（マウスで回転）／地上の観客。右ドラッグで見回し、ホイールでズーム

キー操作の一覧はアプリの「? 操作」にあります。

## さらに高解像度の航空写真にする（任意）

同梱の航空写真は約 1 m/画素です。国土地理院のタイルから約 0.48 m/画素（ズーム 18）の写真と 5 m 間隔の DEM5A 標高を取り込めます。

1. [Node.js](https://nodejs.org/) 20 以上をインストール
2. このフォルダーで次を実行（数分）
   ```
   npm install
   npm run fetch-gsi
   ```
   出力は `assets/data-hires/` に作られます。軽くしたいときは `npm run fetch-gsi -- --zoom 17`。
3. 次のどちらかで反映します
   - そのフォルダーの中身を、インストール済みアプリのユーザーデータへコピー
     - Windows: `%APPDATA%\sekiyado-soaring\data-hires\`
     - macOS: `~/Library/Application Support/sekiyado-soaring/data-hires/`
     - Linux: `~/.config/sekiyado-soaring/data-hires/`
   - または `npm run dist:win` などでインストーラーを作り直す（同梱されます）

地理院タイルの利用には出典の明示が必要です。部外への配布や公開の前に、[地理院タイルの利用規約](https://maps.gsi.go.jp/development/ichiran.html)を確認してください。

## v5.1 の追加・変更

- **雲**：数千枚あった雲のスプライトを 1 回の描画（インスタンス化）にまとめて軽くしました。太陽の高さ・色で雲の陰影が変わり、逆光では雲の縁が明るく光ります。
- **雲の影**：実際の雲の位置から太陽と反対側の地面へ影を落とします（影は真下ではなく、太陽が低いほど遠く・細長くなります。上昇気流の雲と影の位置関係を練習できます）。影は直射日光だけを弱め、空からの光は残ります。
- **地面**：低空で草地・土の細かな凹凸に光の向きで陰影が付きます（マイクロ法線）。
- **川面**：岸辺を透明へぼかし、2 層の波を重ねて模様の繰り返しを目立たなくしました。
- **樹木**：太陽の方を見ると、葉を透けた光で樹冠が少し明るくなります。
- **フライト録画**：飛行中に `V` で録画開始・停止、`Shift+V` で直近 30 秒を保存します。カメラ・機体・曳航機の位置と姿勢、太陽方向などを JSON でダウンロードフォルダーへ保存します。

### 録画を Blender で再現する

```bash
blender --background --python scripts/blender_import_flight.py -- \
  --data-dir ./assets/data --flight ~/Downloads/sekiyado_clip30s_YYYYMMDD_HHMMSS.json \
  --out ./renders/clip01 --save-blend ./renders/clip01/scene.blend --render
```

標高・航空写真の地形、太陽、カメラの動きを再現し、Beauty・Mist（深度）・Normal パスをマルチレイヤー EXR で書き出します（Blender 4.x では PNG 連番にも分けます）。動画生成 AI の深度・法線ガイドなどに使えます。

## 開発者向け

```
npm install
npm run dev          # ビルドして起動（F12 で開発者ツール）
npm run dist:win     # Windows インストーラー（Linux では wine が必要）
npm run dist:mac     # macOS（Mac 上で実行）
npm run dist:linux   # Linux AppImage
```

GitHub にリポジトリを置けば、`.github/workflows/build.yml` で Windows と Mac のインストーラーを自動で作れます（Actions → Build installers → Run workflow）。

| フォルダー | 内容 |
|---|---|
| `electron/main.cjs` | ウィンドウ、`app://` プロトコル（同梱データと高解像度データの切り替え） |
| `src/sim/` | 飛行モデル（`flight.js`）、大気・上昇気流（`atmosphere.js`）、航空機曳航（`tow.js`） |
| `src/world/` | 空と太陽、地形、景観（樹木・建物・川）、雲 |
| `src/aircraft/models.js` | 機体の 3D モデル |
| `src/ui/cockpit.js` | コックピット計器 |
| `scripts/` | ビルド、遠景標高の作成、地理院タイルの取得 |
| `assets/data/` | 地形・航空写真データ |

## 注意

簡易化した飛行モデル・近似 3D モデルです。**実機訓練や航法には使用できません。** 出典とライセンスは `THIRD_PARTY_NOTICES.md` を参照してください。
