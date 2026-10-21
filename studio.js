// 设置面板：选择物品 / 配置 AI 接口 / 用一句话生成新的 3D 时间物品
import { parse as parseJs } from '/vendor/acorn/acorn.mjs';
const ts = window.timespell;
const LS_AI = 'timespell.ai', LS_OBJ = 'timespell.object';
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ai = Object.assign({ base: 'https://api.deepseek.com', key: '', model: 'deepseek-chat', maxTokens: 64000 }, load(LS_AI, {}));

document.head.insertAdjacentHTML('beforeend', `<style>
  #stBtn { position: fixed; left: 12px; top: 12px; z-index: 20; background: rgba(0,0,0,.55); color: #d7ffe1; border: 1px solid rgba(120,255,170,.4);
    border-radius: 8px; padding: 6px 12px; font: 13px system-ui, "Microsoft YaHei", sans-serif; cursor: pointer; }
  #stBtn:hover { background: rgba(20,60,35,.7); }
  #stPanel { position: fixed; left: 12px; top: 52px; z-index: 20; width: min(380px, calc(100vw - 24px)); max-height: calc(100vh - 70px); overflow: auto;
    background: rgba(6,14,10,.92); color: #d7ffe1; border: 1px solid rgba(120,255,170,.3); border-radius: 12px; padding: 14px 16px;
    font: 13px/1.5 system-ui, "Microsoft YaHei", sans-serif; box-shadow: 0 10px 40px rgba(0,0,0,.5); }
  #stPanel[hidden] { display: none; }
  #stPanel h3 { margin: 14px 0 8px; font-size: 13px; color: #8dffb2; font-weight: 600; letter-spacing: .04em; }
  #stPanel h3:first-child { margin-top: 0; }
  #stPanel label { display: block; margin: 8px 0 3px; color: #a9cdb4; font-size: 12px; }
  #stPanel input, #stPanel select, #stPanel textarea { width: 100%; box-sizing: border-box; background: #0b1a12; color: #e8fff0;
    border: 1px solid #24432f; border-radius: 6px; padding: 6px 8px; font: inherit; }
  #stPanel textarea { min-height: 64px; resize: vertical; }
  #stPanel input:focus, #stPanel select:focus, #stPanel textarea:focus { outline: none; border-color: #4dff88; }
  #stPanel .row { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
  #stPanel .row > * { flex: 1; }
  #stPanel button.b { background: #154b2a; color: #e8fff0; border: 1px solid #2f8a52; border-radius: 6px; padding: 6px 10px; font: inherit; cursor: pointer; }
  #stPanel button.b:hover { background: #1c6136; }
  #stPanel button.b:disabled { opacity: .45; cursor: default; }
  #stPanel button.ghost { background: transparent; border-color: #2a4a36; color: #a9cdb4; }
  #stPanel .note { color: #7fa38b; font-size: 11.5px; margin-top: 6px; }
  #stPanel .status { margin-top: 8px; padding: 8px; border-radius: 6px; background: #0b1a12; font-size: 12px; white-space: pre-wrap; display: none; }
  #stPanel .status.show { display: block; }
  #stPanel .status.err { color: #ffb4a2; }
  #stPanel .status.ok { color: #9dffbe; }
</style>`);

document.body.insertAdjacentHTML('beforeend', `
<button id="stBtn" type="button">⚙ 物品与 AI</button>
<div id="stPanel" hidden>
  <h3>当前物品</h3>
  <select id="stObj"></select>
  <div class="note" id="stObjNote" style="white-space: pre-line"></div>

  <h3>AI 接口（兼容 OpenAI 格式）</h3>
  <label for="stBase">API 地址</label>
  <input id="stBase" placeholder="https://api.deepseek.com" autocomplete="off">
  <label for="stKey">API Key</label>
  <div class="row"><input id="stKey" type="password" placeholder="sk-..." autocomplete="off"><button class="b ghost" id="stShow" type="button" style="flex:0 0 auto">显示</button></div>
  <label for="stModel">模型</label>
  <input id="stModel" list="stModels" placeholder="deepseek-chat" autocomplete="off"><datalist id="stModels"></datalist>
  <label for="stMax">最大输出 token（带思考的模型要给足，建议 64000 以上）</label>
  <input id="stMax" type="number" min="4000" step="1000">
  <div class="row"><button class="b" id="stTest" type="button">测试连接</button><button class="b ghost" id="stSave" type="button">保存</button></div>
  <div class="note">Key 只保存在这台电脑的浏览器里，经本机 server.py 转发给你填写的地址，不会写进项目文件。生成的物品运行在沙箱里，读不到 Key。</div>
  <div class="status" id="stApiStatus"></div>

  <h3>生成新物品</h3>
  <label for="stDesc">描述你的物品，以及它的过去和未来（可选）</label>
  <textarea id="stDesc" placeholder="例如：一根点燃的白蜡烛。过去：蜂巢 → 蜡块 → 新蜡烛；未来：越烧越短 → 蜡泪堆积 → 熄灭冒烟"></textarea>
  <div class="row"><button class="b" id="stGen" type="button">生成</button><button class="b ghost" id="stStop" type="button" disabled>取消</button></div>
  <div class="note">一次生成约 1–5 分钟，取决于模型是否带思考过程。生成的文件保存在 objects/user/，可以直接分享或提交到仓库。</div>
  <div class="status" id="stGenStatus"></div>
</div>`);

