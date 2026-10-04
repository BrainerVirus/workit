# /wk-test-audit

Load and apply the bundled `workit-test-audit` skill to find tautological and low-value tests.

Run `workit test-audit`, triage each finding with "Name the Break" (replace with an independent oracle proven on a planted bug, keep with a reason, or remove only assertion-free/duplicate tests), check with `workit test-audit --mutate --diff`, and finish with `workit check test` green.

Extra context: $ARGUMENTS
