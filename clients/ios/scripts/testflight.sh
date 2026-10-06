#!/usr/bin/env bash
# Archive the app and upload it to App Store Connect (TestFlight).
#
#   clients/ios/scripts/testflight.sh
#
# Needs App Store Connect access for team 8W7QX56MCL, either:
#   • an Apple Account signed in to Xcode (Settings → Accounts), or
#   • an App Store Connect API key: ASC_KEY_PATH=<AuthKey_XXXX.p8> ASC_KEY_ID=<key id> ASC_ISSUER_ID=<issuer id>
# The build number (CURRENT_PROJECT_VERSION in project.yml) must be higher than the last one uploaded.
set -euo pipefail
cd "$(dirname "$0")/.."
auth=()
if [[ -n "${ASC_KEY_PATH:-}" ]]; then
  auth=(-authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
fi
xcodegen generate >/dev/null
rm -rf build/Superatom.xcarchive build/export
xcodebuild -project Superatom.xcodeproj -scheme Superatom -configuration Release -destination 'generic/platform=iOS' \
  -archivePath build/Superatom.xcarchive -allowProvisioningUpdates ${auth[@]+"${auth[@]}"} archive | tail -3
opts=$(mktemp -t export).plist
cat > "$opts" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>8W7QX56MCL</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict></plist>
PLIST
xcodebuild -exportArchive -archivePath build/Superatom.xcarchive -exportOptionsPlist "$opts" -exportPath build/export \
  -allowProvisioningUpdates ${auth[@]+"${auth[@]}"} | tail -5
