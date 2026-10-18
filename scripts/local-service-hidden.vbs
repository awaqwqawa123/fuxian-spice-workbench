Option Explicit

' WScript has no console. Hide PowerShell at process creation so Windows Terminal
' cannot flash before PowerShell handles its own -WindowStyle argument.
Dim shell, files, scriptPath, powershell, command, result
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
scriptPath = files.BuildPath(files.GetParentFolderName(WScript.ScriptFullName), "local-service-startup.ps1")
powershell = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
command = """" & powershell & """ -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -WindowStyle Hidden -File """ & scriptPath & """ -Action Run"
result = shell.Run(command, 0, True)
WScript.Quit result
