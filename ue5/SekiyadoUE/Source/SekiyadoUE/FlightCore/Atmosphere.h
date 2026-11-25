// 大気モデル：平均風（高度による変化）、乱気流、上昇気流（周囲の下降気流と風下への傾き付き）。
// JS 版 src/sim/atmosphere.js の移植。
#pragma once
#include <vector>

namespace sekiyado {

struct Thermal { double x, z, r, w, phase; };

struct AtmosphereSettings {
  double windSpeed = 0;      // m/s
  double windFromDeg = 0;    // 風が吹いてくる方位 [deg]
  double thermalScale = 1;
  double turbulence = 0.5;
  double cloudBase = 1350;   // m
};

struct WindSample { double x = 0, y = 0, z = 0, lift = 0; };

class Atmosphere {
 public:
  explicit Atmosphere(const AtmosphereSettings& s = AtmosphereSettings());

  double Profile(double agl) const;
  void ThermalCenter(const Thermal& t, double agl, double& cx, double& cz) const;
  double Lift(double x, double z, double agl, double time) const;
  void Wind(double x, double z, double agl, double time, WindSample& out) const;

  const std::vector<Thermal>& Thermals() const { return thermals_; }
  double WindSpeed() const { return windSpeed_; }
  double CloudBase() const { return cloudBase_; }

 private:
  double windSpeed_, windFrom_, thermalScale_, turbulence_, cloudBase_;
  double wdx_, wdz_;
  std::vector<Thermal> thermals_;
};

}  // namespace sekiyado
