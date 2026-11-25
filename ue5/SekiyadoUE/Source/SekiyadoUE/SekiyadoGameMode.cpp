#include "SekiyadoGameMode.h"
#include "GliderPawn.h"
#include "Engine/Canvas.h"
#include "Engine/Engine.h"
#include "GameFramework/PlayerController.h"

ASekiyadoGameMode::ASekiyadoGameMode()
{
	DefaultPawnClass = AGliderPawn::StaticClass();
	HUDClass = ASekiyadoHUD::StaticClass();
}

void ASekiyadoHUD::DrawHUD()
{
	Super::DrawHUD();
	const AGliderPawn* P = PlayerOwner ? Cast<AGliderPawn>(PlayerOwner->GetPawn()) : nullptr;
	if (!P || !Canvas) return;
	const sekiyado::FlightState& S = P->GetFlightState();
	const FString Lines[] = {
		FString::Printf(TEXT("速度 %3.0f km/h   トリム %3.0f km/h"), S.airspeed * 3.6, S.trim * 3.6),
		FString::Printf(TEXT("高度 %4.0f m   昇降 %+4.1f m/s"), S.y, S.te),
		FString::Printf(TEXT("方位 %03.0f°   バンク %+3.0f°   G %.1f"), P->GetHeadingDeg(), FMath::RadiansToDegrees(S.bank), S.g),
		FString::Printf(TEXT("%s%s%s%s"), P->IsOnTow() ? TEXT("曳航中（R で切り離し）  ") : TEXT(""), S.brake > 0 ? TEXT("エアブレーキ  ") : TEXT(""),
			P->IsStalling() ? TEXT("失速！  ") : TEXT(""), S.onGround ? TEXT("接地") : TEXT("")),
	};
	float Y = 40.f;
	for (const FString& L : Lines)
	{
		DrawText(L, FLinearColor::White, 40.f, Y, GEngine->GetMediumFont(), 1.4f);
		Y += 32.f;
	}
}
