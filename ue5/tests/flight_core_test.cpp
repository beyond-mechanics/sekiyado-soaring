// C++ 飛行コアが JS 版と同じ軌跡を描くかの一致テスト（UE 不要、g++/clang/MSVC でビルド可）。
//   node ue5/tests/make_reference.mjs           … 参照軌跡を作る
//   ./ue5/tests/run.sh                          … ビルドして比較
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>
#include "FlightModel.h"
#include "Tow.h"
#include "FlightMath.h"
#include <algorithm>

using namespace sekiyado;

static double TestHeight(double x, double z) { return 8 + 2 * std::sin(x / 300) * std::cos(z / 400); }

struct Seg { long step; double v[7]; };   // roll pitch yaw brake trim engine throttle（nan=変更なし）
struct Scenario {
  std::string aircraft, mode;
  double dt = 0, release = -1, launchSpeed = 0;
  long steps = 0, sampleEvery = 1;
  bool assist = false, onGround = false;
  double atmo[5] = {}, start[4] = {};
  std::vector<Seg> segs;
};

static double Num(const std::string& s) { return s == "nan" ? NAN : std::strtod(s.c_str(), nullptr); }

static bool LoadScenario(const std::string& file, Scenario& sc) {
  std::ifstream in(file);
  if (!in) return false;
  std::string line;
  while (std::getline(in, line)) {
    std::istringstream ls(line);
    std::string key; ls >> key;
    std::vector<std::string> t; std::string w; while (ls >> w) t.push_back(w);
    if (key == "aircraft") sc.aircraft = t[0];
    else if (key == "mode") sc.mode = t[0];
    else if (key == "dt") sc.dt = Num(t[0]);
    else if (key == "steps") sc.steps = std::atol(t[0].c_str());
    else if (key == "sampleEvery") sc.sampleEvery = std::atol(t[0].c_str());
    else if (key == "assist") sc.assist = t[0] == "1";
    else if (key == "release") sc.release = Num(t[0]);
    else if (key == "atmo") for (int i = 0; i < 5; i++) sc.atmo[i] = Num(t[i]);
    else if (key == "start") { for (int i = 0; i < 4; i++) sc.start[i] = Num(t[i]); sc.onGround = t[4] == "1"; sc.launchSpeed = Num(t[5]); }
    else if (key == "seg") { Seg s; s.step = std::atol(t[0].c_str()); for (int i = 0; i < 7; i++) s.v[i] = Num(t[i + 1]); sc.segs.push_back(s); }
  }
  return true;
}

static std::vector<std::vector<double>> LoadCsv(const std::string& file) {
  std::vector<std::vector<double>> rows;
  std::ifstream in(file); std::string line;
  std::getline(in, line);   // 見出し
  while (std::getline(in, line)) {
    std::vector<double> r; std::stringstream ss(line); std::string cell;
    while (std::getline(ss, cell, ',')) r.push_back(std::strtod(cell.c_str(), nullptr));
    rows.push_back(r);
  }
  return rows;
}

static std::vector<double> Row(const FlightState& s) {
  return { s.time, s.x, s.y, s.z, s.vx, s.vy, s.vz, s.heading, s.bank, s.pitch, s.alpha, s.airspeed, s.te, s.onGround ? 1.0 : 0.0 };
}

int main(int argc, char** argv) {
  const std::string dir = argc > 1 ? argv[1] : "ue5/tests/reference";
  const char* names[] = { "glide_calm", "thermal_turn_wind", "stall", "assist_turn", "landing_rwy36", "dimona_takeoff", "aerotow_release" };
  // 許容誤差：位置 [m]、速度 [m/s]、角度 [rad]
  const double tolPos = 0.05, tolVel = 0.01, tolAng = 0.001;
  int failed = 0;
  for (const char* name : names) {
    Scenario sc;
    if (!LoadScenario(dir + "/" + name + ".scn", sc)) { std::printf("NG %s: シナリオがありません（make_reference.mjs を先に実行）\n", name); failed++; continue; }
    const auto ref = LoadCsv(dir + "/" + name + ".csv");
    const AircraftParams& a = *FindAircraft(sc.aircraft);
    AtmosphereSettings as; as.windSpeed = sc.atmo[0]; as.windFromDeg = sc.atmo[1]; as.thermalScale = sc.atmo[2]; as.turbulence = sc.atmo[3]; as.cloudBase = sc.atmo[4];
    Atmosphere atmo(as);
    const HeightFn height = TestHeight;
    FlightState s = CreateState(a, sc.start[0], sc.start[1], sc.start[2], sc.start[3], sc.onGround);
    TowState tow; bool hasTow = sc.mode == "tow";
    if (hasTow) tow = CreateTow(height);
    else if (!sc.onGround) Launch(s, sc.launchSpeed);

    std::vector<std::vector<double>> out; out.push_back(Row(s));
    ControlInput input; size_t segI = 0;
    for (long i = 0; i < sc.steps; i++) {
      if (segI < sc.segs.size() && sc.segs[segI].step == i) {
        const double* v = sc.segs[segI].v;
        if (!std::isnan(v[0])) input.roll = v[0];
        if (!std::isnan(v[1])) input.pitch = v[1];
        if (!std::isnan(v[2])) input.yaw = v[2];
        if (!std::isnan(v[3])) s.brake = v[3];
        if (!std::isnan(v[4])) ClampTrim(s, v[4]);
        if (!std::isnan(v[5])) s.engine.on = v[5] != 0;
        if (!std::isnan(v[6])) s.engine.throttle = v[6];
        segI++;
      }
      const double tNow = i * sc.dt;
      if (hasTow && tow.attached && sc.release >= 0 && tNow >= sc.release - 1e-9) ReleaseTow(tow, s, height);
      if (hasTow && tow.attached) StepTow(tow, s, sc.dt, height);
      else StepFlight(s, input, sc.dt, atmo, height, sc.assist);
      if ((i + 1) % sc.sampleEvery == 0) out.push_back(Row(s));
    }

    double ePos = 0, eVel = 0, eAng = 0; int groundMismatch = 0;
    const size_t n = std::min(out.size(), ref.size());
    for (size_t r = 0; r < n; r++) {
      const auto& c = out[r]; const auto& j = ref[r];
      ePos = std::max(ePos, std::max(std::fabs(c[1] - j[1]), std::max(std::fabs(c[2] - j[2]), std::fabs(c[3] - j[3]))));
      eVel = std::max(eVel, std::max(std::fabs(c[4] - j[4]), std::max(std::fabs(c[5] - j[5]), std::fabs(c[6] - j[6]))));
      for (int k = 7; k <= 10; k++) eAng = std::max(eAng, std::fabs(AngleDiff(c[k], j[k])));
      if (c[13] != j[13]) groundMismatch++;
    }
    const bool ok = out.size() == ref.size() && ePos <= tolPos && eVel <= tolVel && eAng <= tolAng && groundMismatch == 0;
    std::printf("%s %-18s 行 %zu  位置差 %.2e m  速度差 %.2e m/s  角度差 %.2e rad  接地不一致 %d\n",
                ok ? "OK" : "NG", name, out.size(), ePos, eVel, eAng, groundMismatch);
    if (!ok) failed++;
  }
  std::printf(failed ? "\n%d 件が不一致\n" : "\nすべて一致\n", failed);
  return failed ? 1 : 0;
}
