#!/bin/bash
# Builds this fork (Release) signed with your Apple Development certificate and, with
# --install, replaces /Applications/Sol.app with it. See FORK.md.
set -euo pipefail

cd "$(dirname "$0")/.."
root=$(pwd)

TEAM_ID=${TEAM_ID:-2983V7ZMW9}
SIGN_IDENTITY=${SIGN_IDENTITY:-"Apple Development: ajchoutka@icloud.com (65GY6G7SX5)"}
DERIVED_DATA=${DERIVED_DATA:-"$HOME/Library/Developer/Xcode/DerivedData/sol-fork"}

# CocoaPods runs on Homebrew's bundled Ruby (the system Ruby is too old, and Homebrew won't
# install formulae without the Command Line Tools). Installed with:
#   GEM_HOME=~/.local/share/cocoapods-gems \
#     /opt/homebrew/Library/Homebrew/vendor/portable-ruby/current/bin/gem install cocoapods -v 1.16.2
export GEM_HOME="$HOME/.local/share/cocoapods-gems"
export PATH="/opt/homebrew/Library/Homebrew/vendor/portable-ruby/current/bin:$GEM_HOME/bin:$PATH"
export LANG=en_US.UTF-8
export NODE_BINARY=${NODE_BINARY:-$(command -v node)}

bun install
(cd macos && pod install)

xcodebuild \
  -workspace macos/sol.xcworkspace \
  -scheme release \
  -configuration Release \
  -derivedDataPath "$DERIVED_DATA" \
  CODE_SIGN_STYLE=Manual \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_IDENTITY="$SIGN_IDENTITY" \
  PROVISIONING_PROFILE_SPECIFIER="" \
  build | tail -n 20

app="$DERIVED_DATA/Build/Products/Release/Sol.app"
echo "Built: $app"

if [ "${1:-}" = "--install" ]; then
  osascript -e 'quit app "Sol"' 2>/dev/null || true
  for _ in $(seq 1 20); do pgrep -x sol >/dev/null || break; sleep 0.5; done
  # Keep the official build the first time, to roll back with:
  #   rm -rf /Applications/Sol.app && cp -R ~/.local/share/sol-fork/Sol-upstream.app /Applications/Sol.app
  backup="$HOME/.local/share/sol-fork/Sol-upstream.app"
  previous="$HOME/.local/share/sol-fork/Sol-previous.app"
  mkdir -p "$(dirname "$backup")"
  if [ ! -e "$backup" ]; then
    cp -R /Applications/Sol.app "$backup"
  fi
  rm -rf "$previous"
  mv /Applications/Sol.app "$previous"
  cp -R "$app" /Applications/Sol.app
  open /Applications/Sol.app
  echo "Installed to /Applications/Sol.app"
fi
