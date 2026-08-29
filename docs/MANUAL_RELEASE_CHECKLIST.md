# Manual release checklist

- [ ] Run `npm run release:verify` on Windows x64.
- [ ] Confirm keyboard-only navigation and visible focus at 100%, 125%, and 150% scaling.
- [ ] Confirm the 1080×700 minimum window and offline startup.
- [ ] Corrupt a disposable profile and verify visible backup recovery.
- [ ] Install the per-user NSIS build without elevation.
- [ ] Confirm `%APPDATA%\holodori Planner\profile.json` survives restart.
- [ ] Export, preview, cancel, then complete a profile import.
- [ ] Uninstall/reinstall and confirm AppData is retained.
- [ ] Publish v0.1.0 and install normally.
- [ ] Publish a tested v0.1.1 release and verify notification, approved download, explicit restart/install, and profile preservation.
- [ ] When signing begins, remove `verifyUpdateCodeSignature: false` and lock the publisher identity.
