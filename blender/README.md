# Blender で作る機体・小物

`blender/` のスクリプトは、Blender（bpy）で機体や飛行場の小物を**手順として**組み立て、
glTF（`.glb`）に書き出します。手で作ったモデルと同じく、書き出した `.blend` を開けば Blender 上で直接直せます。
スクリプトを直して再実行すれば、何度でも同じものが作り直せます。

| スクリプト | 出力 | 内容 |
|---|---|---|
| `aircraft/duo_discus_t.py` | `assets/data/models/duo_discus_t.glb`（LOD0）・`duo_discus_t_lod1.glb`（LOD1） | 複座グライダー Duo Discus T の外形 |

## 作り直す

```bash
# Blender 本体で
blender -b --factory-startup -P blender/aircraft/duo_discus_t.py -- --out assets/data/models --blend duo_discus_t.blend --render renders/duo.png
# Python の bpy モジュールでも同じ（pip install bpy==4.2.0、Python 3.11）
python blender/aircraft/duo_discus_t.py --out assets/data/models
```

- `--blend`：編集用の `.blend` を保存（LOD0 と LOD1 が別コレクション）
- `--render`：Cycles でプレビュー画像（`--views front34,side,nose,rear34`、`--samples`）
- シム（three.js）での見え方は `node scripts/model-preview/run.mjs renders/model-preview`（Playwright が必要）で、従来の形と並べて撮れます。

GitHub Actions の「Blender models」が、`blender/` を変えたブランチで Blender 4.2 LTS と 5.2 LTS の両方で実行し、`.glb` とプレビューを成果物に残します。

## 決まりごと（ほかの機体・小物を足すとき）

- **座標**：スクリプトの中は「シム座標」（右 +x・上 +y・後ろ +z、機首は -z、単位 m）で書き、`common.sim()` で Blender に渡す。glTF は Y-up で書き出すので、three.js にはそのまま、UE5 には読み込み時の自動変換で入ります。
- **原点**：機体は重心付近。地上では原点が地面から `gearH`（`src/sim/flight.js`）の高さ。小物は接地面の中心。
- **動く部品**：名前つきのノードにし、原点をヒンジ上に、ローカル X（方向舵はローカル Y）をヒンジ軸に合わせる。名前は `aileron_L/R`・`elevator`・`rudder`・`airbrake_L/R`（ローカル Y にせり上がる。移動量は extras の `travel`）・`wheel_*`・`prop`。
- **LOD**：LOD0（近く・コックピット用）と LOD1（遠景・画質「低」用、LOD0 の 1/5 程度）を必ず両方。LOD1 のノード名は `名前_LOD1`（UE5 の命名と同じ）。
- **マテリアル**：Principled BSDF の基本色・粗さ・金属・クリアコート・アルファだけ（glTF の metallic-roughness と KHR_materials_clearcoat に載る範囲）。テクスチャを使うときは 2K まで。
- **写真**：参考にした部員の写真はリポジトリにもビルドにも入れない（顔が写っているため）。登録記号（JA…）も入れない。
- **寸法**：公開諸元と写真からの目測で作る近似形状。メーカー図面や市販モデルの複製はしない。
