#include "FlightModel.h"
#include "FlightMath.h"
#include <cmath>

namespace sekiyado {

const AircraftParams& GliderParams() {
  static const AircraftParams p{ "glider", "複座練習グライダー", 540, 17.9, 17, 5.4, -0.045, 1.42,
    0.0105, 0.0205, 0.05, 25, 77, 0.95, 0.035, 0.07, 0.35, 0.75, 0, 0, 0 };
  return p;
}
const AircraftParams& DimonaParams() {
  static const AircraftParams p{ "dimona", "SUPER DIMONA TC100", 770, 15.3, 16.3, 5.3, -0.04, 1.6,
    0.0185, 0.0225, 0.045, 28, 72, 1.25, 0.02, 0.06, 0.35, 0.85, 73500, 0.5, 2100 };
  return p;
}
const AircraftParams* FindAircraft(const std::string& id) {
  if (id == "glider") return &GliderParams();
  if (id == "dimona") return &DimonaParams();
  return nullptr;
}

void RunwayCoords(double x, double z, double& along, double& cross) {
  const double s = std::sin(kRunwayHeading), c = std::cos(kRunwayHeading);
  along = x * s - z * c; cross = x * c + z * s;
}
bool InRunway(double x, double z) {
  double along, cross; RunwayCoords(x, z, along, cross);
  return std::fabs(along) < kRunwayLength / 2 && std::fabs(cross) < kRunwayWidth / 2;
}

FlightState CreateState(const AircraftParams& a, double x, double y, double z, double heading, bool onGround) {
  FlightState s;
  s.a = &a; s.x = x; s.y = y; s.z = z; s.heading = heading;
  s.onGround = onGround; s.hasFlown = !onGround; s.trim = a.trim;
  s.engine.on = false; s.engine.throttle = onGround ? 1 : 0.65; s.engine.rpm = 0;
  return s;
}

double TrimAlpha(const AircraftParams& a, double v) {
  const double CL = 2 * a.mass * kG / (kRho * a.S * v * v);
  return CL / a.CLa + a.alpha0;
}

void Launch(FlightState& s, double speed) {
  s.vx = std::sin(s.heading) * speed; s.vz = -std::cos(s.heading) * speed; s.vy = 0;
  s.airspeed = speed; s.prevV = speed;
  s.alpha = TrimAlpha(*s.a, s.trim);
}

namespace {
struct CLResult { double CL, stall; };
CLResult CLof(const AircraftParams& a, double alpha) {
  const double stallA = a.CLmax / a.CLa + a.alpha0;
  if (alpha <= stallA) return { a.CLa * (alpha - a.alpha0), 0 };
  const double over = alpha - stallA;
  return { Max(0.75, a.CLmax - over * 4.0), Min(1, over / 0.06) };
}
}  // namespace

void StepFlight(FlightState& s, const ControlInput& input, double dt, const Atmosphere& atmo, const HeightFn& height, bool assist) {
  const AircraftParams& a = *s.a;
  const double ground = height(s.x, s.z);
  const double agl = s.y - ground - a.gearH;
  WindSample wind;
  atmo.Wind(s.x, s.z, Max(0, agl), s.time, wind);
  s.lift = wind.lift;

  // エンジン回転数（一次遅れ）と推力
  double T = 0;
  if (a.power != 0) {
    EngineState& e = s.engine;
    const double target = e.on ? 1800 + 3700 * e.throttle : 0;
    e.rpm += (target - e.rpm) * Min(1, dt * (e.on ? 1.6 : 0.7));
    const double p = Max(0, (e.rpm - 1400) / 4100);
    const double Vf = Max(s.airspeed, 1);
    T = e.on ? Min(a.staticThrust * p, a.power * std::pow(p, 1.5) * a.propEff / Vf) : 0;
  }

  // 対気速度
  double ax = s.vx - wind.x, ay = s.vy - wind.y, az = s.vz - wind.z;
  double V = std::sqrt(ax * ax + ay * ay + az * az);

  // 操縦舵面（描画用）
  s.aileron += (input.roll - s.aileron) * Min(1, dt * 8);
  s.elevator += (input.pitch - s.elevator) * Min(1, dt * 8);
  s.rudder += (input.yaw - s.rudder) * Min(1, dt * 8);
  s.beta += (input.yaw * 0.1 - s.beta) * Min(1, dt * 2);

  const double brakeCD = s.brake * a.CDbrake;

  if (s.onGround) {
    // ---- 地上滑走 ----
    const double hx = std::sin(s.heading), hz = -std::cos(s.heading);
    double gs = s.vx * hx + s.vz * hz;                          // 対地速度（機軸方向）
    const double Va = Max(0, gs - (wind.x * hx + wind.z * hz));  // 機軸方向の対気速度
    // 昇降舵：一定速度以上で機首上げ可能
    const double authority = Min(1, Max(0, (Va - 12) / 10));
    const double alphaCmd = a.groundAlpha + Max(0, input.pitch) * 0.17 * authority;
    s.alpha += (alphaCmd - s.alpha) * Min(1, dt * 3);
    const double CL = CLof(a, s.alpha).CL;
    const double q = 0.5 * kRho * Va * Va;
    const double L = q * a.S * CL, D = q * a.S * (a.CD0 + a.k * CL * CL + brakeCD);
    const double W = a.mass * kG, N = Max(0, W - L);
    const double mu = a.mu + s.brake * a.brakeMu;
    const double fr = gs > 0.05 ? mu * N : 0;
    const double acc = (T - D - fr) / a.mass;
    gs = Max(0, gs + acc * dt);
    // 方向：ラダー／前輪（左右キー＋ラダーキー）
    const double steer = (input.roll * 0.9 + input.yaw) * 0.32 * Min(1, gs / 4 + 0.15);
    s.heading += steer * dt;
    s.bank += (0 - s.bank) * Min(1, dt * 4);
    s.vx = std::sin(s.heading) * gs; s.vz = -std::cos(s.heading) * gs; s.vy = 0;
    s.x += s.vx * dt; s.z += s.vz * dt;
    s.y = height(s.x, s.z) + a.gearH;
    s.pitch = s.alpha - a.groundAlpha * 0.5;
    s.airspeed = Va; s.stall = 0; s.g = 1;
    s.wheelSpin += gs * dt / 0.3;
    // 離陸：揚力が重量を上回ったら浮揚
    if (L > W * 1.02 && Va > 15) { s.onGround = false; s.vy = 0.3; s.y += 0.05; s.hasFlown = true; s.touchdown = Touchdown(); }
  } else {
    // ---- 空中 ----
    if (V < 3) V = 3;
    const double vx = ax / V, vy = ay / V, vz = az / V;
    // 迎角：トリム迎角 ± スティック（一次遅れ）
    const double aTrim = TrimAlpha(a, s.trim);
    const double alphaCmd = aTrim + (input.pitch >= 0 ? input.pitch * 0.17 : input.pitch * 0.2);
    // 速度が低いと舵の効きが落ちる
    const double eff = Min(1, V / 18);
    s.alpha += (alphaCmd - s.alpha) * Min(1, dt * 3.2 * eff);
    const CLResult cl = CLof(a, s.alpha);
    const double CL = cl.CL, stall = cl.stall;
    s.stall = stall;
    const double q = 0.5 * kRho * V * V;
    const double L = q * a.S * CL;
    // 地面効果：翼幅程度の高さ以下で誘導抗力が減る（McCormick の近似）
    const double hb = Max(0.05, (agl + a.gearH) / a.span), ge = (16 * hb * hb) / (1 + 16 * hb * hb);
    const double CD = a.CD0 + a.k * ge * CL * CL + brakeCD + stall * 0.09 + std::fabs(s.beta) * 0.15;
    const double D = q * a.S * CD;

    // バンク
    const double roll = input.roll * a.rollRate * Min(1, V / 20) * (1 - stall * 0.5);
    if (assist) {
      const double target = input.roll * 0.95;
      s.bank += (target - s.bank) * Min(1, dt * 1.6 * Min(1, V / 20));
    } else {
      s.bank += roll * dt;
    }
    // 失速時は片翼が落ちる
    if (stall > 0.4) s.bank += std::sin(s.time * 0.7 + 1.3) * stall * 0.9 * dt;
    s.bank = Clamp(s.bank, -1.35, 1.35);

    // 右方向ベクトル r = v × up、揚力方向 = (r × v)·cos(bank) + r·sin(bank)
    double rx = -vz, rz = vx;
    double rl = std::hypot(rx, rz); if (rl == 0) rl = 1;
    rx /= rl; rz /= rl;
    const double ux = -rz * vy, uy = rz * vx - rx * vz, uz = rx * vy;   // r × v (ry = 0)
    const double cb = std::cos(s.bank), sb = std::sin(s.bank);
    const double lx = ux * cb + rx * sb, ly = uy * cb, lz = uz * cb + rz * sb;
    const double side = q * a.S * 0.25 * s.beta;   // ラダーによる横力（滑り）

    const double fx = L * lx - D * vx + T * vx + side * rx;
    const double fy = L * ly - D * vy + T * vy;
    const double fz = L * lz - D * vz + T * vz + side * rz;
    s.g = L / (a.mass * kG);

    s.vx += fx / a.mass * dt;
    s.vy += (fy / a.mass - kG) * dt;
    s.vz += fz / a.mass * dt;
    s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;

    ax = s.vx - wind.x; ay = s.vy - wind.y; az = s.vz - wind.z;
    V = std::sqrt(ax * ax + ay * ay + az * az);
    s.airspeed = V;
    s.heading = std::atan2(ax, -az) + s.beta;
    const double gamma = std::asin(Clamp(ay / Max(V, 0.1), -1, 1));
    s.pitch = gamma + s.alpha - 0.03;
    s.maxAgl = Max(s.maxAgl, agl);

    // 接地判定
    const double g2 = height(s.x, s.z) + a.gearH;
    if (s.y <= g2) {
      double along, cross; RunwayCoords(s.x, s.z, along, cross);
      Touchdown& td = s.touchdown;
      td.valid = true; td.vs = s.vy; td.bank = s.bank; td.speed = s.airspeed;
      td.groundSpeed = std::hypot(s.vx, s.vz);
      td.onRunway = std::fabs(along) < kRunwayLength / 2 && std::fabs(cross) < kRunwayWidth / 2;
      td.along = along; td.cross = cross;
      s.onGround = true; s.y = g2;
      // 機軸方向へ速度をそろえる
      const double gs = Max(0, s.vx * std::sin(s.heading) - s.vz * std::cos(s.heading));
      s.vx = std::sin(s.heading) * gs; s.vz = -std::cos(s.heading) * gs; s.vy = 0;
      s.alpha = a.groundAlpha;
    }
  }

  // 総エネルギー（TE）補正付き昇降計：vy + V·dV/dt / g、計器の遅れ 0.6 s
  const double dV = (s.airspeed - s.prevV) / dt;
  s.prevV = s.airspeed;
  s.teRaw = s.onGround ? 0 : s.vy + s.airspeed * dV / kG;
  s.te += (Clamp(s.teRaw, -12, 12) - s.te) * Min(1, dt / 0.6);
  s.distance += std::hypot(s.vx, s.vz) * dt;
  s.time += dt;
}

double StallSpeed(const AircraftParams& a) { return std::sqrt(2 * a.mass * kG / (kRho * a.S * a.CLmax)); }
double ClampTrim(FlightState& s, double v) {
  s.trim = Max(StallSpeed(*s.a) * 1.15, Min(s.a->vne * 0.8, v));
  return s.trim;
}

}  // namespace sekiyado
