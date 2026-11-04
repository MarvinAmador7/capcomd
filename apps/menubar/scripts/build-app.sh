#!/bin/sh
# Builds the capcomd app (the window and the menu bar item in one Dock app) as a signed macOS app bundle:
# apps/menubar/build/capcomd.app (gitignored).
#
#   apps/menubar/scripts/build-app.sh                     release build for this Mac's architecture
#   apps/menubar/scripts/build-app.sh --debug             debug build (a debugger can attach)
#   apps/menubar/scripts/build-app.sh --universal --zip   what a release ships: arm64 + x86_64, then
#                                                         build/capcomd-app-<version>.zip and its .sha256
#
# CAPCOMD_SIGN_IDENTITY picks the code-signing identity (a name or part of one, as `codesign --sign` takes it).
# Without it the app is signed ad hoc, which macOS treats as a new app on every build: the Keychain asks again for
# the capcomd token after each rebuild. A stable identity keeps "Always Allow" working across rebuilds. Needs Xcode
# or the Command Line Tools (swift, codesign, iconutil, lipo, ditto) and Bun (the icon is drawn by scripts/gen-icon.ts).
set -eu

usage() { sed -n '2,13s/^# \{0,1\}//p' "$0"; }
config=release
universal=
zip=
for arg in "$@"; do
  case $arg in
    --debug) config=debug ;;
    --release) config=release ;;
    --universal) universal=1 ;;
    --zip) zip=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "build-app.sh: unknown option $arg" >&2; usage >&2; exit 2 ;;
  esac
done

[ "$(uname -s)" = Darwin ] || { echo "build-app.sh: the app bundle is macOS only" >&2; exit 1; }
menubar=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$menubar/../.." && pwd)
pkg="$menubar/app"
out="$menubar/build"
app="$out/capcomd.app"
# One app. Its bundle id is new (the menu bar app was dev.capcomd.menubar, the desktop app dev.capcomd.desktop): the
# Keychain token is found by service and account, not by app, so it stays readable, and the app copies the old apps'
# preferences once (Preferences.migrate in CapcomdApp/App.swift).
bundle_id=dev.capcomd.app
product=CapcomdApp
archs=$(uname -m)
if [ -n "$universal" ]; then archs="arm64 x86_64"; fi

bun=${BUN_BIN:-$(command -v bun || true)}
[ -n "$bun" ] || bun="$HOME/.bun/bin/bun"
[ -x "$bun" ] || { echo "build-app.sh: Bun not found (install it, or set BUN_BIN)" >&2; exit 1; }

# The app's version is the repo's (package.json); the build number counts commits, so every commit's build is higher.
version=$(plutil -extract version raw -o - "$repo/package.json")
build=$(git -C "$repo" rev-list --count HEAD 2>/dev/null || echo 1)

# Release builds turn off cross-module optimization: with it, Swift 6.4's optimizer crashes deserializing a
# CapcomdStore function into the app target (PerformanceSILLinker, CapcomdStore.WindowFit.fitted). Speed doesn't need it.
set --
if [ "$config" = release ]; then set -- -Xswiftc -disable-cmo; fi
# --universal is one build for both architectures (`--arch arm64 --arch x86_64`): SwiftPM builds the build tools its
# plugins run (the OpenAPI generator) for this Mac and the product as one universal binary. Two single-arch builds
# don't work: the second builds the generator for the other architecture and can't run it without Rosetta.
if [ -n "$universal" ]; then set -- "$@" --arch arm64 --arch x86_64; fi
echo "==> swift build -c $config --product $product ($archs)"
swift build -c "$config" --product "$product" --package-path "$pkg" "$@"
bin=$(swift build -c "$config" --package-path "$pkg" "$@" --show-bin-path)

mkdir -p "$out"
stage="$out/.partial/capcomd.app"
rm -rf "$out/.partial" "$out/AppIcon.iconset"
mkdir -p "$stage/Contents/MacOS" "$stage/Contents/Resources"
exe="$stage/Contents/MacOS/$product"
cp "$bin/$product" "$exe"
for arch in $archs; do
  lipo "$exe" -verify_arch "$arch" || { echo "build-app.sh: $product has no $arch slice" >&2; exit 1; }
done
printf 'APPL????' > "$stage/Contents/PkgInfo"

