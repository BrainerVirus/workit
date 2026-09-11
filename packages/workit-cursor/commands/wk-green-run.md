# /wk-green-run

Load and apply the bundled `workit-green-run` skill to drive a red CI pipeline back to green.

Read the failing logs, classify (flake/stale-base/real failure), fix at root cause with a regression test, push one wave, re-verify green on the new head.

Extra context: $ARGUMENTS
