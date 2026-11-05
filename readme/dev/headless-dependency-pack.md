# Dependency/runtime pack for the ChatGPT sandbox — handoff to Codex

Measured in the actual sandbox on 2026-09-19. These are observed outputs, not assumed from previous sessions:

```text
$ uname -m
x86_64
$ node --version
v22.16.0
$ ldd --version | head -n 1
ldd (Debian GLIBC 2.41-12+deb13u3) 2.41
```

OS: Debian GNU/Linux 13.3 (trixie), Linux x86-64. Node module ABI 127, Node-API 10, `process.arch` x64. There is no Docker command/daemon available here. `tar`, gzip, zstd, GCC, make and Python are available. The default TypeScript is 5.8.3, not the pinned 5.9.3. A bounded registry probe still failed DNS resolution (`Could not resolve host: registry.npmjs.org`). The built-in Node SQLite is not SQLCipher.

The supplied successful native builder is **ARM64**. Its `.node` and ELF shared-library files cannot be used as the native x86-64 pack. Ordinary JavaScript can be reused, but all platform-specific binaries in the runtime closure must match the target, not just sqlite3. The already passed ARM64 functional acceptance is not invalidated by this separate portability need.

## Preferred deliverable: a prepared, relocatable CLI workspace

Please prepare `joplin-headless-runtime-linux-x64.tar.zst` (or `.tar.gz`) from a **clean build staging directory**, for Linux amd64/x86-64, Node 22.16.0, and glibc no newer than 2.41. Debian 12/bookworm amd64 or Debian 13/trixie amd64 are reasonable builder targets; validate the resulting libraries rather than assuming the distro name is enough. On the ARM64 builder, Docker `--platform linux/amd64` is one possible build environment if available there. Do not send a Docker image as the only artifact: this sandbox needs extracted files, not a running container engine.

Use the current checkout's vendored Yarn 4.17.0 when preparing this pack. The historical original-source core used by the earlier tests is `10bf74ee79537b697b82db92b6519087fdf3ad51`; its mapped public-history commit is `5ddb572501f5430e02ad25840a372984c8c04392`. Those tests were not rerun against the mapped commit. For the equivalent changes in snapshot history, see `d3f50c9213b58c5e2728b0b217b7c71b51b11e7b`. Record any later imported account-interface commit separately. Do not change the upstream lockfile to manufacture a smaller pack.

Suggested archive layout:

```text
joplin-headless-runtime-linux-x64/
  MANIFEST.json
  README-run.txt
  SHA256SUMS
  workspace/
    package.json, yarn.lock, .yarnrc.yml, tsconfig*.json
    .yarn/releases/ ... and relevant patches/install state
    node_modules/ ... including TypeScript 5.9.3 and needed build/test tools
    packages/app-cli/ ... source, generated JS/build, own node_modules
    packages/lib/ ... source, generated JS/assets, own node_modules
    packages/<transitive-workspace>/ ... built output/assets and own node_modules
    extras/headless-service/ ... if the new increment is included
  native/
    node_modules/sqlite3/ ... COMPLETE compatible package, including .node
    ... the sqlite3 package's required JS dependencies
  lib/
    ... required non-system SQLCipher/OpenSSL/etc shared libraries, if dynamic
  checks/
    environment.txt
    native-library-dependencies.txt
    relocation-smoke.log
```

An exact layout variation is fine if `README-run.txt` gives working relative paths. `native/` may be unnecessary when the correct binding is included within the workspace. The important result is that **the unpacked CLI can run without downloading packages**.

Do not include only the root `node_modules`. This snapshot sets `nodeLinker: node-modules` and `nmHoistingLimits: workspaces`: required packages may live in workspace-local `node_modules`. Preserve the relative directory layout and symlinks, including internal `@joplin/*` workspace targets. The prior stock-comparator staging failure already demonstrated why missing workspace dependencies matter.

A source-manifest traversal of runtime/optional/peer workspace dependencies identified these initial workspace candidates: app-cli, lib, utils, renderer, htmlpack, onenote-converter, fork-htmlparser2, fork-sax, fork-uslug, turndown, turndown-plugin-gfm. This is **not** proof of the installed dynamic-import or build-tool closure. Include additional workspaces/assets demanded by the actual compiled CLI and chosen build/tests; a complete clean prepared workspace is safer than pruning blindly.

Include SQLCipher 4.10.0 with the compatible sqlite3 5.1.6 binding if reproducing the known native setup. Either statically link SQLCipher and other suitable dependencies into the addon, or include the matching non-system shared-library closure and an explicit `LD_LIBRARY_PATH`/RPATH arrangement. Run `ldd` on the **trusted, newly built** native addon and relevant libraries; resolve every `not found`. Do not overwrite the sandbox's glibc or ELF loader, and do not silently bundle an incompatible loader as a workaround. Do not compile with CPU-specific `-march=native` assumptions about the builder.

## Small relocation check before packaging

Use a second directory and an empty temporary HOME, with no test profiles or real credentials. Verify symlinks do not point back to `/work/joplin`, `/opt/headless-native`, a package store outside the archive, or a developer HOME. Relative workspace links must still reach files inside the pack. If the existing builder uses absolute links, fix the staging copy, not the working source tree.

