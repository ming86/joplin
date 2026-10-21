#!/bin/sh
set -eu

role=${1:-core}
if [ "$#" -gt 0 ]; then
	shift
fi

case "$role" in
	core)
		# Pass the database key on an inherited descriptor; the application validates its bytes.
		: "${JOPLIN_HEADLESS_PROFILE:=/data/profile}"
		: "${JOPLIN_HEADLESS_SQLITE_MODULE:=/opt/headless-native/node_modules/sqlite3}"
		: "${JOPLIN_HEADLESS_KEY_FILE:=/run/secrets/database-key}"
		export JOPLIN_HEADLESS=1
		export JOPLIN_HEADLESS_PROFILE JOPLIN_HEADLESS_SQLITE_MODULE
		exec 3<"$JOPLIN_HEADLESS_KEY_FILE"
		unset JOPLIN_HEADLESS_KEY_FILE
		export JOPLIN_HEADLESS_KEY_FD=3
		if [ "$#" -eq 0 ]; then
			set -- serve
		fi
		exec node /app/packages/app-cli/build/main.js "$@"
		;;
	mcp)
		case "$#" in
			0) set -- /etc/joplin-headless/mcp-http.json ;;
			1) : ;;
			*) echo 'usage: entrypoint.sh mcp [config]' >&2; exit 2 ;;
		esac
		exec node /app/extras/headless-service/mcp-http.mjs "$1"
		;;
	*)
		echo "unknown headless-service role: $role" >&2
		exit 2
		;;
esac
