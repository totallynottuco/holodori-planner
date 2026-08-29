# Security

Please report security issues privately through GitHub's security-advisory feature rather than a public issue.

The renderer is sandboxed with context isolation enabled and Node integration disabled. The preload exposes only typed, purpose-specific methods. Profile writes, imports, external links, planner application, and update actions are validated in the main process.

Version 0.1 Windows builds are not Authenticode-signed. Verify downloads originate from this repository's Releases page. Code-signature verification will be required once signing is introduced, and subsequent releases must retain the same publisher identity.
