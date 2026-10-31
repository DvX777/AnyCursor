'use strict';
/*
 * Cursor capture proxy - Stage 0 (v2)
 *
 * Speaks BOTH protocols on one port:
 *   - HTTP/1.1  (renderer unary Connect calls)
 *   - h2c       (agent host server-streaming Connect calls)
 *
 * Forwards everything to the real Cursor backend unchanged, except:
 *   - fixes hop-by-hop headers (no transfer-encoding + content-length together)
 *   - logs every request/response for schema recovery
 *
 * Usage: node capture-proxy.js [--port 8899]
 */
const http = require('http');
const http2 = require('http2');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');

const { ConfigService } = require('../config/service');
const { buildRegistry } = require('../catalog/registry');
const { transformCatalog } = require('../catalog/response');
const { selectedModelIds } = require('../cursor/state');
const providers = require('../providers');
const { cachedOpencodeCredential } = require('../providers/opencode-credential');
const inference = require('./inference');
const selections = require('./selections');

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

function defaultConfigPath() {
  const local = path.join(
    process.env.LOCALAPPDATA || process.env.USERPROFILE || '',
    'AnyCursor',
    'config.json',
  );
  const repo = path.join(__dirname, '..', '..', 'config', 'anycursor.json');
  if (fs.existsSync(repo)) return repo;
  return local;
}

const CONFIG_PATH = path.resolve(
  arg('config', process.env.ANY_CURSOR_CONFIG || defaultConfigPath()),
);
const configService = new ConfigService(CONFIG_PATH);
let registry = configService.config ? buildRegistry(configService.config) : null;
const initialConfig = configService.config;

function applyConfig() {
  registry = configService.config ? buildRegistry(configService.config) : null;
  adapter.configure({
    sessionsDir: path.join(DATA_DIR, 'sessions'),
    workspace: (configService.config && configService.config.gateway && configService.config.gateway.workspace) || undefined,
  });
  return configService.config;
}

function currentConfig() {
  return configService.config;
}

function providerApiKey(provider) {
  if (!provider) return '';
  if (provider.apiKey) return provider.apiKey;
  if (provider.credential === 'opencode-go'
    || provider.modelsDevProvider === 'opencode-go'
    || /opencode\.ai\/inference\/go/i.test(provider.baseUrl || '')) {
    const credential = cachedOpencodeCredential();
    if (credential && credential.key) return credential.key;
  }
  return '';
}

function prepareInferenceModel(model) {
  const config = currentConfig();
  const provider = config && config.providers ? config.providers[model.provider] : null;
  if (!provider && !model.baseUrl) return null;
  return {
    apiKey: model.apiKey || providerApiKey(provider) || '',
    baseUrl: model.baseUrl || (provider && (provider.baseUrl || provider.endpoint)) || '',
    endpoint: model.endpoint || (provider && provider.endpoint) || '',
    headers: (provider && provider.headers) || {},
    region: (provider && provider.region) || '',
    accessKeyId: (provider && provider.accessKeyId) || '',
    secretAccessKey: (provider && provider.secretAccessKey) || '',
    sessionToken: (provider && provider.sessionToken) || '',
  };
}

// Apply edits made outside the dashboard (editor, git, installer scripts).
function watchConfig() {
  let timer = null;
  const reload = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const before = JSON.stringify(configService.raw || null);
      const loaded = configService.load();
      if (!loaded) {
        console.error(`[anycursor] config reload failed: ${configService.error}`);
        return;
      }
      if (JSON.stringify(configService.raw || null) === before) return;
      applyConfig();
      console.log(`[anycursor] config reloaded from ${CONFIG_PATH}`);
    }, 250);
  };
  try {
    fs.watch(path.dirname(CONFIG_PATH), { persistent: false }, (_event, filename) => {
      if (!filename || filename === path.basename(CONFIG_PATH)) reload();
    });
  } catch (_) {
    // fs.watch is unavailable on some network shares; poll instead.
    fs.watchFile(CONFIG_PATH, { interval: 2000 }, reload);
  }
}

const CONFIG_PORT = initialConfig && initialConfig.gateway ? initialConfig.gateway.port : undefined;
const CONFIG_HOST = initialConfig && initialConfig.gateway ? initialConfig.gateway.host : undefined;
const PORT = Number(arg('port', process.env.ANY_CURSOR_PORT || process.env.CURSOR_PROXY_PORT || CONFIG_PORT || 43110));
const HOST = arg('host', process.env.ANY_CURSOR_HOST || process.env.CURSOR_PROXY_HOST || CONFIG_HOST || '127.0.0.1');
const PORT_EXPLICIT = argv.includes('--port') || !!process.env.ANY_CURSOR_PORT || !!process.env.CURSOR_PROXY_PORT;
const HOST_EXPLICIT = argv.includes('--host') || !!process.env.ANY_CURSOR_HOST || !!process.env.CURSOR_PROXY_HOST;
const UPSTREAM_EXPLICIT = argv.includes('--upstream') || !!process.env.ANY_CURSOR_UPSTREAM || !!process.env.CURSOR_PROXY_UPSTREAM;
const DATA_DIR_EXPLICIT = !!process.env.ANY_CURSOR_DATA_DIR;
const DEFAULT_UPSTREAM = arg('upstream', process.env.ANY_CURSOR_UPSTREAM || process.env.CURSOR_PROXY_UPSTREAM || (initialConfig && initialConfig.gateway && initialConfig.gateway.upstream) || 'https://api2.cursor.sh');
const DATA_DIR = process.env.ANY_CURSOR_DATA_DIR
  || (initialConfig && initialConfig.gateway && initialConfig.gateway.dataDir)
  || path.join(__dirname, '..', '..', 'data');