From the relocated tree, using the x64 Node 22.16.0 runtime:

1. Load the sqlite3 package and query `PRAGMA cipher_version`; it must return the expected SQLCipher version rather than an empty result from ordinary SQLite.
2. Run the existing native test with `JOPLIN_TEST_SQLITE_MODULE` pointing at the **relocated** package. It uses disposable local data, not the E2EE account.
3. Run the compiled CLI's `--version` or `help` using a disposable HOME/profile to catch missing dynamic workspace imports. Keep `JOPLIN_HEADLESS` unset for this ordinary help invocation. Then verify the headless isolated tests resolve their TypeScript dependency.
4. Verify the included TypeScript reports 5.9.3. If supplying a rebuild-capable pack, also demonstrate the exact intended compile command from the relocated tree without package downloads.

These are packaging checks, **not a request to repeat the passed seven-stage live acceptance**. No real account/profile is needed or wanted in the archive. The Phase 1.5 real-account smoke can be run separately on the existing ARM64 builder; the new application module itself has no native or third-party dependencies.

If dynamic libraries are bundled, the receiving commands will be approximately:

```sh
PACK=/mnt/data/joplin-headless-runtime-linux-x64
export LD_LIBRARY_PATH="$PACK/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export JOPLIN_HEADLESS_SQLITE_MODULE="$PACK/native/node_modules/sqlite3"
export JOPLIN_TEST_SQLITE_MODULE="$PACK/native/node_modules/sqlite3"
node --test "$PACK/workspace/packages/app-cli/tests/headless/native.test.cjs"
```

The production override `JOPLIN_HEADLESS_SQLITE_MODULE` is confirmed in `packages/app-cli/app/headless/config.ts`; `JOPLIN_TEST_SQLITE_MODULE` is the native-test override. No real DB key is needed for that disposable native test.

## Manifest and delivery

Record `git rev-parse HEAD`, `git rev-parse HEAD^{tree}`, `sha256sum yarn.lock`, Node `process.versions`, `uname -m`, distro/glibc version, Yarn/TypeScript versions, SQLCipher/sqlite3 versions, native addon path and `ldd` output. State whether files are prebuilt runtime, rebuild support, or both. Retain relevant package licenses.

Stage no `.git` history (we already have the bundles), private `.npmrc`, auth-bearing `.yarnrc.yml`, `.env*`, credentials, user profiles/databases, test-account state, API tokens, E2EE keys, private logs, browser profiles or model weights. Use the original repository's nonsecret Yarn configuration or a reviewed sanitized equivalent. These packaging instructions do not require encrypting every dependency file.

From the parent of the reviewed clean directory:

```sh
# tar preserves relative symlinks and executable modes. Do not use -h/--dereference.
tar --zstd -cf joplin-headless-runtime-linux-x64.tar.zst joplin-headless-runtime-linux-x64
sha256sum joplin-headless-runtime-linux-x64.tar.zst > joplin-headless-runtime-linux-x64.tar.zst.sha256
```

Attach the archive and checksum here, or upload them to an artifact destination selected by the operator and give the filename/file reference. Large archives can be split into 200 MiB chunks for convenience with `split -b 200M -d -a 3`; include the overall hash and hashes for parts. This size is a convenience, not a stated platform upload limit.

## Optional alternative: offline rebuild material

If preparing an amd64 runtime is inconvenient, the complete `.yarn/cache` and exact manifests/lock/patches, plus source/toolchain inputs for native builds, are still useful. They do **not** replace a ready-made native runtime: cache archives are package inputs, and install/build scripts may separately need Node headers, SQLCipher source, native prebuilds or other assets. Include those needed inputs or document missing ones. An ARM64-only cache can omit platform-specific x64 packages.

For a deliberately complete offline mirror, the receiving install would use the vendored Yarn with network disabled and immutable inputs, for example `YARN_ENABLE_NETWORK=0 node .yarn/releases/yarn-4.17.0.cjs install --immutable --immutable-cache`. That command cannot compensate for missing cached packages or unavailable native build inputs. Do not send an entire HOME/npm cache as a substitute; it may contain credentials and unrelated data.

The **preferred first pack is the runnable x64 workspace plus native binding**, because it removes the immediate native/runtime blocker. A cache-only pack is a secondary option, not an additional mandatory deliverable.

## Primary references checked for these instructions

- Yarn cache strategy, including native-build caveat: https://yarnpkg.com/features/caching
- Yarn `nmHoistingLimits`, `nodeLinker`, `enableNetwork`, `installStatePath`: https://yarnpkg.com/configuration/yarnrc
- Node 22.16.0 Node-API and external-library ABI boundary: https://nodejs.org/download/release/v22.16.0/docs/api/n-api.html
- sqlite3 SQLCipher build reference: https://github.com/TryGhost/node-sqlite3#building-for-sqlcipher

No compatible dependency/runtime pack was actually received or built in this task. These are the requested preparation and transfer instructions.
