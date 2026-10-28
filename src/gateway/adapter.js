'use strict';
/*
 * Cursor agent-turn adapter.
 *
 * Input : AgentClientMessage.run_request (protobuf, Connect-framed)
 * Output: AgentServerMessage frames carrying InteractionUpdate events
 *
 * Field numbers are taken from Cursor 3.27.22 (agent.v1.*), see app-js-3.27.22.
 */
const zlib = require('zlib');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SESSIONS_DIR_DEFAULT = path.join(__dirname, 'sessions');
let SESSIONS_DIR = SESSIONS_DIR_DEFAULT;
const MAX_SESSION_MESSAGES = 60;
const MAX_SESSION_CHARS = 400000;

/* ---------------- protobuf primitives ---------------- */
function rv(buf, i) {
  let shift = 0;
  let val = 0;
  while (true) {
    if (i >= buf.length) throw new RangeError('eof');
    const c = buf[i++];
    val |= (c & 0x7f) << shift;
    if (!(c & 0x80)) return [val, i];
    shift += 7;
  }
}

function readFields(buf) {
  const out = [];
  if (!buf || !Buffer.isBuffer(buf)) return out;
  let i = 0;
  while (i < buf.length) {
    let key;
    try { [key, i] = rv(buf, i); } catch (_) { break; }
    const no = key >>> 3;
    const wire = key & 7;
    if (wire === 0) {
      let v; try { [v, i] = rv(buf, i); } catch (_) { break; }
      out.push({ no, wire, value: v });
    } else if (wire === 2) {
      let len; try { [len, i] = rv(buf, i); } catch (_) { break; }
      if (i + len > buf.length) break;
      out.push({ no, wire, value: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 5) {
      out.push({ no, wire, value: buf.subarray(i, i + 4) }); i += 4;
    } else if (wire === 1) {
      out.push({ no, wire, value: buf.subarray(i, i + 8) }); i += 8;
    } else {
      break;
    }
  }
  return out;
}

function one(buf, no, wire = 2) {
  if (!buf || !Buffer.isBuffer(buf)) return undefined;
  const f = readFields(buf).find((x) => x.no === no && x.wire === wire);
  return f ? f.value : undefined;
}

function str(buf, no) {
  if (!buf || !Buffer.isBuffer(buf)) return undefined;
  const v = one(buf, no);
  return v === undefined ? undefined : v.toString('utf8');
}

/* ---------------- Connect framing ---------------- */
function varint(n) {
  const out = [];
  let v = n >>> 0;
  while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
  out.push(v);
  return Buffer.from(out);
}

function tag(field, wire) {
  return varint((field << 3) | wire);
}

function ld(field, buf) {
  return Buffer.concat([tag(field, 2), varint(buf.length), buf]);
}

function vi(field, n) {
  return Buffer.concat([tag(field, 0), varint(n)]);
}

function frame(payload, flags = 0) {
  const head = Buffer.alloc(5);
  head[0] = flags;
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

/* ---------------- server events ---------------- */
function textFrame(text) {
  const delta = ld(1, Buffer.from(text, 'utf8')); // TextDeltaUpdate{text}
  return frame(ld(1, ld(1, delta)));              // AgentServerMessage{interaction_update{text_delta}}
}

function thinkingFrame(text) {
  const delta = ld(1, Buffer.from(text, 'utf8')); // ThinkingDeltaUpdate{text}
  return frame(ld(1, ld(4, delta)));              // interaction_update{thinking_delta}
}

function thinkingCompletedFrame(ms) {
  const done = vi(1, Math.max(0, Math.round(ms))); // ThinkingCompletedUpdate{thinking_duration_ms}
  return frame(ld(1, ld(5, done)));                // interaction_update{thinking_completed}
}

function turnEndFrame() {
  const ended = Buffer.concat([vi(1, 0), vi(2, 0), vi(6, Date.now())]);
  return frame(ld(1, ld(14, ended)));
}

function endStreamFrame() {
  return frame(Buffer.from('{}'), 0x02);
}

function endStreamError(code, message) {
  return frame(Buffer.from(JSON.stringify({ error: { code, message } })), 0x02);
}

/* ---------------- tool bridge (exec_server_message) ----------------
 * AgentServerMessage.2 = exec_server_message
 *   ExecServerMessage: 1 id, 15 exec_id, then one args field:
 *     2 shell_args, 3 write_args, 7 read_args
 * AgentClientMessage.2 = exec_client_message carries the result.
 */
const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file from the workspace. Returns the file contents.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or workspace-relative file path' },
          offset: { type: 'integer', description: '1-based line offset' },
          limit: { type: 'integer', description: 'Maximum number of lines' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write complete contents to a file, creating or overwriting it. Use edit_file for small changes.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace an exact string in a file with new text. Fails if the old text is not found or is ambiguous.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string', description: 'Exact text to replace, including indentation' },
          new_string: { type: 'string', description: 'Replacement text' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_terminal',
      description: 'Run a shell command in the workspace and return stdout, stderr and the exit code.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          working_directory: { type: 'string' },
          description: { type: 'string', description: 'Short human-readable purpose' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file from the workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ls',
      description: 'List the direct children of a directory.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Defaults to the workspace root' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Find files by glob pattern, e.g. "**/*.ts" or "src/**/*.jsx".',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: 'Directory to search from' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents with a regular expression. Returns file:line matches.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: 'Directory or file to search' },
          glob: { type: 'string', description: 'Restrict to matching files, e.g. "**/*.ts"' },
          case_insensitive: { type: 'boolean' },
          head_limit: { type: 'integer', description: 'Maximum matches, default 100' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch a URL and return its readable text content.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_lints',
      description: 'Read compiler/linter diagnostics for a file or the whole workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Optional file or directory' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description: 'Create or update the visible task list. Use status pending, in_progress, completed or cancelled. The list is UI state, not a file — never create a file for it. Pass an empty todos array to clear it when the work is finished.',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                content: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
              },
              required: ['content', 'status'],
            },
          },
          merge: { type: 'boolean', description: 'Merge into the existing list instead of replacing it' },
        },
        required: ['todos'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task',
      description: 'Spawn a subagent to work on an independent task. Use for parallel exploration or implementation where the work can be delegated without blocking. The subagent runs in the same workspace and returns its final report.',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Short 3-5 word description of the task' },
          prompt: { type: 'string', description: 'Complete, self-contained instructions for the subagent' },
          subagent_type: {
            type: 'string',
            enum: ['generalPurpose', 'explore'],
            description: 'generalPurpose for implementation/research; explore for read-only codebase exploration',
          },
          readonly: { type: 'boolean', description: 'Restrict the subagent to read-only tools' },
        },
        required: ['description', 'prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_question',
      description: 'Ask the user a structured question with options and wait for their answer. Use for clarifications you cannot resolve from the code.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          questions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                prompt: { type: 'string' },
                options: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { id: { type: 'string' }, label: { type: 'string' } },
                    required: ['id', 'label'],
                  },
                },
                allow_multiple: { type: 'boolean' },
              },
              required: ['prompt', 'options'],
            },
          },
        },
        required: ['questions'],
      },
    },
  },
];
const MODE_NAMES = {
  0: 'AGENT', 1: 'AGENT', 2: 'ASK', 3: 'PLAN', 4: 'DEBUG',
  5: 'TRIAGE', 6: 'SPEC', 7: 'MULTITASK', 8: 'CUSTOM',
};

