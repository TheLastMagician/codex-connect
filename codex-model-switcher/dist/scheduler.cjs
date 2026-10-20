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

// src/scheduler-worker.mjs
var import_node_net2 = __toESM(require("node:net"), 1);
var import_node_fs6 = __toESM(require("node:fs"), 1);
var import_node_path6 = __toESM(require("node:path"), 1);
var import_node_crypto5 = require("node:crypto");
var import_promises3 = require("node:timers/promises");

// src/schedules.mjs
var import_node_fs4 = __toESM(require("node:fs"), 1);
var import_node_path4 = __toESM(require("node:path"), 1);
var import_node_crypto2 = require("node:crypto");

// src/providers.mjs
var import_node_fs = __toESM(require("node:fs"), 1);
var import_node_path = __toESM(require("node:path"), 1);
var import_node_os = __toESM(require("node:os"), 1);

// node_modules/smol-toml/dist/error.js
function getLineColFromPtr(string, ptr) {
  let lines = string.slice(0, ptr).split(/\r?\n/);
  return [lines.length, lines.pop().length + 1];
}
function makeCodeBlock(string, line, column) {
  let lines = string.split(/\r?\n/);
  let codeblock = "";
  let numberLen = (Math.log10(line + 1) | 0) + 1;
  for (let i = line - 1; i <= line + 1; i++) {
    let l = lines[i - 1];
    if (!l)
      continue;
    codeblock += i.toString().padEnd(numberLen, " ");
    codeblock += ":  ";
    codeblock += l;
    codeblock += "\n";
    if (i === line) {
      codeblock += " ".repeat(numberLen + column + 2);
      codeblock += "^\n";
    }
  }
  return codeblock;
}
var TomlError = class _TomlError extends Error {
  line;
  column;
  codeblock;
  constructor(message, options) {
    const [line, column] = getLineColFromPtr(options.toml, options.ptr);
    const codeblock = makeCodeBlock(options.toml, line, column);
    super(`Invalid TOML document: ${message}

${codeblock}`, options);
    this.line = line;
    this.column = column;
    this.codeblock = codeblock;
  }
  /** @internal */
  static x(message, ctx, ptr) {
    throw new _TomlError(message, { toml: ctx.s, ptr: ptr ?? ctx.p });
  }
};

// node_modules/smol-toml/dist/primitive.js
function parseString(ctx) {
  let startPtr = ctx.p;
  let c = ctx.s.charCodeAt(ctx.p++);
  let first = c;
  let isLiteral = c === 39;
  let isMultiline = c === ctx.s.charCodeAt(ctx.p) && c === ctx.s.charCodeAt(ctx.p + 1);
  if (isMultiline) {
    if ((c = ctx.s.charCodeAt(ctx.p += 2)) === 10)
      ctx.p++;
    else if (c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)
      ctx.p += 2;
  }
  let parsed = "";
  let sliceStart = ctx.p;
  let state = 0;
  for (; ctx.p < ctx.s.length; ctx.p++) {
    c = ctx.s.charCodeAt(ctx.p);
    if (isMultiline && (c === 10 || c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)) {
      state = state && 3;
    } else if (c < 32 && c !== 9 || c === 127) {
      TomlError.x("control characters are not allowed in strings", ctx);
    } else if ((!state || state === 3) && c === first && (!isMultiline || ctx.s.charCodeAt(ctx.p + 1) === first && ctx.s.charCodeAt(ctx.p + 2) === first)) {
      if (isMultiline) {
        if (ctx.s.charCodeAt(ctx.p + 3) === first)
          ctx.p++;
        if (ctx.s.charCodeAt(ctx.p + 3) === first)
          ctx.p++;
      }
      if (!state) {
        let s = ctx.s.slice(sliceStart, ctx.p);
        parsed = parsed ? parsed + s : s;
      }
      ctx.p += isMultiline ? 3 : 1;
      return parsed;
    } else if (!state) {
      if (!isLiteral && c === 92) {
        parsed += ctx.s.slice(sliceStart, sliceStart = ctx.p);
        state = 1;
      }
    } else if (state === 1) {
      if (c === 120 || c === 117 || c === 85) {
        let errPtr = ctx.p++ - 1;
        let value = 0;
        let len = c === 120 ? 2 : c === 117 ? 4 : 8;
        for (let j = 0; j < len; j++, ctx.p++) {
          let hex = ctx.s.charCodeAt(ctx.p);
          let digit = (
            /* 0-9 */
            hex >= 48 && hex <= 57 ? hex - 48 : (
              /* A-F */
              hex >= 65 && hex <= 70 ? hex - 65 + 10 : (
                /* a-f */
                hex >= 97 && hex <= 102 ? hex - 97 + 10 : -1
              )
            )
          );
          if (digit < 0)
            TomlError.x("invalid non-hex character in unicode escape", ctx);
          value = value << 4 | digit;
        }
        if (value < 0 || value > 1114111 || value >= 55296 && value <= 57343) {
          TomlError.x("invalid unicode escape", ctx, errPtr);
        }
        parsed += String.fromCodePoint(value);
        sliceStart = ctx.p--;
        state = 0;
      } else if (isMultiline && (c === 32 || c === 9)) {
        state = 2;
      } else {
        if (c === 98)
          parsed += "\b";
        else if (c === 116)
          parsed += "	";
        else if (c === 110)
          parsed += "\n";
        else if (c === 102)
          parsed += "\f";
        else if (c === 114)
          parsed += "\r";
        else if (c === 101)
          parsed += "\x1B";
        else if (c === 34)
          parsed += '"';
        else if (c === 92)
          parsed += "\\";
        else
          TomlError.x("unrecognised escape sequence", ctx);
        sliceStart = ctx.p + 1;
        state = 0;
      }
    } else if (c !== 32 && c !== 9) {
      if (state === 2)
        TomlError.x("invalid escape: only line-ending whitespace may be escaped", ctx, sliceStart);
      state = !isLiteral && c === 92 ? 1 : 0;
      sliceStart = ctx.p;
    }
  }
  TomlError.x("unfinished string", ctx, startPtr);
}

