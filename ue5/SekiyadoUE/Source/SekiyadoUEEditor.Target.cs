using UnrealBuildTool;

public class SekiyadoUEEditorTarget : TargetRules
{
	public SekiyadoUEEditorTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Editor;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("SekiyadoUE");
	}
}