const $ = id => document.getElementById(id);
const panel = $('stPanel');
// 面板里的滚轮和按键不能漏给主页面（滚轮会拨时间，M/B/D 是快捷键）
['wheel', 'keydown', 'pointerdown'].forEach(ev => panel.addEventListener(ev, e => e.stopPropagation()));
$('stBtn').onclick = () => { panel.hidden = !panel.hidden; };

function status(el, text, kind = '') { el.textContent = text; el.className = 'status show ' + kind; }

// ---------- 物品列表 ----------
let objects = [];
async function refreshObjects(selectId) {
  let list = null;
  try { const r = await fetch('api/objects'); if (r.ok) list = await r.json(); } catch {}
  // 没有 server.py（纯静态托管）时直接读物品清单，此时不能生成新物品
  if (!list) {
    try { list = { builtin: await (await fetch('objects/index.json')).json(), user: [] }; } catch { list = { builtin: [], user: [] }; }
  }
  objects = [...list.builtin.map(o => ({ ...o, group: '内置' })), ...list.user.map(o => ({ ...o, group: '我生成的' }))];
  const groups = ['内置', '我生成的'].map(g => {
    const items = objects.filter(o => o.group === g);
    return items.length ? `<optgroup label="${g}">${items.map(o => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</optgroup>` : '';
  });
  $('stObj').innerHTML = groups.join('');
  const want = selectId || load(LS_OBJ, 'apple3d');
  $('stObj').value = objects.some(o => o.id === want) ? want : objects[0]?.id;
}
function applyObject() {
  const o = objects.find(x => x.id === $('stObj').value);
  if (!o) return;
  save(LS_OBJ, o.id);
  $('stObjNote').textContent = [o.prompt && '描述：' + o.prompt, o.model && '模型：' + o.model, o.note].filter(Boolean).join('\n') || o.src;
  ts.setObject(o);
}
$('stObj').onchange = applyObject;