function modePrompt(mode) {
  switch (mode) {
    case 'ASK':
      return [
        'Ask mode is active. The user wants answers about their codebase or coding in general.',
        'You MUST NOT make edits, run non-readonly tools, change configs, or commit. This overrides any other instruction.',
        'Use read-only tools (read, ls, glob, grep, diagnostics) to ground your answer.',
        'Answer comprehensively, cite specific file paths and line numbers, and say so when something is not in the codebase.',
      ].join(' ');
    case 'PLAN':
      return [
        'Plan mode is active. Produce a concrete, ordered plan; do not execute it.',
        'You MUST NOT make edits or run non-readonly tools until the user explicitly and unambiguously asks to execute.',
        'Treat actionable statements ("let us do X", "implement Y") as plan iteration unless they clearly refer to executing the existing plan.',
        'Use read-only tools to ground the plan in the real code. Keep the todo list current.',
      ].join(' ');
    case 'SPEC':
      return [
        'Spec mode is active. Produce a structured specification with implementation steps.',
        'Do not modify files or run non-readonly tools. Investigate with read-only tools first.',
      ].join(' ');
    case 'DEBUG':
      return [
        'Debug mode is active. Debug with runtime evidence, not code-only guesses.',
        'Reproduce the problem, gather logs and traces, find the root cause, fix it, then verify end to end.',
        'Keep instrumentation until verification proves the fix. Prefer reproduction and real runs over unit tests.',
      ].join(' ');
    case 'TRIAGE':
      return [
        'Triage mode is active. Classify the work, break it into parallel tasks, and coordinate them.',
        'Keep the todo list current and delegate independent work with the task tool where possible.',
      ].join(' ');
    case 'MULTITASK':
      return [
        'Multitask mode is active. Run and coordinate multiple tasks in parallel.',
        'Keep the todo list current; use the task tool for independent work instead of serialising it.',
      ].join(' ');
    default:
      return 'Agent mode: plan, search, make edits and run commands to complete the task. Delegate independent work with the task tool when it saves time.';
  }
}

function shellPrompt() {
  const override = process.env.CURSOR_PROXY_SHELL;
  const dialect = override || (process.platform === 'win32' ? 'powershell' : 'posix');
  if (dialect === 'powershell') {
    return 'Terminal: Windows PowerShell. Use PowerShell syntax; `&&` and `||` are not valid in PowerShell 5.1, use `;`. Prefer the ls/glob/grep tools over shell equivalents (`grep`, `wc`, `head` may not exist).';
  }
  return 'Terminal: POSIX shell (bash). Standard `&&`, pipes and coreutils are available.';
}

function toolsForMode(mode, extra = [], opts = {}) {
  const readOnly = ['read_file', 'ls', 'glob', 'grep', 'web_fetch', 'read_lints'];
  let list;
  if (mode === 'ASK') {
    list = TOOL_DEFS.filter((t) => readOnly.includes(t.function.name));
  } else if (mode === 'PLAN' || mode === 'SPEC') {
    const allowed = [...readOnly, 'todo_write', 'ask_question'];
    list = TOOL_DEFS.filter((t) => allowed.includes(t.function.name));
  } else {
    list = TOOL_DEFS.filter((t) => !(opts.isSubagent && t.function.name === 'task'));
    if (Array.isArray(extra) && extra.length) list.push(...extra);
  }
  return list;
}

/** Resolve the real Cursor workspace instead of the proxy's own cwd. */
function inferWorkspace() {
  const env = process.env.CURSOR_PROXY_WORKSPACE;
  if (env) return env;
  try {
    const fs = require('fs');
    const pathMod = require('path');
    const base = pathMod.join(
      process.env.APPDATA || pathMod.join(process.env.USERPROFILE || '', 'AppData', 'Roaming'),
      'Cursor', 'User', 'workspaceStorage',
    );
    const items = fs.readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const f = pathMod.join(base, d.name, 'workspace.json');
        try {
          const st = fs.statSync(f);
          const j = JSON.parse(fs.readFileSync(f, 'utf8'));
          return { t: st.mtimeMs, folder: j.folder || j.workspace };
        } catch (_) { return null; }
      })
      .filter((x) => x && x.folder && x.folder.startsWith('file://'))
      .sort((a, b) => b.t - a.t);

    for (const it of items) {
      let p = decodeURIComponent(it.folder.replace(/^file:\/{2,3}/, ''));
      p = p.replace(/\//g, '\\');
      if (/^[a-zA-Z]:/.test(p) && fs.existsSync(p)) return p;
    }
  } catch (_) { /* fall through */ }
  return process.cwd();
}

let WORKSPACE = inferWorkspace();
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cursor', '.cache', 'target', 'vendor']);
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|mdx|css|scss|sass|less|html|htm|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|ps1|bat|yml|yaml|toml|ini|env|txt|sql|graphql|prisma|vue|svelte)$/i;

function resolvePath(p) {
  const pathMod = require('path');
  if (!p || typeof p !== 'string') return WORKSPACE;
  return pathMod.isAbsolute(p) ? pathMod.normalize(p) : pathMod.resolve(WORKSPACE, p);
}

function insideWorkspace(p) {
  if (process.env.CURSOR_PROXY_ALLOW_OUTSIDE === '1') return true;
  const pathMod = require('path');
  const rel = pathMod.relative(WORKSPACE, p);
  return !!rel && !rel.startsWith('..') && !pathMod.isAbsolute(rel) || rel === '';
}

function globToRegExp(glob) {
  let g = String(glob).replace(/\\/g, '/');
  let out = '^';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { out += '.*'; i++; if (g[i + 1] === '/') i++; }
      else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if ('\\^$+.()|{}[]'.includes(c)) out += '\\' + c;
    else out += c;
  }
  return new RegExp(out + '$');
}

async function* walkAsync(dir, depth = 0) {
  const fs = require('fs');
  const pathMod = require('path');
  if (depth > 12) return;
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.env') continue;
    const full = pathMod.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walkAsync(full, depth + 1);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

const yieldToLoop = () => new Promise((r) => setImmediate(r));

/** Fallback shell: Cursor's terminal daemon can fail to spawn (e.g. no bash). */
function localShell(command, cwd) {
  const { execFile } = require('child_process');
  const dir = cwd ? resolvePath(cwd) : WORKSPACE;
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', String(command || '')],
      { cwd: dir, timeout: 60000, maxBuffer: 5 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err && typeof err.code === 'number' ? err.code : (err ? 1 : 0);
        const out = [stdout || '', stderr || ''].filter(Boolean).join('\n').trim();
        resolve(`exit_code=${code}\n${out}`.trim());
      },
    );
  });
}

async function localTool(name, a) {
  const fs = require('fs');
  const pathMod = require('path');

  if (name === 'ls') {
    const dir = resolvePath(a.path);
    if (!insideWorkspace(dir)) return `ERROR: path is outside the workspace (${WORKSPACE}): ${dir}`;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch (e) { return `ERROR: cannot list ${dir}: ${e.code || e.message}`; }
    const lines = entries.slice(0, 300).map((e) => (e.isDirectory() ? 'dir  ' : 'file ') + e.name);
    return lines.length ? lines.join('\n') : '(empty directory)';
  }

  if (name === 'glob') {
    const root = resolvePath(a.path);
    if (!insideWorkspace(root)) return `ERROR: path is outside the workspace (${WORKSPACE}): ${root}`;
    const re = globToRegExp(a.pattern || '**/*');
    const out = [];
    for await (const file of walkAsync(root)) {
      const rel = pathMod.relative(root, file).replace(/\\/g, '/');
      if (re.test(rel)) out.push(rel);
      if (out.length >= 300) break;
      if (out.length % 50 === 0) await yieldToLoop();
    }
    return out.length ? out.join('\n') : '(no matches)';
  }

  if (name === 'grep') {
    const root = resolvePath(a.path);
    if (!insideWorkspace(root)) return `ERROR: path is outside the workspace (${WORKSPACE}): ${root}`;
    const flags = a.case_insensitive ? 'i' : '';
    let re;
    try { re = new RegExp(a.pattern, flags); } catch (e) { return 'ERROR: bad regex: ' + e.message; }
    const limit = Number(a.head_limit) || 100;
    const fileRe = a.glob ? globToRegExp(a.glob) : null;
    const out = [];
    const stat = await fs.promises.stat(root);
    const files = stat.isDirectory() ? walkAsync(root) : [root];
    let scanned = 0;
    for await (const file of files) {
      scanned++;
      if (scanned % 50 === 0) await yieldToLoop();
      if (fileRe) {
        const rel = pathMod.relative(root, file).replace(/\\/g, '/');
        if (!fileRe.test(rel)) continue;
      }
      if (!TEXT_EXT.test(file)) continue;
      let st;
      try { st = await fs.promises.stat(file); } catch (_) { continue; }
      if (st.size > 2 * 1024 * 1024) continue;
      let content;
      try { content = await fs.promises.readFile(file, 'utf8'); } catch (_) { continue; }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        const rel = pathMod.relative(root, file) || pathMod.basename(file);
        out.push(`${rel.replace(/\\/g, '/')}:${i + 1}: ${lines[i].trim().slice(0, 240)}`);
        if (out.length >= limit) return out.join('\n');
      }
    }
    return out.length ? out.join('\n') : '(no matches)';
  }

  if (name === 'web_fetch') {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    try {
      const res = await fetch(a.url, { signal: ac.signal, headers: { 'user-agent': 'cursor-local-proxy/1.0' } });
      const text = await res.text();
      const cleaned = text
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return `HTTP ${res.status}\n${cleaned.slice(0, 20000)}`;
    } catch (e) {
      return 'ERROR: ' + String(e && e.message ? e.message : e);
    } finally {
      clearTimeout(timer);
    }
  }

  return null;
}