# SwiftPM resource bundles (Bundle.module) go in Contents/Resources, where the generated accessor looks inside an
# app. None of the app's targets has resources today; test targets' bundles are skipped.
for b in "$bin"/*.bundle; do
  [ -e "$b" ] || continue
  case $(basename "$b") in *Tests.bundle) continue ;; esac
  cp -R "$b" "$stage/Contents/Resources/"
done

# Swift back-deployment libraries the binary links through @rpath (libswiftCompatibilitySpan on macOS 14 and 15) go
# in Contents/Frameworks. macOS 26 and later have them in /usr/lib/swift, the first rpath, so theirs are used there.
# The toolchain's copies are universal; each one must hold every architecture the app is built for.
otool -L "$exe" | sed -n 's|^[[:space:]]*@rpath/\([^ ]*\.dylib\).*|\1|p' | sort -u | while read -r lib; do
  found=
  for dir in $(otool -l "$exe" | sed -n 's|^ *path \(/[^ ]*\) (offset.*|\1|p' | awk '!seen[$0]++'); do
    [ "$dir" = /usr/lib/swift ] && continue
    if [ -f "$dir/$lib" ]; then found="$dir/$lib"; break; fi
  done
  [ -n "$found" ] || { echo "build-app.sh: $lib (linked through @rpath) not found in the toolchain" >&2; exit 1; }
  for arch in $archs; do
    lipo "$found" -verify_arch "$arch" || { echo "build-app.sh: $found has no $arch slice" >&2; exit 1; }
  done
  mkdir -p "$stage/Contents/Frameworks"
  cp "$found" "$stage/Contents/Frameworks/$lib"
done
if [ -d "$stage/Contents/Frameworks" ]; then
  install_name_tool -add_rpath @executable_path/../Frameworks "$exe" 2>/dev/null
fi

echo "==> icon"
"$bun" "$menubar/scripts/gen-icon.ts" "$out/AppIcon.iconset"
iconutil -c icns "$out/AppIcon.iconset" -o "$stage/Contents/Resources/AppIcon.icns"
rm -rf "$out/AppIcon.iconset"

cat > "$stage/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleDisplayName</key>
	<string>capcomd</string>
	<key>CFBundleExecutable</key>
	<string>$product</string>
	<key>CFBundleIconFile</key>
	<string>AppIcon</string>
	<key>CFBundleIdentifier</key>
	<string>$bundle_id</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>capcomd</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>$version</string>
	<key>CFBundleVersion</key>
	<string>$build</string>
	<key>LSApplicationCategoryType</key>
	<string>public.app-category.developer-tools</string>
	<key>LSMinimumSystemVersion</key>
	<string>14.0</string>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>NSHumanReadableCopyright</key>
	<string>Copyright © 2026 Marvin Amador Campos. MIT License.</string>
</dict>
</plist>
PLIST
plutil -lint -s "$stage/Contents/Info.plist"

# Signing. Today the app is signed ad hoc, or with CAPCOMD_SIGN_IDENTITY, without the hardened runtime: it only matters
# for notarization, and its library validation would refuse an embedded back-deployment library under an ad hoc
# signature. No entitlements: the app isn't sandboxed and needs none. The identity itself is never echoed.
#
# Developer ID and notarization go here, switched on by the environment (the release workflow's secrets), once there
# is a Developer ID. Not implemented yet; CAPCOMD_NOTARIZE=1 refuses until it is. What it will take:
#   1. CAPCOMD_SIGN_IDENTITY="Developer ID Application: …" (a certificate imported into a temporary keychain in CI);
#   2. sign_flags="--options runtime --timestamp" (hardened runtime, a secure timestamp), the Frameworks dylibs first;
#      with library validation on, an embedded dylib must carry the same Team ID (it does once re-signed here);
#   3. after the zip below: xcrun notarytool submit "$zip_path" --wait, with an App Store Connect API key
#      (--key, --key-id, --issuer from secrets) or --keychain-profile;
#   4. xcrun stapler staple "$app", then zip it again (the stapled ticket is inside the bundle) and redo the .sha256;
#   5. drop the cask's "Open Anyway" caveat (scripts/homebrew-cask.ts).
if [ -n "${CAPCOMD_NOTARIZE:-}" ]; then
  echo "build-app.sh: notarization isn't set up yet (see the comment above CAPCOMD_NOTARIZE in this script)" >&2
  exit 1
fi
sign_flags="--timestamp=none"
xattr -cr "$stage"
identity=${CAPCOMD_SIGN_IDENTITY:-}
if [ -n "$identity" ]; then
  echo "==> codesign (identity from CAPCOMD_SIGN_IDENTITY)"
  signed="with CAPCOMD_SIGN_IDENTITY"
else
  echo "==> codesign (ad hoc; set CAPCOMD_SIGN_IDENTITY to keep Keychain access across rebuilds)"
  identity=-
  signed="ad hoc"
fi
for lib in "$stage"/Contents/Frameworks/*.dylib; do
  # shellcheck disable=SC2086 # sign_flags is a list
  if [ -e "$lib" ]; then codesign --force $sign_flags --sign "$identity" "$lib"; fi
done
# shellcheck disable=SC2086
codesign --force $sign_flags --sign "$identity" "$stage"
codesign --verify --deep --strict "$stage"

rm -rf "$app"
mv "$stage" "$app"
rmdir "$out/.partial"
echo "==> $app"
echo "    capcomd $version ($build), $config, $(lipo -archs "$app/Contents/MacOS/$product"), signed $signed"

if [ -n "$zip" ]; then
  # ditto keeps the bundle's symlinks, permissions and signature; --keepParent puts capcomd.app at the zip's top.
  name="capcomd-app-$version.zip"
  zip_path="$out/$name"
  rm -f "$zip_path" "$zip_path.sha256"
  ditto -c -k --keepParent "$app" "$zip_path"
  (cd "$out" && shasum -a 256 "$name" > "$name.sha256")
  echo "==> $zip_path"
  echo "    $(cat "$zip_path.sha256")"
fi
