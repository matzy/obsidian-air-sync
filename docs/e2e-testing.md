# End-to-end testing against real backends

The unit suite verifies each backend with the shared `runIFileSystemContract` over
**in-memory fakes** of the Google Drive / Dropbox / OneDrive clients (see
[ADR 0002](adr/0002-backends-verified-by-shared-behaviour-contracts.md)). That is fast and
runs in CI, but a fake can drift from the real API and every test stays green.

The **opt-in e2e** runs that *same* contract against the **live** APIs to catch such drift
([ADR 0003](adr/0003-opt-in-e2e-validates-fakes-against-real-backends.md)). It is
**local/manual only** — never part of `npm test`, the lint gate, or CI.

> **Use a throwaway test account, not a real vault.** The suite creates and then
> recursively deletes an `airsync-e2e-*` folder on each run.

## TL;DR

```bash
cp .env.e2e.example .env.e2e          # gitignored; fill the Google + OneDrive client ids first
npm run e2e:bootstrap -- google       # authorize in the browser → token auto-written to .env.e2e
npm run e2e:bootstrap -- dropbox      # authorize in the browser → token auto-written to .env.e2e
npm run e2e:bootstrap -- onedrive     # authorize in the browser → token auto-written to .env.e2e
npm run test:e2e                      # runs the contract against the live APIs
```

With **no** credentials, `npm run test:e2e` warns and skips every backend and exits 0 — so
it can never break anything if run by accident.

## Prerequisites

- Node 20 or 22 (the e2e transport uses the global `fetch`).
- A **test** Google, Dropbox, and/or (personal) Microsoft account. Each backend is
  independent: provide one token to test just that backend; the others warn and skip.

## One-time OAuth-app setup (loopback)

The bootstrap captures the OAuth redirect on a localhost loopback server (default
`http://localhost:53682/callback`; override with `AIRSYNC_E2E_OAUTH_PORT`). Register that
redirect URI once:

- **Google** — the built-in auth server returns tokens to `obsidian://`, which a loopback
  can't capture, so the e2e uses **your own** GCP OAuth client. In Google Cloud Console create
  an OAuth client (Desktop app, or Web app with redirect `http://localhost:53682/callback`),
  enable the Google Drive API, and put its id/secret in `.env.e2e`
  (`AIRSYNC_E2E_GOOGLE_CLIENT_ID` / `_CLIENT_SECRET`). The Google e2e refreshes with this same
  client; with only a refresh token (no id/secret) it falls back to the built-in auth server.
- **Dropbox** — on the app at <https://www.dropbox.com/developers/apps> add
  `http://localhost:53682/callback` under **Redirect URIs**. It uses the public PKCE client id
  (no secret).