/** Apply an exact-string edit locally and return the new file content. */
function applyEdit(a) {
  const fs = require('fs');
  const p = resolvePath(a.path);
  if (!insideWorkspace(p)) return { error: 'path is outside the workspace' };
  let content;
  try { content = fs.readFileSync(p, 'utf8'); } catch (e) { return { error: 'cannot read file: ' + e.message }; }
  const oldStr = String(a.old_string ?? '');
  const newStr = String(a.new_string ?? '');
  if (!oldStr) return { error: 'old_string must not be empty' };
  const count = content.split(oldStr).length - 1;
  if (count === 0) return { error: 'old_string not found in file' };
  if (count > 1 && !a.replace_all) return { error: `old_string appears ${count} times; pass replace_all or use more context` };
  const updated = a.replace_all ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
  return { content: updated, before: content, count: a.replace_all ? count : 1 };
}

/** Best-effort current file contents, for diff rendering. */
function readBefore(pathStr) {
  try {
    const fs = require('fs');
    const p = resolvePath(pathStr);
    if (!fs.existsSync(p)) return '';
    return fs.readFileSync(p, 'utf8');
  } catch (_) {
    return undefined;
  }
}

function execServerFrame(name, rawArgs, toolCallId, execId, idNum) {
  let a = {};
  if (rawArgs && typeof rawArgs === 'object') a = rawArgs;
  else {
    try { a = JSON.parse(rawArgs || '{}'); } catch (_) { a = {}; }
  }

  let body;
  if (name === 'read_file') {
    const parts = [ld(1, Buffer.from(String(a.path || ''))), ld(2, Buffer.from(toolCallId))];
    if (a.offset) parts.push(vi(4, Number(a.offset) || 0));
    if (a.limit) parts.push(vi(5, Number(a.limit) || 0));
    body = Buffer.concat([vi(1, idNum), ld(15, Buffer.from(execId)), ld(7, Buffer.concat(parts))]);
  } else if (name === 'write_file') {
    body = Buffer.concat([
      vi(1, idNum), ld(15, Buffer.from(execId)),
      ld(3, Buffer.concat([
        ld(1, Buffer.from(String(a.path || ''))),
        ld(2, Buffer.from(String(a.content || ''))),
        ld(3, Buffer.from(toolCallId)),
      ])),
    ]);
  } else if (name === 'run_terminal') {
    const parts = [ld(1, Buffer.from(String(a.command || ''))), ld(4, Buffer.from(toolCallId))];
    if (a.working_directory) parts.push(ld(2, Buffer.from(String(a.working_directory))));
    if (a.description) parts.push(ld(15, Buffer.from(String(a.description))));
    // Cursor's own shell args always carry a parsing result; omit it and the
    // exec daemon can fail to spawn.
    parts.push(ld(8, Buffer.alloc(0)));
    body = Buffer.concat([vi(1, idNum), ld(15, Buffer.from(execId)), ld(2, Buffer.concat(parts))]);
  } else if (name === 'delete_file') {
    body = Buffer.concat([
      vi(1, idNum), ld(15, Buffer.from(execId)),
      ld(4, Buffer.concat([
        ld(1, Buffer.from(String(a.path || ''))),
        ld(2, Buffer.from(toolCallId)),
      ])),
    ]);
  } else if (name === 'read_lints') {
    const p = a.path ? resolvePath(String(a.path)) : WORKSPACE;
    body = Buffer.concat([
      vi(1, idNum), ld(15, Buffer.from(execId)),
      ld(9, Buffer.concat([
        ld(1, Buffer.from(p)),
        ld(2, Buffer.from(toolCallId)),
      ])),
    ]);
  } else {
    throw new Error('unsupported tool: ' + name);
  }
  return frame(ld(2, body));
}

/** Parse an AgentClientMessage frame; returns null if it is not an exec result. */
function parseClientFrame(payload) {
  const exec = one(payload, 2);
  if (!exec) return null;
  return { id: one(exec, 1, 0) || 0, execId: str(exec, 15) || '', exec };
}

/** Turn an ExecClientMessage result into text the model can read. */
function execResultText(exec) {
  const read = one(exec, 7);
  if (read) {
    const ok = one(read, 1);
    if (ok) {
      const content = str(ok, 2) || '';
      const truncated = one(ok, 6, 0);
      return content + (truncated ? '\n[content truncated]' : '');
    }
    const err = one(read, 2);
    if (err) return 'ERROR: ' + (str(err, 1) || 'read failed');
    if (one(read, 4)) return 'ERROR: file not found';
    if (one(read, 5)) return 'ERROR: permission denied';
    return 'ERROR: read failed';
  }

  const shell = one(exec, 2);
  if (shell) {
    const ok = one(shell, 1) || one(shell, 2);
    if (ok) {
      const code = one(ok, 3, 0) || 0;
      const out = [str(ok, 5) || '', str(ok, 6) || ''].filter(Boolean).join('\n');
      return `exit_code=${code}\n${out}`.trim();
    }
    if (one(shell, 4)) return 'REJECTED: the user declined to run this command';
    if (one(shell, 3)) return 'TIMEOUT: command exceeded the time limit';
    const spawn = one(shell, 5);
    if (spawn) {
      const cmd = str(spawn, 1) || '';
      const err = str(spawn, 3) || 'unknown error';
      return `ERROR: spawn failed: ${err}${cmd ? ` (command: ${cmd})` : ''}`;
    }
    if (one(shell, 7)) return 'ERROR: permission denied';
    return 'ERROR: shell failed';
  }

  const write = one(exec, 3);
  if (write) {
    const ok = one(write, 1);
    if (ok) {
      return `wrote ${str(ok, 1) || ''} (${one(ok, 2, 0) || 0} lines)`;
    }
    if (one(write, 6)) return 'REJECTED: the user declined this write';
    if (one(write, 3)) return 'ERROR: permission denied';
    if (one(write, 4)) return 'ERROR: no space left';
    if (one(write, 5)) return 'ERROR: ' + (str(one(write, 5), 1) || 'write failed');
    return 'ERROR: write failed';
  }

  const del = one(exec, 4);
  if (del) {
    if (one(del, 1)) return 'deleted';
    if (one(del, 6)) return 'REJECTED: the user declined this deletion';
    if (one(del, 2)) return 'ERROR: file not found';
    if (one(del, 3)) return 'ERROR: not a file';
    if (one(del, 4)) return 'ERROR: permission denied';
    if (one(del, 5)) return 'ERROR: file busy';
    return 'ERROR: delete failed';
  }

  const diag = one(exec, 9);
  if (diag) {
    const ok = one(diag, 1);
    if (ok) {
      const p = str(ok, 1) || '';
      const total = one(ok, 3, 0) || 0;
      const sev = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' };
      const lines = readFields(ok)
        .filter((f) => f.no === 2 && f.wire === 2)
        .map((f) => {
          const d = f.value;
          const s = sev[one(d, 1, 0) || 0] || 'info';
          const msg = str(d, 3) || '';
          const src = str(d, 4) || '';
          const code = str(d, 5) || '';
          return `- ${s}: ${msg}${src ? ` [${src}]` : ''}${code ? ` (${code})` : ''}`;
        });
      return `${p || '(workspace)'} - ${total} diagnostic${total === 1 ? '' : 's'}\n${lines.join('\n') || '(none)'}`;
    }
    const err = one(diag, 2);
    if (err) return 'ERROR: ' + [str(err, 1), str(err, 2)].filter(Boolean).join(' ');
    if (one(diag, 4)) return 'ERROR: file not found';
    if (one(diag, 5)) return 'ERROR: permission denied';
    return 'ERROR: diagnostics failed';
  }

  const mcp = one(exec, 11);
  if (mcp) {
    const ok = one(mcp, 1);
    if (ok) {
      const texts = readFields(ok)
        .filter((f) => f.no === 1 && f.wire === 2)
        .map((f) => {
          const textBlock = one(f.value, 1);
          return (textBlock && str(textBlock, 1)) || '';
        })
        .filter(Boolean);
      const isErr = one(ok, 2, 0);
      return (isErr ? 'MCP error: ' : '') + (texts.join('\n') || '(no content)');
    }
    const err = one(mcp, 2);
    if (err) return 'MCP ERROR: ' + (str(err, 1) || 'unknown error');
    if (one(mcp, 3)) {
      const rej = one(mcp, 3);
      return 'REJECTED: ' + (str(rej, 1) || 'the user declined this MCP tool call');
    }
    if (one(mcp, 4)) return 'ERROR: MCP permission denied';
    if (one(mcp, 5)) return 'ERROR: MCP tool not found';
    if (one(mcp, 6)) return 'ERROR: MCP server not found';
    return 'MCP result: ok';
  }

  const sub = one(exec, 28);
  if (sub) {
    const ok = one(sub, 1);
    if (ok) {
      const msg = str(ok, 2) || '';
      return msg.trim() || '(subagent finished without a final message)';
    }
    const err = one(sub, 2);
    if (err) return 'ERROR: ' + (str(err, 2) || 'subagent failed');
    return 'ERROR: subagent result was empty';
  }

  return 'ERROR: unsupported tool result';
}

