# Remaining Phase 1 real-runtime acceptance

This runner covers the remaining gaps from `chatgpt-phase1-unblock.zip`: autonomous synchronization/decryption while `serve` remains alive, network outage/recovery, and restoration of a **complete** stopped profile with a note that was never synchronized. It does not replace the supplied SQLCipher/native and workspace-build results.

## Preconditions

Run on Linux in an environment with Node 22.16.0 or a compatible tested Node 22 release, both compiled CLI entry points and their installed dependencies, and the tested SQLCipher-enabled `sqlite3` binding. Both entry points, source profiles, scratch directory and key file must be accessible in the same environment/network namespace as the runner. The stock CLI must be an unmodified build of the corresponding upstream commit, not a second invocation of the modified CLI. Do not point at a different machine's container path.

Use the **existing disposable test account**, already enabled for E2EE in the supplied test results. Stop the original headless and stock clients before copying. Keep their private recovery state. The runner deliberately does **not** call `e2ee enable`, `e2ee disable`, generate a replacement master key, reset provisioning, or require the account password in its configuration.

Source profiles must use Joplin Server target `9`, the expected canonical server URL and username, and the same existing active E2EE key. Their previously working synchronization and decryption credentials must remain available in their profile databases. Profiles whose credentials exist only in an external keychain are not supported by this test. Separate independent root profiles are required. Other targets, preexisting network proxies, redirects, profile symlinks and concurrent original clients are intentionally outside this first runner's scope, not new product restrictions.

The archive contains build recipes and sanitized results, **not** a compiled workspace or native binaries. Build with the two supplied compiler fixes applied. No repository dependency-lock change is needed for this continuation. The existing native build recipe can continue supplying `/opt/headless-native/node_modules/sqlite3`.

## Configure and run

Copy `config.example.json` to a private location and replace its placeholder paths, server URL and username. `workDir` must not exist and its parent must exist. It cannot be inside either source profile. Set both confirmation booleans to true only for a disposable account whose original clients are stopped.

`databaseKeyFile` must contain the **existing** headless database key as 64 hexadecimal characters, with an optional newline. Use the value from the retained private recovery material; do not generate a new key or change its format. The file belongs outside the source profiles and returned results. The runner opens it read-only for each headless process and supplies its descriptor as FD3; the key is never passed as a command-line argument or environment value.

```sh
chmod 600 /private/acceptance.json /run/secrets/existing-headless-database-key.hex

node packages/app-cli/tests/headless/acceptance/run.cjs \
  /private/acceptance.json
```

The main process is the test's supervisor. Do not run the copied profiles in another process concurrently. SIGINT/SIGTERM asks the runner to stop its children; abrupt termination can leave private scratch state and a running child to inspect locally. Avoid `kill -9` except when necessary. No command in this README asks to upload private state.

The runner uses Joplin's supported **300-second** recurrent sync interval, not an unsupported shorter enum value and not a manual headless `/sync` call. The timeout is a per-stage deadline (default 900,000 ms), not an estimated execution duration. Inbound and recovery stages may wait for that normal recurrence; a listening API alone does not pass them.

## Exact experiment

1. Acquire the headless source's normal cooperative profile lease. Copy the complete stopped headless and stock profiles into a private scratch directory, hashing every regular file before and after copying. Reject special files/symlinks instead of following them. Leave the original source profiles unchanged. The stock CLI does not share that headless lease; its source must actually be stopped as declared.
2. Read existing settings privately from the copies; verify target, account and E2EE identity. Obtain the existing API token without printing it. Change only test-local connection/port/interval settings, never the E2EE key configuration.
3. Start a fixed-destination loopback fault proxy for the headless client's server connection. The stock comparator talks directly to the actual server. Redirects are rejected to prevent bypassing fault injection. The proxy never records headers, tokens, request bodies or URLs.
4. Start `serve`, create a synthetic notebook/note through its private API and find the body through FTS. Poll ordinary stock `sync`/`e2ee decrypt`/read commands until the stock client observes the note. There are **no headless one-shot sync or decryption commands** during the experiment.
5. Change the note from the stock client, upload it, and use only read/search calls against the unchanged headless process until its updated body is decrypted and searchable. Do not restart or write to the headless API to force an inbound sync.
6. Block the headless server connection while the stock comparator stays online. Make both a remote edit and a locally saved note. Require a real blocked sync request; verify local FTS still works, the remote edit is not visible locally yet, and the stock client does not list the offline-created note.
7. Reopen the proxy and wait for both directions to converge without a headless restart, signal or write to trigger recovery. Require the same `serve` PID.
8. Block the connection again. Create and index another unique note and establish that the stock client cannot list it. Stop the headless client cleanly; copy its **entire** profile into a backup, then restore that backup to another directory. Reopen the restored profile with the existing key/API token while the proxy remains blocked. Require the unsynchronized note through FTS and no forwarded network request during restore. A remote re-download therefore cannot explain success.
9. Confirm retained API token and E2EE key identity, check selected credential values are absent from the restored plaintext settings, and verify both original source-profile inventories remain unchanged.

Only stock comparator commands may run `sync` or `e2ee decrypt`. Before and after `serve`, the copied headless client may run `config --import/--export` to arrange or inspect the test. A guard refuses even an accidental headless one-shot command while the daemon is running.

## Outputs and retained data

Success requires exit status zero, `PASS autonomous-acceptance` and an `acceptance-report.json` with `status: PASS` and seven passing checkpoints. Failure names its stage and, when safe, an internal error code. It does not dump raw native, JSON, HTTP or CLI diagnostics because those can contain secrets or note content.

The report and console checkpoint names are suitable for sharing after review. **Do not share** the configuration, raw database key, either source profile, scratch/backup/restored profiles, raw command output, or `live-headless-state.json`. `workDir` contains the stock comparator's ordinary plaintext database as well as encrypted headless copies. These are private validation artifacts, not a new production encryption requirement.

Two synchronized synthetic notes and their notebook remain in the disposable remote account. The final unsynchronized restore canary remains only in the retained private test profiles. The runner does not delete remote data, reset the original clients, rewrite private recovery files or remove failed-run files. Review and clean up the synthetic notebook separately when appropriate.

Record the actual rebuilt source revisions and native versions alongside the report. A passing report records results for those binaries, not every future rebase. The runner itself cannot cryptographically verify that an arbitrary supplied `stockCli` was built unmodified; the builder must identify that build.

## Local tests of the runner

```sh
node --test packages/app-cli/tests/headless/acceptance.test.cjs
node --test packages/app-cli/tests/headless/scheduling.test.cjs
```

These tests cover the real loopback proxy, file-descriptor handoff, copying, validation, shutdown and scheduling boundaries. One test drives the entire runner with **simulated CLIs**, which reject any attempted headless `sync`/`e2ee` command. That self-test does **not** test native encryption, real FTS, real synchronization or real E2EE. Run the separate `run.cjs` command above for actual runtime results.
