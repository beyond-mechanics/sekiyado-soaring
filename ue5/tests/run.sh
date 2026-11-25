#!/usr/bin/env bash
# 飛行コアの一致テスト：JS 版で参照軌跡を作り、C++ 版をビルドして比べる。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CORE="$ROOT/ue5/SekiyadoUE/Source/SekiyadoUE/FlightCore"
BUILD="${BUILD_DIR:-$ROOT/ue5/tests/build}"
mkdir -p "$BUILD"
node "$ROOT/ue5/tests/make_reference.mjs" "$BUILD/reference"
${CXX:-g++} -std=c++17 -O2 -Wall -Wextra -Wshadow -Werror -ffp-contract=off -I"$CORE" \
  "$ROOT/ue5/tests/flight_core_test.cpp" "$CORE/Atmosphere.cpp" "$CORE/FlightModel.cpp" "$CORE/Tow.cpp" -o "$BUILD/flight_core_test"
"$BUILD/flight_core_test" "$BUILD/reference"