function nextFrame(buf) {
  return firstFrame(buf);
}

/* ---------------- MCP bridge ----------------
 * run_request.4 mcp_tools -> McpToolDefinition{1 name,2 description,4 provider,5 tool_name,6 input_schema_json}
 * exec_server_message.11 mcp_args -> McpArgs{1 name,2 map<string,Value>,3 tool_call_id,4 provider,5 tool_name,9 server}
 */
function sanitizeToolName(s) {
  return String(s || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'mcp_tool';
}

function pbValue(v) {
  if (v === null || v === undefined) return vi(1, 0);
  if (typeof v === 'number') {
    const b = Buffer.alloc(8);
    b.writeDoubleBE(v);
    return Buffer.concat([tag(2, 1), b]);
  }
  if (typeof v === 'string') return ld(3, Buffer.from(v));
  if (typeof v === 'boolean') return vi(4, v ? 1 : 0);
  if (Array.isArray(v)) return ld(6, Buffer.concat(v.map((x) => ld(1, pbValue(x)))));
  if (typeof v === 'object') return ld(5, pbStruct(v));
  return ld(3, Buffer.from(String(v)));
}

function pbStruct(obj) {
  return Buffer.concat(Object.entries(obj).map(([k, v]) =>
    ld(1, Buffer.concat([ld(1, Buffer.from(k)), ld(2, pbValue(v))]))));
}

function cleanSchema(node) {
  if (Array.isArray(node)) return node.map(cleanSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (v === null || v === undefined) continue;
    if (k === 'type' && v === '') continue;
    out[k] = cleanSchema(v);
  }
  return out;
}

function sanitizeParameters(schema) {
  let s = cleanSchema(schema);
  if (!s || typeof s !== 'object' || Array.isArray(s)) s = {};
  if (s.type !== 'object') {
    if (s.properties || s.required) s.type = 'object';
    else s = { type: 'object', properties: {}, additionalProperties: true };
  }
  if (!s.properties || typeof s.properties !== 'object' || Array.isArray(s.properties)) {
    s.properties = {};
  }
  if (s.required && !Array.isArray(s.required)) delete s.required;
  return s;
}

function parseSchema(json) {
  let parameters;
  try {
    parameters = JSON.parse(json || '{}');
  } catch (_) {
    parameters = { type: 'object', properties: {}, additionalProperties: true };
  }
  return sanitizeParameters(parameters);
}

/* google.protobuf.Value -> JS, used when a descriptor carries the parsed
 * schema (field 4) instead of input_schema_json (field 5). */
function valueToJs(buf) {
  if (!buf) return undefined;
  for (const f of readFields(buf)) {
    if (f.no === 1) return null;
    if (f.no === 2 && Buffer.isBuffer(f.value) && f.value.length === 8) return f.value.readDoubleBE(0);
    if (f.no === 3) return f.value.toString('utf8');
    if (f.no === 4) return !!f.value;
    if (f.no === 5) return structToJs(f.value);
    if (f.no === 6) {
      return readFields(f.value)
        .filter((x) => x.no === 1 && x.wire === 2)
        .map((x) => valueToJs(x.value));
    }
  }
  return undefined;
}

function structToJs(buf) {
  const out = {};
  for (const f of readFields(buf)) {
    if (f.no !== 1 || f.wire !== 2) continue;
    const key = str(f.value, 1) || '';
    const val = one(f.value, 2);
    if (key) out[key] = valueToJs(val);
  }
  return out;
}

function schemaFromDescriptor(toolBuf) {
  const json = str(toolBuf, 5) || '';
  if (json.trim()) return parseSchema(json);
  const parsed = valueToJs(one(toolBuf, 4));
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  return parseSchema('');
}

function registerMcpTool(defs, map, name, description, provider, toolName, parameters, serverName) {
  const modelName = sanitizeToolName(`mcp__${provider || serverName || 'server'}__${toolName || name}`);
  if (map[modelName]) return;
  const params = sanitizeParameters(parameters);
  const required = Array.isArray(params.required)
    ? params.required.filter((x) => typeof x === 'string' && x.trim())
    : [];
  const base = description || `MCP tool ${toolName || name}`;
  const desc = required.length
    ? `${base}\nRequired arguments: ${required.join(', ')}.`
    : base;
  defs.push({
    type: 'function',
    function: {
      name: modelName,
      description: desc,
      parameters: params,
    },
  });
  map[modelName] = { name: name || toolName, provider, toolName: toolName || name, serverName };
}

function collectToolDefs(msg, fieldNo, defs, map) {
  if (!msg) return;
  for (const f of readFields(msg)) {
    if (f.no !== fieldNo || f.wire !== 2) continue;
    const d = f.value;
    const name = str(d, 1) || '';
    if (!name) continue;
    const description = str(d, 2) || '';
    const provider = str(d, 4) || '';
    const toolName = str(d, 5) || name;
    let parameters = parseSchema(str(d, 6));
    if (!str(d, 6) || !str(d, 6).trim()) {
      const parsed = valueToJs(one(d, 3));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) parameters = parsed;
    }
    registerMcpTool(defs, map, name, description, provider, toolName, parameters, '');
  }
}

/* RequestContext.34 mcp_meta_tool_options:
 *   McpMetaToolOptions{1 enabled, 2 mcp_descriptors}
 *   McpDescriptor{1 server_name, 2 server_identifier, 5 tools}
 *   McpToolDescriptor{1 tool_name, 3 description, 5 input_schema_json}
 * Cursor caps the directly-exposed tool list (request_context.tools) and puts
 * the full catalogue here for its GetMcpTools/CallMcpTool meta-tools. Since the
 * proxy answers the turn itself, it can expose the full catalogue directly.
 */
function collectCatalogTools(requestContext, defs, map) {
  const empty = { count: 0, descCount: 0, toolFields: [], descFields: [] };
  if (!requestContext) return empty;
  const sources = [
    { msg: one(requestContext, 34), field: 2, name: 'meta' },      // McpMetaToolOptions.mcp_descriptors
    { msg: one(requestContext, 23), field: 3, name: 'filesystem' } // McpFileSystemOptions.mcp_descriptors
  ];
  let count = 0;
  let descCount = 0;
  let descFields = [];
  let toolFields = [];
  for (const src of sources) {
    if (!src.msg) continue;
    for (const df of readFields(src.msg)) {
      if (df.no !== src.field || df.wire !== 2) continue;  // McpDescriptor
      descCount++;
      if (!descFields.length) {
        descFields = readFields(df.value).map((f) => ({ no: f.no, wire: f.wire, len: Buffer.isBuffer(f.value) ? f.value.length : undefined }));
      }
      const serverName = str(df.value, 1) || '';
      const serverId = str(df.value, 2) || serverName;
      for (const tf of readFields(df.value)) {
        if (tf.no !== 5 || tf.wire !== 2) continue;        // tools
        if (!toolFields.length) {
          toolFields = readFields(tf.value).map((f) => ({ no: f.no, wire: f.wire, len: Buffer.isBuffer(f.value) ? f.value.length : undefined }));
        }
        const toolName = str(tf.value, 1) || '';
        if (!toolName) continue;
        registerMcpTool(defs, map, toolName, str(tf.value, 3) || '',
          serverId, toolName, schemaFromDescriptor(tf.value), serverName);
        count++;
      }
    }
  }
  return { count, descCount, descFields, toolFields };
}