// node_modules/smol-toml/dist/date.js
var DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})?[Tt ]?(?:(\d{2}):\d{2}(?::\d{2}(?:\.\d+)?)?)?(Z|z|[-+]\d{2}:\d{2})?$/i;
var TomlDate = class _TomlDate extends Date {
  #hasDate = false;
  #hasTime = false;
  #offset = null;
  constructor(date, fasttype, unsafeDelim) {
    let hasDate = true;
    let hasTime = true;
    let offset = "Z";
    let c;
    if (typeof date === "string") {
      if (fasttype)
        prep: {
          if (fasttype < 3) {
            if (+date.slice(11, 13) > 23) {
              date = "";
              break prep;
            }
            if (fasttype === 2) {
              offset = null;
              date += "Z";
            } else if ((c = date.charCodeAt(date.length - 1)) !== 90 && c !== 122) {
              offset = date.slice(date.length - 6);
            }
            if (unsafeDelim)
              date = date.slice(0, 10) + "T" + date.slice(11);
          } else if (fasttype === 4) {
            date = +date.slice(0, 2) > 23 ? "" : `0000-01-01T${date}Z`;
          }
          hasDate = fasttype !== 4;
          hasTime = fasttype !== 3;
        }
      else {
        let match = date.match(DATE_TIME_RE);
        if (match) {
          if (!match[1]) {
            hasDate = false;
            date = `0000-01-01T${date}`;
          }
          hasTime = !!match[2];
          hasTime && date[10] === " " && (date = date.replace(" ", "T"));
          if (match[2] && +match[2] > 23) {
            date = "";
          } else {
            offset = match[3] || null;
            if (!offset && hasTime)
              date += "Z";
          }
        } else {
          date = "";
        }
      }
    }
    super(date);
    if (!isNaN(this.getTime())) {
      this.#hasDate = hasDate;
      this.#hasTime = hasTime;
      this.#offset = offset;
    }
  }
  isDateTime() {
    return this.#hasDate && this.#hasTime;
  }
  isLocal() {
    return !this.#hasDate || !this.#hasTime || !this.#offset;
  }
  isDate() {
    return this.#hasDate && !this.#hasTime;
  }
  isTime() {
    return this.#hasTime && !this.#hasDate;
  }
  isValid() {
    return this.#hasDate || this.#hasTime;
  }
  toISOString() {
    let iso = super.toISOString();
    if (this.isDate())
      return iso.slice(0, 10);
    if (this.isTime())
      return iso.slice(11, 23);
    if (this.#offset === null)
      return iso.slice(0, -1);
    if (this.#offset === "Z" || this.#offset === "z")
      return iso;
    let offset = +this.#offset.slice(1, 3) * 60 + +this.#offset.slice(4, 6);
    offset = this.#offset[0] === "-" ? offset : -offset;
    let offsetDate = new Date(this.getTime() - offset * 6e4);
    return offsetDate.toISOString().slice(0, -1) + this.#offset;
  }
  static wrapAsOffsetDateTime(jsDate, offset = "Z") {
    let date = new _TomlDate(jsDate);
    date.#offset = offset;
    return date;
  }
  static wrapAsLocalDateTime(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#offset = null;
    return date;
  }
  static wrapAsLocalDate(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#hasTime = false;
    date.#offset = null;
    return date;
  }
  static wrapAsLocalTime(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#hasDate = false;
    date.#offset = null;
    return date;
  }
};

// node_modules/smol-toml/dist/extract.js
function isDigit(char, base = 10) {
  return base === 16 ? char > 47 && char < 58 || char > 64 && char < 71 || char > 96 && char < 103 : char > 47 && char < 48 + base;
}
function isEndOfValue(char, delim) {
  return char === 32 || char === 9 || char === 10 || char === 13 || // Structure end or next value delimiter
  delim && (char === delim || char === 44) || // Comment
  char === 35;
}
function extractValue(ctx, end) {
  let errPtr = ctx.p;
  let c = ctx.s.charCodeAt(ctx.p);
  if (c === 91 || c === 123) {
    ctx.d-- || TomlError.x("document contains excessively nested structures. aborting.", ctx);
    let value = c === 91 ? parseArray(ctx) : parseInlineTable(ctx);
    ctx.d++;
    return value;
  }
  if (c === 34 || c === 39) {
    return parseString(ctx);
  }
  if (c === 116) {
    if (ctx.s.charCodeAt(++ctx.p) !== 114 || ctx.s.charCodeAt(++ctx.p) !== 117 || ctx.s.charCodeAt(++ctx.p) !== 101)
      TomlError.x("invalid value", ctx, errPtr);
    return ctx.p++, true;
  }
  if (c === 102) {
    if (ctx.s.charCodeAt(++ctx.p) !== 97 || ctx.s.charCodeAt(++ctx.p) !== 108 || ctx.s.charCodeAt(++ctx.p) !== 115 || ctx.s.charCodeAt(++ctx.p) !== 101)
      TomlError.x("invalid value", ctx, errPtr);
    return ctx.p++, false;
  }
  if (c === 43 || c === 45) {
    return parseNumber(ctx, ctx.p, ctx.s.charCodeAt(++ctx.p), 44 - c, end);
  }
  if (ctx.s.charCodeAt(ctx.p + 4) === 45 && ctx.s.charCodeAt(ctx.p + 7) === 45) {
    return parseDate(ctx, c, end);
  }
  if (ctx.s.charCodeAt(ctx.p + 2) === 58) {
    return parseTime(ctx, c, end);
  }
  return parseNumber(ctx, ctx.p, c, 0, end);
}
function parseNumber(ctx, startPtr, startChr, sign, endChr) {
  let c = startChr;
  let state = 0;
  let hasUnderscores = false;
  if (c === 105) {
    if (ctx.s.charCodeAt(++ctx.p) !== 110 || ctx.s.charCodeAt(++ctx.p) !== 102)
      TomlError.x("invalid value", ctx, startPtr);
    return ctx.p++, (sign || 1) / 0;
  }
  if (c === 110) {
    if (ctx.s.charCodeAt(++ctx.p) !== 97 || ctx.s.charCodeAt(++ctx.p) !== 110)
      TomlError.x("invalid value", ctx, startPtr);
    return ctx.p++, NaN;
  }
  if (c === 48) {
    if (++ctx.p >= ctx.s.length || isEndOfValue(c = ctx.s.charCodeAt(ctx.p), endChr))
      return ctx.bi === true ? 0n : 0;
    if (!sign) {
      if (c === 120)
        return parseIntegerBaseN(ctx, startPtr, 16, endChr);
      else if (c === 98)
        return parseIntegerBaseN(ctx, startPtr, 2, endChr);
      else if (c === 111)
        return parseIntegerBaseN(ctx, startPtr, 8, endChr);
    }
    if (c === 46)
      state = 2;
    else if (c === 101 || c === 69)
      state = 4;
    else
      TomlError.x("illegal leading zero", ctx, startPtr);
  } else if (!isDigit(c))
    TomlError.x("invalid value", ctx, startPtr);
  while (++ctx.p < ctx.s.length && (c = ctx.s.charCodeAt(ctx.p), !isEndOfValue(c, endChr))) {
    if (!state)
      state = 1;
    if (c === 95) {
      if (!(state & 1))
        TomlError.x("illegal underscore", ctx);
      state += 11;
      hasUnderscores = true;
    } else if (state === 1 && c === 46)
      state = 2;
    else if ((state === 1 || state === 3) && (c === 101 || c === 69))
      state = 4;
    else if (state === 4 && (c === 43 || c === 45)) {
      state = 6;
    } else if (!isDigit(c))
      TomlError.x(`illegal character in numeric literal`, ctx);
    else if (state > 9)
      state -= 11;
    else if (!(state & 1))
      state++;
  }
  if (!state) {
    let val = (startChr - 48) * (sign || 1);
    return ctx.bi === true ? BigInt(val) : val;
  }
  if (!(state & 1))
    TomlError.x("unfinished numeric value", ctx, startPtr);
  let str = ctx.s.slice(startPtr, ctx.p);
  if (hasUnderscores)
    str = str.replaceAll("_", "");
  return state > 1 ? parseFloat(str) : parseInteger(ctx, str, 10, startPtr);
}
function parseIntegerBaseN(ctx, startPtr, base, endChr) {
  let c, underscore = 1;
  while (++ctx.p < ctx.s.length && (c = ctx.s.charCodeAt(ctx.p), !isEndOfValue(c, endChr))) {
    if (c === 95) {
      if (underscore & 1)
        TomlError.x("illegal underscore", ctx);
      underscore = 3;
    } else if (!isDigit(c, base))
      TomlError.x(`illegal character in numeric literal`, ctx);
    else if (underscore & 1)
      underscore--;
  }
  if (underscore & 1)
    TomlError.x("unfinished numeric value", ctx);
  let str = ctx.s.slice(startPtr + 2, ctx.p);
  if (underscore)
    str = str.replaceAll("_", "");
  return parseInteger(ctx, str, base, startPtr);
}
function parseInteger(ctx, str, base, startPtr) {
  if (ctx.bi !== true)
    int: {
      let val = parseInt(str, base);
      if (!Number.isSafeInteger(val)) {
        if (ctx.bi)
          break int;
        TomlError.x("integer value cannot be represented losslessly", ctx, startPtr);
      }
      return val;
    }
  return base === 10 ? BigInt(str) : BigInt((base === 2 ? "0b" : base === 8 ? "0o" : "0x") + str);
}
function parseDate(ctx, c, endChr) {
  let startPtr = ctx.p++, unsafeSeparator;
  if (!isDigit(c) || !isDigit(ctx.s.charCodeAt(ctx.p++)) || !isDigit(ctx.s.charCodeAt(ctx.p++)) || !isDigit(ctx.s.charCodeAt(ctx.p++))) {
    return parseNumber(ctx, ctx.p = startPtr, c, 0, endChr);
  }
  ctx.p += 5;
  if (!isDigit(ctx.s.charCodeAt(ctx.p++)))
    TomlError.x("invalid date-time: date part is malformed", ctx, startPtr);
  if (ctx.p >= ctx.s.length || ((c = ctx.s.charCodeAt(ctx.p)) !== 32 || (unsafeSeparator = true, !isDigit(ctx.s.charCodeAt(ctx.p + 1)))) && c !== 84 && c !== 116) {
    let t2 = ctx.s.slice(startPtr, ctx.p);
    return readDate(ctx, t2, 3, false, startPtr);
  }
  if (ctx.s.charCodeAt(ctx.p += 3) !== 58)
    TomlError.x("invalid date-time: time part is malformed", ctx, startPtr);
  if (ctx.s.charCodeAt(ctx.p += 3) === 58)
    ctx.p += 3;
  if (ctx.s.charCodeAt(ctx.p) === 46)
    while (isDigit(ctx.s.charCodeAt(++ctx.p)))
      ;
  if (c = ctx.s.charCodeAt(ctx.p)) {
    if (c === 90 || c === 122) {
      let t2 = ctx.s.slice(startPtr, ++ctx.p);
      return readDate(ctx, t2, 1, unsafeSeparator, startPtr, "[+00:00]");
    }
    if (c === 43 || c === 45) {
      let t2 = ctx.s.slice(startPtr, ctx.p += 6);
      return readDate(ctx, t2, 1, unsafeSeparator, startPtr, !ctx.ld && "[" + ctx.s.slice(ctx.p - 6, ctx.p) + "]");
    }
  }
  let t = ctx.s.slice(startPtr, ctx.p);
  return readDate(ctx, t, 2, unsafeSeparator, startPtr);
}
function parseTime(ctx, c, endChr) {
  let start = ctx.p;
  if (!isDigit(c) || !isDigit(ctx.s.charCodeAt(++ctx.p))) {
    return parseNumber(ctx, --ctx.p, c, 0, endChr);
  }
  if (ctx.s.charCodeAt(ctx.p += 4) === 58)
    ctx.p += 3;
  if (ctx.s.charCodeAt(ctx.p) === 46)
    while (isDigit(ctx.s.charCodeAt(++ctx.p)))
      ;
  let t = ctx.s.slice(start, ctx.p);
  return readDate(ctx, t, 4, false, start);
}
function readDate(ctx, str, type, unsafeDelim, errPtr, temporalSuffix) {
  if (ctx.ld) {
    let date = new TomlDate(str, type, unsafeDelim);
    if (!date.isValid())
      TomlError.x("invalid date", ctx, errPtr);
    return date;
  }
  try {
    if (temporalSuffix)
      str += temporalSuffix;
    switch (type) {
      case 1:
        return Temporal.ZonedDateTime.from(str);
      case 2:
        return Temporal.PlainDateTime.from(str);
      case 3:
        return Temporal.PlainDate.from(str);
      case 4:
        return Temporal.PlainTime.from(str);
    }
  } catch (e) {
    TomlError.x(e instanceof Error ? e.message : "" + e, ctx, errPtr);
  }
}

// node_modules/smol-toml/dist/util.js
function skipComment(ctx) {
  for (; ctx.p < ctx.s.length; ctx.p++) {
    let c = ctx.s.charCodeAt(ctx.p);
    if (c === 10)
      break;
    if (c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10) {
      ctx.p++;
      break;
    }
    if (c < 32 && c !== 9 || c === 127) {
      TomlError.x("control characters are not allowed in comments", ctx);
    }
  }
}
function skipVoid(ctx, banNewLines, banComments) {
  let c;
  while (ctx.p < ctx.s.length) {
    while (ctx.p < ctx.s.length && ((c = ctx.s.charCodeAt(ctx.p)) === 32 || c === 9 || !banNewLines && (c === 10 || c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)))
      ctx.p++;
    if (banComments || c !== 35)
      break;
    skipComment(ctx);
  }
}

// node_modules/smol-toml/dist/struct.js
function parseKey(ctx, end = 61) {
  let startPtr;
  let state = 0;
  let parsed = [];
  let sliceStart;
  let c = ctx.s.charCodeAt(startPtr = ctx.p);
  do {
    if (c === end) {
      if (!state)
        TomlError.x("unexpected end of key", ctx);
      if (state === 1)
        parsed.push(ctx.s.slice(sliceStart, ctx.p));
      return ctx.p++, parsed;
    } else if (c === 46) {
      if (!state)
        TomlError.x("illegal empty bare key", ctx);
      if (state === 1)
        parsed.push(ctx.s.slice(sliceStart, ctx.p));
      state = 0;
    } else if (!state && (c === 34 || c === 39)) {
      if (c === ctx.s.charCodeAt(ctx.p + 1) && c === ctx.s.charCodeAt(ctx.p + 2))
        TomlError.x("illegal quoted key: multiline strings are not allowed", ctx);
      parsed.push(parseString(ctx));
      state = 2;
      ctx.p--;
    } else if (c === 32 || c === 9) {
      if (state === 1) {
        parsed.push(ctx.s.slice(sliceStart, ctx.p));
        state = 2;
      }
    } else if (state === 2 || c < 48 && c !== 45 || c > 57 && c < 65 || c > 90 && c < 97 && c !== 95 || c > 122) {
      TomlError.x("illegal character in key", ctx);
    } else if (!state) {
      state = 1;
      sliceStart = ctx.p;
    }
  } while (c = ctx.s.charCodeAt(++ctx.p));
  TomlError.x("incomplete key-value: cannot find end of key", ctx, startPtr);
}
function parseInlineTable(ctx) {
  let startPtr = ctx.p++;
  let res = /* @__PURE__ */ Object.create(null);
  let seen = /* @__PURE__ */ new Set();
  let c;
  while (ctx.p < ctx.s.length) {
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p)) === 125) {
      ctx.p++;
      return res;
    }
    let k;
    let t = res;
    let hasOwn = false;
    let errPtr = ctx.p;
    let key = parseKey(ctx);
    for (let i = 0; i < key.length; i++) {
      if (i)
        t = hasOwn ? t[k] : t[k] = /* @__PURE__ */ Object.create(null);
      k = key[i];
      if ((hasOwn = Object.hasOwn(t, k)) && (typeof t[k] !== "object" || seen.has(t[k]))) {
        TomlError.x("trying to redefine an already defined value", ctx, errPtr);
      }
      let unsafe = k === "__proto__";
      if (ctx.uk && (unsafe || k === "constructor")) {
        t = ctx.uk !== 1 && TomlError.x("document contains an unsafe property", ctx, errPtr);
        break;
      }
      if (!hasOwn && unsafe) {
        Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
      }
    }
    if (hasOwn) {
      TomlError.x("trying to redefine an already defined value", ctx, errPtr);
    }
    skipVoid(ctx, true, true);
    let value = extractValue(
      ctx,
      125
      /* } */
    );
    if (t && typeof (t[k] = value) === "object")
      seen.add(value);
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p++)) === 125) {
      return res;
    }
    if (c !== 44)
      TomlError.x("expected comma or end of structure", ctx, ctx.p - 1);
  }
  TomlError.x("unfinished table", ctx, startPtr);
}
function parseArray(ctx) {
  let startPtr = ctx.p++;
  let res = [];
  let c;
  while (ctx.p < ctx.s.length) {
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p)) === 93) {
      ctx.p++;
      return res;
    }
    res.push(extractValue(
      ctx,
      93
      /* ] */
    ));
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p++)) === 93) {
      return res;
    }
    if (c !== 44)
      TomlError.x("expected comma or end of structure", ctx, ctx.p - 1);
  }
  TomlError.x("unfinished array", ctx, startPtr);
}

