# Release guide

This guide is for the maintainers. It explains how to build the downloads for macOS and Windows, how to make a release, and how to sign the Mac app. For users, see [Download](../README.md#download).

- [Release guide](#release-guide)
  - [The downloads](#the-downloads)
    - [How the app starts](#how-the-app-starts)
  - [Build the downloads on a Mac](#build-the-downloads-on-a-mac)
  - [Make a release](#make-a-release)
  - [Sign and notarize the Mac app](#sign-and-notarize-the-mac-app)
    - [Prepare the certificate and the password](#prepare-the-certificate-and-the-password)
    - [Sign on GitHub](#sign-on-github)
    - [Sign on your Mac](#sign-on-your-mac)
    - [What the script does](#what-the-script-does)
  - [Windows](#windows)

## The downloads

| File | Content |
|---|---|
| `Tutor-<version>-macos.zip` | `Tutor.app`. One app for Apple silicon and for Intel. |
| `Tutor-<version>-windows-x64.zip` | A folder `Tutor` with `Start Tutor.bat` and the folder `app`. |

Each download contains Node.js 24, the built browser app, the server in one file (`dist/server/main.js`), and the production packages. Thus the user needs no Node.js and no npm. `scripts/package.ts` sets the version of Node.js.

### How the app starts

- macOS: the program `Tutor.app/Contents/MacOS/Tutor` comes from `scripts/package/launcher.c`. It starts `Contents/MacOS/node` with the server in the background, and then it ends. The output of the server goes to `~/Library/Logs/Tutor.log`. The app has no window and no Dock icon.
- Windows: `Start Tutor.bat` starts `app\node.exe` with the server in its window. If the user closes the window, the tutor stops.

The two programs start the server with the option `--app`. With this option, the server does these things:

1. It keeps `.env` and `data/` in a folder of the user, so that an update of the program keeps the books. On macOS, the folder is `~/Library/Application Support/Tutor`. On Windows, it is `%LOCALAPPDATA%\Tutor`. The variable `TUTOR_HOME` replaces the folder.
2. If a tutor runs already, the server opens the browser at that tutor and ends. Two servers must not use one database.
3. It uses the first free port from 3000 to 3009.
4. It opens the browser. If the tutor has no model, the browser opens the Settings page. With `BROWSER=none`, the server opens no browser.
5. The Settings page shows "Stop the tutor".

On macOS, an app can run from a temporary copy (App Translocation). Then the server stops with a message, and the user must move the app to the Applications folder. If the app has the quarantine mark of a download, the launcher removes the mark from the app.

## Build the downloads on a Mac

The build needs macOS, because the Mac app needs `clang`, `lipo`, `iconutil`, and `ditto`.

```
npm run package
```

The command writes the two zip files into `release/`. To build only one download, add `-- --only macos` or `-- --only windows`. The first run downloads Node.js into `release/cache/` and checks its checksum. Git ignores `release/`.

The command also runs a smoke test of the Mac app. The test starts the server of the app with no browser and a temporary data folder. Then it checks the health route, the browser app, the Settings page, the stop route, and the native packages.

To test the Mac app by hand with a separate data folder and no browser, run this command:

```
BROWSER=none TUTOR_HOME=/tmp/tutor-test release/work/macos/Tutor.app/Contents/MacOS/Tutor
```

## Make a release

1. Set the new version in `package.json`, for example `0.2.0`. Commit the change.
2. Make a tag with the same version, and push it:

   ```
   git tag v0.2.0
   git push origin v0.2.0
   ```

3. The workflow `.github/workflows/release.yml` runs on a Mac of GitHub. It runs the type check and the tests, builds the two zip files, and makes the GitHub release.

The tag must be `v` and the version in `package.json`. The zip files get the version from `package.json`.

To build the zip files with no release, open Actions > Release on GitHub and click "Run workflow". The zip files are then in the artifact `tutor-downloads` of the run.

## Sign and notarize the Mac app

With no signature, macOS blocks the first start of `Tutor.app`. The user must then click "Open Anyway" in System Settings > Privacy & Security. With a Developer ID signature and a notarization, macOS only shows its usual question for an app from the internet.

You need a membership of the Apple Developer Program.

### Prepare the certificate and the password

1. Make a "Developer ID Application" certificate. In Xcode, open Settings > Accounts, select your team, and click "Manage Certificates". Click "+" and select "Developer ID Application".
2. In Keychain Access, export the certificate with its private key as a `.p12` file. Set a password for the file.
3. Make an app-specific password for your Apple Account at account.apple.com, in "Sign-In and Security".
4. Find your team ID at developer.apple.com/account, in "Membership details".
5. Find the name of the signing identity:

   ```
   security find-identity -v -p codesigning
   ```

   The name has the form `Developer ID Application: Your Name (TEAMID)`.

### Sign on GitHub

Add these secrets in the GitHub repository, in Settings > Secrets and variables > Actions:

| Secret | Value |
|---|---|
| `MACOS_CERTIFICATE` | The `.p12` file in base64. To copy it, run `base64 -i certificate.p12 \| pbcopy`. |
| `MACOS_CERTIFICATE_PASSWORD` | The password of the `.p12` file. |
| `MACOS_SIGN_IDENTITY` | The name of the signing identity. |
| `APPLE_ID` | The email address of your Apple Account. |
| `APPLE_APP_PASSWORD` | The app-specific password. |
| `APPLE_TEAM_ID` | Your team ID. |

The workflow then signs and notarizes each release. A fork of the repository has no secrets, so its Mac app has no signature.

### Sign on your Mac

If the certificate is in your keychain, set the same values as variables of the shell:

```
MACOS_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
APPLE_ID=you@example.com APPLE_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx APPLE_TEAM_ID=TEAMID \
npm run package -- --only macos
```

### What the script does

1. It signs each native file of the packages, then Node.js, then the app. Each signature has the hardened runtime and a secure timestamp.
2. Node.js gets the entitlements in `scripts/package/entitlements.plist`. These are the entitlements of the official Node.js program, with no `get-task-allow`, because the notary service rejects that entitlement.
3. It sends the app to the notary service with `notarytool` and waits for the result. If the result is not "Accepted", the script shows the log of the notary service and stops.
4. It attaches the ticket to the app with `stapler`. Then macOS needs no network connection to check the app.

To check a signed app, run this command. The answer must contain `source=Notarized Developer ID`.

```
spctl --assess --type execute --verbose release/work/macos/Tutor.app
```

## Windows

The Windows download has no signature, so Windows shows a warning at the first start. A code signing certificate for Windows costs money, and the workflow does not use one.

Windows can open a zip file as a folder. If the user double-clicks `Start Tutor.bat` in the zip file, the file runs alone in a temporary folder. Then it tells the user to extract the zip file first.