function parseMcpTools(run, requestContext) {
  const defs = [];
  const map = {};
  collectToolDefs(one(run, 4), 1, defs, map);          // run_request.mcp_tools
  collectToolDefs(requestContext, 7, defs, map);        // request_context.tools (direct)
  const catalog = collectCatalogTools(requestContext, defs, map);
  const providers = {};
  for (const meta of Object.values(map)) {
    const p = meta.provider || meta.serverName || 'server';
    providers[p] = (providers[p] || 0) + 1;
  }
  return {
    defs, map, providers,
    catalogCount: catalog.count,
    catalogDebug: {
      descCount: catalog.descCount,
      descFields: catalog.descFields,
      toolFields: catalog.toolFields,
    },
  };
}

function mcpArgsMsg(meta, argsObj, toolCallId, skipApproval) {
  const parts = [ld(1, Buffer.from(meta.name || ''))];
  for (const [k, v] of Object.entries(argsObj || {})) {
    parts.push(ld(2, Buffer.concat([ld(1, Buffer.from(k)), ld(2, pbValue(v))])));
  }
  parts.push(ld(3, Buffer.from(String(toolCallId || ''))));
  if (meta.provider) {
    parts.push(ld(4, Buffer.from(meta.provider)));
    parts.push(ld(9, Buffer.from(meta.provider)));
  }
  if (meta.toolName) parts.push(ld(5, Buffer.from(meta.toolName)));
  if (skipApproval) parts.push(vi(8, 1));
  return Buffer.concat(parts);
}

function mcpExecFrame(meta, argsObj, toolCallId, execId, idNum, skipApproval) {
  const body = Buffer.concat([
    vi(1, idNum),
    ld(15, Buffer.from(execId)),
    ld(11, mcpArgsMsg(meta, argsObj, toolCallId, skipApproval)),
  ]);
  return frame(ld(2, body)); // AgentServerMessage.exec_server_message{mcp_args}
}

function mcpResultMsg(resultText) {
  const text = String(resultText || '');
  if (/^REJECTED/.test(text)) {
    return ld(3, Buffer.concat([ld(1, Buffer.from(text))]));        // McpRejected{reason}
  }
  if (/^ERROR|^MCP ERROR|^MCP result: ERROR/.test(text)) {
    return ld(2, ld(1, Buffer.from(text)));                        // McpError{error}
  }
  const content = ld(1, ld(1, Buffer.from(text)));                  // content[0].text{text}
  return ld(1, ld(1, content));                                    // success.content[0]
}

function mcpToolCallMsg(meta, argsObj, callId, resultText, rawResult) {
  const inner = [ld(1, mcpArgsMsg(meta, argsObj, callId, false))];
  if (rawResult && Buffer.isBuffer(rawResult) && rawResult.length) {
    inner.push(ld(2, rawResult));                                  // pass through McpResult
  } else if (resultText !== undefined) {
    inner.push(ld(2, mcpResultMsg(resultText)));
  }
  const tool = ld(15, Buffer.concat(inner));                       // ToolCall.mcp_tool_call
  return Buffer.concat([ld(1, Buffer.from(String(callId || ''))), ld(2, tool)]);
}

function mcpToolStartedFrame(meta, argsObj, callId) {
  return frame(ld(1, ld(2, mcpToolCallMsg(meta, argsObj, callId))));
}

function mcpToolCompletedFrame(meta, argsObj, callId, resultText, rawResult) {
  return frame(ld(1, ld(3, mcpToolCallMsg(meta, argsObj, callId, resultText, rawResult))));
}

function execMcpResult(exec) {
  return one(exec, 11);
}

/* ---------------- subagents (task) ----------------
 * ToolCall.19 task_tool_call {1 args TaskArgs, 2 result TaskResult}
 * ExecServerMessage.28 subagent_args
 * ExecClientMessage.28 subagent_result
 */
function taskArgsMsg(a) {
  const parts = [
    ld(1, Buffer.from(String(a.description || ''))),
    ld(2, Buffer.from(String(a.prompt || ''))),
  ];
  // TaskArgs.3 subagent_type is a SubagentType oneof.
  if (a.subagent_type === 'explore') parts.push(ld(3, ld(4, Buffer.alloc(0))));
  else parts.push(ld(3, ld(1, Buffer.alloc(0))));
  if (a.model) parts.push(ld(4, Buffer.from(String(a.model))));
  return Buffer.concat(parts);
}

function taskToolCallMsg(a, callId, resultText) {
  const inner = [ld(1, taskArgsMsg(a))];
  if (resultText !== undefined) {
    if (/^ERROR/.test(String(resultText))) {
      inner.push(ld(2, ld(2, ld(1, Buffer.from(String(resultText)))))); // TaskResult.error
    } else {
      const success = Buffer.concat([
        ld(2, Buffer.from(String(a.agent_id || ''))),                 // agent_id
        vi(3, a.run_in_background ? 1 : 0),                          // is_background
        ld(5, Buffer.from(String(resultText))),                      // result_suffix
      ]);
      inner.push(ld(2, ld(1, success)));                             // TaskResult.success
    }
  }
  const tool = ld(19, Buffer.concat(inner));                         // ToolCall.task_tool_call
  return Buffer.concat([ld(1, Buffer.from(String(callId || ''))), ld(2, tool)]);
}

function taskToolStartedFrame(a, callId) {
  return frame(ld(1, ld(2, taskToolCallMsg(a, callId))));
}

function taskToolCompletedFrame(a, callId, resultText) {
  return frame(ld(1, ld(3, taskToolCallMsg(a, callId, resultText))));
}

function subagentExecFrame(a, toolCallId, execId, idNum, parent) {
  const parts = [
    ld(1, Buffer.from(String(toolCallId || ''))),
    ld(2, Buffer.from(String(a.subagent_type || 'generalPurpose'))),
    ld(3, Buffer.from(String(parent.modelId || ''))),
    ld(4, Buffer.from(String(a.prompt || ''))),
  ];
  if (a.readonly) parts.push(vi(5, 1));
  if (a.run_in_background) parts.push(vi(7, 1));
  parts.push(ld(9, Buffer.from(String(parent.conversationId || ''))));
  if (parent.apiKey) {
    const creds = [ld(1, Buffer.from(String(parent.apiKey)))];
    if (parent.baseUrl) creds.push(ld(2, Buffer.from(String(parent.baseUrl))));
    parts.push(ld(10, Buffer.concat(creds)));                       // ApiKeyCredentials
  }
  const mode = parent.modeNum && parent.modeNum > 0 ? parent.modeNum : 1;
  parts.push(vi(14, mode));
  parts.push(ld(16, Buffer.from(String(parent.conversationId || ''))));
  const body = Buffer.concat([
    vi(1, idNum),
    ld(15, Buffer.from(String(execId || ''))),
    ld(28, Buffer.concat(parts)),
  ]);
  return frame(ld(2, body));
}

/** Metadata about a client frame, for logging (no payload content). */
function describeClient(payload) {
  const fields = readFields(payload).map((f) => ({
    no: f.no,
    wire: f.wire,
    len: Buffer.isBuffer(f.value) ? f.value.length : undefined,
    value: typeof f.value === 'number' ? f.value : undefined,
  }));
  const exec = one(payload, 2);
  const execFields = exec
    ? readFields(exec).map((f) => ({ no: f.no, len: Buffer.isBuffer(f.value) ? f.value.length : undefined }))
    : [];
  return {
    fields,
    execId: exec ? (str(exec, 15) || '') : '',
    execNum: exec ? (one(exec, 1, 0) || 0) : 0,
    execFields,
  };
}

/* ---------------- interaction UI events for tool calls ---------------- */
function readArgsMsg(a) {
  const parts = [ld(1, Buffer.from(String(a.path || '')))];
  if (a.offset) parts.push(vi(2, Number(a.offset) || 0));
  if (a.limit) parts.push(vi(3, Number(a.limit) || 0));
  return Buffer.concat(parts);
}

