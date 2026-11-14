[Setup]
AppId=me.holodori.planner.desktop
AppName=Hololive Dreams Planner
AppVersion={#AppVersion}
AppPublisher=Hololive Dreams Planner
AppCopyright=Game artwork and data © COVER Corporation and QualiArts, Inc.
VersionInfoVersion={#AppVersion}
VersionInfoProductName=Hololive Dreams Planner
VersionInfoCopyright=Game artwork and data © COVER Corporation and QualiArts, Inc.
DefaultDirName={localappdata}\Holodori Planner
DefaultGroupName=Hololive Dreams Planner
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
SetupIconFile={#ProjectRoot}\src-tauri\icons\icon.ico
UninstallDisplayIcon={app}\holodori-desktop.exe
OutputBaseFilename=Hololive-Dreams-Planner-{#AppVersion}-Windows-x64-Setup
Compression=lzma2/fast
SolidCompression=no
DiskSpanning=yes
DiskSliceSize=1900000000
SlicesPerDisk=1
WizardStyle=modern

[Files]
Source: "{#ProjectRoot}\src-tauri\target\release\holodori-desktop.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ProjectRoot}\src-tauri\resources\capture\holodori-account-reader.dll"; DestDir: "{app}\capture"; Flags: ignoreversion
Source: "{#ProjectRoot}\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ProjectRoot}\THIRD_PARTY.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ProjectRoot}\licenses\*"; DestDir: "{app}\licenses"; Flags: ignoreversion recursesubdirs
Source: "{#ProjectRoot}\hololive-assets\animations\*"; DestDir: "{app}\animations"; Flags: ignoreversion recursesubdirs nocompression
Source: "{#ProjectRoot}\hololive-dist\assets\outfits\*"; DestDir: "{app}\outfits"; Flags: ignoreversion nocompression
Source: "{#ProjectRoot}\hololive-dist\assets\chart-artwork\*"; DestDir: "{app}\chart-artwork"; Flags: ignoreversion nocompression
Source: "{#ProjectRoot}\hololive-dist\assets\team-optimizer\soundtracks\*"; DestDir: "{app}\soundtracks"; Flags: ignoreversion nocompression
Source: "{#WebView2Installer}"; DestDir: "{tmp}"; DestName: "WebView2RuntimeInstaller.exe"; Flags: deleteafterinstall nocompression; Check: NeedsWebView2

[Icons]
Name: "{group}\Hololive Dreams Planner"; Filename: "{app}\holodori-desktop.exe"; WorkingDir: "{app}"

[Run]
Filename: "{tmp}\WebView2RuntimeInstaller.exe"; Parameters: "/silent /install"; StatusMsg: "Installing Microsoft Edge WebView2…"; Check: NeedsWebView2
Filename: "{app}\holodori-desktop.exe"; Description: "Launch Hololive Dreams Planner"; Flags: nowait postinstall skipifsilent

[Code]
const
  WebView2Client = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function HasWebView2(RootKey: Integer): Boolean;
var
  Version: String;
begin
  Result := RegQueryStringValue(RootKey, WebView2Client, 'pv', Version) and
    (Version <> '') and (Version <> '0.0.0.0');
end;

function NeedsWebView2: Boolean;
begin
  Result := not (HasWebView2(HKLM32) or HasWebView2(HKLM64) or HasWebView2(HKCU32));
end;
