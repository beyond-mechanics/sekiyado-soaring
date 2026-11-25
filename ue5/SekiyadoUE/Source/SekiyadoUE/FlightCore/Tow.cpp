#include "Tow.h"
#include "FlightMath.h"
#include <cmath>

namespace sekiyado {

namespace { constexpr double kRope = 55; }

TowState CreateTow(const HeightFn& height) {
  TowState t;
  t.x = -std::sin(kRunwayHeading) * 600; t.z = std::cos(kRunwayHeading) * 600;
  t.y = height(t.x, t.z) + 1.5; t.heading = kRunwayHeading;
  return t;
}

bool StepTow(TowState& t, FlightState& s, double dt, const HeightFn& height) {
  t.time += dt; t.v = Min(31, t.v + (t.airborne ? 0.6 : 1.15) * dt);
  t.propSpin += dt * 40;
  const double agl = t.y - height(t.x, t.z);
  if (t.v >= 24 && !t.airborne) t.airborne = true;
  double turnRate = 0;
  if (t.airborne) {
    t.climb = Min(3.2, t.climb + dt * 0.7);
    // 上空 150 m 以降は場周を大きく左旋回しながら上昇
    if (agl > 150) turnRate = -0.045;
    t.heading += turnRate * dt;
    t.y += t.climb * dt;
  } else {
    t.y = height(t.x, t.z) + 1.5;
  }
  t.bank += (std::atan(turnRate * t.v / 9.81) - t.bank) * Min(1, dt * 1.5);
  t.pitch = std::asin(Min(0.3, t.climb / Max(t.v, 1))) + 0.04;
  t.x += std::sin(t.heading) * t.v * dt; t.z -= std::cos(t.heading) * t.v * dt;

  // グライダー：曳航機の後方 ROPE m、わずかに上（ハイトウ）。滑らかに追従。
  const double tx = t.x - std::sin(t.heading) * kRope, tz = t.z + std::cos(t.heading) * kRope;
  const double ground = height(tx, tz) + s.a->gearH;
  const double ty = Max(ground, t.airborne ? t.y + 2.0 : ground);
  const double px = s.x, py = s.y, pz = s.z;
  const double k = Min(1, dt * 3.5);
  s.x += (tx - s.x) * k; s.z += (tz - s.z) * k; s.y += (ty - s.y) * k;
  // グライダーは曳航機より先に浮く（地面効果で 20 m/s 前後）
  if (!t.airborne && t.v > 19) s.y = Max(s.y, ground + Min(1.2, (t.v - 19) * 0.3));
  s.vx = (s.x - px) / dt; s.vy = (s.y - py) / dt; s.vz = (s.z - pz) / dt;
  s.heading += AngleDiff(t.heading, s.heading) * k; s.bank += (t.bank - s.bank) * k;
  s.pitch = t.pitch - 0.03; s.airspeed = t.v; s.onGround = s.y <= ground + 0.02; s.hasFlown = !s.onGround || s.hasFlown;
  s.brake = 0; s.stall = 0; s.g = 1; s.time += dt; s.wheelSpin += t.v * dt / 0.3;
  return s.y - height(s.x, s.z) >= 600;
}

bool ReleaseTow(TowState& t, FlightState& s, const HeightFn& height) {
  if (!t.attached || s.y - height(s.x, s.z) < 30) return false;
  t.attached = false; t.departTime = 0;
  s.onGround = false; s.hasFlown = true; s.prevV = s.airspeed;
  return true;
}

// 切り離し後：曳航機は左へ降下旋回して離脱（グライダーは右へ）
void StepDeparture(TowState& t, double dt) {
  t.departTime += dt; t.heading -= 0.12 * dt; t.bank += (-0.45 - t.bank) * Min(1, dt * 2);
  t.pitch += (-0.08 - t.pitch) * Min(1, dt); t.propSpin += dt * 40;
  t.x += std::sin(t.heading) * t.v * dt; t.z -= std::cos(t.heading) * t.v * dt; t.y -= 4 * dt;
}

}  // namespace sekiyado
