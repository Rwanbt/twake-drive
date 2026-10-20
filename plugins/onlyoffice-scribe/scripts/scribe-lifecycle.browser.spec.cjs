const { expect, test } = require("@playwright/test");
const { createServer } = require("node:http");
const { readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

// Serve the *actual* OnlyOffice plugin modules in Chromium. The editor API is
// the only stub: it holds one GetSelectedText callback so a stale panel's
// continuation can overlap a new authorized panel. No Cozy account, Docker,
// external site or test-only copy of the Scribe listener is involved.
const scriptNames = new Set([
  "scribe.js",
  "host-messages.js",
  "document.js",
  "markdown.js",
  "presentation.js",
]);

let appServer;
let editorServer;
let appOrigin;
let editorOrigin;

const listen = (server) =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });

const close = (server) =>
  new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

test.beforeAll(async () => {
  editorServer = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/vendor/marked.esm.js") {
      response.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
      });
      response.end(
        readFileSync(join(dirname(require.resolve("marked")), "marked.esm.js"))
      );
      return;
    }
    if (url.pathname.startsWith("/scripts/")) {
      const name = url.pathname.slice("/scripts/".length);
      if (!scriptNames.has(name)) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
      });
      // Optional immutable baseline lets the exact same Chromium scenario
      // demonstrate RED against the old shipped script, then GREEN on HEAD.
      const file =
        name === "scribe.js" && process.env.SCRIBE_BROWSER_SOURCE_FILE
          ? process.env.SCRIBE_BROWSER_SOURCE_FILE
          : join(__dirname, name);
      response.end(readFileSync(file));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (url.pathname === "/editor") {
      response.end('<!doctype html><iframe src="/plugin"></iframe>');
      return;
    }
    if (url.pathname === "/plugin") {
      response.end(`<!doctype html>
      <script type="importmap">{ "imports": { "marked": "/vendor/marked.esm.js" } }</script>
      <script>
        window.mockEditor = { calls: [], holdSelection: false, pendingSelections: [] };
        window.Asc = { scope: {}, plugin: {
          info: { editorType: 'word' },
          callCommand(command, _unused, _recalculated, done) {
            window.mockEditor.calls.push(command.name);
            done({ content: 'real editor document', target: 'document', canReplace: true });
          },
          executeMethod(_method, _args, done) {
            if (window.mockEditor.holdSelection) {
              window.mockEditor.holdSelection = false;
              window.mockEditor.pendingSelections.push(done);
            } else done('');
          }
        }};
      </script><script type="module">
        import('/scripts/scribe.js').then(() => window.Asc.plugin.init());
      </script>`);
      return;
    }
    response.writeHead(404).end();
  });
  const editorPort = await listen(editorServer);
  editorOrigin = `http://127.0.0.1:${editorPort}`;
  appServer = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><script>
      window.scribeMessages = [];
      window.addEventListener('message', event => {
        window.scribeMessages.push({
          type: event.data?.type,
          origin: event.origin,
          requestId: event.data?.requestId
        });
        if (event.data?.type === 'twake-scribe:ready') window.scribePlugin = event.source;
      });
    </script><iframe src="${editorOrigin}/editor?parentOrigin=${encodeURIComponent(
      appOrigin
    )}"></iframe>`);
  });
  const appPort = await listen(appServer);
  appOrigin = `http://127.0.0.1:${appPort}`;
});

test.afterAll(async () => {
  await Promise.all([close(appServer), close(editorServer)]);
});

