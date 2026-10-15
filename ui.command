#!/bin/bash
# The interface preview, started with a double click in Finder (or from any
# folder in a terminal): the app's window in the browser, no build needed.
# Close this terminal window, or press Ctrl+C, to stop it.
cd "$(dirname "$0")" || exit 1
[ -d node_modules ] || npm install
# Already running (another window, say): just open it again.
if lsof -nP -iTCP:1430 -sTCP:LISTEN > /dev/null 2>&1; then
  open "http://localhost:1430/preview.html"
  exit 0
fi
exec npm run ui
