#!/bin/sh

# Restore the package-local Wrangler config before dev or deploy starts.
set -eu

# Keep the final config beside the package: Wrangler resolves entrypoint paths relative to it.
package_dir=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
cd "$package_dir"

temp_file=''

# Remove partial plaintext on normal exit or interruption.
cleanup() {
	if [ -n "$temp_file" ]; then
		rm -f "$temp_file"
	fi
}

# Stage plaintext under ignored .wrangler/ so partial output cannot enter version control.
umask 077
if ! mkdir -p .wrangler; then
	printf '%s\n' 'Could not prepare the private Wrangler temp directory.' >&2
	exit 1
fi

if ! temp_file=$(mktemp .wrangler/wrangler.local.jsonc.XXXXXX); then
	printf '%s\n' 'Could not create a private Wrangler config temp file.' >&2
	exit 1
fi

trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Keep the previous config intact unless SOPS fully decrypts into the private temp file.
if sops --decrypt wrangler.sops.json > "$temp_file"; then
	if ! chmod 600 "$temp_file"; then
		printf '%s\n' 'Could not secure the restored Wrangler config.' >&2
		exit 1
	fi
	if ! mv -f "$temp_file" wrangler.local.jsonc; then
		printf '%s\n' 'Could not install the restored Wrangler config.' >&2
		exit 1
	fi
	temp_file=''
	printf '%s\n' 'Restored Wrangler config.'
else
	status=$?
	printf '%s\n' 'Failed to restore Wrangler config; SOPS left the existing config unchanged.' >&2
	exit "$status"
fi
