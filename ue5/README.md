# 関宿SIM Unreal Engine 5 版（試作）

既存の Electron＋three.js 版（リポジトリ直下）には手を入れず、ここで UE5 版を並行開発します。
計画書：「関宿SIM Unreal Engine 5 移植計画」（Claude Doc）https://claude.ai/artifact/41bsipEDrp6M9PrC8Dkv7X

## 構成

| 場所 | 中身 | UE が必要か |
| --- | --- | --- |
| `SekiyadoUE/Source/SekiyadoUE/FlightCore/` | 飛行コア（大気・飛行モデル・曳航）。`src/sim/*.js` の 1 対 1 移植、UE 非依存の C++17 | 不要 |
| `SekiyadoUE/` | UE プロジェクト。`GliderPawn`（固定 120 Hz で飛行コアを回す）、簡易 HUD、GameMode | 要 |
| `tests/` | JS 版と C++ 版の一致テスト（7 シナリオ：滑空・サーマル旋回・失速・バンク補助・着陸・ダイモナ離陸・航空機曳航） | 不要 |
| `tools/make_landscape_heightmap.mjs` | 同梱標高データ → Landscape 用 16bit 高さマップ＋読み込み設定 | 不要 |

座標：飛行コアは JS 版と同じ x=東・y=上・z=南（m）。UE は X=北・Y=東・Z=上（cm）。変換は `SekiyadoCoords.h` だけで行います。

## 一致テスト（クラウドでも GitHub Actions でも動く）

```
./ue5/tests/run.sh
```

JS 版で参照軌跡を作り、C++ 版を同じ操作で動かして位置・速度・角度の差を比べます。許容誤差は位置 5 cm・速度 1 cm/s・角度 0.001 rad です（現状の実測差は 1e-10 m 程度）。
`src/sim/` の JS を変えたら C++ も同じように直さないとここで落ちます。Actions の `ue5-flightcore.yml` が Linux（g++）と Windows（MSVC）で毎回回します。

## 本人 PC での最初の手順（段階 1）

1. Epic Games Launcher で Unreal Engine 5.7 以降を入れる。
2. Visual Studio 2022 を「C++ によるゲーム開発」ワークロード付きで入れる。
3. `ue5/SekiyadoUE/SekiyadoUE.uproject` を右クリック →「Generate Visual Studio project files」、その後ダブルクリックで開く（初回は C++ のビルドを聞かれるので「はい」）。
   - 5.7 以外の版を入れた場合は、開くときに出る「別の版で開く」で入れた版を選ぶ。
4. File → New Level →「Basic」で空のレベルを作り、Play。何もないレベルでも標高 10 m の平地として飛べます。
5. 地形を入れる場合：`node ue5/tools/make_landscape_heightmap.mjs` を実行 → Landscape モード → Import from File で `ue5/SekiyadoUE/RawData/sekiyado_heightmap_1009.png` を選び、同じ名前の `.json` に書かれた Location と Scale を入れる。
6. ビルドエラーか、飛んでいる画面のスクリーンショットをスレッドに貼ってください。

### 操作（Electron 版と同じ）

| キー | 操作 |
| --- | --- |
| ← → | 補助翼 |
| ↑ ↓ | 昇降舵（↓ で機首上げ） |
| Z / X | 方向舵 |
| [ / ] | トリム −/+ 5 km/h |
| B | エアブレーキ |
| R | 曳航索の切り離し |
| E | エンジン（ダイモナ） |
| C | 視点（操縦席／後方） |
| Backspace | やり直し |

機体の種類・発航方法（空中／航空機曳航／自力離陸）・風・サーマルは、レベルに置いた GliderPawn の詳細パネル（Sekiyado 欄）で変えられます。

## 未確認・既知の点

- UE のビルドはまだ一度も通していません（クラウドに UE が無いため）。最初のビルドでエラーが出たら直します。
- 同梱の標高データには欠測（0 m）の点が散らばっていて、高さマップに黒い点として出ます。DEM5A を取り直すか穴埋め処理を入れます。
- 機体は仮の板です。計器は文字表示です。