const MAX_CAPTURE = 8 * 1024 * 1024;
const SAVE_BODIES = argv.includes('--save-bodies') || process.env.CURSOR_PROXY_SAVE_BODIES === '1';
const adapter = require('./adapter');

adapter.configure({
  sessionsDir: path.join(DATA_DIR, 'sessions'),
  workspace: (initialConfig && initialConfig.gateway && initialConfig.gateway.workspace) || undefined,
});
watchConfig();

const ROUTES = [
  [/^\/origin\.v1\./, 'https://api.origin.cursor.com'],
  [/^\/agent\.v1\./, 'https://agentn.global.api5.cursor.sh'],
  [/^\/aiserver\.v1\./, 'https://api2.cursor.sh'],
];

// ---- fake turn mode (Stage 2): answer AgentService/Run ourselves ----
const FAKE_TURN = argv.includes('--fake-turn') || process.env.CURSOR_PROXY_FAKE_TURN === '1';
const FAKE_TEXT = arg('fake-text',
  'Hello from the local Cursor proxy. If you can read this, the agent turn protocol works.');

// ---- live mode (Stage 3): forward the turn to the model in run_request ----
const LIVE_TURN = argv.includes('--live') || process.env.CURSOR_PROXY_LIVE === '1';
const PROVIDER_BASE = arg('provider-base', process.env.CURSOR_PROXY_PROVIDER_BASE || '');

function varint(n) {
  const out = [];
  let v = n >>> 0;
  while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
  out.push(v);
  return Buffer.from(out);
}
function ld(field, buf) {
  return Buffer.concat([Buffer.from([(field << 3) | 2]), varint(buf.length), buf]);
}
function vi(field, n) {
  return Buffer.concat([Buffer.from([(field << 3) | 0]), varint(n)]);
}
function connectFrame(payload, flags = 0) {
  const head = Buffer.alloc(5);
  head[0] = flags;
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}
function fakeTurnFrames(text) {
  const textDelta = ld(1, Buffer.from(text, 'utf8'));      // TextDeltaUpdate{text}
  const iuText = ld(1, textDelta);                          // InteractionUpdate{text_delta}
  const msgText = ld(1, iuText);                            // AgentServerMessage{interaction_update}

  const ended = Buffer.concat([
    vi(1, 12),                                              // input_tokens
    vi(2, 24),                                              // output_tokens
    vi(6, Date.now()),                                      // ended_at_ms
  ]);
  const iuEnd = ld(14, ended);                              // InteractionUpdate{turn_ended}
  const msgEnd = ld(1, iuEnd);

  return Buffer.concat([
    connectFrame(msgText),
    connectFrame(msgEnd),
    connectFrame(Buffer.from('{}'), 0x02),                  // end-stream
  ]);
}

let lastParentCreds = null;

