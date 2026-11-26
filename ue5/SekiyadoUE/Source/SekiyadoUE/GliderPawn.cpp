#include "GliderPawn.h"
#include "SekiyadoCoords.h"
#include "Camera/CameraComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/World.h"
#include "GameFramework/PlayerController.h"
#include "GameFramework/SpringArmComponent.h"
#include "InputCoreTypes.h"
#include "UObject/ConstructorHelpers.h"

AGliderPawn::AGliderPawn()
{
	PrimaryActorTick.bCanEverTick = true;

	Root = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	RootComponent = Root;

	Body = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("Body"));
	Body->SetupAttachment(Root);
	Body->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	// 仮の機体形状（機体モデルは段階 4 で glTF から差し替える）
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Cube(TEXT("/Engine/BasicShapes/Cube.Cube"));
	if (Cube.Succeeded())
	{
		Body->SetStaticMesh(Cube.Object);
		Body->SetRelativeScale3D(FVector(0.08, 0.17, 0.012));   // 8 m × 17 m × 1.2 m の板（翼幅の目安）
	}

	ChaseArm = CreateDefaultSubobject<USpringArmComponent>(TEXT("ChaseArm"));
	ChaseArm->SetupAttachment(Root);
	ChaseArm->TargetArmLength = 2200.f;
	ChaseArm->SocketOffset = FVector(0, 0, 350);
	ChaseArm->bDoCollisionTest = false;
	ChaseArm->bEnableCameraLag = true;
	ChaseArm->bEnableCameraRotationLag = true;
	ChaseArm->CameraRotationLagSpeed = 4.f;

	ChaseCamera = CreateDefaultSubobject<UCameraComponent>(TEXT("ChaseCamera"));
	ChaseCamera->SetupAttachment(ChaseArm);

	CockpitCamera = CreateDefaultSubobject<UCameraComponent>(TEXT("CockpitCamera"));
	CockpitCamera->SetupAttachment(Root);
	CockpitCamera->SetRelativeLocation(FVector(150, 0, 90));   // 機首寄り・頭の高さ [cm]
	CockpitCamera->SetFieldOfView(80.f);

	AutoPossessPlayer = EAutoReceiveInput::Player0;
}

void AGliderPawn::BeginPlay()
{
	Super::BeginPlay();
	Height = [this](double X, double Z) { return GroundHeightM(X, Z); };
	ResetFlight();
}

void AGliderPawn::ResetFlight()
{
	sekiyado::AtmosphereSettings S;
	S.windSpeed = WindSpeed; S.windFromDeg = WindFromDeg; S.thermalScale = ThermalScale; S.turbulence = Turbulence;
	Atmo = MakeUnique<sekiyado::Atmosphere>(S);
	const sekiyado::AircraftParams& A = Aircraft == ESekiyadoAircraft::Dimona ? sekiyado::DimonaParams() : sekiyado::GliderParams();
	const double H = sekiyado::kTakeoffHeading; // RWY 18（北端から南向き）
	bTow = StartMode == ESekiyadoStart::AeroTow && Aircraft == ESekiyadoAircraft::Glider;

	if (bTow)
	{
		Tow = sekiyado::CreateTow(Height);
		const double X = Tow.x - FMath::Sin(Tow.heading) * 55.0, Z = Tow.z + FMath::Cos(Tow.heading) * 55.0;
		State = sekiyado::CreateState(A, X, Height(X, Z) + A.gearH, Z, H, true);
	}
	else if (StartMode == ESekiyadoStart::SelfLaunch)
	{
		// 滑走路北端（RWY 18 の進入端）から
		const double X = -FMath::Sin(H) * 650.0, Z = FMath::Cos(H) * 650.0;
		State = sekiyado::CreateState(A, X, Height(X, Z) + A.gearH, Z, H, true);
		State.engine.on = Aircraft == ESekiyadoAircraft::Dimona;
	}
	else
	{
		// 場周の風下区間あたり、対地 300 m
		const double X = 400.0, Z = 300.0;
		State = sekiyado::CreateState(A, X, Height(X, Z) + 300.0, Z, H + UE_DOUBLE_PI, false);
		sekiyado::Launch(State, A.trim);
	}
	Accumulator = 0;
	ApplyToTransform();
}

double AGliderPawn::GroundHeightM(double X, double Z) const
{
	const UWorld* World = GetWorld();
	if (!World) return FallbackGroundM;
	const FVector Top = SekiyadoCoords::ToUE(X, 5000.0, Z), Bottom = SekiyadoCoords::ToUE(X, -500.0, Z);
	FHitResult Hit;
	FCollisionQueryParams Params(SCENE_QUERY_STAT(SekiyadoGround), false, this);
	if (World->LineTraceSingleByChannel(Hit, Top, Bottom, ECC_WorldStatic, Params))
	{
		return Hit.ImpactPoint.Z / SekiyadoCoords::CmPerM;
	}
	return FallbackGroundM;
}

