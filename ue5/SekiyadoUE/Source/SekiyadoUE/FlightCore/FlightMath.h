// 関宿SIM 飛行コア：UE に依存しない純 C++17。JS 版 src/sim/*.js の 1 対 1 移植。
// 座標系は JS 版と同じ：x=東, y=上, z=南（北は -z）、単位は m・s・rad。
// UE への変換（X=北, Y=東, Z=上, cm）は UE 側の SekiyadoCoords.h だけで行う。
#pragma once
#include <cmath>

namespace sekiyado {

constexpr double kRho = 1.225;
constexpr double kG = 9.81;
constexpr double kPi = 3.14159265358979323846;

inline double Min(double a, double b) { return a < b ? a : b; }
inline double Max(double a, double b) { return a > b ? a : b; }
inline double Clamp(double v, double lo, double hi) { return Max(lo, Min(hi, v)); }

// JS: function hash(n) { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); }
inline double Hash(double n) { const double s = std::sin(n * 127.1) * 43758.5453; return s - std::floor(s); }

// 滑らかな 1 次元ノイズ（乱気流用）
inline double Noise1(double t, double seed) {
  const double i = std::floor(t), f = t - i, u = f * f * (3 - 2 * f);
  return (Hash(i + seed * 17.3) * (1 - u) + Hash(i + 1 + seed * 17.3) * u) * 2 - 1;
}

inline double Smooth(double t) { t = Clamp(t, 0, 1); return t * t * (3 - 2 * t); }

inline double AngleDiff(double a, double b) {
  double d = a - b;
  while (d > kPi) d -= 2 * kPi;
  while (d < -kPi) d += 2 * kPi;
  return d;
}

}  // namespace sekiyado
