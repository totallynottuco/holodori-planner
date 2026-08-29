# Contributing

Issues and focused pull requests are welcome.

1. Use Node.js 24 and install with `npm ci`.
2. Keep calculations and profile mutations in shared pure functions or the Electron main process.
3. Do not add official artwork, logos, screenshots, extracted UI assets, or unreviewed raw master data.
4. Add tests for calculation, persistence, IPC, or user-flow changes.
5. Run `npm run typecheck`, `npm test`, and `npm run build` before opening a pull request.

Catalog updates must be generated with `npm run data:import -- <checkout>` and include the source commit and reviewed manifest diff. Production data changes ship only in application releases.
