// 飛行コアの座標（x=東, y=上, z=南, m）と UE の座標（X=北, Y=東, Z=上, cm）の変換はここだけで行う。
#pragma once
#include "CoreMinimal.h"

namespace SekiyadoCoords
{
	constexpr double CmPerM = 100.0;

	inline FVector ToUE(double X, double Y, double Z) { return FVector(-Z * CmPerM, X * CmPerM, Y * CmPerM); }
	inline void FromUE(const FVector& V, double& X, double& Y, double& Z) { X = V.Y / CmPerM; Y = V.Z / CmPerM; Z = -V.X / CmPerM; }

	// 飛行コアの姿勢 → UE の回転。heading は北から時計回り（UE の Yaw と同じ向き）、
	// bank は右翼下げが正（UE の Roll と同じ）、pitch は機首上げが正。
	inline FRotator ToUERotator(double Heading, double Pitch, double Bank)
	{
		return FRotator(FMath::RadiansToDegrees(Pitch), FMath::RadiansToDegrees(Heading), FMath::RadiansToDegrees(Bank));
	}
}