function handleLiveTurn(stream, hdrs, id, reqPath) {
  const started = Date.now();
  let buf = Buffer.alloc(0);
  let began = false;
  let parsed = null;
  let execSeq = 0;
  const abort = new AbortController();
  const pending = new Map();
  const pendingQueries = new Map();
  let querySeq = 0;

  const failAll = (why) => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(why)); }
    pending.clear();
    for (const p of pendingQueries.values()) { clearTimeout(p.timer); p.reject(new Error(why)); }
    pendingQueries.clear();
  };

  stream.on('close', () => { abort.abort(); failAll('client closed the stream'); });
  stream.on('error', () => { abort.abort(); failAll('stream error'); });

  function waitExec(execId, idNum, ms = 120000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(execId);
        pending.delete('#' + idNum);
        reject(new Error('tool execution timed out'));
      }, ms);
      const slot = { resolve, reject, timer };
      pending.set(execId, slot);
      pending.set('#' + idNum, slot);
    });
  }

  function waitQuery(id, ms = 300000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingQueries.delete(id);
        reject(new Error('question timed out'));
      }, ms);
      pendingQueries.set(id, { resolve, reject, timer });
    });
  }

  function dispatch(payload) {
    log({ id, ts: new Date().toISOString(), dir: 'client', protocol: 'h2', ...adapter.describeClient(payload) });

    const ir = adapter.parseInteractionResponse(payload);
    if (ir) {
      const q = pendingQueries.get(ir.id);
      if (q) {
        clearTimeout(q.timer);
        pendingQueries.delete(ir.id);
        q.resolve(adapter.askAnswerText(ir.resp));
      }
      return;
    }

    const msg = adapter.parseClientFrame(payload);
    if (!msg) return;
    let slot = pending.get(msg.execId) || pending.get('#' + msg.id);
    if (!slot) {
      const unique = new Set(pending.values());
      if (unique.size === 1) slot = [...unique][0];
    }
    if (!slot) return;
    clearTimeout(slot.timer);
    for (const [k, v] of pending) if (v === slot) pending.delete(k);
    slot.resolve({
      text: adapter.execResultText(msg.exec),
      mcpResult: adapter.execMcpResult(msg.exec) || null,
    });
  }

  stream.on('data', (c) => {
    try {
      buf = Buffer.concat([buf, c]);
      for (;;) {
        const f = adapter.nextFrame(buf);
        if (!f) break;
        buf = f.rest;
        if (f.flags & 2) continue;

        if (!began) {
          const p = adapter.parseRunPayload(f.payload);
          if (!p) continue;
          parsed = p;
          began = true;
          parsed.storedHistory = adapter.loadSession(parsed.conversationId);
          stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
          void runTurn();
        } else {
          dispatch(f.payload);
        }
      }
    } catch (e) {
      log({
        id, ts: new Date().toISOString(), dir: 'error', where: 'h2-data',
        error: String(e && e.message ? e.message : e),
        stack: String(e && e.stack ? e.stack : '').slice(0, 1200),
      });
      try { stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR); } catch (_) {}
    }
  });

  async function runTurn() {
    const requestedModelId = parsed.modelId;
    const resolvedRoute = registry ? registry.resolve(parsed.modelId) : { route: 'native' };
    const byokModel = resolvedRoute.route === 'byok' ? resolvedRoute.model : null;
    const config = currentConfig();
    const byokProvider = byokModel && config ? config.providers[byokModel.provider] : null;
    if (byokModel) parsed.modelId = byokModel.model;
    const messages = adapter.buildMessages(parsed);
    querySeq = Math.max(0, (parsed.nextInteractionQueryId || 1) - 1);
    let visible = '';
    let finalText = '';
    let thinkingChars = 0;    let thinkingOpen = false;
    let rounds = 0;
    let toolCalls = 0;
    const thinkStart = Date.now();

    const onEvent = (ev) => {
      if (stream.destroyed) return;
      if (ev.kind === 'thinking') {
        thinkingChars += ev.text.length;
        thinkingOpen = true;
        stream.write(adapter.thinkingFrame(ev.text));
      } else {
        if (thinkingOpen) {
          stream.write(adapter.thinkingCompletedFrame(Date.now() - thinkStart));
          thinkingOpen = false;
        }
        stream.write(adapter.textFrame(ev.text));
      }
    };

    const hb = setInterval(() => {
      if (!stream.destroyed) stream.write(adapter.heartbeatFrame());
    }, 8000);

    try {
      const MAX_ROUNDS = Number(process.env.CURSOR_PROXY_MAX_ROUNDS) || 24;
      const fallbackCreds = (!parsed.apiKey || !parsed.baseUrl) && parsed.isSubagent && lastParentCreds
        ? { apiKey: lastParentCreds.apiKey, baseUrl: lastParentCreds.baseUrl }
        : { apiKey: parsed.apiKey, baseUrl: parsed.baseUrl };
      const creds = byokModel
        ? {
            apiKey: byokModel.apiKey || providerApiKey(byokProvider) || parsed.apiKey || '',
            baseUrl: byokModel.baseUrl
              || (byokProvider && (byokProvider.baseUrl || byokProvider.endpoint))
              || parsed.baseUrl
              || '',
          }
        : fallbackCreds;
      const endpoint = byokModel
        ? (byokModel.endpoint || (byokProvider && byokProvider.endpoint) || '')
        : '';
      const usedFallbackCreds = !byokModel
        && (fallbackCreds.apiKey !== parsed.apiKey || fallbackCreds.baseUrl !== parsed.baseUrl);
      const providerAdapter = providers.getAdapter(byokModel ? byokModel.api : 'openai-compatible');
      const selectedEffort = parsed.modelParameters
        ? (parsed.modelParameters.reasoning_effort || parsed.modelParameters.reasoning)
        : undefined;
      if (parsed.modelParameters) {
        selections.record(byokModel || { cursorId: parsed.modelId }, {
          effort: selectedEffort,
          context: parsed.modelParameters.context,
          fast: parsed.modelParameters.fast,
        });
      }
      const providerOptions = byokModel
        ? {
            headers: (byokProvider && byokProvider.headers) || {},
            version: (byokProvider && byokProvider.version) || '',
            deployment: (byokProvider && byokProvider.deployment) || '',
            apiVersion: (byokProvider && byokProvider.apiVersion) || '',
            region: (byokProvider && byokProvider.region) || '',
            accessKeyId: (byokProvider && byokProvider.accessKeyId) || '',
            secretAccessKey: (byokProvider && byokProvider.secretAccessKey) || '',
            sessionToken: (byokProvider && byokProvider.sessionToken) || '',
            maxOutput: byokModel.maxOutput,
            reasoning: byokModel.capabilities.reasoning,
            effort: selectedEffort || (byokModel.effort ? byokModel.effort.default : undefined),
            reasoningEffortField: (byokModel.effort && byokModel.effort.requestField) || 'reasoning_effort',
            context: parsed.modelParameters ? parsed.modelParameters.context : undefined,
            fast: parsed.modelParameters ? parsed.modelParameters.fast === 'true' : false,
            baseOverride: byokModel.api === 'openai-compatible' ? (PROVIDER_BASE || undefined) : undefined,
          }
        : {};
      for (let round = 0; round < MAX_ROUNDS; round++) {
        rounds = round + 1;
        const forceText = round === MAX_ROUNDS - 1;
        const res = await providerAdapter.streamChat({
          modelId: parsed.modelId,
          apiKey: creds.apiKey,
          baseUrl: creds.baseUrl,
          endpoint,
          conversationId: parsed.conversationId,
          runId: parsed.runId,
          messages,
          tools: forceText ? null : adapter.toolsForMode(parsed.mode, parsed.mcpTools, { isSubagent: parsed.isSubagent }),
          toolChoice: forceText ? 'none' : 'auto',
          ...providerOptions,
        }, onEvent, abort.signal);

        visible += res.text;
        finalText = res.text;
        if (!res.toolCalls.length) break;
        if (forceText) break; // final round is text-only; ignore any stray tool calls

        messages.push({
          role: 'assistant',
          content: res.text || null,
          tool_calls: res.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.args },
          })),
        });

        for (const tc of res.toolCalls) {
          toolCalls++;
          let result;
          let argsObj = {};
          try { argsObj = JSON.parse(tc.args || '{}'); } catch (_) { argsObj = {}; }

          let nativeName = tc.name;
          let nativeArgs = tc.args;
          let editCount = 0;
          let localResult = null;

          if (tc.name === 'ask_question') {
            const sf = adapter.toolStartedFrame('ask_question', argsObj, tc.id, null);
            if (sf) stream.write(sf);
            const qid = ++querySeq;
            log({ id, ts: new Date().toISOString(), dir: 'query', protocol: 'h2', qid, toolCallId: tc.id });
            try {
              stream.write(adapter.askQuestionQueryFrame(qid, argsObj, tc.id));
              result = await waitQuery(qid);
            } catch (e) {
              result = 'ERROR: ' + String(e && e.message ? e.message : e);
            }
            const df = adapter.toolCompletedFrame('ask_question', argsObj, tc.id, null, result);
            if (df) stream.write(df);
            localResult = result;
          } else if (tc.name === 'todo_write') {
            const todos = (Array.isArray(argsObj.todos) ? argsObj.todos : []).map((t, i) => ({
              id: t.id || String(i + 1),
              content: t.content,
              status: t.status,
            }));
            const args = { ...argsObj, todos };
            const sf = adapter.toolStartedFrame('todo_write', args, tc.id, null);
            if (sf) stream.write(sf);
            const df = adapter.toolCompletedFrame('todo_write', args, tc.id, null, 'ok');
            if (df) stream.write(df);
            localResult = `todos updated (${todos.length} item${todos.length === 1 ? '' : 's'})`;
          } else if (tc.name === 'ls' || tc.name === 'glob' || tc.name === 'grep' || tc.name === 'web_fetch') {
            try { localResult = await adapter.localTool(tc.name, argsObj); }
            catch (e) { localResult = 'ERROR: ' + String(e && e.message ? e.message : e); }
          } else if (tc.name === 'edit_file') {
            const ed = adapter.applyEdit(argsObj);
            if (ed.error) {
              localResult = 'ERROR: ' + ed.error;
            } else {
              editCount = ed.count;
              nativeName = 'write_file';
              nativeArgs = JSON.stringify({ path: argsObj.path, content: ed.content });
              argsObj = { ...argsObj, content: ed.content, _before: ed.before };
            }
          } else if (tc.name === 'task') {
            const sf = adapter.taskToolStartedFrame(argsObj, tc.id);
            if (sf) stream.write(sf);
            lastParentCreds = {
              apiKey: parsed.apiKey || '',
              baseUrl: parsed.baseUrl || '',
              modelId: parsed.modelId || '',
            };
            const execId = nodeCrypto.randomUUID();
            const idNum = ++execSeq;
            try {
              stream.write(adapter.subagentExecFrame(argsObj, tc.id, execId, idNum, parsed));
              log({
                id, ts: new Date().toISOString(), dir: 'subagent-call', protocol: 'h2',
                tool: tc.name, subagentType: argsObj.subagent_type || 'generalPurpose',
                background: !!argsObj.run_in_background,
                promptChars: String(argsObj.prompt || '').length,
              });
              const execOut = await waitExec(execId, idNum, 600000);
              localResult = execOut.text;
              log({
                id, ts: new Date().toISOString(), dir: 'subagent-result', protocol: 'h2',
                chars: String(localResult || '').length,
                error: /^ERROR/.test(String(localResult || '')),
              });
            } catch (e) {
              localResult = 'ERROR: ' + String(e && e.message ? e.message : e);
            }
            const df = adapter.taskToolCompletedFrame(argsObj, tc.id, localResult);
            if (df) stream.write(df);
          }

          if (localResult !== null) {
            result = localResult;
          } else {
            if (nativeName === 'write_file' && argsObj._before === undefined) {
              argsObj._before = adapter.readBefore(argsObj.path);
            }
            const execId = nodeCrypto.randomUUID();
            const idNum = ++execSeq;
            const mcpMeta = parsed.mcpMap && parsed.mcpMap[tc.name];
            if (mcpMeta) {
              const mcpStarted = adapter.mcpToolStartedFrame(mcpMeta, argsObj, tc.id);
              if (mcpStarted) stream.write(mcpStarted);
            } else {
              const startedFrame = adapter.toolStartedFrame(nativeName, argsObj, tc.id, null);
              if (startedFrame) stream.write(startedFrame);
            }
            let mcpResultRaw = null;
            try {
              const skipApproval = process.env.CURSOR_PROXY_MCP_SKIP_APPROVAL === '1';
              const outFrame = mcpMeta
                ? adapter.mcpExecFrame(mcpMeta, argsObj, tc.id, execId, idNum, skipApproval)
                : adapter.execServerFrame(nativeName, nativeArgs, tc.id, execId, idNum);
              stream.write(outFrame);
              if (mcpMeta) {
                log({
                  id, ts: new Date().toISOString(), dir: 'mcp-call', protocol: 'h2',
                  tool: tc.name, provider: mcpMeta.provider || '',
                  server: mcpMeta.serverName || '', toolName: mcpMeta.toolName || '',
                  skipApproval,
                });
              }
              const execOut = await waitExec(execId, idNum, 45000);
              result = execOut.text;
              mcpResultRaw = execOut.mcpResult || null;
              if (mcpMeta) {
                const mcpDone = adapter.mcpToolCompletedFrame(mcpMeta, argsObj, tc.id, result, mcpResultRaw);
                if (mcpDone) stream.write(mcpDone);
              }
            } catch (e) {
              result = 'ERROR: ' + String(e && e.message ? e.message : e);
            }
            if (nativeName === 'run_terminal' && /^ERROR: spawn failed/.test(result)) {
              log({
                id, ts: new Date().toISOString(), dir: 'shell-error', protocol: 'h2',
                command: String(argsObj.command || '').slice(0, 300),
                error: String(result).slice(0, 500),
              });
            }
            if (nativeName === 'run_terminal'
                && /^ERROR: spawn failed/.test(result)
                && process.env.CURSOR_PROXY_SHELL_FALLBACK === '1') {
              const local = await adapter.localShell(argsObj.command, argsObj.working_directory);
              result = `${local}\n(note: Cursor's terminal could not spawn; ran via local PowerShell)`;
              log({
                id, ts: new Date().toISOString(), dir: 'shell-fallback', protocol: 'h2',
                command: String(argsObj.command || '').slice(0, 300),
                exit: (/^exit_code=(\d+)/.exec(local) || [])[1] || '?',
              });
            }
            const doneFrame = adapter.toolCompletedFrame(nativeName, argsObj, tc.id, null, result);
            if (doneFrame) stream.write(doneFrame);
            if (editCount && /^wrote /.test(result)) {
              result = `edited ${argsObj.path} (${editCount} replacement${editCount === 1 ? '' : 's'})`;
            }
          }

          messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
        }
      }

      if (thinkingOpen) {
        stream.write(adapter.thinkingCompletedFrame(Date.now() - thinkStart));
      }
      if (!visible.trim()) {
        const fallback = 'I reached the tool-call limit for this turn without producing a final answer. Ask me to continue and I will pick up where I left off.';
        stream.write(adapter.textFrame(fallback));
        visible = fallback;
        finalText = fallback;
      }
      if (finalText.trim()) messages.push({ role: 'assistant', content: finalText });
      adapter.saveSession(parsed.conversationId, messages.filter((m) => m.role !== 'system'));
      stream.write(adapter.turnEndFrame());
      stream.write(adapter.endStreamFrame());
      stream.end();
      log({
        id, ts: new Date().toISOString(), dir: 'live', protocol: 'h2', url: reqPath,
        model: parsed.modelId, provider: PROVIDER_BASE || parsed.baseUrl,
        chars: visible.length, thinkingChars, rounds, toolCalls, ms: Date.now() - started,
        promptProbe: {
          mode: parsed.mode,
          action: parsed.actionCase,
          route: byokModel ? 'byok' : 'native',
          provider: byokModel ? byokModel.provider : '',
          requestedModel: requestedModelId,
          isSubagent: parsed.isSubagent,
          usedFallbackCreds,
          nextQueryId: parsed.nextInteractionQueryId,
          mcpTools: (parsed.mcpTools || []).length,
          mcpCatalog: parsed.mcpCatalogCount || 0,
          mcpCatalogDebug: parsed.mcpCatalogDebug || null,
          mcpProviders: parsed.mcpProviders || {},
          mcpNames: (parsed.mcpNames || []).slice(0, 120),
          runFields: parsed.runFieldSizes,
          ctxFields: parsed.contextFieldSizes,
          customSystemPrompt: parsed.customSystemPrompt.length,
          systemPromptSpec: parsed.systemPromptSpec,
          rootPromptCount: parsed.rootPromptCount,
          rootPromptBytes: parsed.rootPromptBytes,
          historyMessages: parsed.history.length,
          historyChars: parsed.history.reduce((n, m) => n + (m.content || '').length, 0),
          storedHistoryMessages: (parsed.storedHistory || []).length,
          storedHistoryChars: (parsed.storedHistory || []).reduce((n, m) => n + (m.content || '').length, 0),
          ruleCount: parsed.rules.length,
          ruleChars: parsed.rules.reduce((n, r) => n + r.content.length, 0),
        },
      });
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      try {
        stream.write(adapter.endStreamError('internal', msg));
        stream.end();
      } catch (_) {}
      log({
        id, ts: new Date().toISOString(), dir: 'live-error', protocol: 'h2', url: reqPath,
        model: parsed.modelId, error: msg, ms: Date.now() - started,
        stack: String(e && e.stack ? e.stack : '').slice(0, 1600),
      });
    } finally {
      clearInterval(hb);
    }
  }
}

