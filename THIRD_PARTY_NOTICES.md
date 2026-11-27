# 出典とライセンス

- **地理院タイル**（国土地理院）：全国最新写真（シームレス）、数値標高モデル DEM5A・DEM10B を加工して使用。
  https://maps.gsi.go.jp/development/ichiran.html
  航空写真は霞を減らすため色調補正（レベル補正）しています。樹木の位置は航空写真の色から自動推定した近似です。
- **Terrain Tiles**（Mapzen / AWS Open Data、terrarium 形式）：遠景（約300km四方）の標高に使用。
  元データの出典：SRTM、GMTED2010、ETOPO1 ほか。https://github.com/tilezen/joerd/blob/master/docs/attribution.md
- **ESA WorldCover 10 m 2021 v200**（CC BY 4.0、AWS Open Data）：遠景（約300km四方）の土地被覆（森・畑・市街地・水面など）に使用。
  © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium.
  https://esa-worldcover.org/ 　縮小・分類ごとの色付けを加えて使用（scripts/build-far-landcover.mjs）。
- **関宿滑空場 ご利用の手引き**：滑走路の配置の参考。https://www.sekiyado-gf.jp/?page_id=39
- **three.js**（MIT License）© 2010-2024 three.js authors
- **Electron**（MIT License）© Electron contributors / GitHub Inc.

機体の3Dモデルは写真や一般的な形状を参考にした近似で、実機の CAD データではありません。
本ソフトは簡易的な飛行モデルによる体験用です。実機訓練や航法には使用できません。

## 地面の PBR 素材（assets/data/pbr）

Poly Haven（https://polyhaven.com）の CC0 素材を 1K に縮小して同梱しています（aerial_grass_rock、brown_mud_leaves_01、asphalt_02。作者 Rob Tuytel）。CC0 のため表示義務はありませんが、出典として記します。詳細は assets/data/pbr/CREDITS.json。
