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

// src/autostart.mjs
var import_node_path4 = __toESM(require("node:path"), 1);

// src/bridge-lifecycle.mjs
var import_node_fs2 = __toESM(require("node:fs"), 1);
var import_node_path3 = __toESM(require("node:path"), 1);
var import_node_child_process2 = require("node:child_process");
var import_promises2 = require("node:timers/promises");

// src/desktop.mjs
var import_node_net2 = __toESM(require("node:net"), 1);
var import_node_crypto2 = require("node:crypto");

// src/desktop-input.mjs
var import_node_net = __toESM(require("node:net"), 1);
var import_node_os = __toESM(require("node:os"), 1);
var import_node_path = __toESM(require("node:path"), 1);
var import_node_crypto = require("node:crypto");
var import_promises = require("node:timers/promises");
var MAX_FRAME = 8 * 1024 * 1024;
var VERSIONS = { initialize: 0, "thread-owner-discovery": 1, "thread-follower-start-turn": 2 };
function desktopInputPath() {
  return process.platform === "win32" ? "\\\\.\\pipe\\codex-ipc" : import_node_path.default.join(process.env.CODEX_HOME || import_node_path.default.join(import_node_os.default.homedir(), ".codex"), "ipc", "ipc.sock");
}
function frame(message) {
  const data = Buffer.from(JSON.stringify(message), "utf8");
  if (data.length > MAX_FRAME) throw new Error("\u6D88\u606F\u8FC7\u5927");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(data.length);
  return Buffer.concat([header, data]);
}
function inputError(message, notSent = false) {
  return Object.assign(new Error(message), { notSent });
}
var DesktopInput = class {
  constructor({ pipePath = desktopInputPath(), timeoutMs = 1e4, activateThread, loadTimeoutMs = 2e4, pollIntervalMs = 300 } = {}) {
    Object.assign(this, { pipePath, timeoutMs, activateThread, loadTimeoutMs, pollIntervalMs });
    this.pending = /* @__PURE__ */ new Map();
    this.buffer = Buffer.alloc(0);
    this.loading = /* @__PURE__ */ new Map();
  }
  async connect() {
    if (this.socket && !this.socket.destroyed && this.clientId) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      this.clientId = null;
      this.buffer = Buffer.alloc(0);
      await new Promise((resolve, reject) => {
        const socket = import_node_net.default.createConnection(this.pipePath);
        this.socket = socket;
        const timer = setTimeout(() => socket.destroy(new Error("connect-timeout")), this.timeoutMs);
        socket.once("error", reject);
        socket.once("close", () => clearTimeout(timer));
        socket.once("connect", () => {
          clearTimeout(timer);
          socket.off("error", reject);
          socket.on("data", (chunk) => this.onData(chunk));
          socket.on("error", () => {
            if (this.socket === socket) this.disconnect();
          });
          socket.on("close", () => {
            if (this.socket === socket) this.disconnect();
          });
          resolve();
        });
      });
      const response = await this.request("initialize", { clientType: "codex-connect" });
      if (response.resultType !== "success" || typeof response.result?.clientId !== "string") throw new Error("initialize-failed");
      this.clientId = response.result.clientId;
    })().catch(() => {
      this.disconnect();
      throw inputError("\u684C\u9762\u666E\u901A\u6D88\u606F\u5165\u53E3\u4E0D\u53EF\u7528\uFF0C\u6D88\u606F\u5C1A\u672A\u53D1\u9001\u3002\u8BF7\u4FDD\u6301 Codex \u8FD0\u884C\u5E76\u91CD\u65B0\u542F\u52A8\u6865\u63A5\u3002", true);
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }
  request(method, params, { targetClientId, hostId, timeoutMs = this.timeoutMs } = {}) {
    if (!Object.hasOwn(VERSIONS, method)) throw inputError("\u4E0D\u652F\u6301\u7684\u684C\u9762\u8F93\u5165\u64CD\u4F5C", true);
    if (!this.socket || this.socket.destroyed) throw inputError("\u684C\u9762\u8FDE\u63A5\u5DF2\u5173\u95ED\uFF0C\u6D88\u606F\u5C1A\u672A\u53D1\u9001\u3002", true);
    const requestId = (0, import_node_crypto.randomUUID)();
    const remote = hostId && hostId !== "local";
    const message = {
      type: "request",
      requestId,
      sourceClientId: this.clientId || "initializing-client",
      version: VERSIONS[method] + (remote && method.startsWith("thread-follower-") ? 1 : 0),
      method,
      params,
      ...targetClientId ? { targetClientId } : {},
      ...remote ? { hostId } : {},
      timeoutMs
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(inputError("\u684C\u9762\u672A\u786E\u8BA4\u53D1\u9001\u7ED3\u679C\uFF0C\u8BF7\u68C0\u67E5\u4F1A\u8BDD\u540E\u518D\u51B3\u5B9A\u662F\u5426\u91CD\u53D1\u3002"));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.socket.write(frame(message));
      } catch {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(inputError("\u684C\u9762\u8FDE\u63A5\u4E2D\u65AD\uFF0C\u53D1\u9001\u7ED3\u679C\u672A\u77E5\uFF0C\u8BF7\u5148\u68C0\u67E5\u4F1A\u8BDD\u3002"));
      }
    });
  }
  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32LE(0);
      if (!size || size > MAX_FRAME) {
        this.disconnect();
        return;
      }
      if (this.buffer.length < size + 4) return;
      let message;
      try {
        message = JSON.parse(this.buffer.subarray(4, size + 4).toString("utf8"));
      } catch {
        this.disconnect();
        return;
      }
      this.buffer = this.buffer.subarray(size + 4);
      if (message.type === "client-discovery-request") {
        try {
          this.socket?.write(frame({ type: "client-discovery-response", requestId: message.requestId, response: { canHandle: false } }));
        } catch {
          this.disconnect();
          return;
        }
      } else if (message.type === "response") {
        const pending = this.pending.get(message.requestId);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.requestId);
        pending.resolve(message);
      }
    }
  }
  async findOwner(threadId, hostId = "local", timeoutMs = this.timeoutMs) {
    const response = await this.request("thread-owner-discovery", { hostId, conversationId: threadId }, { timeoutMs });
    if (response.resultType === "success" && typeof response.handledByClientId === "string") return response.handledByClientId;
    if (response.resultType === "error" && response.error === "no-client-found") return null;
    throw inputError("\u65E0\u6CD5\u786E\u8BA4\u684C\u9762\u4F1A\u8BDD\u8FDE\u63A5\uFF0C\u6D88\u606F\u5C1A\u672A\u53D1\u9001\u3002\u8BF7\u91CD\u65B0\u542F\u52A8\u6865\u63A5\u3002", true);
  }
  async loadOwner(threadId, hostId, authorize) {
    if (!this.activateThread) throw inputError("\u76EE\u6807\u4F1A\u8BDD\u5C1A\u672A\u52A0\u8F7D\uFF0C\u6D88\u606F\u5C1A\u672A\u53D1\u9001\u3002\u8BF7\u91CD\u65B0\u542F\u52A8\u6865\u63A5\u4EE5\u542F\u7528\u81EA\u52A8\u6253\u5F00\u4F1A\u8BDD\u3002", true);
    const key = JSON.stringify([hostId, threadId]);
    let loading = this.loading.get(key);
    if (!loading) {
      loading = (async () => {
        authorize();
        try {
          await this.activateThread({ threadId, hostId });
        } catch {
          throw inputError("\u672A\u80FD\u786E\u8BA4\u76EE\u6807\u4F1A\u8BDD\u5DF2\u6253\u5F00\uFF0C\u6D88\u606F\u5C1A\u672A\u53D1\u9001\u3002\u8BF7\u68C0\u67E5\u684C\u9762\u8FDE\u63A5\u540E\u91CD\u8BD5\u3002", true);
        }
        const deadline = Date.now() + this.loadTimeoutMs;
        while (Date.now() < deadline) {
          authorize();
          let owner;
          try {
            owner = await this.findOwner(threadId, hostId, Math.min(this.timeoutMs, Math.max(1, deadline - Date.now())));
          } catch {
            throw inputError("\u5DF2\u5C1D\u8BD5\u6253\u5F00\u76EE\u6807\u4F1A\u8BDD\uFF0C\u4F46\u65E0\u6CD5\u786E\u8BA4\u52A0\u8F7D\u72B6\u6001\uFF0C\u6D88\u606F\u5C1A\u672A\u53D1\u9001\u3002\u8BF7\u68C0\u67E5\u684C\u9762\u8FDE\u63A5\u540E\u91CD\u8BD5\u3002", true);
          }
          if (owner) return owner;
          await (0, import_promises.setTimeout)(Math.min(this.pollIntervalMs, Math.max(1, deadline - Date.now())));
        }
        throw inputError("\u5DF2\u5C1D\u8BD5\u6253\u5F00\u76EE\u6807\u4F1A\u8BDD\uFF0C\u4F46\u52A0\u8F7D\u5C1A\u672A\u5B8C\u6210\uFF0C\u6D88\u606F\u5C1A\u672A\u53D1\u9001\u3002\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002", true);
      })();
      this.loading.set(key, loading);
    }
    try {
      return await loading;
    } finally {
      if (this.loading.get(key) === loading) this.loading.delete(key);
    }
  }
  async send({ threadId, hostId = "local", prompt, model, thinking }, beforeSend) {
    if (typeof threadId !== "string" || !threadId.trim() || typeof prompt !== "string" || !prompt.trim() || prompt.length > 12e3)
      throw inputError("\u4F1A\u8BDD\u6216\u6D88\u606F\u65E0\u6548\uFF0C\u6D88\u606F\u5C1A\u672A\u53D1\u9001\u3002", true);
    const authorize = () => {
      try {
        beforeSend?.();
      } catch {
        throw inputError("\u901A\u9053\u6388\u6743\u5DF2\u64A4\u9500\uFF0C\u6D88\u606F\u5C1A\u672A\u53D1\u9001\u3002", true);
      }
    };
    authorize();
    await this.connect();
    let owner;
    try {
      owner = await this.findOwner(threadId, hostId);
    } catch (error) {
      if (error.notSent) throw error;
      throw inputError("\u65E0\u6CD5\u786E\u8BA4\u76EE\u6807\u684C\u9762\u4F1A\u8BDD\u8FDE\u63A5\uFF0C\u6D88\u606F\u5C1A\u672A\u53D1\u9001\uFF0C\u4E5F\u672A\u5207\u6362\u684C\u9762\u3002\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002", true);
    }
    authorize();
    if (!owner) owner = await this.loadOwner(threadId, hostId, authorize);
    authorize();
    const request = {
      threadId,
      clientUserMessageId: (0, import_node_crypto.randomUUID)(),
      input: [{ type: "text", text: prompt, text_elements: [] }],
      ...model ? { model } : {},
      ...thinking ? { effort: thinking } : {}
    };
    const response = await this.request("thread-follower-start-turn", {
      conversationId: threadId,
      turnStart: { request, context: { inheritThreadSettings: true } }
    }, { hostId, targetClientId: owner });
    if (response.resultType !== "success") throw inputError("\u684C\u9762\u672A\u786E\u8BA4\u53D1\u9001\u7ED3\u679C\uFF0C\u8BF7\u5728\u684C\u9762\u68C0\u67E5\u8BE5\u4F1A\u8BDD\u540E\u518D\u51B3\u5B9A\u662F\u5426\u91CD\u53D1\u3002");
    return { threadId, accepted: true };
  }
  disconnect() {
    const socket = this.socket;
    this.socket = null;
    this.clientId = null;
    this.buffer = Buffer.alloc(0);
    socket?.destroy();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(inputError("\u684C\u9762\u8FDE\u63A5\u4E2D\u65AD\uFF0C\u53D1\u9001\u7ED3\u679C\u672A\u77E5\uFF0C\u8BF7\u5148\u68C0\u67E5\u4F1A\u8BDD\u3002"));
    }
    this.pending.clear();
  }
  close() {
    this.disconnect();
  }
};

