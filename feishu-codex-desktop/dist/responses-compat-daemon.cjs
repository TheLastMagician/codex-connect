var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/storage.mjs
var import_node_fs = __toESM(require("node:fs"), 1);
var import_node_path = __toESM(require("node:path"), 1);
var import_node_os = __toESM(require("node:os"), 1);
var import_node_child_process = require("node:child_process");
var import_node_crypto = require("node:crypto");
var dataArgument = process.argv.indexOf("--codex-connect-data-dir");
var dataDir = process.env.FEISHU_CODEX_DATA_DIR || (dataArgument >= 0 ? process.argv[dataArgument + 1] : null) || import_node_path.default.join(import_node_os.default.homedir(), ".codex-feishu-desktop");
function secureDirectory(dir = dataDir) {
  import_node_fs.default.mkdirSync(dir, { recursive: true, mode: 448 });
  if (process.platform === "win32") {
    const who = (0, import_node_child_process.spawnSync)("whoami.exe", [], { encoding: "utf8", windowsHide: true });
    if (who.status !== 0 || !who.stdout.trim()) throw new Error("\u65E0\u6CD5\u786E\u8BA4\u5F53\u524D Windows \u7528\u6237");
    const acl = (0, import_node_child_process.spawnSync)("icacls.exe", [dir, "/inheritance:r", "/grant:r", `${who.stdout.trim()}:(OI)(CI)F`], { windowsHide: true, encoding: "utf8" });
    if (acl.status !== 0) throw new Error("\u65E0\u6CD5\u9650\u5236\u914D\u7F6E\u76EE\u5F55\u7684 Windows \u8BBF\u95EE\u6743\u9650");
  }
}
function readJson(name, fallback) {
  try {
    return JSON.parse(import_node_fs.default.readFileSync(import_node_path.default.join(dataDir, name), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}
function writeJson(name, value) {
  import_node_fs.default.mkdirSync(dataDir, { recursive: true, mode: 448 });
  const target = import_node_path.default.join(dataDir, name);
  const temp = `${target}.${process.pid}.${(0, import_node_crypto.randomBytes)(4).toString("hex")}.tmp`;
  try {
    import_node_fs.default.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 384, flag: "wx" });
    import_node_fs.default.renameSync(temp, target);
  } finally {
    if (import_node_fs.default.existsSync(temp)) import_node_fs.default.unlinkSync(temp);
  }
}

// src/version.mjs
var VERSION = "0.4.1";

// src/responses-compat.mjs
var import_node_http = __toESM(require("node:http"), 1);
var import_node_https = __toESM(require("node:https"), 1);
var import_promises = require("node:stream/promises");
var import_node_zlib = require("node:zlib");
var MAX_BODY = 64 * 1024 * 1024;
var HOP_HEADERS = /* @__PURE__ */ new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
var NAMES = /* @__PURE__ */ new Set(["create_thread", "send_message_to_thread"]);
function decodeXml(text) {
  return text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}
function normalizeDelegations(body) {
  if (!body || !Array.isArray(body.input)) return { body, converted: 0 };
  let converted = 0;
  const input = body.input.map((item) => {
    if (item?.type !== "function_call_output" || item.call_id != null || item.namespace !== "codex_app" || !NAMES.has(item.name) || typeof item.output !== "string") return item;
    const match = /^<codex_delegation>\s*<source_thread_id>[^<>]+<\/source_thread_id>\s*<input>([\s\S]*)<\/input>\s*<\/codex_delegation>$/.exec(item.output.trim());
    if (!match) return item;
    converted++;
    return { type: "message", role: "user", content: [{ type: "input_text", text: decodeXml(match[1]) }] };
  });
  return { body: converted ? { ...body, input } : body, converted };
}
function headersWithoutHop(headers) {
  const excluded = /* @__PURE__ */ new Set([...HOP_HEADERS, ...String(headers.connection || "").toLowerCase().split(",").map((x) => x.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !excluded.has(key.toLowerCase())));
}
function normalizeBytes(bytes, encoding) {
  let decoded = bytes;
  if (encoding === "gzip") decoded = (0, import_node_zlib.gunzipSync)(bytes, { maxOutputLength: MAX_BODY });
  else if (encoding === "deflate") decoded = (0, import_node_zlib.inflateSync)(bytes, { maxOutputLength: MAX_BODY });
  else if (encoding === "br") decoded = (0, import_node_zlib.brotliDecompressSync)(bytes, { maxOutputLength: MAX_BODY });
  else if (encoding && encoding !== "identity") throw Object.assign(new Error("Unsupported request compression"), { status: 415 });
  let body;
  try {
    body = JSON.parse(decoded.toString("utf8"));
  } catch {
    return { bytes, converted: 0 };
  }
  const result = normalizeDelegations(body);
  return result.converted ? { bytes: Buffer.from(JSON.stringify(result.body)), converted: result.converted } : { bytes, converted: 0 };
}
function createResponsesCompatServer({ getRoutes, instanceId, onConverted = () => {
}, allowTestHttp = false }) {
  return import_node_http.default.createServer(async (request, response) => {
    const fail = (status, message) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message, type: "codex_connect_compat_error" } }));
    };
    let upstream;
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === `/health/${instanceId}`) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ service: "codex-connect-responses", instanceId }));
        return;
      }
      const route = getRoutes().find((r) => url.pathname === `/${r.token}/responses` || url.pathname === `/${r.token}/responses/compact`);
      if (request.method !== "POST" || !route) {
        fail(404, "Unknown model endpoint");
        return;
      }
      const base = new URL(route.upstream);
      if (base.username || base.password || base.hash || base.search || base.protocol !== "https:" && !(allowTestHttp && base.protocol === "http:" && base.hostname === "127.0.0.1"))
        throw new Error("Invalid upstream");
      const target = new URL(url.pathname.endsWith("/compact") ? "responses/compact" : "responses", base.href.replace(/\/?$/, "/"));
      target.search = url.search;
      const chunks = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > MAX_BODY) {
          fail(413, "Model request is too large");
          return;
        }
        chunks.push(chunk);
      }
      const normalized = normalizeBytes(Buffer.concat(chunks), String(request.headers["content-encoding"] || ""));
      const headers = headersWithoutHop(request.headers);
      headers.host = target.host;
      headers["content-length"] = String(normalized.bytes.length);
      if (normalized.converted) delete headers["content-encoding"];
      upstream = (target.protocol === "https:" ? import_node_https.default : import_node_http.default).request(target, { method: "POST", headers });
      const cancel = () => upstream.destroy();
      response.once("close", cancel);
      const result = new Promise((resolve, reject) => {
        upstream.once("response", resolve);
        upstream.once("error", reject);
      });
      upstream.end(normalized.bytes);
      const reply = await result;
      response.writeHead(reply.statusCode, headersWithoutHop(reply.headers));
      if (normalized.converted) {
        try {
          onConverted(normalized.converted);
        } catch {
        }
      }
      try {
        await (0, import_promises.pipeline)(reply, response);
      } finally {
        response.off("close", cancel);
      }
    } catch (error) {
      upstream?.destroy();
      fail(error.status || 502, "\u672C\u673A\u6A21\u578B\u517C\u5BB9\u5C42\u672A\u80FD\u5B8C\u6210\u8BF7\u6C42\uFF1B\u4E0D\u4F1A\u81EA\u52A8\u91CD\u8BD5\uFF0C\u8BF7\u68C0\u67E5\u539F\u4F9B\u5E94\u5546\u8FDE\u63A5\u3002");
    }
  });
}

