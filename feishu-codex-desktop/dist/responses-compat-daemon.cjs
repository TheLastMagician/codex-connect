var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
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
var import_node_fs, import_node_path, import_node_os, import_node_crypto, dataArgument, dataDir;
var init_storage = __esm({
  "src/storage.mjs"() {
    import_node_fs = __toESM(require("node:fs"), 1);
    import_node_path = __toESM(require("node:path"), 1);
    import_node_os = __toESM(require("node:os"), 1);
    import_node_crypto = require("node:crypto");
    dataArgument = process.argv.indexOf("--codex-connect-data-dir");
    dataDir = process.env.FEISHU_CODEX_DATA_DIR || (dataArgument >= 0 ? process.argv[dataArgument + 1] : null) || import_node_path.default.join(import_node_os.default.homedir(), ".codex-feishu-desktop");
  }
});

// src/desktop-context-store.mjs
var init_desktop_context_store = __esm({
  "src/desktop-context-store.mjs"() {
    init_storage();
  }
});

// src/responses-compat-daemon.mjs
init_storage();

// src/version.mjs
var VERSION = "0.9.3";

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
var import_node_path3 = __toESM(require("node:path"), 1);
var import_node_child_process = require("node:child_process");
var import_node_util = require("node:util");
var import_node_crypto2 = require("node:crypto");
var import_promises2 = require("node:timers/promises");
var import_node_url2 = require("node:url");
init_storage();

// src/desktop-input.mjs
var MAX_FRAME = 8 * 1024 * 1024;

// src/desktop-context.mjs
var import_node_path2 = __toESM(require("node:path"), 1);
var import_node_url = require("node:url");
var directory = typeof __dirname === "string" ? __dirname : import_node_path2.default.dirname((0, import_node_url.fileURLToPath)(__filename));

// src/desktop.mjs
var MAX_FRAME2 = 8 * 1024 * 1024;

// src/bridge-lifecycle.mjs
init_storage();

// src/wechat-storage.mjs
init_storage();

// src/connections.mjs
init_storage();

// src/bridge-lifecycle.mjs
init_desktop_context_store();
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
var startupQueue = Promise.resolve();

