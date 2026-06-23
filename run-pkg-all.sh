#!/usr/bin/env bash


# Ensure npm is available
if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found in PATH. Install Node/npm or run from an environment where npm is available." >&2
  exit 2
fi

failures=()

# Iterate immediate subdirectories only
for dir in */; do
  [ -d "$dir" ] || continue
  if [ -f "${dir}package.json" ]; then
    printf "\n==> Running pkg:all in %s\n" "$dir"
    pushd "$dir"
    npm install      
    if (npm run pkg:all); then
      printf "Success: %s\n" "$dir"
    else
      printf "Failed: %s\n" "$dir"
      failures+=("$dir")
    fi
    popd
  else
      printf "Ignoring directory: %s\n" "$dir"
  fi
done

if [ ${#failures[@]} -ne 0 ]; then
  echo "\nThe following directories failed to run pkg:all:" >&2
  for f in "${failures[@]}"; do
    echo "- $f" >&2
  done
  exit 1
fi

echo "\nAll pkg:all scripts completed successfully."
