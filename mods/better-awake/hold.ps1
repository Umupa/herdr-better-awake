# better-awake on Windows: keeps the PC (and the display with -Display) awake
# until Herdr ($App) exits or this process is stopped.
param([int]$App, [switch]$Display)

Add-Type -Namespace BetterAwake -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
# ES_CONTINUOUS | ES_SYSTEM_REQUIRED, plus ES_DISPLAY_REQUIRED for the display.
$flags = [uint32]2147483649
if ($Display) { $flags = $flags -bor 2 }
[void][BetterAwake.Power]::SetThreadExecutionState($flags)
Wait-Process -Id $App -ErrorAction SilentlyContinue