// node_modules/smol-toml/dist/parse.js
function peekTable(ctx, key, table, meta, type) {
  let t = table;
  let m = meta;
  let k;
  let hasOwn = false;
  let state;
  for (let i = 0; i < key.length; i++) {
    if (i) {
      t = hasOwn ? t[k] : t[k] = /* @__PURE__ */ Object.create(null);
      m = (state = m[k]).c;
      if (type === 0 && (state.t === 1 || state.t === 2)) {
        return null;
      }
      if (state.t === 2) {
        let l = t.length - 1;
        t = t[l];
        m = m[l].c;
      }
    }
    k = key[i];
    if ((hasOwn = Object.hasOwn(t, k)) && m[k]?.t === 0 && m[k]?.d) {
      return null;
    }
    if (!hasOwn) {
      let unsafe = k === "__proto__";
      if (ctx.uk && (unsafe || k === "constructor"))
        return false;
      if (unsafe) {
        Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
        Object.defineProperty(m, k, { enumerable: true, configurable: true, writable: true });
      }
      m[k] = {
        t: i < key.length - 1 && type === 2 ? 3 : type,
        d: false,
        i: 0,
        c: /* @__PURE__ */ Object.create(null)
      };
    }
  }
  state = m[k];
  if (state.t !== type && !(type === 1 && state.t === 3)) {
    return null;
  }
  if (type === 2) {
    if (!state.d) {
      state.d = true;
      t[k] = [];
    }
    t[k].push(t = /* @__PURE__ */ Object.create(null));
    state.c[state.i++] = state = { t: 1, d: false, i: 0, c: /* @__PURE__ */ Object.create(null) };
  }
  if (state.d) {
    return null;
  }
  state.d = true;
  if (type === 1) {
    t = hasOwn ? t[k] : t[k] = /* @__PURE__ */ Object.create(null);
  } else if (type === 0 && hasOwn) {
    return null;
  }
  return [k, t, state.c];
}
function validateTablePeek(ctx, peek, ptr) {
  if (peek === null || ctx.uk === 2)
    TomlError.x(peek === null ? "trying to redefine an already defined table or value" : "document contains an unsafe property", ctx, ptr);
}
function parse(toml, options = {}) {
  let ctx = {
    s: toml,
    p: 0,
    d: options.maxDepth ?? 1e3,
    bi: options.integersAsBigInt ?? false,
    ld: options.useLegacyDate ?? true,
    uk: options.unsafeKeyBehaviour === "throw" ? 2 : options.unsafeKeyBehaviour === "drop" ? 1 : 0
  };
  let res = /* @__PURE__ */ Object.create(null);
  let meta = /* @__PURE__ */ Object.create(null);
  let tmp;
  let skipping = false;
  let tbl = res;
  let m = meta;
  if (toml.charCodeAt(0) === 65279)
    ctx.p++;
  skipVoid(ctx);
  while (ctx.p < toml.length) {
    if (toml.charCodeAt(ctx.p) === 91) {
      let isTableArray = toml.charCodeAt(++ctx.p) === 91;
      tmp = ctx.p += +isTableArray;
      skipping = false;
      let k = parseKey(
        ctx,
        93
        /* ] */
      );
      if (isTableArray) {
        if (toml.charCodeAt(ctx.p) !== 93) {
          TomlError.x("expected end of table array declaration", ctx);
        }
        ctx.p++;
      }
      let p = peekTable(
        ctx,
        k,
        res,
        meta,
        isTableArray ? 2 : 1
        /* Type.EXPLICIT */
      );
      if (!p) {
        validateTablePeek(ctx, p, tmp);
        skipping = true;
      } else {
        m = p[2];
        tbl = p[1];
      }
    } else {
      tmp = ctx.p;
      let k = parseKey(ctx);
      let p = peekTable(
        ctx,
        k,
        tbl,
        m,
        0
        /* Type.DOTTED */
      );
      if (!p && !skipping)
        validateTablePeek(ctx, p, tmp);
      skipVoid(ctx, true, true);
      let v = extractValue(ctx, void 0);
      if (p && !skipping)
        p[1][p[0]] = v;
    }
    skipVoid(ctx, true);
    if (ctx.p < toml.length && (tmp = toml.charCodeAt(ctx.p)) !== 10 && (tmp !== 13 || toml.charCodeAt(ctx.p + 1) !== 10)) {
      TomlError.x("each key-value declaration must be followed by an end-of-line", ctx);
    }
    skipVoid(ctx);
  }
  return res;
}

