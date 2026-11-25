#pragma once
#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"
#include "GameFramework/HUD.h"
#include "SekiyadoGameMode.generated.h"

// 試作用の簡易計器（文字表示）。段階 4 で UMG のコックピット計器に置き換える。
UCLASS()
class SEKIYADOUE_API ASekiyadoHUD : public AHUD
{
	GENERATED_BODY()
public:
	virtual void DrawHUD() override;
};

UCLASS()
class SEKIYADOUE_API ASekiyadoGameMode : public AGameModeBase
{
	GENERATED_BODY()
public:
	ASekiyadoGameMode();
};