function handleFakeTurn(stream, hdrs, id, reqPath) {
  const started = Date.now();
  let reqBytes = 0;
  const chunks = [];

  stream.respond({
    ':status': 200,
    'content-type': 'application/connect+proto',
  });

  stream.on('data', (c) => {
    reqBytes += c.length;
    if (reqBytes <= MAX_CAPTURE) chunks.push(c);
  });

  const payload = fakeTurnFrames(FAKE_TEXT);
  setTimeout(() => {
    try {
      stream.write(payload);
      stream.end();
    } catch (_) {}
    const saved = saveBody(id, 'req', Buffer.concat(chunks));
    log({
      id, ts: new Date().toISOString(), dir: 'fake', protocol: 'h2',
      url: reqPath, bytes: reqBytes, saved, ms: Date.now() - started,
      text: FAKE_TEXT, frames: 3,
    });
  }, 250);
}


const LOG_DIR = path.join(DATA_DIR, 'logs');
const BODY_DIR = path.join(LOG_DIR, 'bodies');
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(BODY_DIR, { recursive: true });
const traffic = fs.createWriteStream(path.join(LOG_DIR, 'traffic.ndjson'), { flags: 'a' });

// A local proxy must never die on a single bad request; log and keep serving.
function fatal(kind, err) {
  try {
    fs.appendFileSync(path.join(LOG_DIR, 'fatal.ndjson'), JSON.stringify({
      ts: new Date().toISOString(), kind,
      error: String(err && err.message ? err.message : err),
      stack: String(err && err.stack ? err.stack : '').slice(0, 2000),
    }) + '\n');
  } catch (_) {}
}
process.on('uncaughtException', (e) => fatal('uncaughtException', e));
process.on('unhandledRejection', (e) => fatal('unhandledRejection', e));

