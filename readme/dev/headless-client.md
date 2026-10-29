# Encrypted headless CLI: Phase 1 implementation increment

Status: initial source implementation, not a production-ready distribution and not a completed Phase 1. Baseline: snapshot `e39b04f30466e4e47af05be5ee763c814cca627e`, representing original dev commit `f4ecbed4e6f693be49e1dd64d6e1ec1d74f767e9`.

## Scope

The opt-in headless mode retains Joplin's models, E2EE, synchronization and full-text search. It adds a SQLCipher-keyed database driver, dedicated-profile bootstrap, database-backed private API token, and a foreground `serve` command. With `JOPLIN_HEADLESS` unset, ordinary CLI storage and commands retain their existing behavior. A small shared lifecycle capability is separate from `hasGui()`, so the daemon does not pretend to have a graphical UI.

Only relevant valuable data is in scope. Notes, FTS and credentials stored inside the database are intended to be protected. Ordinary settings and public resources can remain plaintext. Resource files, exports and previews retain upstream behavior; this is not attachment encryption, whole-profile encryption or disk/volume encryption. Use disposable data until the native and end-to-end acceptance gates pass.

MCP, semantic search, remote clipping, the PWA and operational multi-user support are not implemented here. BGE-M3 dense plus Joplin lexical search is a Phase 2 candidate from the user's supplied comparison, not a benchmark result or a dependency of this fork. Keep the later OpenAI-compatible embedding client and separately encrypted semantic store outside Joplin's database schema. Evaluate rank fusion with the user's actual queries before selecting a model or ranking policy.

## Runtime and native prerequisites

Initial target: Linux, Node 22.12 or newer, using the repository-selected Yarn 4.16.0. The sandbox used Node 22.16.0. Use the vendored Yarn binary rather than silently changing the lockfile to match the older `engines.yarn` value in the snapshot.

A **SQLCipher 4-enabled node-sqlite3-compatible binding is required**. The unchanged upstream `sqlite3@5.1.6` dependency ordinarily uses unencrypted SQLite. A successful standard install is therefore not enough. This increment neither vendors SQLCipher nor selects an untested replacement dependency in `yarn.lock`.

Two supported loading paths are implemented: rebuild the existing `sqlite3` binding against SQLCipher 4, or set `JOPLIN_HEADLESS_SQLITE_MODULE` to the absolute path of a separately built compatible binding. A regular SQLite build is rejected by a positive `cipher_version` check even though it may silently accept an unknown `PRAGMA key`.

For an external build, the upstream node-sqlite3 SQLCipher instructions supply the starting procedure below. It is a **build recipe to validate**, not a build passed in this task. Install a C/C++ build toolchain, Python and SQLCipher 4 headers/library with FTS4 enabled first. Use the actual prefix containing those headers/library; do not assume the operating system's `sqlcipher` package is version 4.

```sh
# Outside this repository, so its native experiment has a separate package lock.
npm install --prefix /absolute/path/headless-native \
  sqlite3@5.1.6 --build-from-source \
  --sqlite_libname=sqlcipher --sqlite=/absolute/path/sqlcipher-prefix

export JOPLIN_HEADLESS_SQLITE_MODULE=/absolute/path/headless-native/node_modules/sqlite3
export JOPLIN_TEST_SQLITE_MODULE="$JOPLIN_HEADLESS_SQLITE_MODULE"
```

Record the resulting package lock, compiler, crypto-library and SQLCipher versions when that build succeeds. Other API-compatible bindings remain experimental until the same native tests pass. Never accept an untrusted binding path: it loads executable code in the key-owning process.

