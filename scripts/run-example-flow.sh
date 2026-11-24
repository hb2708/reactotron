#!/usr/bin/env bash
set -euo pipefail

# Repeatable full UI flow for apps/example-app on iOS Simulator via agent-device.
# Covers all 9 screens and all actions.
# Usage: ./scripts/run-example-flow.sh [bundle-id]
# Default bundle id is host.exp.Exponent (Expo Go); pass com.exampleapp for dev build.

APP_ID="${1:-host.exp.Exponent}"
STRESS_COUNT="${STRESS_COUNT:-20}"

# Fast tap for intra-screen buttons (no --settle)
tap() {
  local label="$1"
  echo "  -> $label"
  agent-device press "role=button label=\"$label\"" >/dev/null
}

# Navigation tap (waits for transition to settle)
nav() {
  local label="$1"
  echo "=> $label"
  agent-device press "label=\"$label\"" --settle >/dev/null
}

dismiss_overlays() {
  for _ in 1 2 3 4; do
    agent-device react-native dismiss-overlay >/dev/null 2>&1 || break
  done
}

go_back() {
  dismiss_overlays
  agent-device press 'role=button label="Welcome"' --settle >/dev/null 2>&1 || agent-device back --settle >/dev/null
}

echo "Opening $APP_ID..."
agent-device open "$APP_ID" --foreground >/dev/null
dismiss_overlays
agent-device press 'role=button label="Welcome"' --settle >/dev/null 2>&1 || true

# 1. Logging (all 13 actions)
nav "Logging"
tap "console.log"
tap "console.log with data"
tap "console.debug"
tap "console.warn"
tap "console.error"
dismiss_overlays
tap "console.log a BigInt"
tap "console.log a JSON Serialized BigInt"
agent-device scroll down >/dev/null
echo "  -> Stress loop x${STRESS_COUNT} (Spam 100 logs + Log huge object)"
for i in $(seq 1 "$STRESS_COUNT"); do
  agent-device press 'role=button label="Spam 100 logs"' >/dev/null
  agent-device press 'role=button label="Log huge object"' >/dev/null
done
agent-device scroll bottom --settle >/dev/null
tap "console.tron.image"
tap "Log a Screenshot"
tap "console.tron.display"
tap "console.tron.display (important)"
go_back

# 2. Networking (all 2 actions)
nav "Networking"
tap "Make an API Call"
tap "Make a failing API Call"
go_back

# 3. Custom Commands (info screen)
nav "Custom Commands"
go_back

# 4. Benchmarking (all 2 actions)
nav "Benchmarking"
tap "Fast Benchmarks"
sleep 1
tap "Slow Benchmarks"
sleep 2
go_back

# 5. Async Storage (all 3 actions)
nav "Async Storage"
tap "Async Storage SET"
tap "Async Storage REMOVE"
tap "Async Storage CLEAR"
go_back

# 6. State Management: MST (all 4 actions)
nav "State Management: MST"
tap "Reactotron"
tap "Redux"
tap "MobX"
tap "React Native"
go_back

# 7. State Management: Redux (all 4 actions)
nav "State Management: Redux"
tap "Reactotron"
tap "Redux"
tap "MobX"
tap "React Native"
go_back

# 8. Redaction Test (all 5 actions)
nav "Redaction Test"
tap "Fire sensitive API call"
agent-device scroll down >/dev/null
tap "Poison Redux state"
tap "Log value patterns + sensitive keys"
agent-device scroll bottom --settle >/dev/null
tap "multiSet sensitive pairs"
tap "Dispatch action with myInternalField"
go_back

# 9. Error Generators (all 4 actions; Component Error triggers ErrorBoundary -> RESET APP)
nav "Error Generators"
tap "Try/Catch Error"
tap "Redux Error (sync)"
tap "Redux Error (async)"
dismiss_overlays
tap "Component Error"
dismiss_overlays
agent-device press 'label="RESET APP"' --settle >/dev/null 2>&1 || go_back

agent-device close >/dev/null
echo "Done (all 9 screens)."
