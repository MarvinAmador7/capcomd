#!/bin/sh
# Builds the menu bar app as a signed macOS app bundle: apps/menubar/build/capcomd.app (gitignored).
#
#   apps/menubar/scripts/build-app.sh            release build
#   apps/menubar/scripts/build-app.sh --debug    debug build
#
# CAPCOMD_SIGN_IDENTITY picks the code-signing identity (a name or part of one, as `codesign --sign` takes it).
# Without it the app is signed ad hoc, which macOS treats as a new app on every build: the Keychain asks again for
# the capcomd token after each rebuild. A stable identity keeps "Always Allow" working across rebuilds. Needs Xcode
# or the Command Line Tools (swift, codesign, iconutil) and Bun (the icon is drawn by scripts/gen-icon.ts).
set -eu

usage() { sed -n '2,10s/^# \{0,1\}//p' "$0"; }
config=release
for arg in "$@"; do
  case $arg in
    --debug) config=debug ;;
    --release) config=release ;;
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
bundle_id=dev.capcomd.menubar
product=CapcomdMenuBar

bun=${BUN_BIN:-$(command -v bun || true)}
[ -n "$bun" ] || bun="$HOME/.bun/bin/bun"
[ -x "$bun" ] || { echo "build-app.sh: Bun not found (install it, or set BUN_BIN)" >&2; exit 1; }

# The app's version is the repo's (package.json); the build number counts commits, so every commit's build is higher.
version=$(plutil -extract version raw -o - "$repo/package.json")
build=$(git -C "$repo" rev-list --count HEAD 2>/dev/null || echo 1)

# Release builds turn off cross-module optimization: with it, Swift 6.4's optimizer crashes deserializing a
# CapcomdStore function into MenuBarApp (PerformanceSILLinker, CapcomdStore.WindowFit.fitted). Speed doesn't need it.
set --
if [ "$config" = release ]; then set -- -Xswiftc -disable-cmo; fi
echo "==> swift build -c $config --product $product"
swift build -c "$config" --product "$product" --package-path "$pkg" "$@"
bin=$(swift build -c "$config" --package-path "$pkg" --show-bin-path)

mkdir -p "$out"
stage="$out/.partial/capcomd.app"
rm -rf "$out/.partial" "$out/AppIcon.iconset"
mkdir -p "$stage/Contents/MacOS" "$stage/Contents/Resources"
cp "$bin/$product" "$stage/Contents/MacOS/$product"
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
otool -L "$stage/Contents/MacOS/$product" | sed -n 's|^[[:space:]]*@rpath/\([^ ]*\.dylib\).*|\1|p' | while read -r lib; do
  found=
  for dir in $(otool -l "$stage/Contents/MacOS/$product" | sed -n 's|^ *path \(/[^ ]*\) (offset.*|\1|p'); do
    [ "$dir" = /usr/lib/swift ] && continue
    if [ -f "$dir/$lib" ]; then found="$dir/$lib"; break; fi
  done
  [ -n "$found" ] || { echo "build-app.sh: $lib (linked through @rpath) not found in the toolchain" >&2; exit 1; }
  mkdir -p "$stage/Contents/Frameworks"
  cp "$found" "$stage/Contents/Frameworks/$lib"
done
if [ -d "$stage/Contents/Frameworks" ]; then
  install_name_tool -add_rpath @executable_path/../Frameworks "$stage/Contents/MacOS/$product" 2>/dev/null
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
	<key>LSUIElement</key>
	<true/>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>NSHumanReadableCopyright</key>
	<string>Copyright © 2026 Marvin Amador Campos. MIT License.</string>
</dict>
</plist>
PLIST
plutil -lint -s "$stage/Contents/Info.plist"

# Signing. No hardened runtime: it only matters for notarization, and its library validation would refuse an
# embedded back-deployment library under an ad hoc signature. No entitlements: the app isn't sandboxed and needs none.
# The identity itself is never echoed, only whether one was given.
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
  if [ -e "$lib" ]; then codesign --force --timestamp=none --sign "$identity" "$lib"; fi
done
codesign --force --timestamp=none --sign "$identity" "$stage"
codesign --verify --deep --strict "$stage"

rm -rf "$app"
mv "$stage" "$app"
rmdir "$out/.partial"
echo "==> $app"
echo "    capcomd $version ($build), $config, signed $signed"
