// 質点＋姿勢の簡易6自由度風モデル。JS 版 src/sim/flight.js の移植。
// 力：揚力（迎角から CL）、抗力（極曲線 CD0 + k·CL² + エアブレーキ）、推力、重力、車輪の転がり抵抗。
// スティック前後 = 迎角の指示（手を離すとトリム迎角＝トリム速度に戻る、実機と同じ速度安定）。
#pragma once
#include <functional>
#include <string>
#include "Atmosphere.h"

namespace sekiyado {

struct AircraftParams {
  std::string id, name;
  double mass, S, span, CLa, alpha0, CLmax;
  double CD0, k, CDbrake, trim, vne, gearH, groundAlpha;
  double mu, brakeMu, rollRate, power, propEff, staticThrust;
};

// JS 版 AIRCRAFT と同じ値。今後は共通 JSON（ue5/data/aircraft.json）から読む予定。
const AircraftParams& GliderParams();   // 複座練習グライダー（Duo Discus T 相当）
const AircraftParams& DimonaParams();   // SUPER DIMONA TC100
const AircraftParams* FindAircraft(const std::string& id);

constexpr double kRunwayHeading = -0.131;   // RWY 36 の方位（北から時計回り, rad）
// 離陸・着陸の向き：普段は RWY 18（北端から南へ）。JS 版 flight.js の TAKEOFF_HEADING と同じ
constexpr double kTakeoffHeading = kRunwayHeading + 3.14159265358979323846;
constexpr double kRunwayLength = 1500, kRunwayWidth = 90;

void RunwayCoords(double x, double z, double& along, double& cross);
bool InRunway(double x, double z);

struct EngineState { bool on = false; double throttle = 0, rpm = 0; };

struct Touchdown {
  bool valid = false;
  double vs = 0, bank = 0, speed = 0, groundSpeed = 0;
  bool onRunway = false;
  double along = 0, cross = 0;
};

struct FlightState {
  const AircraftParams* a = nullptr;
  double x = 0, y = 0, z = 0, vx = 0, vy = 0, vz = 0;
  double heading = 0, bank = 0, pitch = 0, alpha = 0, beta = 0;
  double airspeed = 0;
  bool onGround = false, hasFlown = false;
  double trim = 0, brake = 0, stall = 0, te = 0, teRaw = 0, lift = 0, g = 1;
  EngineState engine;
  double time = 0;
  Touchdown touchdown;
  double prevV = 0, distance = 0, maxAgl = 0;
  double aileron = 0, elevator = 0, rudder = 0, wheelSpin = 0;
};

struct ControlInput { double roll = 0, pitch = 0, yaw = 0; };   // -1..1

// 地面の標高 [m] を返す関数。UE では Landscape へのライントレース、テストでは解析関数。
using HeightFn = std::function<double(double x, double z)>;

FlightState CreateState(const AircraftParams& a, double x, double y, double z, double heading, bool onGround);
void Launch(FlightState& s, double speed);   // 空中スタート
double TrimAlpha(const AircraftParams& a, double v);
void StepFlight(FlightState& s, const ControlInput& input, double dt, const Atmosphere& atmo, const HeightFn& height, bool assist);
double StallSpeed(const AircraftParams& a);
double ClampTrim(FlightState& s, double v);

}  // namespace sekiyado