sekiyado::ControlInput AGliderPawn::ReadControls()
{
	sekiyado::ControlInput In;
	const APlayerController* PC = Cast<APlayerController>(GetController());
	if (!PC) return In;
	// 試作ではキーとゲームパッドを直接読む（段階 4 で Enhanced Input とジョイスティック設定に置き換える）。
	// キー割当は Electron 版にそろえる：←→ 補助翼、↑↓ 昇降舵（↓で機首上げ）、Z/X 方向舵。
	auto Key = [PC](const FKey& K) { return PC->IsInputKeyDown(K) ? 1.0 : 0.0; };
	In.roll = Key(EKeys::Right) - Key(EKeys::Left) + PC->GetInputAnalogKeyState(EKeys::Gamepad_LeftX);
	In.pitch = Key(EKeys::Down) - Key(EKeys::Up) - PC->GetInputAnalogKeyState(EKeys::Gamepad_LeftY);
	In.yaw = Key(EKeys::X) - Key(EKeys::Z) + PC->GetInputAnalogKeyState(EKeys::Gamepad_RightX);
	In.roll = FMath::Clamp(In.roll, -1.0, 1.0);
	In.pitch = FMath::Clamp(In.pitch, -1.0, 1.0);
	In.yaw = FMath::Clamp(In.yaw, -1.0, 1.0);
	return In;
}

void AGliderPawn::ReadDiscreteKeys()
{
	const APlayerController* PC = Cast<APlayerController>(GetController());
	if (!PC) return;
	auto Pressed = [this, PC](const FKey& K)
	{
		const bool Down = PC->IsInputKeyDown(K);
		bool& Prev = PrevKeys.FindOrAdd(K);
		const bool Edge = Down && !Prev;
		Prev = Down;
		return Edge;
	};
	// キー割当は Electron 版と同じ
	if (Pressed(EKeys::B) && !IsOnTow()) State.brake = State.brake > 0 ? 0.0 : 1.0;                    // エアブレーキ
	if (Pressed(EKeys::RightBracket)) sekiyado::ClampTrim(State, State.trim + 1.39);                      // トリム +5 km/h
	if (Pressed(EKeys::LeftBracket)) sekiyado::ClampTrim(State, State.trim - 1.39);                       // トリム −5 km/h
	if (Pressed(EKeys::E) && Aircraft == ESekiyadoAircraft::Dimona) State.engine.on = !State.engine.on;   // エンジン
	if (Pressed(EKeys::R) && bTow) sekiyado::ReleaseTow(Tow, State, Height);                              // 曳航索の切り離し
	if (Pressed(EKeys::C)) bCockpitView = !bCockpitView;                                                  // 視点
	if (Pressed(EKeys::BackSpace)) ResetFlight();
	ChaseCamera->SetActive(!bCockpitView);
	CockpitCamera->SetActive(bCockpitView);
}

void AGliderPawn::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	ReadDiscreteKeys();
	const sekiyado::ControlInput In = ReadControls();
	const double Dt = 1.0 / FMath::Max(30.0, double(PhysicsHz));
	Accumulator = FMath::Min(Accumulator + DeltaSeconds, 0.25);   // 処理落ち時に追いつこうとして固まらないよう上限
	while (Accumulator >= Dt)
	{
		if (bTow && Tow.attached)
		{
			if (sekiyado::StepTow(Tow, State, Dt, Height)) sekiyado::ReleaseTow(Tow, State, Height);   // 600 m で自動切り離し
		}
		else
		{
			if (bTow) sekiyado::StepDeparture(Tow, Dt);
			sekiyado::StepFlight(State, In, Dt, *Atmo, Height, bBankAssist);
		}
		Accumulator -= Dt;
	}
	ApplyToTransform();
}

void AGliderPawn::ApplyToTransform()
{
	SetActorLocationAndRotation(SekiyadoCoords::ToUE(State.x, State.y, State.z),
		SekiyadoCoords::ToUERotator(State.heading, State.pitch, State.bank));
}

float AGliderPawn::GetHeadingDeg() const
{
	double Deg = FMath::RadiansToDegrees(State.heading);
	Deg = FMath::Fmod(Deg + 360.0, 360.0);
	return float(Deg);
}

void AGliderPawn::SetupPlayerInputComponent(UInputComponent* PlayerInputComponent)
{
	Super::SetupPlayerInputComponent(PlayerInputComponent);
}
