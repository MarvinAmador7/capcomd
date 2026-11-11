# CHANGELOG

- Homebrew 7 and later can refuse to load capcomd "from untrusted tap". Trust the tap once with
  `brew trust MarvinAmador7/tap` and run the install again (README → Install). The cask now states its macOS
  requirement in the current form (`depends_on macos: :sonoma`), so Homebrew no longer warns about it.