let seq = 0;
const SECRET_HEADERS = new Set(['authorization', 'cookie', 'x-api-key', 'x-cursor-checksum', 'local-client-key']);
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade']);
const H2_FORBIDDEN = new Set([...HOP_BY_HOP, 'host', 'te']);

function redact(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SECRET_HEADERS.has(k.toLowerCase()) ? '<redacted>' : v;
  }
  return out;
}

function upstreamFor(url) {
  for (const [re, upstream] of ROUTES) if (re.test(url)) return upstream;
  return DEFAULT_UPSTREAM;
}

function log(obj) {
  traffic.write(JSON.stringify(obj) + '\n');
}

function saveBody(id, kind, buf) {
  if (!SAVE_BODIES) return false;
  if (buf.length && buf.length <= MAX_CAPTURE) {
    fs.writeFileSync(path.join(BODY_DIR, `${kind}-${id}.bin`), buf);
    return true;
  }
  return false;
}

// ---------------- upstream HTTP/2 sessions ----------------
const sessions = new Map();
function getSession(origin) {
  let s = sessions.get(origin);
  if (s && !s.closed && !s.destroyed) return s;
  s = http2.connect(origin);
  s.on('close', () => sessions.delete(origin));
  s.on('error', () => sessions.delete(origin));
  sessions.set(origin, s);
  return s;
}

