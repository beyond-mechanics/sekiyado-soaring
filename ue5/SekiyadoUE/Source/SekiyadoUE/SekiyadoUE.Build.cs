using System.IO;
using UnrealBuildTool;

public class SekiyadoUE : ModuleRules
{
	public SekiyadoUE(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine", "InputCore" });
		// 飛行コア（UE 非依存の純 C++）。ue5/tests の一致テストと同じソースを使う。
		PublicIncludePaths.Add(Path.Combine(ModuleDirectory, "FlightCore"));
	}
}
