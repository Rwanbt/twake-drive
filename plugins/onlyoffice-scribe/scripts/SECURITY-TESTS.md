# OnlyOffice Scribe host-message boundary

Base SHA: `78e8ccc4f86ce5b87567deb714f63f9299deaa38`.

The plugin's `window.parent.parent` reference survives origin changes. Merely
comparing `event.source` with that WindowProxy does not authenticate the
origin of a post-navigation message. The editor frame already receives
`parentOrigin` from the Document Server; the listener now pins that origin
at initialization and rejects mismatched origin/source, including when the
configuration is absent. It no longer learns trust from incoming messages.

Run without external network access, browser or npm dependencies:

```sh
node --test plugins/onlyoffice-scribe/scripts/host-messages.test.mjs plugins/onlyoffice-scribe/scripts/host-message-lifecycle.test.mjs
```

The suite covers exact source+origin, changed scheme, lookalike domain,
missing/null origin, forged frame, and the real Scribe listener's document
read/write path with a stubbed editor API. A separate RED→GREEN lifecycle
suite demonstrates that initially unopened panels, closed panels and
in-flight replacements cannot write stale content. Valid open-panel writes
remain functional. Both suites are required steps in
`.github/workflows/ci-cd.yml`.

### Packaged plugin reproducibility

The real GitHub Playwright run failed 11 Scribe document tests with
`Asc.plugin.init is not a function`. The OnlyOffice package builder
copied `.js` but omitted `.mjs`, including the runtime security
module imported by `scribe.js`. The browser could not execute the
entrypoint. The packager now includes both runtime module formats and
excludes test files. The standalone build-inventory tests validate every
relative runtime import against the files selected for shipping.
An actual GitHub browser E2E rerun is required for qualification.

The packager now calls `assertScribePackage` after writing the actual
deployment files. The validator checks the ESM entrypoint, all relative
runtime imports, and absence of test source. Its four negative/positive
packaged-artifact cases demonstrate fail-closed behavior if a required
module is removed, a test source leaks, or the entrypoint is invalid.
The CI build runs `yarn build:onlyoffice-scribe` as a required gate.

Publishing credentials are never used on the fork, including its master
or tags. The `fork-release-policy` tests ensure SSH deployment and
`cozyPublish` can only run on the non-fork upstream. All **16** focused
tests pass locally; complete Playwright Scribe integration and release
qualification remain separate mandatory gates.

### Chromium/OnlyOffice MIME compatibility

The GitHub Playwright execution `39125123849` (exact SHA `01bdd542`)
confirmed the prior missing-module fix alone was insufficient: the
Document Server serves `.mjs` with `application/octet-stream`, rejected
by Chromium's strict ES module MIME policy. `Asc.plugin.init` never
executed. The host-origin authorization helper is now deployed as a
`.js` ES module (the format already used by the working Scribe modules).
The actual build validator rejects all non-`.js` relative runtime
imports, with an adversarial fixture reproducing this failure.

This is a code/package-level fix; only a clean Playwright rerun can prove
that the Document Server loads the corrected module successfully.

Passing these deterministic boundary tests is **not** proof of a safe
OnlyOffice deployment. Full Jest/Playwright/OnlyOffice integration, browser
CSP, document permissions, cross-window initialization, and build output
must still pass on the PR's exact HEAD SHA before merge.
### Editor command failure and stale queued writes

The actual Scribe `runInEditor` queue previously kept a rejected Promise
as `lastCommand` after a synchronous `Asc.plugin.callCommand` exception.
This permanently rejected later editor operations, even after a valid
request from the same authorized panel. A direct VM test reproduced the
failure (RED); the queue now handles the prior rejection *for scheduling*
while still returning the original rejection to its caller (GREEN).
An additional controlled queued-read test proves a stale replacement cannot
write when the original Scribe panel closes, even if the same trusted origin
opens a new panel. Both tests exercise the production `scribe.js` listener,
not a copied authorization mock. These local tests do not replace the real
Playwright/OnlyOffice CI gate.

### Chromium close/reopen write ownership regression

An insert can finish in OnlyOffice while `GetSelectedText` remains pending.
Closing and reopening the assistant at the same host origin must revoke the
old panel's *write lock*, not just its document command. The shared boolean
previously blocked a new, valid answer until the old selection callback
returned. The plugin now owns the write lock by its panel request epoch; an
obsolete callback cannot block or unlock the new panel.

The actual unmodified `scribe.js` from `418f692` fails the browser test
(one write instead of two). The updated plugin passes the *same* Chromium
scenario, including a host-origin sibling iframe attempting a forged read,
two concurrently pending selection callbacks, and an old callback attempting
to release the current panel's write lock. The browser loads the real Scribe
ES modules through a disposable pair of local HTTP origins and stubs only the
OnlyOffice command bridge; no application accounts or external servers exist.

The CI build runs this targeted real-browser check after the Node lifecycle
tests. Developers with dependencies installed can reproduce it using:

```sh
yarn playwright install chromium
yarn playwright test --config=plugins/onlyoffice-scribe/scripts/playwright.lifecycle.config.cjs
```