// ---------------- local UI & health ----------------
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const STARTED_AT = Date.now();
const PKG = (() => {
  try { return require(path.join(__dirname, '..', '..', 'package.json')); } catch (_) { return { version: '0.0.0' }; }
})();

function sendJson(res, status, payload, headOnly = false) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': body.length,
  });
  if (!headOnly) res.end(body); else res.end();
}

function redactModel(model) {
  return {
    id: model.id,
    cursorId: model.cursorId,
    displayName: model.displayName,
    shortName: model.shortName,
    provider: model.provider,
    providerLabel: model.providerLabel,
    model: model.model,
    api: model.api,
    vendor: model.vendor,
    contextWindow: model.contextWindow,
    maxOutput: model.maxOutput,
    effort: model.effort,
    contextOptions: model.contextOptions,
    fast: model.fast,
    capabilities: model.capabilities,
    order: model.order,
    enabled: model.enabled,
  };
}

function statusPayload() {
  const config = currentConfig();
  return {
    ok: !!config,
    version: PKG.version,
    uptimeMs: Date.now() - STARTED_AT,
    configPath: CONFIG_PATH,
    configLoaded: !!config,
    configError: configService.error,
    warnings: configService.warnings,
    gateway: {
      host: HOST,
      port: PORT,
      upstream: DEFAULT_UPSTREAM,
      dataDir: DATA_DIR,
    },
    routing: config ? config.routing : null,
    providers: config
      ? Object.fromEntries(Object.entries(config.providers).map(([name, provider]) => [name, {
          type: provider.type,
          baseUrl: provider.baseUrl || provider.endpoint || '',
          configured: !!(providerApiKey(provider) || provider.accessKeyId),
        }]))
      : {},
    models: config ? config.models.map(redactModel) : [],
    selections: selections.snapshot(),
  };
}

function restartRequired(config) {
  const gateway = (config && config.gateway) || {};
  return {
    host: !HOST_EXPLICIT && gateway.host !== HOST,
    port: !PORT_EXPLICIT && Number(gateway.port || 43110) !== PORT,
    upstream: !UPSTREAM_EXPLICIT && (gateway.upstream || 'https://api2.cursor.sh') !== DEFAULT_UPSTREAM,
    dataDir: !DATA_DIR_EXPLICIT && !!gateway.dataDir && path.resolve(gateway.dataDir) !== path.resolve(DATA_DIR),
  };
}

function readJsonBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(new Error(`invalid JSON: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

function configPayload(extra = {}) {
  const redacted = configService.redacted();
  return {
    ...redacted,
    restartRequired: restartRequired(configService.config),
    gateway: { host: HOST, port: PORT, upstream: DEFAULT_UPSTREAM, dataDir: DATA_DIR },
    ...extra,
  };
}

function handleLocal(req, res) {
  let pathname;
  try {
    pathname = new URL(req.url, `http://${HOST}:${PORT}`).pathname;
  } catch (_) {
    return false;
  }
  const headOnly = req.method === 'HEAD';

  if (pathname === '/api/config') {
    if (req.method === 'GET' || req.method === 'HEAD') {
      sendJson(res, 200, configPayload(), headOnly);
      return true;
    }
    if (req.method === 'POST') {
      readJsonBody(req).then((body) => {
        const next = body && body.config ? body.config : body;
        try {
          const result = configService.save(next);
          applyConfig();
          log({
            id: ++seq, ts: new Date().toISOString(), dir: 'config-save',
            path: CONFIG_PATH, models: configService.config.models.length, backup: result.backup,
          });
          sendJson(res, 200, configPayload({ ok: true, backup: result.backup }));
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error && error.message ? error.message : error) });
        }
      }, (error) => {
        sendJson(res, 400, { ok: false, error: String(error && error.message ? error.message : error) });
      });
      return true;
    }
    res.writeHead(405, { allow: 'GET, HEAD, POST', 'content-type': 'text/plain; charset=utf-8' });
    res.end('method not allowed');
    return true;
  }

  if (pathname === '/api/config/reload' && req.method === 'POST') {
    const loaded = configService.load();
    if (!loaded) {
      sendJson(res, 400, { ok: false, error: configService.error });
      return true;
    }
    applyConfig();
    log({ id: ++seq, ts: new Date().toISOString(), dir: 'config-reload', path: CONFIG_PATH });
    sendJson(res, 200, configPayload({ ok: true }));
    return true;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  if (pathname === '/health' || pathname === '/api/status') {
    sendJson(res, currentConfig() ? 200 : 503, statusPayload(), headOnly);
    return true;
  }
  if (pathname === '/api/models') {
    const config = currentConfig();
    sendJson(res, 200, { models: config ? config.models.map(redactModel) : [] }, headOnly);
    return true;
  }
  if (pathname === '/favicon.ico') {
    res.writeHead(204); res.end();
    return true;
  }
  if (pathname === '/' || pathname === '/index.html') {
    let body;
    try {
      body = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'));
    } catch (_) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('AnyCursor web UI is not installed.');
      return true;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': body.length,
    });
    if (!headOnly) res.end(body); else res.end();
    return true;
  }
  return false;
}

