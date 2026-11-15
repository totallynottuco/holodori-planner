#include PayloadMetadata
#ifndef PlannerAppId
#define PlannerAppId "me.holodori.planner.desktop"
#endif

[Setup]
AppId={#PlannerAppId}
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
UsePreviousSetupType=no
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
SetupIconFile={#ProjectRoot}\src-tauri\icons\icon.ico
UninstallDisplayIcon={app}\holodori-desktop.exe
OutputBaseFilename=Hololive-Dreams-Planner-{#AppVersion}-Windows-x64-Setup
Compression=lzma2/fast
SolidCompression=no
ArchiveExtraction=full
WizardStyle=modern

[Types]
Name: core; Description: "Core app"
Name: full; Description: "Core app and all offline media"
Name: custom; Description: "Choose media packs"; Flags: iscustom

[Components]
Name: core; Description: "Hololive Dreams Planner"; Types: core full custom; Flags: fixed
Name: outfits; Description: "Live2D outfit previews"; Types: full
Name: animations; Description: "Animated card artwork"; Types: full
Name: charts; Description: "Chart artwork"; Types: full
Name: music; Description: "Soundtracks"; Types: full

[Files]
#ifdef PayloadUrl
Source: "{#HostedPayloadIndex}"; DestName: "hosted-payload-index.txt"; Flags: dontcopy
#endif
#ifdef CoreHash
Source: "{code:PayloadPath|core.zip}"; DestDir: "{app}"; ExternalSize: {#CoreBytes}; Flags: external extractarchive recursesubdirs ignoreversion
#else
Source: "{#ProjectRoot}\src-tauri\target\release\holodori-desktop.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ProjectRoot}\src-tauri\resources\capture\holodori-account-reader.dll"; DestDir: "{app}\capture"; Flags: ignoreversion
Source: "{#ProjectRoot}\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ProjectRoot}\THIRD_PARTY.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ProjectRoot}\licenses\*"; DestDir: "{app}\licenses"; Flags: ignoreversion recursesubdirs
#endif
Source: "{#MediaManifest}"; DestDir: "{app}"; Flags: ignoreversion
Source: "{code:PayloadPath|outfits.zip}"; DestDir: "{app}\outfits"; ExternalSize: {#OutfitsBytes}; Components: outfits; Flags: external extractarchive recursesubdirs ignoreversion; Check: MediaPrepared('outfits')
Source: "{code:PayloadPath|animations.zip}"; DestDir: "{app}\animations"; ExternalSize: {#AnimationsBytes}; Components: animations; Flags: external extractarchive recursesubdirs ignoreversion; Check: MediaPrepared('animations')
Source: "{code:PayloadPath|charts.zip}"; DestDir: "{app}\chart-artwork"; ExternalSize: {#ChartsBytes}; Components: charts; Flags: external extractarchive recursesubdirs ignoreversion; Check: MediaPrepared('charts')
Source: "{code:PayloadPath|music.zip}"; DestDir: "{app}\soundtracks"; ExternalSize: {#MusicBytes}; Components: music; Flags: external extractarchive recursesubdirs ignoreversion; Check: MediaPrepared('music')

[Icons]
Name: "{group}\Hololive Dreams Planner"; Filename: "{app}\holodori-desktop.exe"; WorkingDir: "{app}"; Tasks: startmenuicon; Check: not RestartAfterUpdate
Name: "{userdesktop}\Hololive Dreams Planner"; Filename: "{app}\holodori-desktop.exe"; WorkingDir: "{app}"; Tasks: desktopicon; Check: not RestartAfterUpdate

[Tasks]
Name: startmenuicon; Description: "Create a &Start menu shortcut"; GroupDescription: "Shortcuts"
Name: desktopicon; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts"; Flags: unchecked

[UninstallDelete]
Type: filesandordirs; Name: "{app}\outfits"
Type: filesandordirs; Name: "{app}\animations"
Type: filesandordirs; Name: "{app}\chart-artwork"
Type: filesandordirs; Name: "{app}\soundtracks"
Type: files; Name: "{app}\media-source.txt"
Type: files; Name: "{app}\media-packs.latest.json"
Type: files; Name: "{app}\media-packs.latest.bak"
Type: filesandordirs; Name: "{app}\.media-*-stage"
Type: filesandordirs; Name: "{app}\.media-*-previous"

[Run]
Filename: "{code:PayloadPath|WebView2RuntimeInstaller.exe}"; Parameters: "/silent /install"; StatusMsg: "Installing Microsoft Edge WebView2…"; Check: NeedsWebView2
Filename: "{app}\holodori-desktop.exe"; Description: "Launch Hololive Dreams Planner"; Flags: nowait postinstall skipifsilent
Filename: "{app}\holodori-desktop.exe"; Flags: nowait skipifnotsilent; Check: RestartAfterUpdate

[Code]
const
  WebView2Client = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

var
  DownloadPage: TDownloadWizardPage;
  PayloadFiles: TStringList;

function OpenUpdateProcess(Access: Cardinal; InheritHandle: Boolean; ProcessId: Cardinal): THandle;
  external 'OpenProcess@kernel32.dll stdcall';
function WaitForSingleObject(Handle: THandle; Milliseconds: Cardinal): Cardinal;
  external 'WaitForSingleObject@kernel32.dll stdcall';
function CloseHandle(Handle: THandle): Boolean;
  external 'CloseHandle@kernel32.dll stdcall';

procedure WaitForPlanner;
var
  UpdatePid: Integer;
  ProcessHandle: THandle;
begin
  UpdatePid := StrToIntDef(ExpandConstant('{param:UPDATEPID|0}'), 0);
  if UpdatePid <= 0 then Exit;
  ProcessHandle := OpenUpdateProcess($00100000, False, UpdatePid);
  if ProcessHandle = 0 then begin
    if DLLGetLastError <> 87 then
      RaiseException('Setup could not check whether the planner closed.');
    Exit;
  end;
  try
    if WaitForSingleObject(ProcessHandle, 15000) <> 0 then
      RaiseException('Close Hololive Dreams Planner before installing the update.');
  finally
    CloseHandle(ProcessHandle);
  end;
end;

function RestartAfterUpdate: Boolean;
begin
  Result := (StrToIntDef(ExpandConstant('{param:UPDATEPID|0}'), 0) > 0) or
    (ExpandConstant('{param:PLANNERUPDATE|0}') = '1');
end;

function InstallMedia: Boolean;
begin
  Result := not RestartAfterUpdate;
end;

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

function LocalPayload(Name: String): String;
begin
  Result := ExpandConstant('{src}\payload\') + Name;
end;

function PayloadPath(Name: String): String;
var
  Index: Integer;
begin
  Result := LocalPayload(Name);
  if PayloadFiles = nil then Exit;
  Index := PayloadFiles.IndexOf(Name);
  if Index >= 0 then Result := PayloadFiles[Index + 1];
end;

procedure RememberPayload(Name, Path: String);
begin
  PayloadFiles.Add(Name);
  PayloadFiles.Add(Path);
end;

#ifdef PayloadUrl
procedure DownloadPayload(Name, Hash: String);
var
  Index: TStringList;
  Number, Separator, PartCount: Integer;
  Row, PartName, PartHash, Path, PartPath: String;
  OutputStream, InputStream: TFileStream;
begin
  if not FileExists(ExpandConstant('{tmp}\hosted-payload-index.txt')) then
    ExtractTemporaryFile('hosted-payload-index.txt');
  Index := TStringList.Create;
  try
    Index.LoadFromFile(ExpandConstant('{tmp}\hosted-payload-index.txt'));
    Path := ExpandConstant('{tmp}\') + Name;
    OutputStream := TFileStream.Create(Path, fmCreate);
    try
      PartCount := 0;
      DownloadPage.Show;
      try
        for Number := 0 to Index.Count - 1 do begin
          Row := Index[Number];
          if Pos(Name + '|', Row) <> 1 then Continue;
          Delete(Row, 1, Length(Name) + 1);
          Separator := Pos('|', Row);
          PartName := Copy(Row, 1, Separator - 1);
          PartHash := Copy(Row, Separator + 1, Length(Row));
          DownloadPage.Clear;
          DownloadPage.Add('{#PayloadUrl}/' + PartName, PartName, PartHash);
          DownloadPage.Download;
          PartPath := ExpandConstant('{tmp}\') + PartName;
          InputStream := TFileStream.Create(PartPath, fmOpenRead or fmShareDenyWrite);
          try
            OutputStream.CopyFrom(InputStream, 0, 1024 * 1024);
          finally
            InputStream.Free;
          end;
          DeleteFile(PartPath);
          PartCount := PartCount + 1;
        end;
      finally
        DownloadPage.Hide;
      end;
    finally
      OutputStream.Free;
    end;
    if (PartCount = 0) or (CompareText(GetSHA256OfFile(Path), Hash) <> 0) then
      RaiseException(Name + ' failed verification after download.');
    RememberPayload(Name, Path);
  finally
    Index.Free;
  end;
end;
#endif

procedure QueuePayload(Name, Hash: String);
var
  Path, AssetName: String;
begin
  AssetName := ChangeFileExt(Name, '') + '-' + Hash + ExtractFileExt(Name);
  Path := LocalPayload(Name);
  if not FileExists(Path) then Path := LocalPayload(AssetName);
  if FileExists(Path) then begin
    if CompareText(GetSHA256OfFile(Path), Hash) <> 0 then
      RaiseException(Name + ' failed verification. Replace it with the matching payload for this Setup.');
    RememberPayload(Name, Path);
    Exit;
  end;
#ifdef PayloadUrl
  DownloadPayload(Name, Hash);
#else
  RaiseException(Name + ' is missing. Keep the payload folder beside Setup for an offline installation.');
#endif
end;

function HasCurrentMedia(Folder, Hash: String): Boolean;
var
  Directory: String;
  Marker: AnsiString;
  Entry: TFindRec;
begin
  Result := False;
  Directory := ExpandConstant('{app}\') + Folder + '\';
  if not LoadStringFromFile(Directory + '.media-pack-sha256', Marker) then Exit;
  if CompareText(Trim(String(Marker)), Hash) <> 0 then Exit;
  if Folder <> 'animations' then begin
    Result := FileExists(Directory + 'index.json');
  end else if FindFirst(Directory + '*', Entry) then begin
    try
      repeat
        if (Entry.Name <> '.') and (Entry.Name <> '..') and
          FileExists(Directory + Entry.Name + '\full-0.webm') then begin
          Result := True;
          Exit;
        end;
      until not FindNext(Entry);
    finally
      FindClose(Entry);
    end;
  end;
end;

procedure QueueMedia(Component, Folder, Hash: String);
begin
  if WizardIsComponentSelected(Component) and not HasCurrentMedia(Folder, Hash) then
    QueuePayload(Component + '.zip', Hash);
end;

function MediaPrepared(Component: String): Boolean;
begin
  Result := (PayloadFiles <> nil) and (PayloadFiles.IndexOf(Component + '.zip') >= 0);
end;

procedure InitializeWizard;
begin
  PayloadFiles := TStringList.Create;
  DownloadPage := CreateDownloadPage('Downloading selected files',
    'Setup downloads only the selected media and any missing Windows runtime.', nil);
  DownloadPage.ShowBaseNameInsteadOfUrl := True;
end;

procedure DeinitializeSetup;
begin
  if PayloadFiles <> nil then PayloadFiles.Free;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  PayloadFiles.Clear;
  try
    WaitForPlanner;
#ifdef CoreHash
    QueuePayload('core.zip', '{#CoreHash}');
#endif
    if NeedsWebView2 then QueuePayload('WebView2RuntimeInstaller.exe', '{#WebView2Hash}');
    if InstallMedia then begin
      QueueMedia('outfits', 'outfits', '{#OutfitsHash}');
      QueueMedia('animations', 'animations', '{#AnimationsHash}');
      QueueMedia('charts', 'chart-artwork', '{#ChartsHash}');
      QueueMedia('music', 'soundtracks', '{#MusicHash}');
    end;
  except
    Result := GetExceptionMessage;
  end;
end;

procedure MarkMedia(Component, Folder, Hash: String);
begin
  if not MediaPrepared(Component) then Exit;
  if not SaveStringToFile(ExpandConstant('{app}\') + Folder + '\.media-pack-sha256', Hash, False) then
    RaiseException('Could not record the installed media pack: ' + Component);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  SourceFolder: TArrayOfString;
begin
  if CurStep <> ssPostInstall then Exit;
  if FileExists(LocalPayload('media-packs.json')) then begin
    SetArrayLength(SourceFolder, 1);
    SourceFolder[0] := ExpandConstant('{src}\payload');
    if not SaveStringsToUTF8File(ExpandConstant('{app}\media-source.txt'), SourceFolder, False) then
      RaiseException('Could not save the media payload location.');
  end;
  if InstallMedia then begin
    MarkMedia('outfits', 'outfits', '{#OutfitsHash}');
    MarkMedia('animations', 'animations', '{#AnimationsHash}');
    MarkMedia('charts', 'chart-artwork', '{#ChartsHash}');
    MarkMedia('music', 'soundtracks', '{#MusicHash}');
  end;
end;
