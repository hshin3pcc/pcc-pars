# PARS iOS shell

Thin native shell: a WKWebView for the bundled attendance app (`PARSApp/www/`, a folder
reference copied into the bundle) and a WKWebView for the live PARS site (persistent cookies).

## Run on your iPhone
1. `open PARSApp.xcodeproj` in Xcode.
2. Select the PARSApp target > Signing & Capabilities > Team: pick your personal (Apple ID) team.
3. Plug in the iPhone, choose it as the run destination, press Run. (First time: trust the
   developer profile under Settings > General > VPN & Device Management.)

## Unsigned .ipa for AltStore
```
xcodebuild -project PARSApp.xcodeproj -scheme PARSApp -sdk iphoneos -configuration Release CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO BUILD_DIR=build build
mkdir -p build/Payload && cp -R build/Release-iphoneos/PARSApp.app build/Payload/ && (cd build && zip -qr PARSApp.ipa Payload)
```
Output: `build/PARSApp.ipa`. Debug launch args: `-PARSURL <url>`, `-PARSMarksSeed '<json array>'`.