// src/responses-compat-settings.mjs
var import_node_fs2 = __toESM(require("node:fs"), 1);
var import_node_os2 = __toESM(require("node:os"), 1);
var import_node_path2 = __toESM(require("node:path"), 1);
var import_node_child_process2 = require("node:child_process");
var import_node_util = require("node:util");
var import_node_crypto2 = require("node:crypto");
var import_promises2 = require("node:timers/promises");
var import_node_url = require("node:url");

// src/desktop-input.mjs
var MAX_FRAME = 8 * 1024 * 1024;

// src/desktop.mjs
var MAX_FRAME2 = 8 * 1024 * 1024;

// src/bridge-lifecycle.mjs
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// src/responses-compat-settings.mjs
var execute = (0, import_node_util.promisify)(import_node_child_process2.execFile);
var directory = typeof __dirname === "string" ? __dirname : import_node_path2.default.dirname((0, import_node_url.fileURLToPath)(__filename));
var runtime = import_node_path2.default.join(dataDir, "runtime");
var registry = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
var registryName = "CodexConnectResponsesCompat";
var home = () => process.env.CODEX_HOME || import_node_path2.default.join(import_node_os2.default.homedir(), ".codex");
async function providerConfig(request, { codexHome = home(), python = process.env.FEISHU_CODEX_PYTHON || "python", script = import_node_path2.default.join(directory, "provider-config.py") } = {}) {
  return new Promise((resolve, reject) => {
    const child = (0, import_node_child_process2.spawn)(python, ["-I", "-X", "utf8", script], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    const fail = () => reject(new Error("\u65E0\u6CD5\u5B89\u5168\u8BFB\u53D6\u6216\u66F4\u65B0\u4F9B\u5E94\u5546\u914D\u7F6E\uFF0C\u9700\u8981 Python 3.11+\u3002"));
    const timer = setTimeout(() => {
      child.kill();
      fail();
    }, 1e4);
    child.once("error", () => {
      clearTimeout(timer);
      fail();
    });
    child.stdout.on("data", (data) => {
      output += data;
      if (output.length > 65536) {
        child.kill();
        fail();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(output);
        if (code !== 0 || parsed.error) {
          fail();
          return;
        }
        resolve(parsed);
      } catch {
        fail();
      }
    });
    child.stdin.on("error", () => {
    });
    child.stdin.end(JSON.stringify({ ...request, codexHome }));
  });
}
function safeBase(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("\u4F9B\u5E94\u5546\u63A5\u53E3\u5730\u5740\u65E0\u6548\u3002");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error("\u4EC5\u652F\u6301\u672A\u5728\u5730\u5740\u4E2D\u5D4C\u5165\u51ED\u636E\u7684 HTTPS Responses \u4F9B\u5E94\u5546\u3002");
  return url.href.replace(/\/?$/, "/");
}
function responsesCompatStatus() {
  const saved = readJson("responses-compat.json", {}), status = readJson("responses-compat-status.json", {});
  return {
    enabled: !!saved.routes?.length,
    processAlive: alive(status.pid),
    version: status.version || null,
    port: saved.port || null,
    converted: status.instanceId === saved.instanceId ? status.converted || 0 : 0,
    providers: (saved.routes || []).map((route) => ({ id: route.providerId, upstream: route.upstream, baseUrl: route.baseUrl })),
    note: "\u53EA\u8F6C\u6362\u7F3A\u5C11 call_id \u7684 Codex \u539F\u751F\u8F6C\u4EA4\u8BB0\u5F55\u3002\u6B63\u5E38\u5DE5\u5177\u7ED3\u679C\u3001\u6A21\u578B\u3001\u8BA4\u8BC1\u53CA\u6743\u9650\u4FDD\u6301\u539F\u8BBE\u7F6E\u3002\u66F4\u6362\u4F9B\u5E94\u5546\u5730\u5740\u540E\u9700\u91CD\u542F Codex \u624D\u80FD\u4F7F\u5DF2\u52A0\u8F7D\u7684\u914D\u7F6E\u751F\u6548\u3002"
  };
}
function syncResponsesCompatRuntime(bundleDir) {
  secureDirectory();
  import_node_fs2.default.mkdirSync(runtime, { recursive: true, mode: 448 });
  for (const name of ["responses-compat-daemon.cjs", "provider-config.py"]) {
    const source = import_node_path2.default.join(bundleDir, name);
    if (!import_node_fs2.default.existsSync(source)) throw new Error("\u7F3A\u5C11 Responses \u517C\u5BB9\u7EC4\u4EF6\uFF0C\u8BF7\u66F4\u65B0\u63D2\u4EF6\u3002");
    const target = import_node_path2.default.join(runtime, name), temp = target + "." + (0, import_node_crypto2.randomUUID)() + ".tmp";
    try {
      import_node_fs2.default.copyFileSync(source, temp);
      import_node_fs2.default.renameSync(temp, target);
    } finally {
      try {
        import_node_fs2.default.unlinkSync(temp);
      } catch {
      }
    }
  }
}
async function lock(name, action) {
  import_node_fs2.default.mkdirSync(dataDir, { recursive: true, mode: 448 });
  const file = import_node_path2.default.join(dataDir, name);
  let descriptor;
  const deadline = Date.now() + 12e3;
  while (descriptor === void 0) {
    try {
      descriptor = import_node_fs2.default.openSync(file, "wx", 384);
      import_node_fs2.default.writeFileSync(descriptor, JSON.stringify({ pid: process.pid }));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let previous;
      try {
        previous = JSON.parse(import_node_fs2.default.readFileSync(file, "utf8"));
      } catch {
      }
      if (previous?.pid && !alive(previous.pid)) {
        try {
          import_node_fs2.default.unlinkSync(file);
        } catch {
        }
        continue;
      }
      if (Date.now() >= deadline) throw new Error("\u53E6\u4E00\u4E2A\u517C\u5BB9\u8BBE\u7F6E\u64CD\u4F5C\u5C1A\u672A\u5B8C\u6210\u3002");
      await (0, import_promises2.setTimeout)(100);
    }
  }
  try {
    return await action();
  } finally {
    import_node_fs2.default.closeSync(descriptor);
    try {
      import_node_fs2.default.unlinkSync(file);
    } catch {
    }
  }
}
async function healthy(settings, status) {
  if (!alive(status.pid) || settings.instanceId !== status.instanceId || !Number.isInteger(status.port)) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${status.port}/health/${settings.instanceId}`, { signal: AbortSignal.timeout(1e3), redirect: "error" });
    const result = await response.json();
    return response.ok && result.service === "codex-connect-responses" && result.instanceId === settings.instanceId;
  } catch {
    return false;
  }
}
async function ensureResponsesCompat() {
  if (!readJson("responses-compat.json", {}).routes?.length) return { enabled: false };
  return lock("responses-compat-start.lock", async () => {
    const settings = readJson("responses-compat.json", {});
    if (!settings.routes?.length) return { enabled: false };
    let status = readJson("responses-compat-status.json", {});
    if (await healthy(settings, status)) return status;
    const entry = import_node_path2.default.join(runtime, "responses-compat-daemon.cjs");
    if (!import_node_fs2.default.existsSync(entry)) throw new Error("\u672C\u673A Responses \u517C\u5BB9\u8FD0\u884C\u6587\u4EF6\u4E22\u5931\uFF0C\u8BF7\u66F4\u65B0\u63D2\u4EF6\u3002");
    const child = (0, import_node_child_process2.spawn)(process.execPath, [entry, "--codex-connect-data-dir", dataDir], { windowsHide: true, detached: true, stdio: "ignore", env: process.env });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    for (let index = 0; index < 50; index++) {
      await (0, import_promises2.setTimeout)(100);
      status = readJson("responses-compat-status.json", {});
      if (status.pid === child.pid && await healthy(settings, status)) return status;
      if (!alive(child.pid)) break;
    }
    throw new Error("\u672C\u673A Responses \u517C\u5BB9\u670D\u52A1\u672A\u80FD\u5C31\u7EEA\uFF1B\u672A\u4FEE\u6539\u4F9B\u5E94\u5546\u5730\u5740\u3002");
  });
}
async function setCompatStartup(enabled, { entry = import_node_path2.default.join(runtime, "responses-compat-daemon.cjs") } = {}) {
  if (process.platform !== "win32") throw new Error("\u672C\u7248\u517C\u5BB9\u670D\u52A1\u81EA\u52A8\u542F\u52A8\u4EC5\u652F\u6301 Windows\u3002");
  if (enabled) await execute("reg.exe", ["add", registry, "/v", registryName, "/t", "REG_SZ", "/d", `"${process.execPath}" "${entry}" --codex-connect-data-dir "${dataDir}"`, "/f"], { windowsHide: true });
  else await execute("reg.exe", ["delete", registry, "/v", registryName, "/f"], { windowsHide: true }).catch(() => {
  });
}
async function configureResponsesCompat({ providerId, enabled }, {
  bundleDir,
  desktopPipePath,
  config: configOverride,
  codexHome,
  startup = setCompatStartup,
  ensure = ensureResponsesCompat
} = {}) {
  if (typeof enabled !== "boolean" || typeof providerId !== "string" || !providerId) throw new Error("\u9700\u8981\u771F\u5B9E\u4F9B\u5E94\u5546 ID \u548C enabled\u3002");
  return lock("responses-compat-config.lock", async () => {
    const previous = readJson("responses-compat.json", {}), existing = previous.routes?.find((r) => r.providerId === providerId);
    const config2 = configOverride || ((request) => providerConfig(request, { codexHome: existing?.codexHome || codexHome || home() }));
    const catalog = await config2({ action: "list" }), provider = catalog.providers.find((p) => p.id === providerId);
    if (!provider) throw new Error("\u672A\u627E\u5230\u8FD9\u4E2A\u5DF2\u914D\u7F6E\u7684\u4F9B\u5E94\u5546\u3002");
    const backup = () => import_node_path2.default.join(dataDir, "provider-backups", `${Date.now()}-${(0, import_node_crypto2.randomUUID)()}.toml`);
    if (!enabled) {
      if (existing && provider.baseUrl === existing.baseUrl) await config2({ action: "update", providerId, expected: existing.baseUrl, replacement: existing.originalBaseUrl, backupPath: backup() });
      const next = {
        ...previous,
        routes: (previous.routes || []).filter((r) => r.providerId !== providerId),
        disabledProviders: [.../* @__PURE__ */ new Set([...previous.disabledProviders || [], providerId])]
      };
      writeJson("responses-compat.json", next);
      if (!next.routes.length) await startup(false);
      return responsesCompatStatus();
    }
    if (existing) {
      if (provider.baseUrl !== existing.baseUrl) throw new Error("\u4F9B\u5E94\u5546\u5730\u5740\u5DF2\u5728\u63D2\u4EF6\u5916\u66F4\u6539\uFF1B\u8BF7\u5148\u5173\u95ED\u6B64\u4F9B\u5E94\u5546\u7684\u517C\u5BB9\u8BBE\u7F6E\u3002");
      writeJson("responses-compat.json", { ...previous, disabledProviders: (previous.disabledProviders || []).filter((id) => id !== providerId) });
      await ensure();
      return responsesCompatStatus();
    }
    if (provider.wireApi !== "responses" || provider.supportsWebsockets) throw new Error("\u517C\u5BB9\u5C42\u4EC5\u652F\u6301 HTTP Responses\uFF1B\u5F53\u524D\u4F9B\u5E94\u5546\u542F\u7528\u4E86\u5176\u4ED6\u534F\u8BAE\u6216 WebSocket\u3002");
    const upstream = safeBase(provider.baseUrl);
    syncResponsesCompatRuntime(bundleDir);
    const route = {
      providerId,
      codexHome: codexHome || home(),
      upstream,
      originalBaseUrl: provider.baseUrl,
      token: (0, import_node_crypto2.randomBytes)(24).toString("hex"),
      ...desktopPipePath ? { restartRequiredForPipe: desktopPipePath } : {}
    };
    writeJson("responses-compat.json", {
      ...previous,
      instanceId: previous.instanceId || (0, import_node_crypto2.randomBytes)(24).toString("hex"),
      routes: [...previous.routes || [], route],
      disabledProviders: (previous.disabledProviders || []).filter((id) => id !== providerId)
    });
    try {
      const status = await ensure();
      const next = readJson("responses-compat.json", {});
      route.baseUrl = `http://127.0.0.1:${status.port}/${route.token}`;
      writeJson("responses-compat.json", { ...next, port: status.port, routes: next.routes.map((r) => r.providerId === providerId ? route : r) });
      await startup(true);
      await config2({ action: "update", providerId, expected: provider.baseUrl, replacement: route.baseUrl, backupPath: backup() });
      return responsesCompatStatus();
    } catch (error) {
      writeJson("responses-compat.json", previous);
      if (!previous.routes?.length) await startup(false);
      throw error;
    }
  });
}

