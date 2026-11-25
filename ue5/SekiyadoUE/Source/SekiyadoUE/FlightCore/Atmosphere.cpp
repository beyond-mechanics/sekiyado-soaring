#include "Atmosphere.h"
#include "FlightMath.h"
#include <cmath>

namespace sekiyado {

namespace {
// 練習用に位置を固定した上昇気流（JS 版 FIXED_THERMALS と同じ）
const Thermal kFixedThermals[] = {
  { -900, -900, 260, 3.0, 0 },
  { 1250, 500, 300, 3.5, 0 },
  { 500, -2000, 230, 2.6, 0 },
  { -2600, 1800, 280, 2.8, 0 },
  { 2900, -2700, 320, 3.2, 0 },
  { -1800, -3600, 250, 2.4, 0 },
};
}  // namespace

Atmosphere::Atmosphere(const AtmosphereSettings& s)
    : windSpeed_(s.windSpeed), windFrom_(s.windFromDeg * kPi / 180), thermalScale_(s.thermalScale),
      turbulence_(s.turbulence), cloudBase_(s.cloudBase) {
  const double to = windFrom_ + kPi;   // 吹いていく方向
  wdx_ = std::sin(to); wdz_ = -std::cos(to);
  if (thermalScale_ > 0) {
    for (const Thermal& t : kFixedThermals) {
      thermals_.push_back({ t.x, t.z, t.r, t.w * thermalScale_, Hash(t.x) * 6.28 });
    }
  }
}

// 高度（対地）での平均風の倍率：対数則、10m で 1.0、300m 以上で約 1.6
double Atmosphere::Profile(double agl) const {
  const double z0 = 0.05, h = Max(1, Min(300, agl));
  return std::log(h / z0) / std::log(10 / z0);
}

// 上昇気流中心は風に流されて高度とともに風下へずれる
void Atmosphere::ThermalCenter(const Thermal& t, double agl, double& cx, double& cz) const {
  const double drift = windSpeed_ * Profile(agl) * agl / 2.5;
  cx = t.x + wdx_ * drift; cz = t.z + wdz_ * drift;
}

double Atmosphere::Lift(double x, double z, double agl, double time) const {
  double w = 0;
  if (thermals_.empty()) return 0;
  const double ramp = Min(1, Max(0, agl) / 160);
  const double top = 1 - Smooth((agl - cloudBase_ * 0.82) / (cloudBase_ * 0.18));
  if (top <= 0) return 0;
  for (const Thermal& t : thermals_) {
    double cx, cz; ThermalCenter(t, agl, cx, cz);
    const double d = std::hypot(x - cx, z - cz);
    if (d > t.r * 3.2) continue;
    const double pulse = 0.85 + 0.15 * std::sin(time * 0.01 + t.phase);
    const double core = std::exp(-(d * d) / (t.r * t.r));
    const double rr = d - 1.7 * t.r, rw = 0.55 * t.r;
    const double ring = std::exp(-(rr * rr) / (rw * rw));
    w += t.w * pulse * (core - 0.32 * ring);
  }
  // 熱的な一般沈下（気流のない場所はわずかに下降）
  return (w - 0.12 * thermalScale_) * ramp * top;
}

void Atmosphere::Wind(double x, double z, double agl, double time, WindSample& out) const {
  const double m = windSpeed_ * Profile(agl);
  const double turb = turbulence_ * (0.35 + 0.08 * windSpeed_) * (agl < 2 ? 0.2 : 1);
  const double nx = Noise1(time * 0.9 + x * 0.004, 1) * 0.6 + Noise1(time * 2.7 + z * 0.01, 2) * 0.4;
  const double nz = Noise1(time * 0.8 + z * 0.004, 3) * 0.6 + Noise1(time * 2.3 + x * 0.01, 4) * 0.4;
  const double ny = Noise1(time * 1.1 + (x + z) * 0.006, 5) * 0.7 + Noise1(time * 3.1, 6) * 0.3;
  const double lift = Lift(x, z, agl, time);
  // 上昇気流の中は乱れが強い
  const double tb = turb * (1 + Min(1.5, std::fabs(lift) * 0.35));
  out.x = wdx_ * m + nx * tb;
  out.z = wdz_ * m + nz * tb;
  out.y = lift + ny * tb * 0.8 * Min(1, agl / 30);
  out.lift = lift;
}

}  // namespace sekiyado