test("real Chromium origin/source boundary and reopen permit a new write before old selection resolves", async ({
  page,
}) => {
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  await page.goto(appOrigin);
  await expect
    .poll(async () => {
      const isReady = await page.evaluate(() => !!window.scribePlugin);
      if (!isReady && browserErrors.length > 0)
        throw new Error(browserErrors.join("\n"));
      return isReady;
    })
    .toBe(true);
  const pluginFrame = page
    .frames()
    .find((frame) => new URL(frame.url()).pathname === "/plugin");
  expect(pluginFrame).toBeTruthy();

  const send = (type, data = {}) =>
    page.evaluate(
      ({ type, data, editorOrigin }) => {
        window.scribePlugin.postMessage({ type, ...data }, editorOrigin);
      },
      { type, data, editorOrigin }
    );
  const messagesOfType = (type) =>
    page.evaluate(
      (type) =>
        window.scribeMessages.filter((message) => message.type === type).length,
      type
    );
  const writes = () =>
    pluginFrame.evaluate(
      () =>
        window.mockEditor.calls.filter((name) => name === "writeBlocks").length
    );

  // A message from the plugin frame itself is neither the real host WindowProxy
  // nor the trusted host origin: the production listener must ignore it.
  await pluginFrame.evaluate(() =>
    window.postMessage({ type: "twake-scribe:getContent" }, "*")
  );
  expect(await messagesOfType("twake-scribe:content")).toBe(0);

  // A sibling of the editor shares the genuine host origin but does not
  // possess the host WindowProxy. Its getContent/close/write must be ignored.
  await page.evaluate(() => {
    const sibling = document.createElement("iframe");
    sibling.id = "hostile-sibling";
    sibling.srcdoc = "<!doctype html><title>same-origin sibling</title>";
    document.body.appendChild(sibling);
  });
  await expect
    .poll(() => page.frames().some((frame) => frame.url() === "about:srcdoc"))
    .toBe(true);
  const siblingFrame = page
    .frames()
    .find((frame) => frame.url() === "about:srcdoc");
  expect(siblingFrame).toBeTruthy();
  await siblingFrame.evaluate((origin) => {
    window.parent.scribePlugin.postMessage(
      { type: "twake-scribe:getContent" },
      origin
    );
    window.parent.scribePlugin.postMessage(
      {
        type: "twake-scribe:applyAnswer",
        text: "attack",
        answerAction: "insert",
      },
      origin
    );
  }, editorOrigin);
  expect(await messagesOfType("twake-scribe:content")).toBe(0);
  expect(await writes()).toBe(0);

  await send("twake-scribe:getContent", { requestId: 41 });
  await expect.poll(() => messagesOfType("twake-scribe:content")).toBe(1);
  expect(await page.evaluate(() => window.scribeMessages[1].origin)).toBe(
    editorOrigin
  );
  expect(await page.evaluate(() => window.scribeMessages[1].requestId)).toBe(41);

  await pluginFrame.evaluate(() => {
    window.mockEditor.holdSelection = true;
  });
  await send("twake-scribe:applyAnswer", {
    answerAction: "insert",
    text: "old answer",
  });
  await expect
    .poll(() =>
      pluginFrame.evaluate(() => window.mockEditor.pendingSelections.length)
    )
    .toBe(1);
  expect(await writes()).toBe(1);

  await send("twake-scribe:close");
  await send("twake-scribe:getContent", { requestId: 42 });
  await expect.poll(() => messagesOfType("twake-scribe:content")).toBe(2);
  expect(
    await page.evaluate(
      () =>
        window.scribeMessages.filter(
          (message) => message.type === "twake-scribe:content"
        )[1].requestId
    )
  ).toBe(42);
  await pluginFrame.evaluate(() => {
    window.mockEditor.holdSelection = true;
  });
  await send("twake-scribe:applyAnswer", {
    answerAction: "insert",
    text: "fresh answer",
  });
  await expect.poll(writes).toBe(2);
  await expect
    .poll(() =>
      pluginFrame.evaluate(() => window.mockEditor.pendingSelections.length)
    )
    .toBe(2);

  // The old async callback cannot release the write lock now held by the new
  // panel. Conversely the current callback must allow subsequent writes.
  await pluginFrame.evaluate(() =>
    window.mockEditor.pendingSelections[0]("stale selection")
  );
  await send("twake-scribe:applyAnswer", {
    answerAction: "insert",
    text: "another fresh answer",
  });
  expect(await writes()).toBe(2);
  await pluginFrame.evaluate(() =>
    window.mockEditor.pendingSelections[1]("current selection")
  );
  await send("twake-scribe:applyAnswer", {
    answerAction: "insert",
    text: "another fresh answer",
  });
  await expect.poll(writes).toBe(3);
});