// ---------------- HTTP/1.1 handler ----------------
const h1 = http.createServer((req, res) => {
  if (handleLocal(req, res)) return;
  const id = ++seq;
  const started = Date.now();
  const chunks = [];
  let size = 0;

  req.on('data', (c) => {
    size += c.length;
    if (size <= MAX_CAPTURE) chunks.push(c);
  });

  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const upstream = upstreamFor(req.url);
    let target;
    try {
      target = new URL(req.url, upstream);
    } catch (e) {
      res.writeHead(400).end('bad url');
      return;
    }

    const headers = { ...req.headers };
    for (const h of HOP_BY_HOP) delete headers[h];
    headers.host = target.host;
    delete headers['content-length'];
    if (body.length) headers['content-length'] = String(body.length);

    const saved = saveBody(id, 'req', body);
    log({
      id, ts: new Date().toISOString(), dir: 'req', protocol: 'h1',
      method: req.method, url: req.url, upstream: target.origin,
      contentType: headers['content-type'], bytes: body.length, saved,
      headers: redact(headers),
    });

    const pathOnly = target.pathname;
    const shouldTransform = pathOnly === '/aiserver.v1.AiService/AvailableModels';
    const up = https.request(target, { method: req.method, headers }, (upRes) => {
      if (!shouldTransform) {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        let rsize = 0;
        const rchunks = [];
        upRes.on('data', (c) => {
          rsize += c.length;
          if (rsize <= MAX_CAPTURE) rchunks.push(c);
          res.write(c);
        });
        upRes.on('end', () => {
          const rsaved = saveBody(id, 'res', Buffer.concat(rchunks));
          log({
            id, dir: 'res', protocol: 'h1', status: upRes.statusCode,
            ms: Date.now() - started, contentType: upRes.headers['content-type'],
            bytes: rsize, saved: rsaved,
          });
          res.end();
        });
        upRes.on('error', (e) => { log({ id, dir: 'res-error', error: String(e) }); res.destroy(e); });
        return;
      }

      let rsize = 0;
      const rchunks = [];
      upRes.on('data', (c) => {
        rsize += c.length;
        if (rsize <= MAX_CAPTURE) rchunks.push(c);
      });
      upRes.on('end', () => {
        const original = Buffer.concat(rchunks);
        let out = original;
        let merged = false;
        if (upRes.statusCode === 200 && currentConfig() && currentConfig().models.length) {
          try {
            const transformed = transformCatalog(
              original,
              upRes.headers,
              currentConfig().models,
              selectedModelIds(),
            );
            out = transformed.body;
            merged = true;
            log({
              id, ts: new Date().toISOString(), dir: 'catalog-merge', protocol: 'h1',
              url: req.url, models: transformed.models, encoding: transformed.encoding,
              nativeBytes: original.length, mergedBytes: out.length,
            });
          } catch (error) {
            log({
              id, ts: new Date().toISOString(), dir: 'catalog-merge-error', protocol: 'h1',
              url: req.url, error: String(error && error.message ? error.message : error),
            });
          }
        }
        const responseHeaders = { ...upRes.headers };
        delete responseHeaders['transfer-encoding'];
        responseHeaders['content-length'] = String(out.length);
        res.writeHead(upRes.statusCode || 502, responseHeaders);
        res.end(out);
        log({
          id, dir: 'res', protocol: 'h1', status: upRes.statusCode,
          ms: Date.now() - started, contentType: upRes.headers['content-type'],
          bytes: out.length, saved: saveBody(id, 'res', out), catalogMerged: merged,
        });
      });
      upRes.on('error', (e) => { log({ id, dir: 'res-error', error: String(e) }); res.destroy(e); });
    });

    up.on('error', (e) => {
      log({ id, dir: 'error', protocol: 'h1', error: String(e) });
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('cursor proxy upstream error: ' + e.message);
    });

    if (body.length) up.write(body);
    up.end();
  });
});

// ---------------- h2c handler ----------------
const h2 = http2.createServer();

function forwardH2(stream, hdrs, id, reqPath, prefix = Buffer.alloc(0)) {
  const started = Date.now();
  const method = hdrs[':method'] || 'POST';
  const upstream = upstreamFor(reqPath);
  let target;
  try {
    target = new URL(reqPath, upstream);
  } catch (e) {
    stream.respond({ ':status': 400 });
    stream.end('bad url');
    return;
  }

  const outHeaders = {};
  for (const [k, v] of Object.entries(hdrs)) {
    if (k.startsWith(':')) continue;
    if (H2_FORBIDDEN.has(k.toLowerCase())) continue;
    outHeaders[k] = v;
  }
  outHeaders[':method'] = method;
  outHeaders[':path'] = target.pathname + target.search;
  outHeaders[':authority'] = target.host;
  outHeaders[':scheme'] = 'https';

  const savedMeta = {
    id, ts: new Date().toISOString(), dir: 'req', protocol: 'h2',
    method, url: reqPath, upstream: target.origin,
    contentType: hdrs['content-type'], headers: redact(outHeaders),
  };
  log({ ...savedMeta, bytes: prefix.length, saved: false });

  let up;
  try {
    up = getSession(target.origin).request(outHeaders, { endStream: false });
  } catch (e) {
    log({ ...savedMeta, bytes: 0, saved: false, error: 'request failed: ' + e.message });
    stream.respond({ ':status': 502 });
    stream.end();
    return;
  }

  if (prefix.length && !up.destroyed) up.write(prefix);
  let reqBytes = prefix.length;
  let resBytes = 0;
  const reqChunks = prefix.length ? [prefix] : [];
  const resChunks = [];
  let responded = false;
  let resContentType = null;
  let resHeaders = null;

  up.on('response', (h) => {
    const rh = {};
    for (const [k, v] of Object.entries(h)) {
      if (!k.startsWith(':')) rh[k] = v;
    }
    responded = true;
    resContentType = h['content-type'] || null;
    resHeaders = rh;
    stream.respond({ ':status': h[':status'] || 502, ...rh });
  });

  up.on('trailers', (t) => {
    try { stream.sendTrailers(t); } catch (_) {}
  });

  up.on('data', (c) => {
    resBytes += c.length;
    if (resBytes <= MAX_CAPTURE) resChunks.push(c);
    stream.write(c);
  });

  up.on('end', () => {
    const rsaved = saveBody(id, 'res', Buffer.concat(resChunks));
    log({
      ...savedMeta, bytes: reqBytes, reqSaved: saveBody(id, 'req', Buffer.concat(reqChunks)),
      dir: 'res', status: responded ? 'stream' : null,
      ms: Date.now() - started, contentType: resContentType, resHeaders,
      resBytes, saved: rsaved,
    });
    try { stream.end(); } catch (_) {}
  });

  up.on('error', (e) => {
    log({ ...savedMeta, bytes: reqBytes, dir: 'error', protocol: 'h2', error: String(e) });
    try { stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR); } catch (_) {}
  });

  stream.on('data', (c) => {
    reqBytes += c.length;
    if (reqBytes <= MAX_CAPTURE) reqChunks.push(c);
    if (!up.destroyed) up.write(c);
  });

  stream.on('end', () => {
    if (!up.destroyed) up.end();
  });

  stream.on('error', () => {
    try { up.close(); } catch (_) {}
  });
}