function shellArgsMsg(a) {
  const parts = [ld(1, Buffer.from(String(a.command || '')))];
  if (a.working_directory) parts.push(ld(2, Buffer.from(String(a.working_directory))));
  return Buffer.concat(parts);
}

const TODO_STATUS = { pending: 1, in_progress: 2, completed: 3, cancelled: 4 };

function todoItemMsg(t) {
  const status = TODO_STATUS[String(t.status || 'pending').toLowerCase()] || 1;
  return Buffer.concat([
    ld(1, Buffer.from(String(t.id || ''))),
    ld(2, Buffer.from(String(t.content || ''))),
    vi(3, status),
  ]);
}

function todoListMsg(todos) {
  return Buffer.concat((todos || []).map((t) => ld(1, todoItemMsg(t))));
}

function toolCallMsg(name, argsObj, callId, modelCallId, result) {
  let tool;
  if (name === 'read_file') {
    const inner = [ld(1, readArgsMsg(argsObj))];
    if (result !== undefined) {
      const content = String(result || '');
      const totalLines = content ? content.split(/\r?\n/).length : 0;
      const success = Buffer.concat([
        ld(1, Buffer.from(content)),                       // content
        vi(4, totalLines),                                 // total_lines
        ld(7, Buffer.from(String(argsObj.path || ''))),    // path
      ]);
      inner.push(ld(2, ld(1, success))); // result{success{content,total_lines,path}}
    }
    tool = ld(8, Buffer.concat(inner)); // ToolCall.read_tool_call
  } else if (name === 'run_terminal') {
    const inner = [ld(1, shellArgsMsg(argsObj))];
    if (result !== undefined) {
      const success = Buffer.concat([
        ld(1, Buffer.from(String(argsObj.command || ''))),
        ld(5, Buffer.from(String(result || ''))),
      ]);
      inner.push(ld(2, ld(1, success))); // result{success{command,stdout}}
    }
    tool = ld(1, Buffer.concat(inner)); // ToolCall.shell_tool_call
  } else if (name === 'write_file' || name === 'edit_file') {
    const content = String(argsObj.content || '');
    const argsMsg = Buffer.concat([
      ld(1, Buffer.from(String(argsObj.path || ''))),
      ld(6, Buffer.from(content)),
    ]);
    const inner = [ld(1, argsMsg)];
    if (result !== undefined) {
      if (/^REJECTED/.test(String(result))) {
        inner.push(ld(2, ld(6, Buffer.alloc(0))));       // EditResult.rejected
      } else if (/^ERROR/.test(String(result))) {
        inner.push(ld(2, ld(7, Buffer.concat([
          ld(1, Buffer.from(String(argsObj.path || ''))),
          ld(2, Buffer.from(String(result))),
        ]))));                                            // EditResult.error
      } else {
        const lines = content ? content.split(/\r?\n/).length : 0;
        const successParts = [
          ld(1, Buffer.from(String(argsObj.path || ''))),
          vi(3, lines),
        ];
        if (argsObj._before !== undefined) {
          successParts.push(ld(6, Buffer.from(String(argsObj._before || '')))); // before
          successParts.push(ld(7, Buffer.from(content)));                       // after
        }
        inner.push(ld(2, ld(1, Buffer.concat(successParts)))); // EditResult.success
      }
    }
    tool = ld(12, Buffer.concat(inner)); // ToolCall.edit_tool_call
  } else if (name === 'delete_file') {
    const inner = [ld(1, Buffer.concat([ld(1, Buffer.from(String(argsObj.path || '')))]))];
    if (result !== undefined) {
      if (/^REJECTED/.test(String(result))) {
        inner.push(ld(2, ld(6, Buffer.alloc(0))));
      } else {
        inner.push(ld(2, ld(1, Buffer.concat([
          ld(1, Buffer.from(String(argsObj.path || ''))),
          ld(2, Buffer.from(String(argsObj.path || ''))),
        ]))));
      }
    }
    tool = ld(3, Buffer.concat(inner)); // ToolCall.delete_tool_call
  } else if (name === 'todo_write') {
    const todos = Array.isArray(argsObj.todos) ? argsObj.todos : [];
    const argsMsg = Buffer.concat([
      todoListMsg(todos),
      ...(argsObj.merge ? [vi(2, 1)] : []),
    ]);
    const inner = [ld(1, argsMsg)];
    if (result !== undefined) {
      const success = Buffer.concat([
        todoListMsg(todos),
        vi(2, todos.length),
        ...(argsObj.merge ? [vi(3, 1)] : []),
      ]);
      inner.push(ld(2, ld(1, success))); // UpdateTodosResult.success
    }
    tool = ld(9, Buffer.concat(inner)); // ToolCall.update_todos_tool_call
  } else if (name === 'ask_question') {
    const inner = [ld(1, askQuestionArgsMsg(argsObj))];
    if (result !== undefined) {
      inner.push(ld(2, ld(1, Buffer.alloc(0)))); // AskQuestionResult.success (empty)
    }
    tool = ld(23, Buffer.concat(inner)); // ToolCall.ask_question_tool_call
  } else {
    return null;
  }
  const parts = [ld(1, Buffer.from(callId)), ld(2, tool)];
  if (modelCallId) parts.push(ld(3, Buffer.from(modelCallId)));
  return Buffer.concat(parts);
}

function toolStartedFrame(name, argsObj, callId, modelCallId) {
  const tc = toolCallMsg(name, argsObj, callId, modelCallId);
  if (!tc) return null;
  return frame(ld(1, ld(2, tc))); // InteractionUpdate.tool_call_started
}

function toolCompletedFrame(name, argsObj, callId, modelCallId, result) {
  const tc = toolCallMsg(name, argsObj, callId, modelCallId, result);
  if (!tc) return null;
  return frame(ld(1, ld(3, tc))); // InteractionUpdate.tool_call_completed
}

function heartbeatFrame() {
  return frame(ld(1, ld(13, Buffer.alloc(0))));
}

/* ---------------- ask_question (interaction_query) ----------------
 * AgentServerMessage.7 = InteractionQuery{1 id, 3 ask_question_interaction_query}
 * AgentClientMessage.6 = InteractionResponse{1 id, 3 ask_question_interaction_response}
 */
function askQuestionArgsMsg(a) {
  const parts = [];
  if (a.title) parts.push(ld(1, Buffer.from(String(a.title))));
  for (const q of a.questions || []) {
    const qParts = [
      ld(1, Buffer.from(String(q.id || ''))),
      ld(2, Buffer.from(String(q.prompt || ''))),
    ];
    for (const o of q.options || []) {
      qParts.push(ld(3, Buffer.concat([
        ld(1, Buffer.from(String(o.id || ''))),
        ld(2, Buffer.from(String(o.label || ''))),
      ])));
    }
    if (q.allow_multiple) qParts.push(vi(4, 1));
    parts.push(ld(2, Buffer.concat(qParts)));
  }
  if (a.run_async) parts.push(vi(5, 1));
  return Buffer.concat(parts);
}

function askQuestionQueryFrame(queryId, argsObj, toolCallId) {
  const inner = Buffer.concat([
    ld(1, askQuestionArgsMsg(argsObj)),
    ld(2, Buffer.from(String(toolCallId || ''))),
  ]);
  return frame(ld(7, Buffer.concat([vi(1, queryId), ld(3, inner)])));
}

function parseInteractionResponse(payload) {
  const resp = one(payload, 6);
  if (!resp) return null;
  return { id: one(resp, 1, 0) || 0, resp };
}

function askAnswerText(resp) {
  const aq = one(resp, 3);
  if (!aq) return 'ERROR: not an ask_question response';
  const result = one(aq, 1);
  if (!result) return 'ERROR: empty ask_question response';
  const success = one(result, 1);
  if (success) {
    const answers = readFields(success).filter((f) => f.no === 1 && f.wire === 2);
    if (!answers.length) return 'The user did not select an option.';
    return answers.map((f) => {
      const a = f.value;
      const qid = str(a, 1) || 'question';
      const opts = readFields(a)
        .filter((x) => x.no === 2 && x.wire === 2)
        .map((x) => x.value.toString('utf8'));
      const free = str(a, 3) || '';
      return `${qid}: ${opts.join(', ') || free || '(no selection)'}`;
    }).join('\n');
  }
  if (one(result, 3)) return 'REJECTED: the user dismissed the question';
  if (one(result, 4)) return 'The question was queued asynchronously; continue without an answer for now.';
  return 'ERROR: ask_question failed';
}

