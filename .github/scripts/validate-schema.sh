#!/usr/bin/env bash
set -eu

shopt -s nullglob
manifests=(plugins/*/plugin.json)
if [ "${#manifests[@]}" -eq 0 ]; then
    printf '%s\n' 'No local plugin manifests to validate.'
    exit 0
fi

# Create before registering cleanup, so a collision never removes an existing directory.
schema_dir=".github/scripts/.schema-check-$$"
mkdir -- "$schema_dir"
trap 'rm -rf -- "$schema_dir"' EXIT
trap 'exit 1' HUP INT TERM

curl -fsSL https://agent-plugins.org/schemas/1.0.0/plugin.schema.json -o "$schema_dir/plugin.schema.json"
npx --yes ajv-cli@5.0.0 validate --spec=draft2020 -s "$schema_dir/plugin.schema.json" -d "plugins/*/plugin.json"
