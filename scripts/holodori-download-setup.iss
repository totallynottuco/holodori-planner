[Setup]
AppName=Hololive Dreams Planner
VersionInfoProductName=Hololive Dreams Planner
VersionInfoVersion={#AppVersion}
VersionInfoCopyright=Game artwork and data © COVER Corporation and QualiArts, Inc.
AppVersion={#AppVersion}
AppCopyright=Game artwork and data © COVER Corporation and QualiArts, Inc.
OutputBaseFilename=Hololive-Dreams-Planner-{#AppVersion}-Windows-x64-Setup
SetupIconFile={#ProjectRoot}\src-tauri\icons\icon.ico
ArchitecturesAllowed=x64compatible
PrivilegesRequired=lowest
CreateAppDir=no
Uninstallable=no
WizardStyle=modern
DisableReadyPage=yes
DisableFinishedPage=yes

[Files]
Source: "{#PayloadSetup}"; DestName: "Holodori-Install.exe"; Flags: dontcopy
#ifdef PayloadManifest
Source: "{#PayloadManifest}"; DestName: "installer-data.txt"; Flags: dontcopy
#endif

[Code]
var
  DownloadPage: TDownloadWizardPage;

#ifdef PayloadManifest
procedure DownloadVolumes;
var
  Manifest: TStringList;
  Volume: Integer;
  PartIndex: Integer;
  Name, Entry, Path: String;
  OutputStream, InputStream: TFileStream;
begin
  ExtractTemporaryFile('installer-data.txt');
  Manifest := TStringList.Create;
  try
    Manifest.LoadFromFile(ExpandConstant('{tmp}\installer-data.txt'));
    for Volume := 1 to 2 do begin
      Path := ExpandConstant('{tmp}\Holodori-Install-') + IntToStr(Volume) + '.bin';
      OutputStream := TFileStream.Create(Path, fmCreate);
      try
        for PartIndex := 0 to Manifest.Count - 1 do begin
          Entry := Manifest[PartIndex];
          Name := Copy(Entry, 1, Pos('=', Entry) - 1);
          if Pos('installer-data-' + IntToStr(Volume) + '-', Name) = 1 then begin
            DownloadPage.Clear;
            DownloadPage.Add('{#PayloadUrl}/' + Name, Name,
              Copy(Entry, Pos('=', Entry) + 1, Length(Entry)));
            DownloadPage.Download;
            InputStream := TFileStream.Create(ExpandConstant('{tmp}\') + Name,
              fmOpenRead or fmShareDenyWrite);
            try
              OutputStream.CopyFrom(InputStream, 0, 1024 * 1024);
            finally
              InputStream.Free;
            end;
            DeleteFile(ExpandConstant('{tmp}\') + Name);
          end;
        end;
      finally
        OutputStream.Free;
      end;
      if ((Volume = 1) and (GetSHA256OfFile(Path) <> '{#HashOne}')) or
         ((Volume = 2) and (GetSHA256OfFile(Path) <> '{#HashTwo}')) then
        RaiseException('Downloaded installer data did not pass verification.');
    end;
  finally
    Manifest.Free;
  end;
end;
#endif

procedure InitializeWizard;
begin
  DownloadPage := CreateDownloadPage(
    'Downloading Hololive Dreams Planner',
    'Setup downloads and verifies the required installation files.', nil);
  DownloadPage.ShowBaseNameInsteadOfUrl := True;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
  Parameters: String;
begin
  Result := '';
#ifndef PayloadManifest
  DownloadPage.Clear;
  DownloadPage.Add('{#PayloadUrl}/{#PayloadOne}', 'Holodori-Install-1.bin', '{#HashOne}');
  DownloadPage.Add('{#PayloadUrl}/{#PayloadTwo}', 'Holodori-Install-2.bin', '{#HashTwo}');
#endif
  DownloadPage.Show;
  try
    try
#ifdef PayloadManifest
      DownloadVolumes;
#else
      DownloadPage.Download;
#endif
      ExtractTemporaryFile('Holodori-Install.exe');
      Parameters := '/NORESTART';
      if WizardSilent then
        Parameters := Parameters + ' /VERYSILENT /SUPPRESSMSGBOXES';
      if ExpandConstant('{param:DIR|}') <> '' then
        Parameters := Parameters + ' /DIR="' + ExpandConstant('{param:DIR|}') + '"';
      if not Exec(ExpandConstant('{tmp}\Holodori-Install.exe'), Parameters,
          ExpandConstant('{tmp}'), SW_SHOW, ewWaitUntilTerminated, ResultCode) then
        Result := 'Could not start installation. ' + SysErrorMessage(ResultCode)
      else if ResultCode <> 0 then
        Result := 'Installation did not complete (exit code ' + IntToStr(ResultCode) + ').';
    except
      Result := GetExceptionMessage;
    end;
  finally
    DownloadPage.Hide;
  end;
end;