// src/desktop.mjs
var MAX_FRAME2 = 8 * 1024 * 1024;
var ALLOWED_TOOLS = /* @__PURE__ */ new Set([
  "list_threads",
  "list_archived_threads",
  "list_projects",
  "read_thread",
  "wait_threads",
  "send_message_to_thread",
  "create_thread",
  "set_thread_title",
  "set_thread_archived",
  "fork_thread",
  "move_thread_to_sidebar_section",
  "navigate_to_codex_page"
]);
function encodeFrame(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > MAX_FRAME2) throw new Error("\u8BF7\u6C42\u8FC7\u5927");
  const frame2 = Buffer.alloc(body.length + 4);
  frame2.writeUInt32LE(body.length);
  body.copy(frame2, 4);
  return frame2;
}
var DesktopClient = class {
  constructor(context, { beforeCreateThread } = {}) {
    this.context = context;
    this.beforeCreateThread = beforeCreateThread;
    this.pending = /* @__PURE__ */ new Map();
    this.nextId = 1;
    this.buffer = Buffer.alloc(0);
    this.connectionGeneration = 0;
    this.input = new DesktopInput({
      pipePath: context.inputPipePath,
      activateThread: ({ threadId }) => this.call("navigate_to_codex_page", { threadId })
    });
  }
  async connect() {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    if (!this.context.pipePath) throw new Error("\u672A\u6536\u5230\u684C\u9762\u7248\u8FDE\u63A5\u4FE1\u606F\uFF0C\u8BF7\u5728 Codex \u5185\u542F\u52A8\u63D2\u4EF6");
    const generation = this.connectionGeneration;
    const connecting = new Promise((resolve, reject) => {
      const socket = import_node_net2.default.createConnection(this.context.pipePath);
      const timer = setTimeout(() => socket.destroy(new Error("\u8FDE\u63A5\u684C\u9762\u7248\u8D85\u65F6")), 5e3);
      socket.once("error", reject);
      socket.once("connect", () => {
        if (generation !== this.connectionGeneration) {
          socket.destroy();
          reject(new Error("\u684C\u9762\u8FDE\u63A5\u5DF2\u66F4\u65B0"));
          return;
        }
        clearTimeout(timer);
        socket.off("error", reject);
        this.socket = socket;
        socket.on("data", (chunk) => this.onData(chunk));
        socket.on("error", (error) => {
          if (this.socket === socket) this.disconnect(error);
        });
        socket.on("close", () => {
          if (this.socket === socket) this.disconnect(new Error("Codex \u684C\u9762\u8FDE\u63A5\u5DF2\u5173\u95ED\uFF0C\u6B63\u5728\u7B49\u5F85\u91CD\u65B0\u8FDE\u63A5"));
        });
        resolve();
      });
      socket.once("close", () => clearTimeout(timer));
    }).finally(() => {
      if (this.connecting === connecting) this.connecting = null;
    });
    this.connecting = connecting;
    return connecting;
  }
  async request(method, params, timeoutMs = 3e4, beforeSend) {
    await this.connect();
    beforeSend?.();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (method === "tools/call") this.socket?.write(encodeFrame({ jsonrpc: "2.0", id, method: "tools/cancel" }));
        reject(new Error("\u684C\u9762\u64CD\u4F5C\u8D85\u65F6\uFF1B\u64CD\u4F5C\u7ED3\u679C\u672A\u77E5\uFF0C\u8BF7\u68C0\u67E5\u4F1A\u8BDD\u540E\u518D\u51B3\u5B9A\u662F\u5426\u91CD\u53D1"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.write(encodeFrame({ jsonrpc: "2.0", id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32LE(0);
      if (size > MAX_FRAME2) {
        this.close();
        return;
      }
      if (this.buffer.length < size + 4) return;
      const raw = this.buffer.subarray(4, size + 4);
      this.buffer = this.buffer.subarray(size + 4);
      let value;
      try {
        value = JSON.parse(raw.toString("utf8"));
      } catch {
        this.close();
        return;
      }
      const pending = this.pending.get(value.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(value.id);
      if (value.error) pending.reject(new Error(value.error.message));
      else pending.resolve(value.result);
    }
  }
  disconnect(error) {
    this.socket?.destroy();
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
  }
  close() {
    this.connectionGeneration++;
    this.connecting = null;
    this.input.close();
    this.disconnect(new Error("\u684C\u9762\u8FDE\u63A5\u5DF2\u5173\u95ED"));
  }
  updateContext(context) {
    if (this.context.pipePath !== context.pipePath) {
      this.close();
    }
    this.context = { ...this.context, ...context };
  }
  async tools() {
    const result = await this.request("tools/list", { threadStartKind: "all" });
    return result.tools.filter((tool) => tool.namespace === "codex_app" && ALLOWED_TOOLS.has(tool.name));
  }
  async call(tool, args = {}, options = {}) {
    if (!ALLOWED_TOOLS.has(tool)) throw new Error("\u4E0D\u652F\u6301\u7684\u684C\u9762\u64CD\u4F5C");
    if (!this.context.threadId) throw new Error("\u7F3A\u5C11\u771F\u5B9E\u8C03\u7528\u4F1A\u8BDD\uFF0C\u8BF7\u4ECE Codex \u684C\u9762\u5185\u542F\u52A8\u6865\u63A5");
    if (tool === "send_message_to_thread") return this.input.send(args, options.beforeSend);
    if (tool === "create_thread" && this.beforeCreateThread) {
      options.beforeSend?.();
      await this.beforeCreateThread(this.context, args);
      options.beforeSend?.();
    }
    const result = await this.request("tools/call", {
      namespace: "codex_app",
      tool,
      arguments: args,
      callerSource: "codex",
      threadId: this.context.threadId,
      hostId: "local",
      turnId: `feishu-${(0, import_node_crypto2.randomUUID)()}`,
      callId: `feishu-${(0, import_node_crypto2.randomUUID)()}`
    }, tool === "wait_threads" ? 45e3 : 3e4, options.beforeSend);
    const output = (result.contentItems || []).filter((item) => item.type === "inputText").map((item) => item.text).join("\n");
    if (!result.success) throw new Error(output || "\u684C\u9762\u64CD\u4F5C\u5931\u8D25");
    try {
      return JSON.parse(output);
    } catch {
      return { text: output };
    }
  }
};

// src/storage.mjs
var import_node_fs = __toESM(require("node:fs"), 1);
var import_node_path2 = __toESM(require("node:path"), 1);
var import_node_os2 = __toESM(require("node:os"), 1);
var import_node_child_process = require("node:child_process");
var import_node_crypto3 = require("node:crypto");
var dataArgument = process.argv.indexOf("--codex-connect-data-dir");
var dataDir = process.env.FEISHU_CODEX_DATA_DIR || (dataArgument >= 0 ? process.argv[dataArgument + 1] : null) || import_node_path2.default.join(import_node_os2.default.homedir(), ".codex-feishu-desktop");
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
    return JSON.parse(import_node_fs.default.readFileSync(import_node_path2.default.join(dataDir, name), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}
function writeJson(name, value) {
  import_node_fs.default.mkdirSync(dataDir, { recursive: true, mode: 448 });
  const target = import_node_path2.default.join(dataDir, name);
  const temp = `${target}.${process.pid}.${(0, import_node_crypto3.randomBytes)(4).toString("hex")}.tmp`;
  try {
    import_node_fs.default.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 384, flag: "wx" });
    import_node_fs.default.renameSync(temp, target);
  } finally {
    if (import_node_fs.default.existsSync(temp)) import_node_fs.default.unlinkSync(temp);
  }
}
function config() {
  const result = readJson("config.json", {});
  const appId = process.env.FEISHU_APP_ID || result.appId;
  const appSecret = process.env.FEISHU_APP_SECRET || result.appSecret;
  if (!Array.isArray(result.allowedOpenIds)) result.allowedOpenIds = [];
  return { ...result, appId, appSecret };
}

// src/wechat-storage.mjs
function readWechatAccount() {
  const account = readJson("wechat.json", {});
  const revoked = readJson("wechat-revoked.json", { loginIds: [] });
  return account.loginId && revoked.loginIds.includes(account.loginId) ? { ...account, enabled: false } : account;
}

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
function readLock(name) {
  try {
    return readJson(name, {});
  } catch (error) {
    if (error instanceof SyntaxError) return {};
    throw error;
  }
}
function desktopContext(extra, { env = process.env, event = {}, saved = readJson("desktop-context.json", {}) } = {}) {
  const meta = extra?._meta || {};
  let turn = meta["x-codex-turn-metadata"];
  if (typeof turn === "string") {
    try {
      turn = JSON.parse(turn);
    } catch {
      turn = {};
    }
  }
  const threadId = turn?.thread_id || meta["openai/threadId"] || meta.threadId || event.session_id || env.CODEX_THREAD_ID || saved.threadId;
  const pipePath = env.CODEX_APP_TOOLS_PIPE_PATH || saved.pipePath;
  if (typeof threadId !== "string" || !threadId || typeof pipePath !== "string" || !pipePath)
    throw new Error("\u7F3A\u5C11\u771F\u5B9E\u684C\u9762\u8FDE\u63A5\uFF1B\u8BF7\u5728 Codex \u684C\u9762\u6062\u590D\u4E00\u4E2A\u4F1A\u8BDD\u540E\u91CD\u8BD5\u3002");
  return { pipePath, threadId };
}
function hasConfiguredChannel() {
  const settings = config(), wechat = readWechatAccount(), login = readJson("wechat-login.json", {});
  return !!(settings.appId && settings.appSecret && settings.feishuEnabled !== false) || !!(wechat.enabled && wechat.token && wechat.botId && wechat.ownerUserId) || ["wait", "scaned", "need_verifycode"].includes(login.status) && login.expiresAt > Date.now();
}
async function validateDesktopContext(context) {
  const desktop = new DesktopClient(context);
  try {
    await desktop.call("list_threads", { limit: 1 });
  } finally {
    desktop.close();
  }
}
function automaticSkip(context) {
  if (readJson("autostart.json", {}).enabled !== true) return "disabled";
  if (readJson("autostart-pause.json", {}).pipePath === context.pipePath) return "paused";
  if (!hasConfiguredChannel()) return "not_configured";
}
async function ensureBridge(context, { entryPath, automatic = false, validate = validateDesktopContext } = {}) {
  const skipped = automatic && automaticSkip(context);
  if (skipped) return { skipped };
  if (!hasConfiguredChannel()) {
    if (automatic) return { skipped: "not_configured" };
    throw new Error("\u8BF7\u5148\u914D\u7F6E\u98DE\u4E66\uFF0C\u6216\u626B\u7801\u8FDE\u63A5\u5FAE\u4FE1\u3002");
  }
  secureDirectory();
  const lockPath = import_node_path3.default.join(dataDir, "bridge-start.lock");
  let lock;
  const deadline = Date.now() + 6e3;
  while (lock === void 0) {
    try {
      lock = import_node_fs2.default.openSync(lockPath, "wx", 384);
      import_node_fs2.default.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = readLock("bridge-start.lock");
      if (owner.pid && !alive(owner.pid)) {
        try {
          import_node_fs2.default.unlinkSync(lockPath);
        } catch {
        }
        continue;
      }
      if (Date.now() >= deadline) throw new Error("\u53E6\u4E00\u4E2A\u542F\u52A8\u64CD\u4F5C\u5C1A\u672A\u5B8C\u6210\uFF0C\u8BF7\u7A0D\u540E\u68C0\u67E5\u6865\u63A5\u72B6\u6001\u3002");
      await (0, import_promises2.setTimeout)(50);
    }
  }
  try {
    await validate(context);
    const skipped2 = automatic && automaticSkip(context);
    if (skipped2) return { skipped: skipped2 };
    writeJson("desktop-context.json", context);
    if (!automatic) writeJson("autostart-pause.json", {});
    const previous = readJson("status.json", {}), running = readLock("bridge.lock");
    if (alive(running.pid)) return { alreadyRunning: true, pid: running.pid, state: previous.state || "starting" };
    if (!entryPath || !import_node_fs2.default.existsSync(entryPath)) throw new Error("\u7F3A\u5C11\u6865\u63A5\u8FD0\u884C\u6587\u4EF6\uFF0C\u8BF7\u66F4\u65B0\u63D2\u4EF6\u540E\u91CD\u8BD5\u3002");
    const log = import_node_fs2.default.openSync(import_node_path3.default.join(dataDir, "bridge.log"), "a", 384);
    let child;
    try {
      child = (0, import_node_child_process2.spawn)(process.execPath, [entryPath], { detached: true, windowsHide: true, stdio: ["ignore", log, log], env: process.env });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
    } finally {
      import_node_fs2.default.closeSync(log);
    }
    const readyBy = Date.now() + 3e3;
    while (Date.now() < readyBy && alive(child.pid)) {
      if (readLock("bridge.lock").pid === child.pid) return { startedProcess: true, pid: child.pid, note: "\u6865\u63A5\u5DF2\u542F\u52A8\uFF0C\u8BF7\u67E5\u770B\u901A\u9053\u8FDE\u63A5\u72B6\u6001\u3002" };
      await (0, import_promises2.setTimeout)(50);
    }
    throw new Error("\u6865\u63A5\u672A\u80FD\u786E\u8BA4\u542F\u52A8\uFF0C\u8BF7\u67E5\u770B\u6865\u63A5\u72B6\u6001\u3002");
  } finally {
    import_node_fs2.default.closeSync(lock);
    try {
      import_node_fs2.default.unlinkSync(lockPath);
    } catch {
    }
  }
}

// src/autostart.mjs
async function main() {
  if (readJson("autostart.json", {}).enabled !== true) return;
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk.toString("utf8");
    if (Buffer.byteLength(raw) > 65536) return;
  }
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }
  if (event.hook_event_name !== "SessionStart" || !["startup", "resume", "clear", "fork"].includes(event.source)) return;
  try {
    if (!process.env.CODEX_APP_TOOLS_PIPE_PATH) throw new Error("No desktop host context");
    const context = desktopContext(void 0, { event });
    const result = await ensureBridge(context, { automatic: true, entryPath: import_node_path4.default.join(__dirname, "bridge.cjs") });
    writeJson("autostart-status.json", { state: result.skipped || "started", checkedAt: Date.now() });
  } catch {
    writeJson("autostart-status.json", { state: "waiting_desktop", checkedAt: Date.now() });
  }
}
main().catch(() => {
});