// ---------- AI 设置 ----------
function fillAi() { $('stBase').value = ai.base; $('stKey').value = ai.key; $('stModel').value = ai.model; $('stMax').value = ai.maxTokens; }
function readAi() {
  Object.assign(ai, { base: $('stBase').value.trim(), key: $('stKey').value.trim(), model: $('stModel').value.trim(), maxTokens: Math.max(4000, +$('stMax').value || 64000) });
  save(LS_AI, ai);
}
$('stShow').onclick = () => { const k = $('stKey'); k.type = k.type === 'password' ? 'text' : 'password'; $('stShow').textContent = k.type === 'password' ? '显示' : '隐藏'; };
$('stSave').onclick = () => { readAi(); status($('stApiStatus'), '已保存', 'ok'); };
$('stTest').onclick = async () => {
  readAi();
  status($('stApiStatus'), '连接中…');
  try {
    const r = await fetch('api/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base: ai.base, key: ai.key }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
    const ids = (d.data || []).map(m => m.id).filter(Boolean);
    $('stModels').innerHTML = ids.map(id => `<option value="${esc(id)}">`).join('');
    // 有的网关模型列表不需要 Key，再发一个最小对话请求，才能确认 Key 和模型都可用
    status($('stApiStatus'), `找到 ${ids.length} 个模型，正在验证 Key 和模型…`);
    const c = await fetch('api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base: ai.base, key: ai.key, body: { model: ai.model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] } }) });
    const cd = await c.json().catch(() => ({}));
    if (!c.ok) throw new Error(`模型「${ai.model}」调用失败：${String(cd.error || 'HTTP ' + c.status).slice(0, 300)}`);
    status($('stApiStatus'), `连接成功：Key 有效，模型「${ai.model}」可用（共 ${ids.length} 个模型可选）`, 'ok');
  } catch (e) {
    status($('stApiStatus'), '连接失败：' + e.message + (e instanceof TypeError ? '\n连不上本机服务，请用 start.bat（server.py）启动' : ''), 'err');
  }
};

// ---------- 生成 ----------
let abort = null;
const THREE_CDN = /https?:\/\/(cdn\.jsdelivr\.net|unpkg\.com|esm\.sh|cdnjs\.cloudflare\.com)\/[^"'\s]*three(@[\d.]+)?\/build\/three\.module(\.min)?\.js/g;
function checkHtml(html) {
  const fixes = [], warns = [];
  if (html.match(THREE_CDN)) { html = html.replace(THREE_CDN, '/vendor/three/three.module.js'); fixes.push('three.js CDN 地址已改成本地'); }
  if (!html.includes('/vendor/three/three.module.js')) warns.push('没有按要求从 /vendor/three/three.module.js 引入 three.js');
  if (!/setTime\s*=|function\s+setTime/.test(html)) warns.push('没有找到 setTime');
  if (!/appendChild\([^)]*domElement|getElementById\([^)]*\)\.appendChild|canvas:\s*\w/.test(html)) warns.push('没有把渲染画布加进页面（appendChild(renderer.domElement)），可能什么都看不到');
  if (!html.includes('timespell:setTime')) warns.push('没有监听 timespell:setTime 消息，法阵将无法驱动它');
  if (/addons|examples\/jsm/.test(html)) warns.push('用了 three 的 addons 模块，本地没有，可能加载失败');
  if (/\bfetch\(|XMLHttpRequest|WebSocket|localStorage/.test(html)) warns.push('代码里有网络或存储调用，沙箱中会失败');
  if (/Math\.random\(|Date\.now\(|performance\.now\(\)/.test(html)) warns.push('用了随机数或时钟，往回拨可能无法精确复原');
  return { html, fixes, warns };
}
// 流式调用模型，返回最终正文；onProgress(思考字数, 正文字数)
async function callModel(messages, onProgress) {
  const body = { model: ai.model, max_tokens: ai.maxTokens, stream: true, messages };
  const r = await fetch('api/chat', { method: 'POST', signal: abort.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base: ai.base, key: ai.key, body }) });
  if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'HTTP ' + r.status); }
  let reasoning = 0, content = '', finish = '';
  if ((r.headers.get('Content-Type') || '').includes('json')) {
    const d = await r.json();
    return { content: d.choices?.[0]?.message?.content || '', finish: d.choices?.[0]?.finish_reason || '' };
  }
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let j; try { j = JSON.parse(data); } catch { continue; }
      const c = j.choices?.[0];
      if (!c) continue;
      reasoning += (c.delta?.reasoning_content || '').length;
      content += c.delta?.content || '';
      if (c.finish_reason) finish = c.finish_reason;
    }
    onProgress(reasoning, content.length);
  }
  return { content, finish };
}