// node_modules/smol-toml/dist/stringify.js
var HAS_WELLFORMED = !!"".isWellFormed;

// src/providers.mjs
var home = () => process.env.CODEX_HOME || import_node_path.default.join(import_node_os.default.homedir(), ".codex");
function readConfig(directory = home()) {
  try {
    return parse(import_node_fs.default.readFileSync(import_node_path.default.join(directory, "config.toml"), "utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("\u65E0\u6CD5\u8BFB\u53D6 Codex \u914D\u7F6E\uFF0C\u8BF7\u68C0\u67E5 config.toml \u7684\u683C\u5F0F\u3002");
  }
}
function publicUrl(value) {
  try {
    const url = new URL(value);
    return url.origin + url.pathname;
  } catch {
    return "";
  }
}
function providerList(config) {
  const items = [{ id: "openai", name: "\u81EA\u5DF1\u7684 ChatGPT / OpenAI \u8D26\u53F7", baseUrl: "OpenAI", wireApi: "responses", authentication: "\u5DF2\u6709 Codex \u767B\u5F55" }];
  for (const [id, p] of Object.entries(config.model_providers || {})) {
    if (id === "openai" || !p || typeof p !== "object" || !p.base_url) continue;
    items.push({
      id,
      name: p.name || id,
      baseUrl: publicUrl(p.base_url),
      wireApi: p.wire_api || "responses",
      authentication: p.requires_openai_auth ? "Codex \u767B\u5F55" : p.env_key ? "\u73AF\u5883\u53D8\u91CF" : p.experimental_bearer_token ? "\u5DF2\u914D\u7F6E\u5BC6\u94A5" : p.auth ? "\u51ED\u636E\u52A9\u624B" : "\u65E0\u5BC6\u94A5",
      ...p.model ? { configurationNote: "\u4F9B\u5E94\u5546\u8868\u5185\u7684 model \u4E0D\u4F1A\u8BBE\u7F6E\u9ED8\u8BA4\u6A21\u578B\uFF1B\u65B0\u5EFA\u65F6\u4EE5\u9762\u677F\u9009\u62E9\u4E3A\u51C6\u3002" } : {}
    });
  }
  return { defaultProvider: config.model_provider || "openai", defaultModel: config.model || null, providers: items };
}
function requireSelection(config, providerId, model) {
  if (!providerList(config).providers.some((p2) => p2.id === providerId)) throw new Error("\u4F9B\u5E94\u5546\u4E0D\u5B58\u5728\uFF0C\u8BF7\u5237\u65B0\u914D\u7F6E\u3002");
  if (typeof model !== "string" || !model.trim() || model.length > 160 || /[\r\n\0]/.test(model)) throw new Error("\u8BF7\u9009\u62E9\u6709\u6548\u7684\u6A21\u578B ID\u3002");
  const p = config.model_providers?.[providerId];
  if (p?.wire_api && p.wire_api !== "responses") throw new Error("\u8FD9\u4E2A\u4F9B\u5E94\u5546\u6CA1\u6709\u914D\u7F6E Responses API\u3002");
  return { modelProvider: providerId, model: model.trim() };
}

// src/service.mjs
var import_node_fs3 = __toESM(require("node:fs"), 1);
var import_node_child_process2 = require("node:child_process");
var import_node_readline2 = require("node:readline");

// src/app-server.mjs
var import_node_fs2 = __toESM(require("node:fs"), 1);
var import_node_os2 = __toESM(require("node:os"), 1);
var import_node_path2 = __toESM(require("node:path"), 1);
var import_node_child_process = require("node:child_process");
var import_node_readline = require("node:readline");
function codexBinary(env = process.env) {
  if (env.CODEX_SWITCHER_CODEX_PATH) return env.CODEX_SWITCHER_CODEX_PATH;
  if (process.platform === "win32") {
    const root = import_node_path2.default.join(env.LOCALAPPDATA || import_node_path2.default.join(import_node_os2.default.homedir(), "AppData", "Local"), "OpenAI", "Codex", "bin");
    try {
      const candidates = import_node_fs2.default.readdirSync(root).map((name) => import_node_path2.default.join(root, name, "codex.exe")).filter((file) => import_node_fs2.default.existsSync(file)).sort((a, b) => import_node_fs2.default.statSync(b).mtimeMs - import_node_fs2.default.statSync(a).mtimeMs);
      if (candidates.length) return candidates[0];
    } catch {
    }
  }
  for (const file of ["/Applications/ChatGPT.app/Contents/Resources/codex", "/Applications/Codex.app/Contents/Resources/codex"])
    if (import_node_fs2.default.existsSync(file)) return file;
  return "codex";
}
var AppServer = class {
  constructor({ binary = codexBinary(), env = process.env, timeoutMs = 45e3, overrides = {} } = {}) {
    Object.assign(this, { binary, env, timeoutMs, overrides });
    this.pending = /* @__PURE__ */ new Map();
    this.nextId = 1;
  }
  async connect() {
    const args = ["app-server", "--listen", "stdio://"];
    for (const [key, value] of Object.entries(this.overrides)) args.push("-c", `${key}=${JSON.stringify(value)}`);
    this.child = (0, import_node_child_process.spawn)(this.binary, args, {
      env: this.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"]
    });
    this.child.on("error", () => this.fail("\u65E0\u6CD5\u542F\u52A8\u672C\u673A Codex\u3002\u8BF7\u68C0\u67E5 Codex \u684C\u9762\u7248\u662F\u5426\u5DF2\u5B89\u88C5\u3002"));
    this.child.on("exit", () => this.fail("Codex \u8FDE\u63A5\u5DF2\u5173\u95ED\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5\u3002"));
    this.child.stdin.on("error", () => {
    });
    this.lines = (0, import_node_readline.createInterface)({ input: this.child.stdout });
    this.lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const item = this.pending.get(message.id);
      if (!item) return;
      clearTimeout(item.timer);
      this.pending.delete(message.id);
      if (message.error) item.reject(new Error(`Codex \u62D2\u7EDD\u4E86 ${item.method} \u8BF7\u6C42\uFF08${message.error.code}\uFF09\u3002`));
      else item.resolve(message.result);
    });
    await this.request("initialize", { clientInfo: { name: "codex_model_switcher", title: "\u4F9B\u5E94\u5546\u4E0E\u6A21\u578B", version: "0.3.0" }, capabilities: { experimentalApi: true } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
    return this;
  }
  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} \u8BF7\u6C42\u8D85\u65F6\u3002\u65B0\u5EFA\u7ED3\u679C\u53EF\u80FD\u672A\u77E5\uFF0C\u8BF7\u5148\u5237\u65B0\u4F1A\u8BDD\u5217\u8868\uFF0C\u4E0D\u8981\u8FDE\u7EED\u91CD\u8BD5\u3002`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  fail(message) {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error(message));
    }
    this.pending.clear();
  }
  async close() {
    this.fail("\u8FDE\u63A5\u5DF2\u7ED3\u675F");
    this.lines?.close();
    if (!this.child || this.child.exitCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill();
        resolve();
      }, 2500);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      this.child.stdin.end();
    });
  }
};
async function withAppServer(action, options) {
  const client = new AppServer(options);
  try {
    await client.connect();
    return await action(client);
  } finally {
    await client.close();
  }
}

// src/desktop-ipc.mjs
var import_node_net = __toESM(require("node:net"), 1);
var import_node_crypto = require("node:crypto");
var import_node_path3 = __toESM(require("node:path"), 1);
var import_node_os3 = __toESM(require("node:os"), 1);
var import_promises = require("node:timers/promises");
var VERSIONS = { initialize: 0, "thread-owner-discovery": 1, "thread-follower-read-model-settings": 1, "thread-follower-update-thread-settings": 2, "thread-follower-start-turn": 2 };
var DesktopReader = class {
  constructor({ pipePath = process.platform === "win32" ? "\\\\.\\pipe\\codex-ipc" : import_node_path3.default.join(process.env.CODEX_HOME || import_node_path3.default.join(import_node_os3.default.homedir(), ".codex"), "ipc", "ipc.sock"), timeoutMs = 8e3 } = {}) {
    Object.assign(this, { pipePath, timeoutMs });
    this.buffer = Buffer.alloc(0);
    this.pending = /* @__PURE__ */ new Map();
  }
  async connect() {
    await new Promise((resolve, reject) => {
      this.socket = import_node_net.default.createConnection(this.pipePath);
      const timer = setTimeout(() => this.socket.destroy(new Error("\u684C\u9762\u8FDE\u63A5\u8D85\u65F6\u3002")), this.timeoutMs);
      this.socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    this.socket.on("data", (chunk) => this.onData(chunk));
    this.socket.on("error", () => this.close());
    this.socket.on("close", () => this.close());
    const reply = await this.request("initialize", { clientType: "codex-model-switcher" });
    if (reply.resultType !== "success") throw new Error("\u684C\u9762\u8FDE\u63A5\u521D\u59CB\u5316\u5931\u8D25\u3002");
    this.clientId = reply.result.clientId;
  }
  request(method, params, { targetClientId } = {}) {
    if (!Object.hasOwn(VERSIONS, method)) throw new Error("\u4E0D\u652F\u6301\u7684\u684C\u9762\u53EA\u8BFB\u64CD\u4F5C\u3002");
    const requestId = (0, import_node_crypto.randomUUID)();
    const data = Buffer.from(JSON.stringify({
      type: "request",
      requestId,
      sourceClientId: this.clientId || "initializing-client",
      version: VERSIONS[method],
      method,
      params,
      timeoutMs: this.timeoutMs,
      ...targetClientId ? { targetClientId } : {}
    }));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(data.length);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("\u684C\u9762\u8BFB\u53D6\u8D85\u65F6\u3002"));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.socket.write(Buffer.concat([header, data]));
    });
  }
  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32LE(0);
      if (size > 8 * 1024 * 1024 || size === 0) {
        this.close();
        return;
      }
      if (this.buffer.length < size + 4) return;
      let msg;
      try {
        msg = JSON.parse(this.buffer.subarray(4, size + 4));
      } catch {
        this.close();
        return;
      }
      this.buffer = this.buffer.subarray(size + 4);
      if (msg.type === "client-discovery-request") {
        const reply = Buffer.from(JSON.stringify({ type: "client-discovery-response", requestId: msg.requestId, response: { canHandle: false } }));
        const h = Buffer.alloc(4);
        h.writeUInt32LE(reply.length);
        this.socket.write(Buffer.concat([h, reply]));
      }
      const item = this.pending.get(msg.requestId);
      if (msg.type === "response" && item) {
        clearTimeout(item.timer);
        this.pending.delete(msg.requestId);
        item.resolve(msg);
      }
    }
  }
  async settings(threadId) {
    const owner = await this.request("thread-owner-discovery", { hostId: "local", conversationId: threadId });
    if (owner.resultType !== "success" || !owner.handledByClientId) return null;
    const reply = await this.request("thread-follower-read-model-settings", { conversationId: threadId }, { targetClientId: owner.handledByClientId });
    if (reply.resultType !== "success") throw new Error("\u684C\u9762\u65E0\u6CD5\u8BFB\u53D6\u8BE5\u4F1A\u8BDD\u7684\u6A21\u578B\u8BBE\u7F6E\u3002");
    return reply.result.settings;
  }
  async setModel(threadId, providerId, model, effort = "none", { verifiedStoredProvider, settleMs = 1e4, pollMs = 120, now = Date.now, sleep = import_promises.setTimeout } = {}) {
    const before = await this.settings(threadId);
    if (!before) throw new Error("\u4F1A\u8BDD\u5C1A\u672A\u5728\u684C\u9762\u52A0\u8F7D\u3002");
    const pendingProvider = (before.modelProvider == null || before.modelProvider === "") && verifiedStoredProvider === providerId && before.resumeState === "resumed";
    if (before.modelProvider !== providerId && !pendingProvider) throw new Error("\u684C\u9762\u5B9E\u9645\u4F9B\u5E94\u5546\u4E0E\u9009\u62E9\u4E0D\u4E00\u81F4\uFF0C\u6A21\u578B\u672A\u4FEE\u6539\u3002");
    const matches = (settings) => settings?.model === model && settings.modelProvider === providerId && settings.reasoningEffort === effort;
    if (matches(before)) return before;
    const owner = await this.request("thread-owner-discovery", { hostId: "local", conversationId: threadId });
    if (owner.resultType !== "success") throw new Error("\u684C\u9762\u4F1A\u8BDD\u8FDE\u63A5\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u6253\u5F00\u8BE5\u4F1A\u8BDD\u3002");
    const reply = await this.request("thread-follower-update-thread-settings", {
      conversationId: threadId,
      threadSettings: { model, effort, serviceTier: null },
      condition: { ifModelEquals: before.model, ifEffortEquals: before.reasoningEffort ?? null }
    }, { targetClientId: owner.handledByClientId });
    if (reply.resultType !== "success" || !reply.result?.applied) throw new Error("\u6A21\u578B\u8BBE\u7F6E\u672A\u88AB\u684C\u9762\u786E\u8BA4\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5\u3002");
    const deadline = now() + settleMs;
    do {
      const after = await this.settings(threadId);
      if (matches(after)) return after;
      if (after?.modelProvider && after.modelProvider !== providerId) throw new Error("\u684C\u9762\u8FD4\u56DE\u4E86\u5176\u4ED6\u4F9B\u5E94\u5546\uFF0C\u5C1A\u672A\u786E\u8BA4\u6240\u9009\u6A21\u578B\u3002");
      if (now() >= deadline) break;
      await sleep(pollMs);
    } while (true);
    throw new Error("\u684C\u9762\u7684\u6A21\u578B\u8BBE\u7F6E\u901A\u77E5\u5C1A\u672A\u5B8C\u6210\uFF0C\u8BF7\u70B9\u51FB\u201C\u6253\u5F00\u5E76\u786E\u8BA4\u6A21\u578B\u201D\u91CD\u8BD5\uFF0C\u4E0D\u4F1A\u91CD\u590D\u521B\u5EFA\u3002");
  }
  close() {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("\u684C\u9762\u8BFB\u53D6\u8FDE\u63A5\u5DF2\u5173\u95ED\u3002"));
    }
    this.pending.clear();
    this.socket?.destroy();
  }
};

// src/service.mjs
var UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function existingThreadId(reference) {
  if (typeof reference !== "string") throw new Error("\u8BF7\u9009\u62E9\u5DF2\u6709\u4F1A\u8BDD\uFF0C\u6216\u7C98\u8D34 codex://threads/ \u4F1A\u8BDD\u94FE\u63A5\u3002");
  const id = reference.trim().replace(/^codex:\/\/threads\//i, "");
  if (!UUID.test(id)) throw new Error("\u4F1A\u8BDD\u94FE\u63A5\u6216 ID \u65E0\u6548\uFF0C\u8BF7\u7C98\u8D34\u5B8C\u6574\u7684 codex://threads/ \u94FE\u63A5\u3002");
  return id.toLowerCase();
}
async function historyModel(thread) {
  if (typeof thread.path !== "string") return { status: "unavailable" };
  let input, lines;
  try {
    const size = import_node_fs3.default.statSync(thread.path).size;
    if (size > 128 * 1024 * 1024) return { status: "unavailable" };
    input = import_node_fs3.default.createReadStream(thread.path, { encoding: "utf8", signal: AbortSignal.timeout(5e3) });
    lines = (0, import_node_readline2.createInterface)({ input, crlfDelay: Infinity });
    let model = null;
    for await (const line of lines) {
      if (!/"type"\s*:\s*"turn_context"/.test(line)) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record.type === "turn_context" && typeof record.payload?.model === "string" && record.payload.model.length <= 160) model = record.payload.model;
    }
    return model ? { status: "recorded", model } : { status: "empty" };
  } catch {
    return { status: "unavailable" };
  } finally {
    lines?.close();
    input?.destroy();
  }
}
function openThread(threadId) {
  if (!UUID.test(threadId)) throw new Error("\u65E0\u6548\u7684\u4F1A\u8BDD ID\u3002");
  const url = `codex://threads/${threadId}`;
  const [bin, args] = process.platform === "win32" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  return new Promise((resolve, reject) => {
    const child = (0, import_node_child_process2.spawn)(bin, args, { windowsHide: true, stdio: "ignore" });
    child.once("error", () => reject(new Error("\u65E0\u6CD5\u6253\u5F00 Codex\uFF0C\u8BF7\u4F7F\u7528\u8FD4\u56DE\u7684\u4F1A\u8BDD\u94FE\u63A5\u3002")));
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("\u684C\u9762\u672A\u786E\u8BA4\u6253\u5F00\u64CD\u4F5C\uFF0C\u8BF7\u4F7F\u7528\u4F1A\u8BDD\u94FE\u63A5\u3002")));
  });
}

