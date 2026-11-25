// 機体の Pawn：入力を飛行コアに渡し、固定刻み（既定 120 Hz）で進めて結果を描く。
// UE の物理（Chaos）は機体運動には使わない。地面の高さは下向きのライントレースで取る。
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Pawn.h"
#include "FlightModel.h"
#include "Tow.h"
#include "GliderPawn.generated.h"

class UCameraComponent;
class USpringArmComponent;
class UStaticMeshComponent;
class USceneComponent;

UENUM(BlueprintType)
enum class ESekiyadoAircraft : uint8 { Glider, Dimona };

UENUM(BlueprintType)
enum class ESekiyadoStart : uint8 { InAir, AeroTow, SelfLaunch };

UCLASS()
class SEKIYADOUE_API AGliderPawn : public APawn
{
	GENERATED_BODY()

public:
	AGliderPawn();
	virtual void Tick(float DeltaSeconds) override;
	virtual void SetupPlayerInputComponent(UInputComponent* PlayerInputComponent) override;

	// ---- 設定（エディターの詳細パネルで変更可） ----
	UPROPERTY(EditAnywhere, Category = "Sekiyado") ESekiyadoAircraft Aircraft = ESekiyadoAircraft::Glider;
	UPROPERTY(EditAnywhere, Category = "Sekiyado") ESekiyadoStart StartMode = ESekiyadoStart::InAir;
	UPROPERTY(EditAnywhere, Category = "Sekiyado", meta = (ClampMin = "30", ClampMax = "1000")) float PhysicsHz = 120.f;
	UPROPERTY(EditAnywhere, Category = "Sekiyado") float WindSpeed = 3.f;
	UPROPERTY(EditAnywhere, Category = "Sekiyado") float WindFromDeg = 330.f;
	UPROPERTY(EditAnywhere, Category = "Sekiyado") float ThermalScale = 1.f;
	UPROPERTY(EditAnywhere, Category = "Sekiyado") float Turbulence = 0.5f;
	UPROPERTY(EditAnywhere, Category = "Sekiyado") bool bBankAssist = false;
	// 地面が見つからないとき（何もないレベル）の標高 [m]
	UPROPERTY(EditAnywhere, Category = "Sekiyado") float FallbackGroundM = 10.f;

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Sekiyado") TObjectPtr<USceneComponent> Root;
	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Sekiyado") TObjectPtr<UStaticMeshComponent> Body;
	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Sekiyado") TObjectPtr<USpringArmComponent> ChaseArm;
	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Sekiyado") TObjectPtr<UCameraComponent> ChaseCamera;
	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Sekiyado") TObjectPtr<UCameraComponent> CockpitCamera;

	// ---- 計器・HUD 用 ----
	UFUNCTION(BlueprintPure, Category = "Sekiyado") float GetAirspeedKmh() const { return float(State.airspeed * 3.6); }
	UFUNCTION(BlueprintPure, Category = "Sekiyado") float GetAltitudeM() const { return float(State.y); }
	UFUNCTION(BlueprintPure, Category = "Sekiyado") float GetVarioMs() const { return float(State.te); }
	UFUNCTION(BlueprintPure, Category = "Sekiyado") float GetHeadingDeg() const;
	UFUNCTION(BlueprintPure, Category = "Sekiyado") bool IsStalling() const { return State.stall > 0.3; }
	UFUNCTION(BlueprintPure, Category = "Sekiyado") bool IsOnTow() const { return bTow && Tow.attached; }
	const sekiyado::FlightState& GetFlightState() const { return State; }

	UFUNCTION(BlueprintCallable, Category = "Sekiyado") void ResetFlight();

protected:
	virtual void BeginPlay() override;

private:
	double GroundHeightM(double X, double Z) const;
	sekiyado::ControlInput ReadControls();
	void ReadDiscreteKeys();
	void ApplyToTransform();

	sekiyado::FlightState State;
	sekiyado::TowState Tow;
	TUniquePtr<sekiyado::Atmosphere> Atmo;
	sekiyado::HeightFn Height;
	bool bTow = false;
	bool bCockpitView = true;
	double Accumulator = 0;
	TMap<FKey, bool> PrevKeys;
};