/* ---------------- request parsing ---------------- */
/**
 * Pull the first complete Connect frame out of an accumulating buffer.
 * Returns { flags, payload } or null.
 */
function firstFrame(buf) {
  if (buf.length < 5) return null;
  const flags = buf[0];
  const len = buf.readUInt32BE(1);
  if (buf.length < 5 + len) return null;
  let payload = buf.subarray(5, 5 + len);
  if (flags & 1) {
    try { payload = zlib.gunzipSync(payload); } catch (_) { return null; }
  }
  return { flags, payload, rest: buf.subarray(5 + len) };
}

/**
 * Parse AgentClientMessage.run_request.
 * Returns null until a run_request frame is complete.
 */
function parseRunPayload(payload) {
  const run = one(payload, 1); // AgentClientMessage.run_request
  if (!run) return null;

  const requested = one(run, 9) || Buffer.alloc(0);
  const creds = one(requested, 4) || Buffer.alloc(0);
  const convState = one(run, 1) || Buffer.alloc(0);
  const stateFields = readFields(convState);
  const rootPrompts = stateFields.filter((f) => f.no === 1 && f.wire === 2);

  const action = one(run, 2) || Buffer.alloc(0);
  const actionFields = readFields(action).filter((f) => f.wire === 2 && f.value && f.value.length);
  const ACTION_CASES = {
    1: 'user_message', 2: 'resume', 3: 'cancel', 4: 'summarize', 5: 'shell_command',
    6: 'start_plan', 7: 'execute_plan', 8: 'async_ask', 10: 'cancel_subagent',
    12: 'background_task', 13: 'background_shell', 14: 'background_subagent',
    16: 'subscription_notification', 18: 'goal_continuation', 19: 'inject_context',
  };
  const actionCase = actionFields.length ? (ACTION_CASES[actionFields[0].no] || `field_${actionFields[0].no}`) : 'none';
  const userAction = one(action, 1) || Buffer.alloc(0);
  const userMsg = one(userAction, 1) || Buffer.alloc(0);
  const requestContext = one(userAction, 2) || Buffer.alloc(0);
  const subagentReminder = str(userMsg, 11) || '';
  const rules = parseRules(requestContext);
  const rootObjs = convState.length ? parseRootPrompts(convState) : [];
  const history = flattenHistory(rootObjs);
  const modeNum = (() => {
    const um = one(userMsg, 4, 0);
    if (um !== undefined) return um;
    if (convState.length) return one(convState, 10, 0) || 0;
    return 0;
  })();
  const mode = MODE_NAMES[modeNum] || 'AGENT';
  const mcp = parseMcpTools(run, requestContext);
  const runFieldSizes = readFields(run).map((f) => ({
    no: f.no,
    wire: f.wire,
    len: Buffer.isBuffer(f.value) ? f.value.length : undefined,
  }));
  const contextFieldSizes = readFields(requestContext).map((f) => ({
    no: f.no,
    len: Buffer.isBuffer(f.value) ? f.value.length : undefined,
  }));

  return {
    modelId: str(requested, 1) || 'unknown',
    apiKey: str(creds, 1) || '',
    baseUrl: str(creds, 2) || '',
    userText: str(userMsg, 1) || '',
    richText: str(userMsg, 8) || '',
    customSystemPrompt: str(run, 8) || '',
    systemPromptSpec: !!one(run, 29),
    conversationId: str(run, 5) || '',
    runId: str(run, 25) || '',
    conversationState: convState,
    rootPromptCount: rootPrompts.length,
    rootPromptBytes: rootPrompts.reduce((n, f) => n + f.value.length, 0),
    history,
    rules,
    ruleCount: rules.length,
    mode,
    modeNum,
    actionCase,
    isSubagent: !!subagentReminder,
    subagentReminder,
    nextInteractionQueryId: one(run, 34, 0) || 1,
    mcpTools: mcp.defs,
    mcpMap: mcp.map,
    mcpCatalogCount: mcp.catalogCount,
    mcpCatalogDebug: mcp.catalogDebug,
    mcpProviders: mcp.providers,
    mcpNames: mcp.defs.map((d) => d.function.name),
    runFieldSizes,
    contextFieldSizes,
  };
}

function parseRunRequest(accumulated) {
  let buf = accumulated;
  for (let guard = 0; guard < 8; guard++) {
    const f = firstFrame(buf);
    if (!f) return null;
    buf = f.rest;
    if (f.flags & 2) continue;
    const parsed = parseRunPayload(f.payload);
    if (parsed) return parsed;
  }
  return null;
}

/* ---------------- provider call ---------------- */
function providerUrl(baseUrl, endpoint) {
  const base = (baseUrl || '').replace(/\/+$/, '');
  if (endpoint) {
    if (/^https?:\/\//.test(endpoint)) return endpoint;
    const path = endpoint.startsWith('/') ? endpoint : '/' + endpoint;
    if (base.endsWith(path)) return base;
    return base + path;
  }
  if (!base) throw new Error('no base URL configured for this provider (BYOK credentials missing)');
  if (/\/chat\/completions$/.test(base)) return base;
  if (/\/responses$/.test(base)) return base;
  return base + '/chat/completions';
}

/**
 * Conversation history and project rules.
 *
 * ConversationStateStructure:
 *   1 root_prompt_messages_json  (repeated JSON blobs)
 *   8 turns                      (repeated binary AgentConversationTurnStructure)
 * We prefer the JSON blobs; they are already rendered messages.
 */
function contentToText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((p) => {
      if (typeof p === 'string') return p;
      if (p && typeof p === 'object') return p.text || p.content || '';
      return '';
    }).filter(Boolean).join('\n');
  }
  if (c && typeof c === 'object') return c.text || c.content || '';
  return '';
}

function normRole(r) {
  switch (String(r || '').toLowerCase()) {
    case 'assistant':
    case 'ai':
    case 'model':
      return 'assistant';
    case 'system':
    case 'developer':
      return 'system';
    case 'tool':
    case 'function':
      return 'tool';
    default:
      return 'user';
  }
}

function flattenHistory(objs) {
  const out = [];
  const walk = (o, depth) => {
    if (depth > 6 || o == null) return;
    if (Array.isArray(o)) { o.forEach((x) => walk(x, depth + 1)); return; }
    if (typeof o !== 'object') return;

    if (o.role && (o.content !== undefined || o.text !== undefined || o.parts !== undefined)) {
      const text = contentToText(o.content !== undefined ? o.content : (o.parts !== undefined ? o.parts : o.text));
      if (text.trim()) out.push({ role: normRole(o.role), content: text.trim() });
      return;
    }
    if (o.message && typeof o.message === 'object') { walk(o.message, depth + 1); return; }
    for (const k of ['messages', 'prompt', 'promptMessages', 'items']) {
      if (o[k] !== undefined) walk(o[k], depth + 1);
    }
  };
  objs.forEach((o) => walk(o, 0));

  // Deduplicate consecutive identical messages.
  const dedup = [];
  for (const m of out) {
    const prev = dedup[dedup.length - 1];
    if (prev && prev.role === m.role && prev.content === m.content) continue;
    dedup.push(m);
  }
  return dedup;
}

function parseRootPrompts(stateBuf) {
  const parsed = [];
  for (const f of readFields(stateBuf)) {
    if (f.no !== 1 || f.wire !== 2) continue;
    try {
      parsed.push(JSON.parse(f.value.toString('utf8')));
    } catch (_) { /* ignore malformed blob */ }
  }
  return parsed;
}

function parseRules(contextBuf) {
  const rules = [];
  for (const f of readFields(contextBuf)) {
    if (f.no !== 2 || f.wire !== 2) continue;
    const path = str(f.value, 1) || '';
    const content = str(f.value, 2) || '';
    if (content.trim()) rules.push({ path, content: content.trim() });
  }
  return rules;
}

function rulesBlock(rules) {
  if (!rules || rules.length === 0) return '';
  const parts = rules.map((r) => `### ${r.path || 'rule'}\n${r.content}`);
  return 'Follow these project rules:\n\n' + parts.join('\n\n');
}

/* ---------------- conversation store ----------------
 * Cursor's real backend keeps the transcript server-side, keyed by
 * conversation_id. The client sends only the new action, so the proxy has to
 * remember the conversation to make follow-ups work.
 */