// src/responses-compat-daemon.mjs
async function main() {
  const settings = readJson("responses-compat.json", {});
  if (process.argv[2] === "restore") {
    for (const route of settings.routes || []) await configureResponsesCompat({ providerId: route.providerId, enabled: false });
    console.log("\u5DF2\u6062\u590D\u539F\u4F9B\u5E94\u5546\u5730\u5740\u5E76\u5173\u95ED\u517C\u5BB9\u670D\u52A1\u81EA\u52A8\u542F\u52A8\u3002\u8BF7\u91CD\u542F Codex\u3002");
    return;
  }
  if (!settings.routes?.length || !settings.instanceId) return;
  let converted = 0;
  let server;
  let timer;
  const save = (state) => writeJson("responses-compat-status.json", {
    state,
    pid: process.pid,
    version: VERSION,
    instanceId: settings.instanceId,
    port: server?.address()?.port || settings.port,
    converted,
    checkedAt: Date.now()
  });
  server = createResponsesCompatServer({
    instanceId: settings.instanceId,
    getRoutes: () => readJson("responses-compat.json", {}).routes || [],
    onConverted: (count) => {
      converted += count;
      save("running");
    }
  });
  server.on("clientError", (_, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(settings.port || 0, "127.0.0.1", resolve);
  });
  save("running");
  const stop = () => {
    clearInterval(timer);
    server.close();
    server.closeAllConnections();
    save("stopped");
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  timer = setInterval(() => {
    try {
      const current = readJson("responses-compat.json", {});
      if (current.instanceId !== settings.instanceId || !current.routes?.length) stop();
    } catch {
    }
  }, 2e3);
}
main().catch(() => {
  console.error("\u672C\u673A Responses \u517C\u5BB9\u670D\u52A1\u672A\u80FD\u542F\u52A8\uFF0C\u8BF7\u68C0\u67E5\u63D2\u4EF6\u517C\u5BB9\u72B6\u6001\u3002");
  process.exitCode = 1;
});
