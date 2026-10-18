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

Passing these deterministic boundary tests is **not** proof of a safe
OnlyOffice deployment. Full Jest/Playwright/OnlyOffice integration, browser
CSP, document permissions, cross-window initialization, and build output
must still pass on the PR's exact HEAD SHA before merge.