// src/responses-compat-settings.mjs
var execute = (0, import_node_util.promisify)(import_node_child_process.execFile);
var directory2 = typeof __dirname === "string" ? __dirname : import_node_path3.default.dirname((0, import_node_url2.fileURLToPath)(__filename));
var runtime = import_node_path3.default.join(dataDir, "runtime");
var registry = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
var registryName = "CodexConnectResponsesCompat";
var home = () => process.env.CODEX_HOME || import_node_path3.default.join(import_node_os2.default.homedir(), ".codex");
async function providerConfig(request, { codexHome = home(), python = process.env.FEISHU_CODEX_PYTHON || "python", script = import_node_path3.default.join(directory2, "provider-config.py") } = {}) {
  return new Promise((resolve, reject) => {
    const child = (0, import_node_child_process.spawn)(python, ["-I", "-X", "utf8", script], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
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
function responsesCompatStatus() {
  const saved = readJson("responses-compat.json", {}), status = readJson("responses-compat-status.json", {});
  return {
    enabled: !!saved.routes?.length,
    processAlive: alive(status.pid),
    version: status.version || null,
    port: saved.port || null,
    converted: status.instanceId === saved.instanceId ? status.converted || 0 : 0,
    providers: (saved.routes || []).map((route) => ({ id: route.providerId, upstream: route.upstream, baseUrl: route.baseUrl })),
    note: saved.routes?.length ? "\u65E7\u7248\u5168\u5C40\u517C\u5BB9\u4ECD\u5728\u8FD0\u884C\uFF0C\u4F1A\u5F71\u54CD\u8BE5\u4F9B\u5E94\u5546\u7684\u6240\u6709\u4F1A\u8BDD\u3002\u8BF7\u5173\u95ED\u517C\u5BB9\u4EE5\u6062\u590D\u539F\u5730\u5740\uFF0C\u4E4B\u540E\u91CD\u542F Codex\u3002" : "\u672A\u542F\u7528\u5168\u5C40\u517C\u5BB9\u3002\u63D2\u4EF6\u4E0D\u4FEE\u6539\u4F9B\u5E94\u5546\u5730\u5740\uFF0C\u65B0\u5EFA\u53CA\u5DF2\u6709\u4F1A\u8BDD\u5747\u4EA4\u7531\u684C\u9762\u539F\u6709\u8FDE\u63A5\u6267\u884C\u3002"
  };
}
async function lock(name, action) {
  import_node_fs2.default.mkdirSync(dataDir, { recursive: true, mode: 448 });
  const file = import_node_path3.default.join(dataDir, name);
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
async function setCompatStartup(enabled, { entry = import_node_path3.default.join(runtime, "responses-compat-daemon.cjs") } = {}) {
  if (process.platform !== "win32") throw new Error("\u672C\u7248\u517C\u5BB9\u670D\u52A1\u81EA\u52A8\u542F\u52A8\u4EC5\u652F\u6301 Windows\u3002");
  if (enabled) await execute("reg.exe", ["add", registry, "/v", registryName, "/t", "REG_SZ", "/d", `"${process.execPath}" "${entry}" --codex-connect-data-dir "${dataDir}"`, "/f"], { windowsHide: true });
  else await execute("reg.exe", ["delete", registry, "/v", registryName, "/f"], { windowsHide: true }).catch(() => {
  });
}
async function configureResponsesCompat({ providerId, enabled }, {
  config: configOverride,
  codexHome,
  startup = setCompatStartup
} = {}) {
  if (typeof enabled !== "boolean" || typeof providerId !== "string" || !providerId) throw new Error("\u9700\u8981\u771F\u5B9E\u4F9B\u5E94\u5546 ID \u548C enabled\u3002");
  if (enabled) throw new Error("\u5DF2\u505C\u7528\u5168\u5C40 Responses \u517C\u5BB9\uFF1B\u5B83\u4F1A\u5F71\u54CD\u8FD9\u4E2A\u4F9B\u5E94\u5546\u7684\u6240\u6709\u4F1A\u8BDD\uFF0C\u65E0\u6CD5\u4EC5\u4F5C\u7528\u4E8E\u65B0\u5EFA\u3002\u73B0\u4EC5\u652F\u6301 enabled=false \u6062\u590D\u539F\u5730\u5740\u3002");
  return lock("responses-compat-config.lock", async () => {
    const previous = readJson("responses-compat.json", {}), existing = previous.routes?.find((r) => r.providerId === providerId);
    const config2 = configOverride || ((request) => providerConfig(request, { codexHome: existing?.codexHome || codexHome || home() }));
    const catalog = await config2({ action: "list" }), provider = catalog.providers.find((p) => p.id === providerId);
    if (!provider) throw new Error("\u672A\u627E\u5230\u8FD9\u4E2A\u5DF2\u914D\u7F6E\u7684\u4F9B\u5E94\u5546\u3002");
    const backup = () => import_node_path3.default.join(dataDir, "provider-backups", `${Date.now()}-${(0, import_node_crypto2.randomUUID)()}.toml`);
    if (existing && provider.baseUrl === existing.baseUrl) await config2({ action: "update", providerId, expected: existing.baseUrl, replacement: existing.originalBaseUrl, backupPath: backup() });
    const next = {
      ...previous,
      routes: (previous.routes || []).filter((r) => r.providerId !== providerId),
      disabledProviders: [.../* @__PURE__ */ new Set([...previous.disabledProviders || [], providerId])]
    };
    writeJson("responses-compat.json", next);
    if (!next.routes.length) await startup(false);
    return responsesCompatStatus();
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