function routeAgentRun(stream, hdrs, id, reqPath) {
  let prefix = Buffer.alloc(0);
  let decided = false;
  let timer;
  const onData = (chunk) => {
    prefix = Buffer.concat([prefix, chunk]);
    const frame = adapter.nextFrame(prefix);
    if (!frame) return;
    const parsed = adapter.parseRunPayload(frame.payload);
    if (!parsed) return;
    decided = true;
    clearTimeout(timer);
    stream.pause();
    stream.removeListener('data', onData);
    const resolved = registry ? registry.resolve(parsed.modelId) : { route: 'native' };
    if (resolved.route === 'byok') {
      stream.unshift(prefix);
      handleLiveTurn(stream, hdrs, id, reqPath);
    } else if (resolved.route === 'error') {
      stream.respond({ ':status': 503, 'content-type': 'text/plain; charset=utf-8' });
      stream.end(resolved.reason || 'unknown model');
    } else {
      forwardH2(stream, hdrs, id, reqPath, prefix);
    }
    stream.resume();
  };
  timer = setTimeout(() => {
    if (decided) return;
    decided = true;
    stream.removeListener('data', onData);
    stream.pause();
    forwardH2(stream, hdrs, id, reqPath, prefix);
    stream.resume();
  }, 5000);
  stream.on('data', onData);
  stream.on('error', () => clearTimeout(timer));
}

h2.on('stream', (stream, hdrs) => {
  const id = ++seq;
  const reqPath = hdrs[':path'] || '/';

  if (reqPath === '/aiserver.v1.InferenceService/RunInference' && registry) {
    inference.handleRunInference(stream, hdrs, id, reqPath, {
      forward: (prefix) => forwardH2(stream, hdrs, id, reqPath, prefix),
      resolve: (modelId) => registry.resolve(modelId),
      prepare: (model) => prepareInferenceModel(model),
      log,
    });
    return;
  }

  if (reqPath.startsWith('/agent.v1.AgentService/Run') && registry && !FAKE_TURN) {
    routeAgentRun(stream, hdrs, id, reqPath);
    return;
  }

  if (LIVE_TURN && reqPath.startsWith('/agent.v1.AgentService/Run')) {
    handleLiveTurn(stream, hdrs, id, reqPath);
    return;
  }

  if (FAKE_TURN && reqPath.startsWith('/agent.v1.AgentService/Run')) {
    handleFakeTurn(stream, hdrs, id, reqPath);
    return;
  }

  forwardH2(stream, hdrs, id, reqPath);
});

// ---------------- protocol multiplexer ----------------
const server = net.createServer((socket) => {
  socket.once('data', (buf) => {
    socket.pause();
    socket.unshift(buf);
    const isH2 = buf.length >= 3 && buf[0] === 0x50 && buf[1] === 0x52 && buf[2] === 0x49; // "PRI"
    if (isH2) h2.emit('connection', socket);
    else h1.emit('connection', socket);
    process.nextTick(() => socket.resume());
  });
  socket.on('error', () => {});
});

let started = false;
function start() {
  if (started) return Promise.resolve({ host: HOST, port: PORT });
  started = true;
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      started = false;
      reject(error);
    };
    server.once('error', onError);
    server.listen(PORT, HOST, () => {
      server.removeListener('error', onError);
      console.log(`[anycursor] listening on http://${HOST}:${PORT} (h1 + h2c)`);
      console.log(`[anycursor] default upstream: ${DEFAULT_UPSTREAM}`);
      console.log(`[anycursor] config: ${CONFIG_PATH}${configService.config ? '' : ' (not loaded)'}`);
      console.log(`[anycursor] logs: ${LOG_DIR}`);
      resolve({ host: HOST, port: PORT });
    });
  });
}

if (require.main === module) {
  start().catch((error) => {
    console.error('[anycursor] failed to start:', error.message);
    process.exit(1);
  });
}

process.on('SIGINT', () => {
  traffic.end(() => process.exit(0));
});

module.exports = {
  start,
  server,
  configService,
  getConfig: () => configService.config,
  getRegistry: () => registry,
  reloadConfig: () => { configService.load(); return applyConfig(); },
  getStatus: () => statusPayload(),
  configPath: CONFIG_PATH,
};
