# Agent notes

## Build & verification commands

- `npm run build` — production builds for the SPA, backend and Chrome extension.
- `npm run build:server` — build the standalone backend to `dist-server/index.js`.
- `npm run build:ext` — build the Chrome MV3 extension to `dist-extension/chrome-mv3`.
- `npm run build:ext:firefox` — build the Firefox MV2 extension to `dist-extension/firefox-mv2`.
- `npm run build:ext:safari` — build the Safari MV2 extension to `dist-extension/safari-mv2`.
- `npm run build:ext:safari-mv3` — build the Safari MV3 extension to `dist-extension/safari-mv3`.
- `npm run package:safari` — build the Safari MV3 extension and convert it to an Xcode macOS app project (requires Xcode).
- `npm run wxt:prepare` (also `postinstall`) — generate WXT `.wxt` types.
- `npx tsc -p tsconfig.extension.json --noEmit` — typecheck the extension.
- `npx eslint extension` — lint the extension source.

## Testing the extension

1. Start the backend with the built SPA:
   ```
   npm run build
   npm run start
   ```
   The server listens on `:8080` and serves `dist/`.
2. Open Chrome / Edge, go to `chrome://extensions`, enable Developer mode, and Load unpacked:
   - Chrome: `dist-extension/chrome-mv3`
   - Firefox: `dist-extension/firefox-mv2` (use `about:debugging` → This Firefox → Load Temporary Add-on)
   - Safari: requires full Xcode.app (Command Line Tools are not enough). Run `npm run package:safari`, then open the generated `KEAP/KEAP.xcodeproj`, build the project, and enable the extension in Safari → Settings → Extensions. For iOS, the generated macOS project must be wrapped in an iOS app and distributed via the App Store.
3. Click the extension toolbar icon to open the KEAP bottom bar.
4. In the Settings tab, enter the KEAP instance URL (e.g. `http://localhost:8080`) and start pairing.
5. Approve the pairing in the opened `/extension/pair?code=...` tab.

## Known lint state

`npm run lint` still reports pre-existing `any` / react-hooks warnings in `server/db.ts` and `src/`. The `extension/` and `server/extension/` source directories are clean.

## nOS deployment

The local nOS runs `iiab-keap-1` from `nos/keap:0.7.3` and exposes the container on `127.0.0.1:8091` (→ container `:8080`). The latest build in this repo is not automatically deployed to that container; it must be rebuilt into the `nos/keap` image or the new `dist/` and `dist-server/` must be mounted into the container.

## Project layout

- `extension/` — WXT extension source (background, content script, React panel UI, API broker utilities).
- `server/extension/` — backend extension routes and auth store (`/ext/v1/*`).
- `shared/contracts/extension.ts` — shared Zod schemas and scopes.
- `wxt.config.ts` — WXT build configuration, cross-browser manifest generation.
- `tsconfig.extension.json` — TypeScript project for the extension.
