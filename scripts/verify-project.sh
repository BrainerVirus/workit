#!/bin/sh

set -u

root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$root" || exit 1

dry_run=false
case " ${*:-} " in
  *" --dry-run "*) dry_run=true ;;
  *" dry-run "*) dry_run=true ;;
esac

passed=0
failed=0
skipped=0

run_check() {
  label=$1
  shift
  printf '\n## %s\n\n' "$label"
  printf 'command: %s\n\n' "$*"
  if [ "$dry_run" = true ]; then
    printf 'status: skipped (dry run)\n'
    skipped=$((skipped + 1))
    return 0
  fi
  "$@"
  code=$?
  if [ "$code" -eq 0 ]; then
    printf '\nstatus: pass\n'
    passed=$((passed + 1))
  else
    printf '\nstatus: fail (exit %s)\n' "$code"
    failed=$((failed + 1))
  fi
  return 0
}

skip_check() {
  label=$1
  reason=$2
  printf '\n## %s\n\nstatus: skipped (%s)\n' "$label" "$reason"
  skipped=$((skipped + 1))
}

has_script() {
  name=$1
  [ -f package.json ] || return 1
  node -e "const p=require('./package.json'); process.exit(p.scripts && p.scripts['$name'] ? 0 : 1)" >/dev/null 2>&1
}

package_runner() {
  if [ -f pnpm-lock.yaml ] || grep -q '"packageManager"[[:space:]]*:[[:space:]]*"pnpm' package.json 2>/dev/null; then
    printf 'pnpm'
  elif [ -f yarn.lock ]; then
    printf 'yarn'
  elif [ -f package-lock.json ]; then
    printf 'npm'
  else
    printf 'npm'
  fi
}

printf '# Verification Context\n'
printf '\nroot: %s\n' "$root"
printf 'dry_run: %s\n' "$dry_run"

if [ -f package.json ]; then
  runner=$(package_runner)
  for script in lint format:check test build; do
    if has_script "$script"; then
      if [ "$runner" = "npm" ]; then
        run_check "$script" npm run "$script"
      else
        run_check "$script" "$runner" "$script"
      fi
    else
      skip_check "$script" "package.json has no $script script"
    fi
  done
else
  skip_check "javascript" "package.json not found"
fi

cargo_manifest=""
if [ -f Cargo.toml ]; then
  cargo_manifest="Cargo.toml"
elif [ -f src-tauri/Cargo.toml ]; then
  cargo_manifest="src-tauri/Cargo.toml"
fi

if [ "$cargo_manifest" != "" ]; then
  run_check "cargo fmt" cargo fmt --manifest-path "$cargo_manifest" -- --check
  run_check "cargo clippy" cargo clippy --manifest-path "$cargo_manifest" --all-targets -- -D warnings
  run_check "cargo test" cargo test --manifest-path "$cargo_manifest" --all-targets
else
  skip_check "rust" "Cargo.toml not found"
fi

if [ -f pyproject.toml ] || [ -f pytest.ini ] || [ -d tests ]; then
  if command -v pytest >/dev/null 2>&1; then
    run_check "pytest" pytest
  else
    skip_check "pytest" "pytest not available"
  fi
  if command -v ruff >/dev/null 2>&1; then
    run_check "ruff check" ruff check .
  else
    skip_check "ruff check" "ruff not available"
  fi
fi

printf '\n# Summary\n\n'
printf 'passed: %s\n' "$passed"
printf 'failed: %s\n' "$failed"
printf 'skipped: %s\n' "$skipped"

if [ "$failed" -gt 0 ]; then
  exit 1
fi