// src/schedules.mjs
var SCHEDULER_VERSION = "0.3.0";
var GRACE_MS = 15 * 60 * 1e3;
var scheduleDirectory = () => import_node_path4.default.join(home(), "model-switcher", "scheduler");
function localDay(now) {
  return new Date(now + 8 * 36e5).toISOString().slice(0, 10);
}
function scheduledTime(job, day) {
  return Date.parse(`${day}T${job.time}:00+08:00`);
}
function nextRun(job, now = Date.now()) {
  if (job.status !== "ACTIVE") return null;
  let at = scheduledTime(job, localDay(now));
  if (at <= now) at += 864e5;
  return at;
}
function atomicJson(file, value) {
  import_node_fs4.default.mkdirSync(import_node_path4.default.dirname(file), { recursive: true, mode: 448 });
  const tmp = `${file}.${(0, import_node_crypto2.randomUUID)()}.tmp`;
  import_node_fs4.default.writeFileSync(tmp, JSON.stringify(value), { mode: 384 });
  import_node_fs4.default.renameSync(tmp, file);
}
var ScheduleStore = class {
  constructor({ directory = scheduleDirectory(), read = readConfig, rpc = withAppServer, now = Date.now } = {}) {
    Object.assign(this, { directory, read, rpc, now });
  }
  jobFile(id) {
    if (!UUID.test(id || "")) throw new Error("\u65E0\u6548\u7684\u5B9A\u65F6\u4EFB\u52A1 ID\u3002");
    return import_node_path4.default.join(this.directory, "jobs", id + ".json");
  }
  readJob(id) {
    try {
      return JSON.parse(import_node_fs4.default.readFileSync(this.jobFile(id), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") throw new Error("\u5B9A\u65F6\u4EFB\u52A1\u4E0D\u5B58\u5728\uFF0C\u8BF7\u5237\u65B0\u5217\u8868\u3002");
      throw error;
    }
  }
  jobs() {
    const folder = import_node_path4.default.join(this.directory, "jobs");
    if (!import_node_fs4.default.existsSync(folder)) return [];
    return import_node_fs4.default.readdirSync(folder).filter((f) => /^[\da-f-]+\.json$/i.test(f)).map((f) => JSON.parse(import_node_fs4.default.readFileSync(import_node_path4.default.join(folder, f), "utf8")));
  }
  runFile(id, day) {
    this.jobFile(id);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("\u65E0\u6548\u7684\u8FD0\u884C\u65E5\u671F\u3002");
    return import_node_path4.default.join(this.directory, "runs", id, day + ".json");
  }
  run(id, day) {
    try {
      return JSON.parse(import_node_fs4.default.readFileSync(this.runFile(id, day), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  claim(job, day) {
    const file = this.runFile(job.id, day);
    import_node_fs4.default.mkdirSync(import_node_path4.default.dirname(file), { recursive: true, mode: 448 });
    const run = { jobId: job.id, day, scheduledFor: scheduledTime(job, day), status: "waiting", clientUserMessageId: (0, import_node_crypto2.randomUUID)(), createdAt: this.now(), updatedAt: this.now() };
    try {
      import_node_fs4.default.writeFileSync(file, JSON.stringify(run), { flag: "wx", mode: 384 });
      return run;
    } catch (e) {
      if (e.code === "EEXIST") return this.run(job.id, day);
      throw e;
    }
  }
  saveRun(run) {
    atomicJson(this.runFile(run.jobId, run.day), { ...run, updatedAt: this.now() });
  }
  recent(id) {
    const folder = import_node_path4.default.join(this.directory, "runs", id);
    if (!import_node_fs4.default.existsSync(folder)) return [];
    return import_node_fs4.default.readdirSync(folder).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse().slice(0, 7).map((f) => JSON.parse(import_node_fs4.default.readFileSync(import_node_path4.default.join(folder, f), "utf8")));
  }
  pending(id) {
    const folder = import_node_path4.default.join(this.directory, "runs", id);
    if (!import_node_fs4.default.existsSync(folder)) return [];
    return import_node_fs4.default.readdirSync(folder).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => JSON.parse(import_node_fs4.default.readFileSync(import_node_path4.default.join(folder, f), "utf8"))).filter((r) => ["accepted", "submitting", "unknown"].includes(r.status));
  }
  acknowledge(id, day) {
    const run = this.run(id, day);
    if (!run || !["unknown", "submitting"].includes(run.status) || this.now() - run.updatedAt < 12e4) throw new Error("\u8BE5\u8BB0\u5F55\u6682\u4E0D\u80FD\u89E3\u9664\u963B\u585E\uFF0C\u8BF7\u7B49\u5F85\u5E76\u6838\u5BF9\u539F\u4F1A\u8BDD\u3002");
    this.saveRun({ ...run, status: "reviewed", note: "\u7528\u6237\u5DF2\u6838\u5BF9\u5E76\u89E3\u9664\u963B\u585E\uFF1B\u672C\u6B21\u4E0D\u4F1A\u91CD\u53D1\u3002" });
    return { acknowledged: true };
  }
  list() {
    return this.jobs().map((job) => ({ ...job, nextRunAt: nextRun(job, this.now()), runs: [...new Map([...this.pending(job.id), ...this.recent(job.id)].map((r) => [r.day, r])).values()].sort((a, b) => b.day.localeCompare(a.day)) }));
  }
  async save(input) {
    const { id, name, threadRef, prompt, time, status = "ACTIVE", providerId = "custom", model = "qwen3.8-27b", effort = "xhigh" } = input;
    this.jobFile(id);
    const threadId = existingThreadId(threadRef), selection = requireSelection(this.read(), providerId, model);
    if (typeof name !== "string" || !name.trim() || name.length > 100) throw new Error("\u4EFB\u52A1\u540D\u79F0\u9700\u8981 1\u2013100 \u4E2A\u5B57\u7B26\u3002");
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 12e3) throw new Error("\u4EFB\u52A1\u63D0\u793A\u8BCD\u9700\u8981 1\u201312000 \u4E2A\u5B57\u7B26\u3002");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time || "")) throw new Error("\u8BF7\u9009\u62E9\u6709\u6548\u7684\u6BCF\u65E5\u6267\u884C\u65F6\u95F4\u3002");
    if (!["ACTIVE", "PAUSED"].includes(status) || !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(effort)) throw new Error("\u65E0\u6548\u7684\u4EFB\u52A1\u72B6\u6001\u6216\u601D\u8003\u5F3A\u5EA6\u3002");
    const thread = await this.rpc(async (c) => (await c.request("thread/read", { threadId, includeTurns: false })).thread);
    if (thread?.id !== threadId || thread.modelProvider !== providerId) throw new Error("\u4EFB\u52A1\u76EE\u6807\u4F1A\u8BDD\u7684\u4F9B\u5E94\u5546\u4E0D\u4E00\u81F4\uFF0C\u672A\u4FDD\u5B58\u3002");
    if (status === "ACTIVE" && this.jobs().some((j) => j.id !== id && j.status === "ACTIVE" && j.threadId === threadId && j.time === time && j.prompt === prompt.trim())) throw new Error("\u8FD9\u4E2A\u4F1A\u8BDD\u5DF2\u6709\u76F8\u540C\u65F6\u95F4\u548C\u63D0\u793A\u8BCD\u7684\u542F\u7528\u4EFB\u52A1\uFF0C\u8BF7\u7F16\u8F91\u5DF2\u6709\u4EFB\u52A1\u3002");
    const old = import_node_fs4.default.existsSync(this.jobFile(id)) ? this.readJob(id) : null;
    const job = { id, name: name.trim(), threadId, title: thread.name || thread.title || name.trim(), prompt: prompt.trim(), time, timeZone: "Asia/Shanghai", status, providerId, model: selection.model, effort, revision: (0, import_node_crypto2.randomUUID)(), activeSince: this.now(), createdAt: old?.createdAt || this.now(), updatedAt: this.now() };
    atomicJson(this.jobFile(id), job);
    return { ...job, nextRunAt: nextRun(job, this.now()) };
  }
  setStatus(id, status) {
    if (!["ACTIVE", "PAUSED"].includes(status)) throw new Error("\u65E0\u6548\u7684\u4EFB\u52A1\u72B6\u6001\u3002");
    const job = { ...this.readJob(id), status, revision: (0, import_node_crypto2.randomUUID)(), updatedAt: this.now() };
    atomicJson(this.jobFile(id), job);
    return job;
  }
};
async function tickSchedules(store, { now = Date.now(), dispatch, observe = async () => null } = {}) {
  const day = localDay(now), jobs = store.jobs();
  for (const job of jobs) {
    for (const old of store.recent(job.id).filter((r) => r.status === "waiting" && now - r.scheduledFor > GRACE_MS)) store.saveRun({ ...old, status: "missed", note: "\u7B49\u5F85\u7A97\u53E3\u5DF2\u7ED3\u675F\uFF0C\u672C\u6B21\u5DF2\u8DF3\u8FC7\u3002" });
    for (const run2 of store.pending(job.id).filter((r) => r.status === "accepted")) {
      try {
        const result = await observe(job, run2);
        if (result) {
          store.saveRun({ ...run2, ...result });
          if (result.status === "model_mismatch") store.setStatus(job.id, "PAUSED");
        }
      } catch {
      }
    }
    const current = store.readJob(job.id);
    if (current.revision !== job.revision || current.status !== "ACTIVE") continue;
    const previousDay = localDay(now - 864e5), previousDue = scheduledTime(job, previousDay), activeSince = job.activeSince || job.createdAt;
    if (job.status === "ACTIVE" && activeSince < previousDue && !store.run(job.id, previousDay)) store.saveRun({ ...store.claim(job, previousDay), status: "missed", note: "\u7535\u8111\u6216\u540E\u53F0\u670D\u52A1\u672A\u5728\u7B49\u5F85\u7A97\u53E3\u5185\u6267\u884C\uFF0C\u672C\u6B21\u5DF2\u8DF3\u8FC7\uFF0C\u4E0D\u4F1A\u8865\u8DD1\u3002" });
    const due = scheduledTime(job, day);
    if (job.status !== "ACTIVE" || now < due || activeSince > due) continue;
    let run = store.run(job.id, day);
    if (run && run.status !== "waiting") continue;
    if (now - due > GRACE_MS) {
      if (!run) run = store.claim(job, day);
      store.saveRun({ ...run, status: "missed", note: "\u8D85\u8FC7 15 \u5206\u949F\u7B49\u5F85\u7A97\u53E3\uFF0C\u5DF2\u8DF3\u8FC7\uFF1B\u4E0D\u4F1A\u8865\u8DD1\u65E7\u4EFB\u52A1\u3002" });
      continue;
    }
    run ??= store.claim(job, day);
    const blocking = jobs.some((j) => j.threadId === job.threadId && store.pending(j.id).length > 0);
    if (blocking) continue;
    let submitted = false;
    const beforeSubmit = () => {
      const fresh = store.readJob(job.id);
      if (fresh.status !== "ACTIVE" || fresh.revision !== job.revision || fresh.updatedAt !== job.updatedAt) throw new Error("\u4EFB\u52A1\u5DF2\u6682\u505C\u6216\u4FEE\u6539\uFF0C\u672C\u6B21\u5C1A\u672A\u53D1\u9001\u3002");
      submitted = true;
      run = { ...run, status: "submitting", submittedAt: now };
      store.saveRun(run);
    };
    try {
      const result = await dispatch(job, run, beforeSubmit);
      if (!submitted) throw new Error("\u53D1\u9001\u5165\u53E3\u672A\u6301\u4E45\u5316\u63D0\u4EA4\u6807\u8BB0\u3002");
      store.saveRun({ ...run, ...result, status: result.turnId ? "accepted" : "unknown", note: result.turnId ? "\u684C\u9762\u5DF2\u63A5\u6536\uFF0C\u7B49\u5F85\u8FD0\u884C\u5B8C\u6210\u3002" : "\u684C\u9762\u672A\u8FD4\u56DE\u56DE\u5408 ID\uFF0C\u7ED3\u679C\u5F85\u6838\u5BF9\uFF1B\u4E0D\u4F1A\u81EA\u52A8\u91CD\u53D1\u3002" });
    } catch (error) {
      store.saveRun({ ...run, status: submitted ? "unknown" : "waiting", note: submitted ? "\u53D1\u9001\u7ED3\u679C\u672A\u77E5\uFF0C\u8BF7\u68C0\u67E5\u539F\u4F1A\u8BDD\uFF1B\u4E0D\u4F1A\u81EA\u52A8\u91CD\u53D1\u3002" : error.message });
    }
  }
}

// src/scheduler-runtime.mjs
var import_node_path5 = __toESM(require("node:path"), 1);
var import_node_crypto3 = require("node:crypto");
var schedulerPipe = () => process.platform === "win32" ? "\\\\.\\pipe\\codex-model-switcher-scheduler-" + (0, import_node_crypto3.createHash)("sha256").update(import_node_path5.default.resolve(scheduleDirectory()).toLowerCase()).digest("hex").slice(0, 16) : import_node_path5.default.join(scheduleDirectory(), "worker.sock");

// src/scheduled-turn.mjs
var import_node_crypto4 = require("node:crypto");
var import_node_fs5 = __toESM(require("node:fs"), 1);
var import_node_readline3 = require("node:readline");
var import_promises2 = require("node:timers/promises");
function scheduledTurnRequest(job, run) {
  return {
    threadId: job.threadId,
    clientUserMessageId: run.clientUserMessageId || (0, import_node_crypto4.randomUUID)(),
    input: [{ type: "text", text: `[\u63D2\u4EF6\u5B9A\u65F6\u4EFB\u52A1\uFF1A${job.name} \xB7 ${run.day} ${job.time} \u5317\u4EAC\u65F6\u95F4]
${job.prompt}`, text_elements: [] }],
    model: job.model,
    effort: job.effort,
    collaborationMode: { mode: "default", settings: { model: job.model, reasoning_effort: job.effort, developer_instructions: null } }
  };
}
async function scheduledPreflight(job, { rpc = withAppServer } = {}) {
  return rpc(async (c) => {
    const thread = (await c.request("thread/read", { threadId: job.threadId, includeTurns: false })).thread;
    if (thread.id !== job.threadId || thread.modelProvider !== job.providerId) throw new Error("\u4F1A\u8BDD\u4F9B\u5E94\u5546\u5DF2\u6539\u53D8\uFF0C\u672C\u6B21\u5C1A\u672A\u53D1\u9001\u3002");
    const turns = await c.request("thread/turns/list", { threadId: job.threadId, limit: 1, itemsView: "notLoaded" });
    if (thread.status?.type === "active" || turns.data?.some((t) => t.status === "inProgress")) throw new Error("\u4F1A\u8BDD\u6B63\u5728\u8FD0\u884C\uFF0C\u7B49\u5F85\u7A7A\u95F2\u540E\u518D\u53D1\u9001\u3002");
    const history = await historyModel(thread);
    if (history.status !== "recorded") throw new Error("\u65E0\u6CD5\u6838\u5BF9\u5386\u53F2\u4E0A\u4E0B\u6587\u6A21\u578B\uFF0C\u8BF7\u5148\u6253\u5F00\u4F1A\u8BDD\u68C0\u67E5\u3002");
    if (history.model !== job.model) throw new Error(`\u5386\u53F2\u4E0A\u4E0B\u6587\u4ECD\u662F ${history.model}\uFF1B\u8BF7\u5728\u539F\u4F1A\u8BDD\u5207\u6362\u6A21\u578B\u5E76\u6267\u884C /compact \u540E\u518D\u542F\u7528\u3002`);
    return thread;
  });
}
async function dispatchScheduled(job, run, beforeSubmit, { rpc = withAppServer, Reader = DesktopReader, open = openThread, read = readConfig, sleep = import_promises2.setTimeout } = {}) {
  requireSelection(read(), job.providerId, job.model);
  await scheduledPreflight(job, { rpc });
  const reader = new Reader({ timeoutMs: 12e3 });
  try {
    await reader.connect();
    let settings = await reader.settings(job.threadId);
    if (!settings) {
      await open(job.threadId);
      for (let i = 0; i < 40 && !settings; i++) {
        await sleep(500);
        settings = await reader.settings(job.threadId);
      }
    }
    if (settings?.resumeState !== "resumed") throw new Error("Codex \u5C1A\u672A\u5B8C\u6210\u52A0\u8F7D\u76EE\u6807\u4F1A\u8BDD\uFF0C\u672C\u6B21\u5C1A\u672A\u53D1\u9001\u3002");
    await reader.setModel(job.threadId, job.providerId, job.model, job.effort, { verifiedStoredProvider: job.providerId });
    await scheduledPreflight(job, { rpc });
    const owner = await reader.request("thread-owner-discovery", { hostId: "local", conversationId: job.threadId });
    if (owner.resultType !== "success" || !owner.handledByClientId) throw new Error("\u76EE\u6807\u4F1A\u8BDD\u672A\u8FDE\u63A5\uFF0C\u672C\u6B21\u5C1A\u672A\u53D1\u9001\u3002");
    beforeSubmit();
    const result = await reader.request("thread-follower-start-turn", { conversationId: job.threadId, turnStart: { request: scheduledTurnRequest(job, run), context: { inheritThreadSettings: true } } }, { targetClientId: owner.handledByClientId });
    if (result.resultType !== "success") throw new Error("\u684C\u9762\u672A\u786E\u8BA4\u5B9A\u65F6\u6D88\u606F\u3002");
    return { turnId: result.result?.result?.turn?.id || null, requestedModel: job.model, requestedEffort: job.effort };
  } finally {
    reader.close();
  }
}
async function observeScheduled(job, run, { rpc = withAppServer } = {}) {
  return rpc(async (c) => {
    const page = await c.request("thread/turns/list", { threadId: job.threadId, limit: 30, itemsView: "notLoaded" });
    const turn = page.data?.find((t) => t.id === run.turnId);
    if (!turn || turn.status === "inProgress") return null;
    if (turn.status !== "completed") return { status: turn.status, note: "\u5B9A\u65F6\u56DE\u5408\u672A\u6210\u529F\u5B8C\u6210\uFF0C\u8BF7\u6253\u5F00\u539F\u4F1A\u8BDD\u67E5\u770B\u9519\u8BEF\u3002" };
    const { thread } = await c.request("thread/read", { threadId: job.threadId, includeTurns: false });
    let model, effort;
    if (thread.path && import_node_fs5.default.statSync(thread.path).size <= 128 * 1024 * 1024) {
      const input = import_node_fs5.default.createReadStream(thread.path, { encoding: "utf8", signal: AbortSignal.timeout(5e3) }), lines = (0, import_node_readline3.createInterface)({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (!line.includes(run.turnId) || !line.includes("turn_context")) continue;
          let d;
          try {
            d = JSON.parse(line);
          } catch {
            continue;
          }
          if (d.type === "turn_context" && d.payload?.turn_id === run.turnId) {
            model = d.payload.model;
            effort = d.payload.effort;
          }
        }
      } finally {
        lines.close();
        input.destroy();
      }
    }
    const expectedModel = run.requestedModel || job.model, expectedEffort = run.requestedEffort || job.effort;
    if (model && model !== expectedModel || effort && effort !== expectedEffort) return { status: "model_mismatch", observedModel: model || null, observedEffort: effort || null, note: "\u5B9E\u9645\u56DE\u5408\u6A21\u578B\u6216\u5F3A\u5EA6\u4E0E\u63D0\u4EA4\u8BBE\u7F6E\u4E0D\u4E00\u81F4\uFF0C\u4EFB\u52A1\u5DF2\u6682\u505C\u3002" };
    const verified = model === expectedModel && effort === expectedEffort;
    return { status: verified ? "completed_verified" : "completed_unverified", observedModel: model || null, observedEffort: effort || null, note: verified ? "\u56DE\u5408\u5DF2\u5B8C\u6210\uFF0C\u5386\u53F2\u8BB0\u5F55\u4E2D\u7684\u6A21\u578B\u548C\u5F3A\u5EA6\u5DF2\u6838\u5BF9\u3002" : "\u56DE\u5408\u5DF2\u5B8C\u6210\uFF0C\u4F46\u5B9E\u9645\u6A21\u578B\u6216\u5F3A\u5EA6\u8BB0\u5F55\u6682\u65E0\u6CD5\u6838\u5BF9\u3002" };
  });
}

// src/scheduler-worker.mjs
async function main() {
  const store = new ScheduleStore(), tokenFile = import_node_path6.default.join(scheduleDirectory(), "control.key");
  const token = import_node_fs6.default.readFileSync(tokenFile, "utf8");
  let stopping = false, working = false;
  const server = import_node_net2.default.createServer((socket) => {
    socket.setTimeout(2e3, () => socket.destroy());
    let data = "";
    socket.on("error", () => {
    });
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.length > 4096) return socket.destroy();
      if (!data.includes("\n")) return;
      let request;
      try {
        request = JSON.parse(data);
      } catch {
        return socket.destroy();
      }
      if (request.command === "stop") {
        const received = Buffer.from(request.token || ""), expected = Buffer.from(token);
        if (received.length !== expected.length || !(0, import_node_crypto5.timingSafeEqual)(received, expected)) return socket.destroy();
        stopping = true;
      }
      socket.end(JSON.stringify({ running: true, version: SCHEDULER_VERSION, pid: process.pid, working, stopping }) + "\n");
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(schedulerPipe(), resolve);
    });
  } catch (error) {
    if (error.code === "EADDRINUSE") return;
    throw error;
  }
  server.on("error", () => {
    stopping = true;
  });
  process.on("SIGTERM", () => {
    stopping = true;
  });
  process.on("SIGINT", () => {
    stopping = true;
  });
  while (!stopping) {
    working = true;
    try {
      await tickSchedules(store, { dispatch: dispatchScheduled, observe: observeScheduled });
      atomicJson(import_node_path6.default.join(scheduleDirectory(), "health.json"), { pid: process.pid, version: SCHEDULER_VERSION, heartbeatAt: Date.now() });
    } catch {
      atomicJson(import_node_path6.default.join(scheduleDirectory(), "health.json"), { pid: process.pid, version: SCHEDULER_VERSION, heartbeatAt: Date.now(), error: "\u5B9A\u65F6\u670D\u52A1\u68C0\u67E5\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u63D2\u4EF6\u8FD0\u884C\u8BB0\u5F55\u3002" });
    }
    working = false;
    for (let i = 0; i < 15 && !stopping; i++) await (0, import_promises3.setTimeout)(1e3);
  }
  await new Promise((resolve) => server.close(resolve));
}
main().catch(() => {
  process.exitCode = 1;
});
/*! Bundled license information:

smol-toml/dist/error.js:
smol-toml/dist/primitive.js:
smol-toml/dist/date.js:
smol-toml/dist/extract.js:
smol-toml/dist/util.js:
smol-toml/dist/struct.js:
smol-toml/dist/parse.js:
smol-toml/dist/stringify.js:
smol-toml/dist/index.js:
  (*!
   * Copyright (c) Squirrel Chat et al., All rights reserved.
   * SPDX-License-Identifier: BSD-3-Clause
   *
   * Redistribution and use in source and binary forms, with or without
   * modification, are permitted provided that the following conditions are met:
   *
   * 1. Redistributions of source code must retain the above copyright notice, this
   *    list of conditions and the following disclaimer.
   * 2. Redistributions in binary form must reproduce the above copyright notice,
   *    this list of conditions and the following disclaimer in the
   *    documentation and/or other materials provided with the distribution.
   * 3. Neither the name of the copyright holder nor the names of its contributors
   *    may be used to endorse or promote products derived from this software without
   *    specific prior written permission.
   *
   * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
   * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
   * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
   * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
   * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
   * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
   * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
   * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
   * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
   * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
   *)
*/
