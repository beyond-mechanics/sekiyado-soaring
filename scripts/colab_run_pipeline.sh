#!/usr/bin/env bash
# Google Colab（GPU ランタイム、L4 / A100 推奨）で、フライト録画から AI 実写風動画までをまとめて実行する。
# Colab のセルで（リポジトリを clone して、その中で）:
#   !bash scripts/colab_run_pipeline.sh /content/drive/MyDrive/sekiyado_clip30s.json /content/drive/MyDrive/sekiyado_renders/run01
# 出力先は Google ドライブの中にすること（Colab のランタイムが切れると /content の中身は消える）。
set -euo pipefail

FLIGHT_JSON="${1:?第1引数にフライト JSON のパスを指定してください}"
OUT_DIR="${2:?第2引数に出力先（Google ドライブ内のフォルダー）を指定してください}"
DURATION_SEC="${3:-28}"
BACKEND="${4:-diffusers}"

BLENDER_VER="4.2.3"  # 4.2 LTS（コンポジターで PNG 連番を書き出すため 4.x を使う）
BLENDER_DIR="/opt/blender-${BLENDER_VER}-linux-x64"
if [ ! -x "${BLENDER_DIR}/blender" ]; then
  echo "[COLAB] Blender ${BLENDER_VER} を入れています"
  wget -q "https://download.blender.org/release/Blender4.2/blender-${BLENDER_VER}-linux-x64.tar.xz" -O /tmp/blender.tar.xz
  tar -xf /tmp/blender.tar.xz -C /opt
  rm -f /tmp/blender.tar.xz
fi
apt-get -qq install -y ffmpeg > /dev/null
if [ "${BACKEND}" = "diffusers" ]; then
  pip install -q --upgrade "diffusers>=0.31" transformers accelerate sentencepiece imageio imageio-ffmpeg
fi

python3 scripts/render_and_ai_v2v.py \
  --blender "${BLENDER_DIR}/blender" \
  --data-dir ./assets/data \
  --flight "${FLIGHT_JSON}" \
  --out "${OUT_DIR}" \
  --duration-sec "${DURATION_SEC}" \
  --backend "${BACKEND}"
echo "[COLAB] 完了：${OUT_DIR}"