References: [node-sqlite3 SQLCipher build instructions](https://github.com/TryGhost/node-sqlite3#building-for-sqlcipher), [SQLCipher build](https://github.com/sqlcipher/sqlcipher), [SQLCipher API and key validation](https://www.zetetic.net/sqlcipher/sqlcipher-api/). Those describe upstream capabilities, not this fork's validation status.

## Build and tests

From the repository root in an environment with dependencies available:

```sh
node .yarn/releases/yarn-4.16.0.cjs install --immutable
node .yarn/releases/yarn-4.16.0.cjs tsc
node .yarn/releases/yarn-4.16.0.cjs workspace joplin build
node .yarn/releases/yarn-4.16.0.cjs updateIgnored
node .yarn/releases/yarn-4.16.0.cjs workspace joplin test-headless

# The external binding path must be set, or explicitly use the rebuilt 'sqlite3'.
JOPLIN_TEST_SQLITE_MODULE="$JOPLIN_HEADLESS_SQLITE_MODULE" \
  node --test packages/app-cli/tests/headless/native.test.cjs
```

Do not use the ordinary `yarn workspace joplin start` launcher for headless mode: it injects development/debug flags, whereas this bootstrap fixes its own profile and logging policy. Run the built `main.js` directly. Upstream workspace installation may require additional platform build prerequisites; no slim production image has been delivered yet.

The isolated Node test suite transpiles actual source boundaries and uses explicitly fake Joplin workers/API routes where dependencies are unavailable. It covers descriptor handling, profile safeguards, driver initialization order, service wiring and shutdown, and real loopback HTTP startup/draining. It does **not** replace the full TypeScript workspace build, lint, real API-model tests or E2EE synchronization tests. A real ordinary `node:sqlite` engine is used only to demonstrate rejection of a non-encrypting engine.

The native test is deliberately skipped unless `JOPLIN_TEST_SQLITE_MODULE` is set. Once set, a missing or incompatible binding fails rather than skips. It checks positive SQLCipher identification, FTS4, WAL content, correct/wrong/no-key reopening and a stopped-copy restore. An unset native gate must never be counted as Phase 1 acceptance.

## Secret and profile contract

| Input | Behavior |
| --- | --- |
| `JOPLIN_HEADLESS=1` | Explicit opt-in; unset for normal CLI. Other values are rejected. |
| `JOPLIN_HEADLESS_PROFILE` | Required absolute, dedicated independent profile root, not a filesystem root. |
| `JOPLIN_HEADLESS_KEY_FD` | Inherited readable descriptor numbered 3 or greater. It supplies exactly 64 hex characters, optionally one newline, then EOF. |
| `JOPLIN_HEADLESS_SQLITE_MODULE` | Optional absolute node-sqlite3-compatible module path; default `sqlite3` must itself be SQLCipher-enabled. |

Use a randomly generated 32-byte database key retained in a password manager or independent recovery source. This is a raw key, not a human password and not the Joplin E2EE master password. Its bytes are not accepted on the command line or in an environment variable. The descriptor is closed after consumption and writable key buffers are cleared after database opening. JavaScript strings/native-library memory are not claimed to be securely erased.

The launcher acquires a `proper-lockfile` lease on the canonical profile directory before initializing it. A second cooperating headless process must fail rather than share that profile. Lease loss forces exit. This is cooperative process ownership, not a security boundary against host root, hostile programs or manually removing the lock. Do not run another CLI against an active profile. Stop `serve` before configuration, sync or decrypt commands.

A fresh profile receives the non-secret `headless-profile.json` format marker. Startup rejects ordinary plaintext databases, unknown profile formats, pre-existing databases without a marker, nested profiles, `flags.txt` overrides and legacy plaintext API tokens. There is no automatic plaintext migration, destructive repair, wrong-key fallback or deletion of an existing database. An interrupted first bootstrap may leave a marker and empty file; investigate rather than deleting a real database to resolve an error.

The marker describes SQLCipher 4 defaults with a raw 256-bit key and no plaintext database header. Keying and schema readability checks happen before Joplin database migrations. Query temporary storage is set to memory; native build behavior remains part of the acceptance test.

## First-run workflow

The following Bash example preserves stdin for config import or interactive E2EE prompts. Supply a **previously generated and safely retained** 64-hex key; do not generate and discard a new key each launch. Turn off shell tracing before handling secrets. In an unattended deployment, replace the manual prompt with a supervisor that passes the same independent key on an inherited pipe.

```sh
set +x
export JOPLIN_HEADLESS=1
export JOPLIN_HEADLESS_PROFILE=/absolute/path/profiles/account-a
# Set JOPLIN_HEADLESS_SQLITE_MODULE as above unless the installed sqlite3 was rebuilt.
read -r -s -p 'Database key (64 hex): ' DB_KEY
printf '\n'

headless() {
  JOPLIN_HEADLESS_KEY_FD=3 node packages/app-cli/build/main.js "$@" \
    3< <(printf '%s\n' "$DB_KEY")
}

headless config --import
```

`config --import` consumes JSON on stdin followed by EOF. Supply the server address and credentials from a controlled source; avoid writing a plaintext provisioning file into the profile or pasting secrets into command arguments. Example **shape**, with placeholders rather than working values:

```json
{
  "sync.target": 9,
  "sync.9.path": "https://your-joplin-server.example",
  "sync.9.username": "your-account@example",
  "sync.9.password": "<account password>",
  "api.port": 41190,
  "api.token": "<independently generated high-entropy API token>"
}
```

The API token is database-backed, secure and not global in headless mode. OS keychain use is disabled for this mode so secure settings use the encrypted database. Ordinary `config` output masks secure values. Deliberate `config --export` can reveal them; do not redirect it into an ordinary log or unprotected backup. Giving a process the API token authorizes reading plaintext even though that process has no database key.

Local database encryption does not itself enable Joplin E2EE. For an existing E2EE account, perform initial sync and unlock with Joplin's normal password prompt, without creating a separate master key unnecessarily:

```sh
headless sync
headless e2ee decrypt
headless e2ee status
headless serve
# After serve stops and no more commands need it:
unset DB_KEY
```

Do not pass `e2ee --password` or sync passwords on the command line. Upstream attachment download/decryption still applies during sync. Use an appropriate disposable test account first. If sync-target migration is required, review it explicitly rather than applying a production target upgrade as part of this experiment.

`serve` is also the default when no command is given. It keeps API serving, background synchronization, decryption and FTS in the same process. The endpoint remains loopback-only. Choose a fixed `api.port` for routing; without one, the upstream port-selection behavior still applies. Pairing routes `/auth` and `/auth/check` are disabled for headless profiles; provision the token out of band.

The ready message means the private API is listening, **not** that initial synchronization, decryption or indexing has finished. An API save is local acceptance, not proof of remote synchronization or backup. The private status action reports native sync and decryption observations. Acquisition failures retain the public message `Headless status unavailable.` and log the failed acquisition stage privately.

Headless diagnostics use a separate instance of Joplin's logger. It writes lifecycle and boundary failures to stderr and `<profile>/log-headless.txt`, whose permissions are set to `0600`. Records contain fixed operation/stage names, recognized error types and codes, available HTTP statuses, vetted explanations, cause chains and known source module locations. Arbitrary upstream messages, response bodies, headers, request objects, full paths and function names are excluded because those values can contain note contents or credentials. Unknown errors explicitly report that no vetted explanation is available; a missing HTTP status is not inferred from an error code. Payload-bearing shared library and Clipper loggers remain disabled. User-invoked CLI commands can intentionally print content. Queued diagnostic file writes drain before explicit headless command exit.

The headless file target rotates before an append would take a nonempty active file beyond 10 MiB, retaining `log-headless.1.txt`, `.2.txt` and `.3.txt` in newest-to-oldest order. Rotation and append use Logger's existing write mutex through a target-specific file driver; other file targets keep the default driver. The writer reads the active size once at initialization and counts UTF-8 bytes after successful appends, with no maintenance timer or per-write filesystem scan. It owns these files exclusively. Initialization sets the active file and existing archives to `0600`. Complete records remain intact, including a single oversized record; a preexisting oversized file rotates on the next write. Filesystem failures reach stderr without forwarding their raw messages or paths.

Headless `sync` rejects native sync exceptions, authentication/lock failures and reported sync errors instead of reporting success. Headless `e2ee decrypt` rejects decryption failures and items disabled after repeated failures; `--retry-failed-items` retains its existing retry behavior. Ordinary CLI behavior and attachment-download policy are unchanged. The native deployment helper reports each bootstrap stage and stops on a nonzero exit; its final encryption status output is informational and does not establish decryption completion on its own.

SIGINT/SIGTERM stop new API work, drain active requests, stop sync scheduling/cancel an active sync, stop workers, flush settings and close the database before releasing the lease. A 30-second shutdown deadline forces exit if draining hangs; that path does not claim a clean checkpoint. Restart/crash recovery must be tested with the native build.

Separate containers do not share loopback automatically. Keep the raw API private and use controlled same-namespace access/forwarding where needed. Do not publish it to the Internet to solve container networking. User authentication and narrower permissions for remote interfaces belong outside this fork in later phases.

## Acceptance still required

Before calling Phase 1 complete, build with the pinned workspace toolchain and SQLCipher binding, run the native gate and upstream relevant tests/lint, and then use a disposable Joplin Server account plus a stock client to create/read/edit/search in both directions. Confirm API-token persistence, unauthenticated API rejection, same-profile process exclusion, key-unavailable behavior, note changes becoming searchable after decryption, restart, sync outage and a protected restore including unsynchronized edits.

The current source implementation does not claim those runtime checks have passed. A future embedding model or web framework is not a blocker for these core checks.

## Evidence from the first implementation session

On 2026-09-19, Linux/Node 22.16.0 ran 25 isolated tests: **24 passed, 1 explicitly skipped native SQLCipher gate, 0 failures**. Four dependency-free TypeScript modules passed a strict TypeScript 5.8.3 check using available Node declarations. All eleven modified/new TypeScript source files transpiled without syntax errors, and the changed JavaScript/CJS files passed `node --check`. `git diff --check` passed and the upstream `yarn.lock` remained unchanged.

The sandbox could not resolve the npm registry. An immutable Yarn install completed resolution but stalled during fetching and was stopped. Therefore the selected workspace dependencies, its pinned TypeScript 5.9.3 compiler, the native SQLCipher binding and actual Joplin runtime were not available. Full build/lint, SQLCipher positive operation, live E2EE sync, actual API authorization and actual `proper-lockfile` multi-process integration were **not run**. The ordinary-SQLite refusal test does not establish that the SQLCipher-positive path works.

`yarn updateIgnored` was attempted but could not run without Yarn's installed-workspace state. The six new generated-JavaScript paths were added narrowly to both generated ignore blocks; regenerate and check those blocks in the normal build environment. No compiled Joplin files or dependencies are shipped by this commit.

## Follow-up: supplied build evidence and autonomous acceptance

The subsequent `chatgpt-phase1-unblock.zip` report supplies a passing Linux ARM64 SQLCipher 4.10.0/native gate, a full workspace/CLI build after two compiler corrections, real private API/restart/token-persistence tests, and a two-way E2EE round trip with the stock CLI. These are builder-supplied results, not additional sandbox reruns. The two exact compiler corrections are incorporated in this continuation.

The supplied E2EE round trip used one-shot headless `sync` and `e2ee decrypt` with `serve` stopped. It does not establish autonomous background operation. The remaining executable gate is documented in [the acceptance runner](../../packages/app-cli/tests/headless/acceptance/README.md). It keeps `serve` running, injects a server outage, and restores a complete profile containing an unsynchronized canary. It reuses copies of the existing test profiles and does not reset their encryption keys.

A cancellation regression test also exposed a shared registry timer that remained active after cancellation completed. The continuation clears that polling interval on completion; the test demonstrates the original failure and the corrected behavior. This is a shutdown resource fix, not a claim that a live continuous-service test has passed.