- **OneDrive** — the shipped app is registered only with the `obsidian://air-sync-auth` redirect
  (and you don't own it), but the headless e2e needs a `http://localhost:53682/callback` loopback,
  so it uses **your own** Entra app, exactly like Google. At <https://entra.microsoft.com> register an app with
  **"Personal Microsoft accounts only"**, the **Files.ReadWrite.AppFolder** delegated
  permission, and a `http://localhost:53682/callback` redirect URI (platform "Mobile and
  desktop"); put its application (client) id in `.env.e2e` (`AIRSYNC_E2E_ONEDRIVE_CLIENT_ID`).
  PKCE means no secret. The OneDrive e2e refreshes with this same client (the refresh token is
  bound to it), so — unlike Dropbox — the client id is required even when a token is present.

## Obtaining refresh tokens

`npm run e2e:bootstrap -- <google|dropbox|onedrive>` reuses the shipped auth code
(`GoogleAuthDirect` / `DropboxAuth` / `OneDriveAuth`) and:

1. Starts a localhost loopback server and prints an authorization URL.
2. You open it and approve — the browser is redirected back to the loopback, which captures the
   code automatically (no copy-paste).
3. The code is exchanged for tokens and the refresh token is written straight into `.env.e2e`.

Tokens are long-lived; redo the bootstrap only if one is revoked.

## Environment variables

Read from the real environment or a gitignored `.env.e2e` at the repo root (real env wins):

| Variable | Backend / purpose |
|---|---|
| `AIRSYNC_E2E_GOOGLE_CLIENT_ID` | Google Drive — your GCP OAuth client id (for loopback) |
| `AIRSYNC_E2E_GOOGLE_CLIENT_SECRET` | Google Drive — your GCP OAuth client secret |
| `AIRSYNC_E2E_GOOGLE_REFRESH_TOKEN` | Google Drive — minted by the bootstrap |
| `AIRSYNC_E2E_CHROME_USER_DATA_DIR` | Google Picker — dedicated system-Chrome profile with the test account signed in |
| `AIRSYNC_E2E_ELECTRON_USER_DATA_DIR` | Google Picker — dedicated Electron BrowserWindow profile with the test account signed in |
| `AIRSYNC_E2E_FIREFOX_PATH` | Google Picker — official Firefox executable installed by the Firefox setup command |
| `AIRSYNC_E2E_GECKODRIVER_PATH` | Google Picker — GeckoDriver executable installed by the Firefox setup command |
| `AIRSYNC_E2E_FIREFOX_PROFILE_DIR` | Google Picker — dedicated Firefox profile with the test account and necessary-cookie consent |
| `AIRSYNC_E2E_DROPBOX_REFRESH_TOKEN` | Dropbox — minted by the bootstrap |
| `AIRSYNC_E2E_ONEDRIVE_CLIENT_ID` | OneDrive — your Entra app client id (for loopback + refresh) |
| `AIRSYNC_E2E_ONEDRIVE_REFRESH_TOKEN` | OneDrive — minted by the bootstrap |
| `AIRSYNC_E2E_OAUTH_PORT` | Optional loopback port (default 53682) |
| `AIRSYNC_E2E_EXTRA_CA` | Optional PEM bundle of extra trust anchors for the Electron `net` host (see [Running behind a TLS-intercepting proxy](#running-behind-a-tls-intercepting-proxy)) |

## Running

It is **never** part of `npm test`, the lint gate, or CI — run it explicitly, when needed:

```bash
npm run test:e2e           # all backends — the per-backend files run IN PARALLEL
npm run test:e2e:google    # Google Drive only
npm run test:e2e:dropbox   # Dropbox only
npm run test:e2e:onedrive  # OneDrive only
npm run test:e2e:google-picker # deployed Google Picker in system Chrome + Electron + Firefox
npm run test:e2e:google-picker:chrome # system Chrome route only
npm run test:e2e:google-picker:electron # Electron BrowserWindow route only
npm run test:e2e:google-picker:firefox # official Firefox route only
npm run e2e:bootstrap:google-picker # one-time sign-in for the dedicated Picker Chrome profile
npm run e2e:bootstrap:google-picker:electron # one-time sign-in for the dedicated Electron profile
npm run e2e:setup:google-picker:firefox # install official Firefox + GeckoDriver under the user cache
npm run e2e:bootstrap:google-picker:firefox # one-time Firefox sign-in + Picker cookie consent
```

- `npm run test:e2e` runs the per-backend files **concurrently** (different services =
  different rate-limit buckets); tests **within** a backend stay sequential, so a single
  backend is never hammered.
- The full `runIFileSystemContract` runs against each live API. A fresh child folder is created
  per test (the contract assumes an empty start) under one per-run parent folder, removed in
  `afterAll`. A green run is the proof that the fakes still match reality.
- **One token missing** → that backend warns and skips; the other runs.
- **No tokens** → both warn and skip; exit 0.

> Running Google individually needs `AIRSYNC_E2E_GOOGLE_CLIENT_ID`/`_CLIENT_SECRET` in
> `.env.e2e` (the refresh token alone falls back to the built-in auth server, which can't
> refresh a token minted by your own OAuth client). OneDrive likewise needs
> `AIRSYNC_E2E_ONEDRIVE_CLIENT_ID` (the refresh token is bound to your own client; the shipped app has no localhost redirect).

## Google Picker browser fidelity

`npm run test:e2e:google-picker` is a separate opt-in T3 check. It runs the same live
Picker contract through an installed system Chrome/Chromium, an Electron
`BrowserWindow`, and official Firefox. Use the `:chrome`, `:electron`, or `:firefox`
suffix to isolate one engine. It does not run the
Google Drive REST contract and is not included in `npm test`, normal CI, or
`test:e2e:google`. All three engines open the production folder-picker URL and deployed
`airsync.takezo.dev` page. Chrome and Electron are observed over the Chrome DevTools
Protocol; Firefox is observed through GeckoDriver and WebDriver BiDi. The system
Chrome route does not import, launch, or fall back to Electron, so its result remains an
independent proof of the external Chrome path. The Firefox route uses Mozilla's official
binary rather than Playwright's patched Firefox build and does not establish compatibility
with Firefox forks such as Zen.

The credentialed Picker needs both the OAuth token and a Google login in Chrome. Set
`AIRSYNC_E2E_CHROME_USER_DATA_DIR` to a dedicated profile directory, then run
`npm run e2e:bootstrap:google-picker`, sign in to the throwaway Google test account,
confirm Google Drive opens, and close the dedicated Chrome window. Do not point this
variable at your normal browser profile. The E2E reuses only this dedicated profile.

The Electron route likewise needs its own signed-in profile. Set
`AIRSYNC_E2E_ELECTRON_USER_DATA_DIR` to a dedicated directory, run
`npm run e2e:bootstrap:google-picker:electron`, sign in to the same throwaway account,
confirm Google Drive opens, and close the Electron window. The fidelity run verifies the
engine identity from `Browser.getVersion`; a system-Chrome result cannot satisfy the
Electron contract and an Electron result cannot satisfy the system-Chrome contract.

For Firefox, first run `npm run e2e:setup:google-picker:firefox`. The setup downloads
Mozilla's current official Linux Firefox and GeckoDriver releases into
`~/.cache/obsidian-air-sync/firefox-e2e`, then writes their paths and a dedicated profile
path to the gitignored `.env.e2e`. Run
`npm run e2e:bootstrap:google-picker:firefox`, sign in if requested, click **Allow
cookies** inside the real Picker, confirm that the Drive folder browser appears, and
close Firefox. The bootstrap refreshes the existing Google e2e token only to open that
production Picker page; it does not print or persist the short-lived access token.

Set `AIRSYNC_E2E_CHROME_PATH` to select an executable explicitly. Otherwise the runner
checks standard Chrome/Chromium executable names and OS-specific install locations,
including Windows Chrome when invoked from WSL. Each invocation uses a fresh debugging
endpoint and either the configured dedicated profile or, when unset, a unique temporary
profile. It closes Chrome after each case and removes only temporary profiles on success,
failure, timeout, or termination. The browser identity is verified through
`Browser.getVersion`; an Electron marker or a non-Chrome/Chromium product fails the check.

The credentialed cases use the same `AIRSYNC_E2E_GOOGLE_REFRESH_TOKEN` as the Google
Drive REST e2e. They also use the same client-aware auth selection: when both
`AIRSYNC_E2E_GOOGLE_CLIENT_ID` and `_CLIENT_SECRET` are present, the token is refreshed
through `GoogleAuthDirect`; otherwise it is refreshed through the built-in `GoogleAuth`
server path. A refresh token is bound to the OAuth client that issued it, so keep the
matching client values alongside a token minted by the loopback bootstrap. Keep all
credentials in the real environment or the gitignored `.env.e2e`; never paste them into
an issue or test output.

Without the shared Google refresh token, the valid and invalid-key cases are each
reported as a named skip with the missing env variable; the credential-independent token-empty
negative control still runs. That control registers its observer before navigation,
records only whether the fragment contained a token, clicks the deployed page's real
`#choose` control, and passes only after the deployed `#content .error` reports the
access-token error. HTTP status, static HTML, or element existence alone cannot pass.
A skip means the corresponding credentialed live behavior was **not executed**, not that
the deployed Picker passed. Credentialed invalid-key and interactive-ready completion is
the next fidelity milestone and requires the shared Google token above.

The system-browser control has a bounded 55-second watchdog. Its result contains only
stage, error class, token-present, interactivity, and Chrome-identity booleans;
access/refresh tokens, API keys, fragment-bearing URLs, raw DOM/CDP payloads, raw browser
identity and stderr, profiles, traces, and account screenshots are neither printed nor
persisted. No Playwright, Puppeteer, or other browser-automation dependency is used.

## Running behind a TLS-intercepting proxy

Some environments (hosted CI runners, corporate networks) route all egress through a
proxy that terminates TLS and re-signs every certificate with its own CA. The e2e runs on
**Electron's `net`** (the desktop engine — that's the whole point, see
[ADR 0003](adr/0003-opt-in-e2e-validates-fakes-against-real-backends.md)), and Chromium's
network stack on Linux ships its **own** root store — it ignores the system CA bundle and
`NODE_EXTRA_CA_CERTS`. So even when `curl` works, every request fails with
`net::ERR_CERT_AUTHORITY_INVALID`. (`--use-system-ca` does **not** help on Linux.)

Point `AIRSYNC_E2E_EXTRA_CA` at a PEM bundle that includes the proxy's CA:

```bash
AIRSYNC_E2E_EXTRA_CA=/etc/ssl/certs/ca-certificates.crt npm run test:e2e
```

The Electron `net` host then installs a `setCertificateVerifyProc` that does **real**
validation against that bundle — it walks the presented chain, checks each link's
signature, requires the leaf to match the requested host, and requires the chain to anchor
in a CA from the bundle. It is **not** a blanket "trust everything": an unrelated or forged
cert still fails. Leave the variable **unset** (the default) and Chromium's normal strict
validation is used unchanged — so ordinary local runs are unaffected.

`AIRSYNC_E2E_EXTRA_CA` applies to the Electron `net` REST transport only. The Picker check
uses the installed system Chrome/Chromium trust store and does not alter certificate
verification.

> Use the **fetch** transport instead (`AIRSYNC_E2E_TRANSPORT=fetch`, which honours
> `NODE_EXTRA_CA_CERTS`) only as a last resort: it diverges from desktop on the
> redirect-auth / `Content-Length` bug classes this e2e exists to catch, so it false-greens
> them (see `e2e/request-url.ts`).

If the proxy also enforces a host **allowlist**, a backend can authenticate yet still 403 on
the host its content up/downloads redirect to (e.g. OneDrive's `*.microsoftpersonalcontent.com`,
returned as `403 Host not in allowlist: …`). That is an egress-policy limit, not a test or
credential failure — add the host to the environment's egress settings to let those tests run.

## Notes

- **Dropbox mtime.** `DropboxFs` reports `server_modified` (the upload wall-clock) as `mtime`,
  so a written mtime does not round-trip — the fake echoes it back, the live backend does not.
  The Dropbox suite therefore runs the contract with `preservesWrittenMtime: false` (Google Drive
  keeps the default `true`), relaxing only the mtime-equality checks to "a plausible
  timestamp." mtime is not Dropbox's change-detection signal (that is the content-hash
  `remoteChecksum`), so nothing load-bearing is dropped. This is the documented divergence
  from ADR 0002, surfaced by this e2e.
- **OneDrive mtime.** Unlike Dropbox, `OneDriveFs` PATCHes `fileSystemInfo.lastModifiedDateTime`
  right after the content PUT, so the written mtime *is* preserved (not a server clock) — but
  this e2e proved Microsoft Graph stores it at **whole-second** precision (`12345 → 12000`,
  `99999 → 99000`). So the suite runs with `mtimePrecisionMs: 1000` (the written value must
  round-trip, floored to the second) rather than the exact default or Dropbox's
  `preservesWrittenMtime: false`. mtime is not OneDrive's change-detection signal (that is the
  content hash `remoteChecksum`), so the second-precision floor is not load-bearing for sync —
  though it does mean two edits within the same second are mtime-indistinguishable, falling to
  the duplicate path in conflict resolution. OneDrive runs under the App Folder scope, so the
  throwaway `airsync-e2e-*` tree is created inside `special/approot`.
- **Leftover folders.** Cleanup runs in `afterAll` but is **best-effort** — it warns instead
  of failing the run (Google Drive's `drive.file` scope can't hard-delete and may 403 on trash under
  load). Folders are uniquely named, so delete any stray `airsync-e2e-*` from the test account
  by hand when needed.
- **Why it is not in CI.** Real network, credentials, and quota make it unsuitable as a gate;
  it backstops — it does not replace — the fast fake-based contracts.