// 解析每段 <script type="module">，返回第一个语法错误（行号相对整个 HTML）
function syntaxError(html) {
  const re = /<script\b[^>]*type=["']module["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (let m; (m = re.exec(html));) {
    const code = m[1], startLine = html.slice(0, m.index + m[0].indexOf(code)).split('\n').length;
    try { parseJs(code, { ecmaVersion: 'latest', sourceType: 'module' }); }
    catch (e) {
      const line = startLine + (e.loc?.line || 1) - 1, all = html.split('\n');
      const context = all.slice(Math.max(0, line - 5), line + 4).map((l, i) => `${Math.max(1, line - 4) + i}: ${l}`).join('\n');
      return { line, msg: e.message.replace(/\s*\(\d+:\d+\)$/, ''), context };
    }
  }
  return null;
}
// 只让模型返回要替换的片段，不重写整个文件
async function repair(html, err, onProgress) {
  const { content } = await callModel([
    { role: 'system', content: '你是 JavaScript 修复助手。只输出 JSON 数组，不要任何解释或代码块标记。' },
    { role: 'user', content: `下面这段 three.js 页面代码第 ${err.line} 行有语法错误：${err.msg}\n\n出错位置附近（行号: 内容）：\n${err.context}\n\n` +
      '请只修这一处，返回 JSON 数组：[{"find": "出错的原文片段（必须逐字出现在代码里，不要带行号）", "replace": "修正后的片段"}]' }], onProgress);
  const json = content.slice(content.indexOf('['), content.lastIndexOf(']') + 1);
  const patches = JSON.parse(json);
  let applied = 0;
  for (const p of Array.isArray(patches) ? patches : []) {
    if (typeof p.find === 'string' && p.find && html.includes(p.find)) { html = html.replace(p.find, String(p.replace ?? '')); applied++; }
  }
  if (!applied) throw new Error('修复补丁对不上原文');
  return html;
}

async function generate() {
  readAi();
  const desc = $('stDesc').value.trim();
  const st = $('stGenStatus');
  if (!desc) return status(st, '先写一句物品描述', 'err');
  if (!ai.base || !ai.model) return status(st, '先在上面填好 API 地址和模型', 'err');
  $('stGen').disabled = true; $('stStop').disabled = false;
  abort = new AbortController();
  const t0 = performance.now(), sec = () => ((performance.now() - t0) / 1000).toFixed(0);
  try {
    const tpl = await (await fetch('prompts/object_task.md')).text();
    status(st, '请求中…');
    const { content, finish } = await callModel([
      { role: 'system', content: '你是资深 three.js 图形工程师。只输出一个完整的 ```html 代码块，然后用一句话说明阶段设计。' },
      { role: 'user', content: tpl.replaceAll('{{OBJECT}}', desc) }],
      (r, c) => status(st, c ? `写代码中… ${c.toLocaleString()} 字 · ${sec()}s` : `思考中… ${r.toLocaleString()} 字 · ${sec()}s`));
    const m = content.match(/```html\s*([\s\S]*?)```/) || content.match(/(<!doctype html[\s\S]*<\/html>)/i);
    if (!m) throw new Error(finish === 'length' ? '输出被截断（max_tokens 不够，思考过程用光了额度）。把「最大输出 token」调大后重试' : '回复里没有找到 HTML 代码');
    let { html, fixes, warns } = checkHtml(m[1].trim());
    // 大模型偶尔会在代码里混进乱码 token，先解析语法，坏了就让它只修出错的那几行
    for (let round = 1; ; round++) {
      const err = syntaxError(html);
      if (!err) break;
      if (round > 2) { warns.push(`第 ${err.line} 行语法错误未能自动修复：${err.msg}`); break; }
      status(st, `发现语法错误（第 ${err.line} 行：${err.msg}），自动修复第 ${round} 轮…`);
      try {
        html = await repair(html, err, (r, c) => status(st, `自动修复第 ${round} 轮（第 ${err.line} 行）… ${sec()}s`));
        fixes.push(`第 ${err.line} 行语法错误：${err.msg}`);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        warns.push(`第 ${err.line} 行语法错误，自动修复失败：${e.message}`); break;
      }
    }
    const name = desc.split(/[。.,，\n]/)[0].slice(0, 20) || '新物品';
    const sr = await fetch('api/objects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, html, prompt: desc, model: ai.model }) });
    const saved = await sr.json();
    if (!sr.ok) throw new Error(saved.error || '保存失败');
    await refreshObjects(saved.id); applyObject();
    const note = content.slice(content.lastIndexOf('```') + 3).trim().slice(0, 300);
    status(st, [`完成，用时 ${sec()}s，已载入「${name}」`, note, ...fixes.map(f => '已修正：' + f), ...warns.map(w => '注意：' + w)].filter(Boolean).join('\n'), warns.length ? '' : 'ok');
  } catch (e) {
    status(st, e.name === 'AbortError' ? '已取消' : '生成失败：' + e.message, 'err');
  } finally {
    $('stGen').disabled = false; $('stStop').disabled = true; abort = null;
  }
}
$('stGen').onclick = generate;
$('stStop').onclick = () => abort?.abort();

fillAi();
await refreshObjects();
const urlObject = new URLSearchParams(location.search).get('object');
if (urlObject) {
  // 地址栏用 ?object= 指定了物品：index.html 已经载入它，这里只同步下拉框
  const hit = objects.find(o => o.src === urlObject.replace(/^\.?\//, ''));
  if (hit) { $('stObj').value = hit.id; $('stObjNote').textContent = hit.prompt ? '描述：' + hit.prompt : hit.src; }
} else applyObject();
// 自动化测试入口
window.__studioTest = { syntaxError, async repairOnce(html) { abort = new AbortController(); try { return await repair(html, syntaxError(html), () => {}); } finally { abort = null; } } };
