// 航空機曳航（自動追従アシスト）。索の張力は計算せず、曳航機の経路にグライダーを追従させる。
// JS 版 src/sim/tow.js の移植。
#pragma once
#include "FlightModel.h"

namespace sekiyado {

struct TowState {
  double x = 0, z = 0, y = 0, v = 0, heading = 0, bank = 0, pitch = 0, climb = 0;
  bool airborne = false, attached = true;
  double departTime = 0, turnDir = 0, time = 0, propSpin = 0;
};

TowState CreateTow(const HeightFn& height);
// 1 ステップ進める。対地 600 m に達したら true（自動切り離しの合図）。
bool StepTow(TowState& t, FlightState& s, double dt, const HeightFn& height);
bool ReleaseTow(TowState& t, FlightState& s, const HeightFn& height);
void StepDeparture(TowState& t, double dt);

}  // namespace sekiyado
