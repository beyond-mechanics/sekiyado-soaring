using UnrealBuildTool;

public class SekiyadoUETarget : TargetRules
{
	public SekiyadoUETarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Game;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("SekiyadoUE");
	}
}