function sessionFile(conversationId) {
  const safe = String(conversationId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(SESSIONS_DIR, safe + '.json');
}

function loadSession(conversationId) {
  if (!conversationId) return [];
  try {
    const raw = fs.readFileSync(sessionFile(conversationId), 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data.messages) ? data.messages : [];
  } catch (_) {
    return [];
  }
}

function saveSession(conversationId, messages) {
  if (!conversationId) return;
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    let msgs = messages.filter((m) => m && (m.content || (m.tool_calls && m.tool_calls.length)));
    if (msgs.length > MAX_SESSION_MESSAGES) msgs = msgs.slice(-MAX_SESSION_MESSAGES);
    let chars = msgs.reduce((n, m) => n + (m.content || '').length + (m.tool_calls ? 200 : 0), 0);
    while (chars > MAX_SESSION_CHARS && msgs.length > 2) {
      chars -= (msgs.shift().content || '').length;
    }
    fs.writeFileSync(sessionFile(conversationId), JSON.stringify({
      conversationId,
      updatedAt: new Date().toISOString(),
      messages: msgs,
    }), 'utf8');
  } catch (_) { /* best effort */ }
}

function appendTurn(conversationId, userText, assistantText) {
  if (!conversationId) return;
  const messages = loadSession(conversationId);
  if (userText && !(messages.length && messages[messages.length - 1].role === 'user'
      && messages[messages.length - 1].content === userText)) {
    messages.push({ role: 'user', content: userText });
  }
  if (assistantText) messages.push({ role: 'assistant', content: assistantText });
  saveSession(conversationId, messages);
}

/**
 * Without a system prompt, DeepSeek-family models tend to answer identity
 * questions from their distillation prior ("I'm ChatGPT"). Cursor normally
 * supplies its own prompt server-side; the proxy has to supply one.
 */
function identityPrompt(modelId) {
  if (process.env.CURSOR_PROXY_IDENTITY === 'off') return '';
  return [
    'You are the AI assistant running inside the Cursor IDE.',
    `The model currently serving this conversation is "${modelId}".`,
    'If you are asked which model or vendor you are, answer truthfully with that model name.',
    'Do not claim to be ChatGPT, OpenAI, Anthropic, Google, or any other vendor unless that is the model actually in use.',
    'Be concise, and answer in the language the user writes in.',
  ].join(' ');
}

function buildMessages(parsed) {
  const clientHistory = Array.isArray(parsed.history) ? parsed.history : [];
  const storedHistory = Array.isArray(parsed.storedHistory) ? parsed.storedHistory : [];
  const history = clientHistory.length ? clientHistory.slice() : storedHistory.slice();
  const messages = [];
  const rules = rulesBlock(parsed.rules);

  const sysIndex = history.findIndex((m) => m.role === 'system');
  if (sysIndex >= 0) {
    // Cursor sent its own system prompt: keep it, append rules only.
    if (rules) history[sysIndex] = { role: 'system', content: history[sysIndex].content + '\n\n' + rules };
    messages.push(...history);
  } else {
    const identity = identityPrompt(parsed.modelId);
    const modeTools = toolsForMode(parsed.mode, [], { isSubagent: parsed.isSubagent }).map((t) => t.function.name);
    const todoLine = modeTools.includes('todo_write')
      ? 'Todo lists are UI state shown to the user — use todo_write for them, never create a file. Mark items completed as you go, and once everything is done clear the list by calling todo_write with an empty todos array.'
      : '';
    const mcpLine = parsed.mcpTools && parsed.mcpTools.length
      ? 'MCP tool JSON schemas are authoritative. Before calling an MCP tool, read its schema and pass every required field; enum values must match exactly. If the server returns an input-validation error, fix the arguments and retry once before giving up.'
      : '';
    const system = [identity, modePrompt(parsed.mode), shellPrompt(), todoLine, mcpLine,
      parsed.customSystemPrompt, rules]
      .filter(Boolean).join('\n\n');
    if (system) messages.push({ role: 'system', content: system });
    messages.push(...history);
  }

  if (parsed.userText) {
    const last = messages[messages.length - 1];
    const dup = last && last.role === 'user' && last.content.trim() === parsed.userText.trim();
    if (!dup) messages.push({ role: 'user', content: parsed.userText });
  }
  return messages;
}

async function streamChat(opts, onEvent, signal, baseOverride) {
  const base = baseOverride || opts.baseUrl;
  const url = providerUrl(base, opts.endpoint);
  const headers = {
    'content-type': 'application/json',
    // OpenCode Go requires a per-conversation session id and a real client UA.
    'x-opencode-session': opts.conversationId || opts.runId || crypto.randomUUID(),
    'user-agent': 'cursor-local-proxy/1.0',
    ...(opts.headers || {}),
  };
  if (opts.apiKey && !headers.authorization && !headers['api-key'] && !headers['x-api-key']) {
    headers.authorization = 'Bearer ' + opts.apiKey;
  }

  const body = {
    model: opts.modelId,
    stream: true,
    messages: opts.messages,
  };
  if (opts.tools && opts.tools.length) {
    body.tools = opts.tools;
    body.tool_choice = opts.toolChoice || 'auto';
  }
  if (opts.maxOutput) body.max_tokens = opts.maxOutput;
  if (opts.effort && opts.reasoningEffortField) body[opts.reasoningEffortField] = opts.effort;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`provider ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  }
  if (!res.body) throw new Error('provider returned no body');

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let full = '';
  const calls = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let json;
      try { json = JSON.parse(data); } catch (_) { continue; }
      const delta = json.choices && json.choices[0] && json.choices[0].delta;
      if (!delta) continue;

      const reasoning = delta.reasoning_content || delta.reasoning || '';
      if (reasoning) await onEvent({ kind: 'thinking', text: reasoning });

      const piece = delta.content || '';
      if (piece) {
        full += piece;
        await onEvent({ kind: 'text', text: piece });
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const i = typeof tc.index === 'number' ? tc.index : 0;
          const slot = calls[i] || (calls[i] = { id: '', name: '', args: '' });
          if (tc.id) slot.id = tc.id;
          if (tc.function) {
            if (tc.function.name) slot.name += tc.function.name;
            if (tc.function.arguments) slot.args += tc.function.arguments;
          }
        }
      }
    }
  }

  const toolCalls = calls
    .filter(Boolean)
    .map((c, i) => ({ id: c.id || `call_${i}`, name: c.name, args: c.args || '{}' }))
    .filter((c) => c.name);

  return { text: full, toolCalls };
}

async function streamProvider(parsed, onEvent, signal, baseOverride) {
  const out = await streamChat({
    modelId: parsed.modelId,
    apiKey: parsed.apiKey,
    baseUrl: parsed.baseUrl,
    conversationId: parsed.conversationId,
    runId: parsed.runId,
    messages: buildMessages(parsed),
  }, onEvent, signal, baseOverride);
  return out.text;
}

function configure(opts = {}) {
  if (opts.sessionsDir) SESSIONS_DIR = path.resolve(opts.sessionsDir);
  if (opts.workspace) WORKSPACE = path.resolve(opts.workspace);
  return { sessionsDir: SESSIONS_DIR, workspace: WORKSPACE };
}

module.exports = {
  configure,
  parseRunRequest,
  parseRunPayload,
  streamProvider,
  streamChat,
  buildMessages,
  identityPrompt,
  flattenHistory,
  parseRules,
  loadSession,
  appendTurn,
  saveSession,
  TOOL_DEFS,
  toolsForMode,
  modePrompt,
  parseMcpTools,
  mcpExecFrame,
  mcpArgsMsg,
  mcpResultMsg,
  mcpToolStartedFrame,
  mcpToolCompletedFrame,
  execMcpResult,
  taskToolStartedFrame,
  taskToolCompletedFrame,
  subagentExecFrame,
  execServerFrame,
  parseClientFrame,
  execResultText,
  localTool,
  localShell,
  applyEdit,
  readBefore,
  resolvePath,
  WORKSPACE,
  nextFrame,
  describeClient,
  toolStartedFrame,
  toolCompletedFrame,
  askQuestionQueryFrame,
  parseInteractionResponse,
  askAnswerText,
  heartbeatFrame,
  textFrame,
  thinkingFrame,
  thinkingCompletedFrame,
  turnEndFrame,
  endStreamFrame,
  endStreamError,
  frame,
  one,
  str,
};
