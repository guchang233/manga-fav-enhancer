// ==UserScript==
// @name         漫画收藏增强助手 (Manga Favorites Enhancer)
// @namespace    https://github.com/local/manga-fav-enhancer
// @version      3.0.0
// @description  为缺少收藏搜索/分类功能的漫画平台提供"收藏库"：点 📚 打开独立的弹窗窗口（原生窗口，可最小化/并排），左侧标签分类 + 关键字搜索 + 封面网格，支持自建标签、批量打标。精确选择器预设防误抓。
// @author       gc
// @match        *://*/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /* ================================================================
   * 存储层（localStorage，按站点主机名分库；弹窗同源可直接共享）
   * ================================================================ */

  const LS_PREFIX = 'mfe:';
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(LS_PREFIX + key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch { return fallback; }
    },
    set(key, val) { localStorage.setItem(LS_PREFIX + key, JSON.stringify(val)); },
    del(key) { localStorage.removeItem(LS_PREFIX + key); },
  };

  const siteKey = () => location.hostname;
  const dataKey = () => `data:${siteKey()}`;
  const cfgKey = () => `cfg:${siteKey()}`;

  const loadEntries = () => store.get(dataKey(), {});
  const saveEntries = (e) => store.set(dataKey(), e);

  /* ================================================================
   * 站点预设：精确选择器，命中预设就不乱抓
   * ================================================================ */

  const PRESETS = [
    {
      name: '18comic / JM 系',
      hostRe: /(^|\.)(18comic|jmcomic|jm)\w*\.[a-z.]+$/i,
      cfg: {
        item: 'div[id^="favorites_album_"]',
        link: 'a[href*="album"]',
        cover: 'img.img-responsive',
        title: '.video-title',
        tags: '',
        author: '',
        next: '',
        urlPattern: '/album/',
      },
    },
  ];

  const DEFAULT_CFG = {
    item: '', title: '', link: '', cover: '', tags: '', author: '', next: '',
    urlPattern: '(album|comic|book|manga|manhua|detail|gallery)',
    allowGeneric: true,
    crawlDelay: 800,
    maxCrawl: 20,
  };

  function getPreset() {
    return PRESETS.find(p => p.hostRe.test(siteKey())) || null;
  }

  function getCfg() {
    const preset = getPreset();
    return Object.assign({}, DEFAULT_CFG, preset ? preset.cfg : {}, store.get(cfgKey(), {}));
  }

  /* ================================================================
   * 数据提取与抓取（运行在主页面上下文，弹窗通过 __MFE__ API 调用）
   * ================================================================ */

  function extractEntry(item, cfg) {
    const q = (sel, root) => (sel ? (root || item).querySelector(sel) : null);

    const link = cfg.link ? q(cfg.link) : (item.matches('a[href]') ? item : item.querySelector('a[href]'));
    if (!link) return null;
    const url = link.href.split('#')[0];
    if (!url) return null;

    const coverEl = q(cfg.cover) || item.querySelector('img');
    const cover = coverEl
      ? (coverEl.getAttribute('data-src') || coverEl.getAttribute('data-original')
        || coverEl.getAttribute('data-lazy-src') || coverEl.src || '')
      : '';

    let title = '';
    const titleEl = q(cfg.title);
    if (titleEl) title = titleEl.getAttribute('title') || titleEl.textContent.trim();
    if (!title) title = link.getAttribute('title') || link.textContent.trim();
    if (!title && coverEl) title = coverEl.alt || coverEl.title || '';
    if (!title) return null;

    let tags = [];
    const tagEls = cfg.tags ? Array.from(item.querySelectorAll(cfg.tags)) : [];
    tags = tagEls.map(e => e.textContent.trim()).filter(t => t && t.length <= 16);

    let author = '';
    const authorEl = q(cfg.author) || item.querySelector('[class*="author" i],[class*="artist" i]');
    if (authorEl) author = authorEl.textContent.trim().slice(0, 40);

    return { url, title, cover, tags, userTags: [], author, firstSeen: Date.now(), lastSeen: Date.now() };
  }

  function heuristicItems(doc) {
    const cfg = getCfg();
    let re;
    try { re = new RegExp(cfg.urlPattern, 'i'); } catch { re = /(album|comic|book|manga|manhua|detail|gallery)/i; }
    const base = doc.baseURI || location.href;
    const links = Array.from(doc.querySelectorAll('a[href]')).filter(a => {
      try {
        const u = new URL(a.getAttribute('href'), base);
        return re.test(u.pathname) || re.test(u.href);
      } catch { return false; }
    });
    const items = [];
    const seen = new Set();
    for (const a of links) {
      let node = a;
      for (let i = 0; i < 6 && node.parentElement; i++) {
        node = node.parentElement;
        if (node.querySelector('img')) break;
      }
      if (!node || node === doc.body || seen.has(node)) continue;
      seen.add(node);
      items.push(node);
    }
    return items.length >= 4 ? items : [];
  }

  function itemsOnDoc(doc) {
    const cfg = getCfg();
    if (cfg.item) return Array.from(doc.querySelectorAll(cfg.item));
    if (cfg.allowGeneric) return heuristicItems(doc);
    return [];
  }

  function mergeEntry(entries, e) {
    const old = entries[e.url];
    if (old) {
      e.firstSeen = old.firstSeen;
      e.userTags = old.userTags || [];
      e.cover = e.cover || old.cover;
      e.author = e.author || old.author;
      if (old.tags.length > e.tags.length) e.tags = old.tags;
      return false;
    }
    return true;
  }

  function scanPage() {
    const cfg = getCfg();
    const items = itemsOnDoc(document);
    const entries = loadEntries();
    let added = 0, found = 0;
    for (const it of items) {
      const e = extractEntry(it, cfg);
      if (!e) continue;
      found++;
      if (mergeEntry(entries, e)) added++;
      entries[e.url] = e;
    }
    saveEntries(entries);
    return { found, added };
  }

  async function crawlNextPage(pageUrl) {
    const cfg = getCfg();
    const res = await fetch(pageUrl, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const items = itemsOnDoc(doc);
    const entries = loadEntries();
    let added = 0, found = 0;
    for (const it of items) {
      const e = extractEntry(it, cfg);
      if (!e) continue;
      if (!/^https?:/.test(e.url)) {
        try { e.url = new URL(e.url, doc.baseURI || pageUrl).href; } catch { continue; }
      }
      found++;
      if (mergeEntry(entries, e)) added++;
      entries[e.url] = e;
    }
    saveEntries(entries);

    let next = cfg.next ? doc.querySelector(cfg.next) : null;
    if (!next) {
      next = Array.from(doc.querySelectorAll('a[href]')).find(a => {
        const t = (a.textContent || '').trim();
        return t === '下一页' || /^(next|›|»|>>)/i.test(t);
      });
    }
    let nextUrl = '';
    if (next) {
      try { nextUrl = new URL(next.getAttribute('href'), pageUrl).href; } catch { nextUrl = ''; }
      if (nextUrl.split('#')[0] === pageUrl.split('#')[0]) nextUrl = '';
    }
    return { found, added, nextUrl };
  }

  function testPage(cfg) {
    const items = cfg.item
      ? Array.from(document.querySelectorAll(cfg.item))
      : (cfg.allowGeneric ? heuristicItems(document) : []);
    const ok = items.map(it => extractEntry(it, cfg)).filter(Boolean);
    return {
      containers: items.length,
      ok: ok.length,
      first: ok[0] ? ok[0].title + ' | ' + ok[0].cover.slice(0, 60) : '—',
    };
  }

  // 弹窗同源可直接调用的 API（抓取必须在主页面的 DOM 上执行）
  window.__MFE__ = {
    siteKey, getPreset, getCfg,
    loadEntries, saveEntries, store,
    scanPage, crawlNextPage, testPage,
  };

  /* ================================================================
   * 📚 启动按钮（可拖动，位置记忆；点击打开独立弹窗）
   * ================================================================ */

  const LAUNCHER_CSS = `
    .launcher {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483646;
      width: 42px; height: 42px; border-radius: 50%; border: none; cursor: grab;
      background: #7c5cff; color: #fff; font-size: 20px;
      box-shadow: 0 4px 14px rgba(0,0,0,.4);
      touch-action: none; user-select: none;
    }
    .launcher:active { cursor: grabbing; }
  `;

  function loadGeom(key, def) {
    return Object.assign({}, def, store.get(key, {}));
  }

  function ensureLauncher() {
    if (document.getElementById('mfe-host')) return;
    const host = document.createElement('div');
    host.id = 'mfe-host';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = LAUNCHER_CSS;
    const btn = document.createElement('button');
    btn.className = 'launcher';
    btn.textContent = '📚';
    btn.title = '收藏库（拖动移动，点击打开）';

    const geom = loadGeom('ui:launcher', {});
    if (geom.left != null) {
      btn.style.left = geom.left + 'px';
      btn.style.top = geom.top + 'px';
      btn.style.right = 'auto';
      btn.style.bottom = 'auto';
    }

    let drag = null;
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const r = btn.getBoundingClientRect();
      drag = { sx: e.clientX, sy: e.clientY, ox: e.clientX - r.left, oy: e.clientY - r.top, moved: false };
      btn.setPointerCapture(e.pointerId);
    });
    btn.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 4) return;
      drag.moved = true;
      const x = Math.min(Math.max(e.clientX - drag.ox, 0), innerWidth - btn.offsetWidth);
      const y = Math.min(Math.max(e.clientY - drag.oy, 0), innerHeight - btn.offsetHeight);
      btn.style.left = x + 'px';
      btn.style.top = y + 'px';
      btn.style.right = 'auto';
      btn.style.bottom = 'auto';
    });
    btn.addEventListener('pointerup', (e) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      try { btn.releasePointerCapture(e.pointerId); } catch { /* noop */ }
      if (d.moved) {
        store.set('ui:launcher', { left: parseInt(btn.style.left, 10), top: parseInt(btn.style.top, 10) });
      } else {
        openPopup();
      }
    });

    shadow.append(style, btn);
    document.documentElement.appendChild(host);
  }

  /* ================================================================
   * 独立弹窗窗口（window.open 原生窗口）
   * ================================================================ */

  function openPopup() {
    const g = loadGeom('ui:win', {});
    const W = g.width || 880, H = g.height || 620;
    const left = g.left != null ? g.left : Math.max(0, Math.round((screen.width - W) / 2));
    const top = g.top != null ? g.top : Math.max(0, Math.round((screen.height - H) / 2));
    const win = window.open('', 'mfe_library',
      `popup=yes,width=${W},height=${H},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no`);
    if (!win) {
      alert('弹窗被浏览器拦截了，请允许本站弹出窗口后重试。');
      return;
    }
    win.document.open();
    win.document.write(popupHtml());
    win.document.close();
    win.focus();
  }

  function popupHtml() {
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>📚 收藏库</title>
<style>
  * { box-sizing: border-box; font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; }
  html, body { margin: 0; height: 100%; }
  body { background: #14151a; color: #e6e6e9; display: flex; flex-direction: column; overflow: hidden; }
  .top {
    display: flex; align-items: center; gap: 10px; padding: 10px 14px;
    background: #1e1f26; border-bottom: 1px solid #30313a; flex-shrink: 0;
  }
  .top b { font-size: 15px; white-space: nowrap; }
  .top .site { font-size: 11px; color: #7a7b85; }
  .top input[type=text] {
    flex: 1; min-width: 120px; background: #101116; border: 1px solid #3a3b44; color: #e6e6e9;
    border-radius: 7px; padding: 7px 12px; font-size: 13px; outline: none;
  }
  .top input[type=text]:focus { border-color: #7c5cff; }
  .btn {
    border: 1px solid #4a4b55; background: #2c2d35; color: #e6e6e9; border-radius: 6px;
    padding: 5px 12px; font-size: 12px; cursor: pointer; white-space: nowrap;
  }
  .btn:hover { background: #383943; }
  .btn.primary { background: #7c5cff; border-color: #7c5cff; }
  .btn.primary:hover { background: #6a4be0; }
  .btn.danger { color: #ff8484; }
  .top select {
    background: #101116; color: #e6e6e9; border: 1px solid #3a3b44; border-radius: 6px;
    padding: 6px 8px; font-size: 12px; outline: none;
  }
  .body { display: flex; flex: 1; min-height: 0; }
  .side {
    width: 190px; flex-shrink: 0; background: #1a1b21; border-right: 1px solid #30313a;
    overflow-y: auto; padding: 10px 8px;
  }
  .side h4 { margin: 6px 6px 8px; font-size: 11px; color: #7a7b85; font-weight: 600; letter-spacing: .05em; }
  .cat {
    display: flex; align-items: center; justify-content: space-between;
    padding: 7px 10px; border-radius: 7px; cursor: pointer; font-size: 13px; color: #c9cad2;
    margin-bottom: 2px; user-select: none;
  }
  .cat:hover { background: #24252d; }
  .cat.on { background: #7c5cff; color: #fff; }
  .cat .n { font-size: 11px; opacity: .65; }
  .main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .status { padding: 6px 16px; font-size: 12px; color: #8d8e99; min-height: 24px; flex-shrink: 0; }
  .status.err { color: #ff7a7a; }
  .grid {
    flex: 1; overflow-y: auto; padding: 4px 16px 80px;
    display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 14px; align-content: start;
  }
  .card {
    cursor: pointer; border-radius: 10px; overflow: hidden; background: #1e1f26;
    position: relative; border: 1px solid transparent;
  }
  .card:hover { border-color: #4a4b55; }
  .card.sel { border-color: #7c5cff; }
  .card .cover { width: 100%; aspect-ratio: 3/4; object-fit: cover; display: block; background: #101116; }
  .card .noimg { width: 100%; aspect-ratio: 3/4; display: flex; align-items: center; justify-content: center; color: #4a4b55; font-size: 30px; }
  .card .t {
    padding: 7px 8px 3px; font-size: 12px; line-height: 1.4;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .card .tagrow { padding: 2px 8px 8px; display: flex; flex-wrap: wrap; gap: 4px; }
  .mini {
    font-size: 10px; padding: 1px 7px; border-radius: 999px;
    background: #2c2d35; color: #a9aab4; border: 1px solid #3a3b44;
  }
  .mini.ut { background: rgba(124,92,255,.18); color: #b9a8ff; border-color: #5b45c7; }
  .card .pick {
    position: absolute; top: 6px; left: 6px; width: 20px; height: 20px; cursor: pointer;
    display: none; accent-color: #7c5cff; z-index: 2;
  }
  .card:hover .pick, .card.sel .pick { display: block; }
  .card .edit {
    position: absolute; top: 6px; right: 6px; width: 24px; height: 24px; border-radius: 6px;
    border: none; background: rgba(0,0,0,.6); color: #fff; cursor: pointer; font-size: 12px;
    display: none; align-items: center; justify-content: center; z-index: 2;
  }
  .card:hover .edit { display: flex; }
  .selbar {
    position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
    display: flex; align-items: center; gap: 8px; padding: 9px 14px;
    background: #26272e; border: 1px solid #4a4b55; border-radius: 10px;
    box-shadow: 0 8px 30px rgba(0,0,0,.5); font-size: 12px; z-index: 5;
  }
  .selbar.hidden { display: none; }
  .empty { grid-column: 1/-1; text-align: center; color: #6a6b75; padding: 80px 0; font-size: 14px; line-height: 2; }
  .dlgback { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; z-index: 10; }
  .dlg { width: 430px; max-width: calc(100% - 40px); max-height: 84vh; overflow-y: auto; background: #23242b; border-radius: 12px; padding: 16px; }
  .dlg h3 { margin: 0 0 10px; font-size: 14px; }
  .dlg .row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .dlg .row label { width: 108px; font-size: 12px; color: #9a9ba6; flex-shrink: 0; }
  .dlg .row input { flex: 1; background: #141519; border: 1px solid #3a3b44; color: #e6e6e9; border-radius: 5px; padding: 5px 8px; font-size: 12px; }
  .dlg .hint { font-size: 11px; color: #7a7b85; margin: 6px 0; line-height: 1.6; }
  .dlg .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; flex-wrap: wrap; }
  .tagbox { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
  .tagbox .mini { font-size: 12px; padding: 3px 10px; cursor: pointer; }
  .filebtn { display: none; }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-thumb { background: #33343c; border-radius: 5px; }
</style>
</head>
<body>
  <div class="top">
    <b>📚 收藏库</b><span class="site" id="site"></span>
    <input type="text" id="q" placeholder="搜索关键字（标题 / 作者 / 标签）…">
    <select id="sort">
      <option value="recent">最近添加</option>
      <option value="old">最早添加</option>
      <option value="title">标题 A→Z</option>
    </select>
    <button class="btn primary" id="b-scan">扫描本页</button>
    <button class="btn" id="b-crawl">连续扫描</button>
    <button class="btn" id="b-cfg">设置</button>
    <button class="btn" id="b-io">备份</button>
    <button class="btn" id="b-close">✕</button>
  </div>
  <div class="body">
    <aside class="side" id="side"></aside>
    <div class="main">
      <div class="status" id="status"></div>
      <div class="grid" id="grid"></div>
    </div>
  </div>
  <div class="selbar hidden" id="selbar"></div>
<script>
/*POPUP_JS_START*/
(function () {
  'use strict';

  // ---- 与主页面同源，通过 __MFE__ API 抓取；数据直接读写同一 localStorage ----
  var OP = window.opener;
  if (!OP || !OP.__MFE__) {
    document.body.innerHTML = '<div style="padding:40px;color:#888;font-size:14px;line-height:2">无法连接原页面。<br>请从安装了脚本、且已加载出 📚 按钮的页面打开收藏库（弹窗需与主页面同源）。</div>';
    return;
  }
  var M = OP.__MFE__;
  var HOST = M.siteKey();

  var view = { q: '', sort: 'recent', activeTag: '__all__', selected: [] };

  function S_get(k, f) {
    try { var r = localStorage.getItem('mfe:' + k); return r == null ? f : JSON.parse(r); } catch (e) { return f; }
  }
  function S_set(k, v) { localStorage.setItem('mfe:' + k, JSON.stringify(v)); }
  function loadEntries() { return S_get('data:' + HOST, {}); }
  function saveEntries(e) { S_set('data:' + HOST, e); }

  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function $(id) { return document.getElementById(id); }

  function status(msg, isErr) {
    var el = $('status');
    if (el) { el.textContent = msg || ''; el.className = 'status' + (isErr ? ' err' : ''); }
  }

  function alive() {
    try { return OP && !OP.closed && !!OP.__MFE__; } catch (e) { return false; }
  }

  // ---- 渲染 ----
  function allTags() {
    var count = {};
    var es = loadEntries();
    for (var k in es) {
      var e = es[k];
      var ts = (e.userTags || []).concat(e.tags || []);
      for (var i = 0; i < ts.length; i++) count[ts[i]] = (count[ts[i]] || 0) + 1;
    }
    return Object.keys(count).sort(function (a, b) {
      return count[b] - count[a] || a.localeCompare(b, 'zh-Hans-CN');
    }).map(function (t) { return [t, count[t]]; });
  }

  function filteredList() {
    var list = [];
    var es = loadEntries();
    for (var k in es) list.push(es[k]);
    if (view.activeTag === '__untagged__') {
      list = list.filter(function (e) { return !(e.userTags || []).length && !(e.tags || []).length; });
    } else if (view.activeTag !== '__all__') {
      list = list.filter(function (e) {
        return (e.userTags || []).indexOf(view.activeTag) >= 0 || (e.tags || []).indexOf(view.activeTag) >= 0;
      });
    }
    if (view.q) {
      var terms = view.q.split(/\\s+/);
      list = list.filter(function (e) {
        var hay = (e.title + ' ' + (e.author || '') + ' ' + (e.tags || []).join(' ') + ' ' + (e.userTags || []).join(' ')).toLowerCase();
        return terms.every(function (t) { return hay.indexOf(t) >= 0; });
      });
    }
    var cmp = {
      recent: function (a, b) { return b.firstSeen - a.firstSeen; },
      old: function (a, b) { return a.firstSeen - b.firstSeen; },
      title: function (a, b) { return a.title.localeCompare(b.title, 'zh-Hans-CN'); },
    }[view.sort];
    return list.sort(cmp || function () { return 0; });
  }

  function render() {
    var tags = allTags();
    var es = loadEntries();
    var total = 0, untagged = 0, k;
    for (k in es) { total++; if (!(es[k].userTags || []).length && !(es[k].tags || []).length) untagged++; }
    var html = '<h4>分类</h4>';
    html += '<div class="cat' + (view.activeTag === '__all__' ? ' on' : '') + '" data-tag="__all__"><span>全部</span><span class="n">' + total + '</span></div>';
    html += '<div class="cat' + (view.activeTag === '__untagged__' ? ' on' : '') + '" data-tag="__untagged__"><span>未分类</span><span class="n">' + untagged + '</span></div>';
    if (tags.length) html += '<h4>标签</h4>';
    for (var i = 0; i < tags.length; i++) {
      html += '<div class="cat' + (view.activeTag === tags[i][0] ? ' on' : '') + '" data-tag="' + esc(tags[i][0]) + '"><span>' + esc(tags[i][0]) + '</span><span class="n">' + tags[i][1] + '</span></div>';
    }
    $('side').innerHTML = html;

    var list = filteredList();
    var g = $('grid');
    if (!total) {
      g.innerHTML = '<div class="empty">收藏库还是空的<br>回到原页面的收藏列表，点上方「扫描本页」开始收集<br>或用「连续扫描」自动抓完所有分页</div>';
    } else if (!list.length) {
      g.innerHTML = '<div class="empty">没有匹配的收藏</div>';
    } else {
      var out = '';
      for (var j = 0; j < list.length; j++) {
        var e = list[j];
        var sel = view.selected.indexOf(e.url) >= 0;
        out += '<div class="card' + (sel ? ' sel' : '') + '" data-url="' + esc(e.url) + '" title="' + esc(e.title) + '">';
        out += '<input type="checkbox" class="pick"' + (sel ? ' checked' : '') + '>';
        out += '<button class="edit" title="编辑标签">✎</button>';
        out += e.cover
          ? '<img class="cover" loading="lazy" referrerpolicy="same-origin" src="' + esc(e.cover) + '">'
          : '<div class="noimg">🖼</div>';
        out += '<div class="t">' + esc(e.title) + '</div><div class="tagrow">';
        var ut = e.userTags || [], st = e.tags || [];
        for (var a = 0; a < ut.length; a++) out += '<span class="mini ut">' + esc(ut[a]) + '</span>';
        for (var b = 0; b < st.length; b++) out += '<span class="mini">' + esc(st[b]) + '</span>';
        out += '</div></div>';
      }
      g.innerHTML = out;
    }
    renderSelbar();
  }

  function renderSelbar() {
    var bar = $('selbar');
    if (!view.selected.length) { bar.className = 'selbar hidden'; bar.innerHTML = ''; return; }
    bar.className = 'selbar';
    bar.innerHTML = '已选 ' + view.selected.length + ' 条'
      + ' <button class="btn primary" id="sb-tag">打标签</button>'
      + ' <button class="btn danger" id="sb-del">删除</button>'
      + ' <button class="btn" id="sb-clear">取消选择</button>';
  }

  // ---- 扫描 / 连续扫描 ----
  var crawling = false;

  function doScan() {
    if (!alive()) { status('原页面已关闭，请回到原页面重新打开收藏库', true); return; }
    try {
      var r = M.scanPage();
      status('本页识别 ' + r.found + ' 张卡片，新增 ' + r.added + '（累计 ' + Object.keys(loadEntries()).length + ' 条）');
      render();
    } catch (e) {
      status('扫描失败：' + e.message, true);
    }
  }

  function doCrawl() {
    if (crawling) return;
    if (!alive()) { status('原页面已关闭，请回到原页面重新打开收藏库', true); return; }
    crawling = true;
    var cfg = M.getCfg();
    var url = OP.location.href.split('#')[0];
    var pages = 0;
    var step = function () {
      if (!url || pages >= (cfg.maxCrawl || 20)) {
        crawling = false;
        status('完成：共抓取 ' + pages + ' 页' + (url ? '（达到最大页数限制，可在设置里调大）' : '，没有更多分页'));
        render();
        return;
      }
      pages++;
      status('正在抓取第 ' + pages + ' 页…');
      M.crawlNextPage(url).then(function (r) {
        status('第 ' + pages + ' 页：识别 ' + r.found + '，新增 ' + r.added + '，累计 ' + Object.keys(loadEntries()).length + ' 条');
        render();
        if (!r.nextUrl) { crawling = false; status('完成：共抓取 ' + pages + ' 页，没有更多分页'); return; }
        url = r.nextUrl;
        setTimeout(step, cfg.crawlDelay || 800);
      }).catch(function (err) {
        crawling = false;
        status('抓取中断：' + err.message + '（已抓 ' + pages + ' 页，数据已保存）', true);
      });
    };
    step();
  }

  // ---- 标签编辑器（单条 / 批量共用） ----
  function openTagEditor(singleUrl) {
    var urls = singleUrl ? [singleUrl] : view.selected.slice();
    if (!urls.length) return;
    var multi = urls.length > 1;
    var entries = loadEntries();
    var items = [];
    for (var i = 0; i < urls.length; i++) if (entries[urls[i]]) items.push(entries[urls[i]]);
    if (!items.length) return;

    var common = multi
      ? (items[0].userTags || []).filter(function (t) {
          return items.every(function (e) { return (e.userTags || []).indexOf(t) >= 0; });
        })
      : (items[0].userTags || []);
    var suggestions = allTags().map(function (x) { return x[0]; });
    var draft = common.slice();

    var back = document.createElement('div');
    back.className = 'dlgback';
    var html = '<div class="dlg"><h3>' + (multi ? '为已选 ' + items.length + ' 条打标签' : '编辑标签') + '</h3>';
    if (!multi) html += '<div class="hint">' + esc(items[0].title) + '</div>';
    html += '<div class="tagbox" id="te-box"></div>';
    html += '<div class="row"><label>标签名</label><input class="tagin" id="te-in" list="mfe-tags" placeholder="输入后回车添加"></div>';
    html += '<datalist id="mfe-tags">';
    for (var s = 0; s < suggestions.length; s++) html += '<option value="' + esc(suggestions[s]) + '"></option>';
    html += '</datalist>';
    html += '<div class="hint">' + (multi ? '批量模式：回车 = 给所有选中条目添加该标签' : '回车 = 添加标签；点上方标签可移除') + '</div>';
    html += '<div class="actions"><button class="btn primary" id="te-ok">保存</button><button class="btn" id="te-cancel">取消</button></div></div>';
    back.innerHTML = html;
    document.body.appendChild(back);

    var redraw = function () {
      $('te-box').innerHTML = draft.length
        ? draft.map(function (t) { return '<span class="mini ut" data-rm="' + esc(t) + '">' + esc(t) + ' ✕</span>'; }).join('')
        : '<span class="hint" style="margin:0">（暂无标签）</span>';
    };
    redraw();

    $('te-box').addEventListener('click', function (ev) {
      var t = ev.target.getAttribute && ev.target.getAttribute('data-rm');
      if (t) { draft = draft.filter(function (x) { return x !== t; }); redraw(); }
    });
    $('te-in').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        var t = this.value.trim();
        if (t && draft.indexOf(t) < 0) { draft.push(t); redraw(); }
        this.value = '';
      }
    });
    $('te-cancel').addEventListener('click', function () { back.remove(); });
    $('te-ok').addEventListener('click', function () {
      var fresh = loadEntries();
      for (var i = 0; i < items.length; i++) {
        var e = fresh[items[i].url];
        if (!e) continue;
        if (multi) {
          var set = (e.userTags || []).slice();
          for (var d = 0; d < draft.length; d++) if (set.indexOf(draft[d]) < 0) set.push(draft[d]);
          e.userTags = set;
        } else {
          e.userTags = draft.slice();
        }
      }
      saveEntries(fresh);
      back.remove();
      status('已更新 ' + items.length + ' 条的标签');
      render();
    });
  }

  function deleteSelected() {
    if (!view.selected.length) return;
    if (!confirm('确定从收藏库删除选中的 ' + view.selected.length + ' 条？（只删本地记录，不影响网站收藏）')) return;
    var fresh = loadEntries();
    for (var i = 0; i < view.selected.length; i++) delete fresh[view.selected[i]];
    saveEntries(fresh);
    view.selected = [];
    status('已删除');
    render();
  }

  // ---- 设置 ----
  function openSettings() {
    var cfg = M.getCfg();
    var preset = null;
    try { preset = M.getPreset(); } catch (e) { /* noop */ }
    var back = document.createElement('div');
    back.className = 'dlgback';
    var fields = [
      ['item', '列表条目 item', '如 div.fav-item（相对整页）'],
      ['title', '标题 title', '相对条目'],
      ['link', '链接 link', '相对条目，默认 a[href]'],
      ['cover', '封面 cover', '相对条目，默认 img'],
      ['tags', '站点标签 tags', '相对条目，可匹配多个'],
      ['author', '作者 author', '相对条目'],
      ['next', '下一页 next', '整页选择器，留空按文字探测'],
      ['urlPattern', 'URL 特征', '详情页 URL 正则（通用探测用）'],
      ['maxCrawl', '连续扫描页数', '1-200'],
      ['crawlDelay', '翻页间隔 ms', '≥100'],
    ];
    var html = '<div class="dlg"><h3>站点设置 — ' + esc(HOST) + '</h3>';
    html += '<div class="hint">' + (preset
      ? '✅ 已命中内置预设「' + esc(preset.name) + '」，下列留空即使用预设的精确选择器。'
      : '未命中内置预设。可关闭"通用启发式探测"避免误抓，或手动填写选择器。') + '</div>';
    for (var i = 0; i < fields.length; i++) {
      var num = (fields[i][0] === 'maxCrawl' || fields[i][0] === 'crawlDelay') ? ' type="number"' : '';
      html += '<div class="row"><label>' + fields[i][1] + '</label><input name="' + fields[i][0] + '"' + num + ' value="' + esc(cfg[fields[i][0]]) + '" placeholder="' + fields[i][2] + '"></div>';
    }
    html += '<div class="row"><label>通用启发式探测</label><input type="checkbox" name="allowGeneric"' + (cfg.allowGeneric ? ' checked' : '') + ' style="flex:none"><span style="font-size:11px;color:#7a7b85">关闭后只按精确选择器抓，绝不误抓</span></div>';
    html += '<div class="actions"><button class="btn" id="st-test">测试当前页</button><button class="btn primary" id="st-save">保存</button><button class="btn" id="st-cancel">取消</button></div>';
    html += '<div class="hint" id="st-out"></div></div>';
    back.innerHTML = html;
    document.body.appendChild(back);

    var readForm = function () {
      var c = {};
      for (var k in cfg) c[k] = cfg[k];
      var els = back.querySelectorAll('input[name]');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.type === 'checkbox') c[el.name] = el.checked;
        else if (el.type === 'number') c[el.name] = Number(el.value) || cfg[el.name];
        else c[el.name] = el.value.trim();
      }
      return c;
    };
    $('st-cancel').addEventListener('click', function () { back.remove(); });
    $('st-save').addEventListener('click', function () {
      S_set('cfg:' + HOST, readForm());
      back.remove();
      status('设置已保存（仅对本站生效）');
    });
    $('st-test').addEventListener('click', function () {
      if (!alive()) { $('st-out').textContent = '原页面已关闭，无法测试。'; return; }
      try {
        var r = M.testPage(readForm());
        $('st-out').textContent = '识别 ' + r.containers + ' 个条目容器，解析成功 ' + r.ok + ' 条。首条：' + r.first;
      } catch (e) {
        $('st-out').textContent = '测试失败：' + e.message;
      }
    });
  }

  // ---- 备份 / 恢复 ----
  function openIO() {
    var back = document.createElement('div');
    back.className = 'dlgback';
    back.innerHTML = '<div class="dlg"><h3>备份 / 恢复</h3>'
      + '<div class="hint">导出全部站点的收藏库数据（含自建标签）。导入按 URL 合并。</div>'
      + '<div class="actions" style="justify-content:flex-start">'
      + '<button class="btn primary" id="io-export">导出 JSON</button>'
      + '<button class="btn" id="io-import">导入 JSON</button>'
      + '<button class="btn" id="io-close">关闭</button></div>'
      + '<input type="file" class="filebtn" id="io-file" accept=".json,application/json"></div>';
    document.body.appendChild(back);

    var allData = function () {
      var data = {};
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf('mfe:data:') === 0) data[k.slice(4)] = localStorage.getItem(k);
      }
      return data;
    };
    $('io-close').addEventListener('click', function () { back.remove(); });
    back.addEventListener('click', function (ev) { if (ev.target === back) back.remove(); });
    $('io-export').addEventListener('click', function () {
      var blob = new Blob([JSON.stringify(allData(), null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'manga-favorites-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      URL.revokeObjectURL(url);
    });
    $('io-import').addEventListener('click', function () { $('io-file').click(); });
    $('io-file').addEventListener('change', function () {
      var f = this.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var obj = JSON.parse(reader.result);
          var n = 0;
          for (var k in obj) {
            if (k.indexOf('data:') !== 0) continue;
            var cur = {};
            try { cur = JSON.parse(localStorage.getItem('mfe:' + k) || '{}'); } catch (e) { cur = {}; }
            var inc = JSON.parse(obj[k]);
            for (var u in inc) cur[u] = inc[u];
            S_set(k, cur);
            n++;
          }
          back.remove();
          status('导入完成：' + n + ' 个站点');
          render();
        } catch (e) {
          status('导入失败：' + e.message, true);
        }
      };
      reader.readAsText(f);
    });
  }

  // ---- 记住窗口位置/大小 ----
  window.addEventListener('pagehide', function () {
    try {
      OP.localStorage.setItem('mfe:ui:win', JSON.stringify({
        left: window.screenX, top: window.screenY,
        width: window.outerWidth, height: window.outerHeight,
      }));
    } catch (e) { /* noop */ }
  });

  // ---- 事件绑定 ----
  var qEl = $('q'), deb;
  qEl.addEventListener('input', function () {
    clearTimeout(deb);
    deb = setTimeout(function () { view.q = qEl.value.trim().toLowerCase(); render(); }, 150);
  });
  $('sort').addEventListener('change', function () { view.sort = this.value; render(); });
  $('b-scan').addEventListener('click', doScan);
  $('b-crawl').addEventListener('click', doCrawl);
  $('b-cfg').addEventListener('click', openSettings);
  $('b-io').addEventListener('click', openIO);
  $('b-close').addEventListener('click', function () { window.close(); });

  $('side').addEventListener('click', function (ev) {
    var cat = ev.target.closest && ev.target.closest('.cat');
    if (cat) { view.activeTag = cat.getAttribute('data-tag'); render(); }
  });
  $('selbar').addEventListener('click', function (ev) {
    var id = ev.target.id;
    if (id === 'sb-tag') openTagEditor();
    else if (id === 'sb-del') deleteSelected();
    else if (id === 'sb-clear') { view.selected = []; render(); }
  });
  $('grid').addEventListener('click', function (ev) {
    if (ev.target.classList && ev.target.classList.contains('edit')) {
      ev.stopPropagation();
      openTagEditor(ev.target.closest('.card').getAttribute('data-url'));
      return;
    }
    var card = ev.target.closest && ev.target.closest('.card');
    if (card && !(ev.target.classList && ev.target.classList.contains('pick'))) {
      window.open(card.getAttribute('data-url'), '_blank');
    }
  });
  $('grid').addEventListener('change', function (ev) {
    if (ev.target.classList && ev.target.classList.contains('pick')) {
      var url = ev.target.closest('.card').getAttribute('data-url');
      var idx = view.selected.indexOf(url);
      if (ev.target.checked && idx < 0) view.selected.push(url);
      if (!ev.target.checked && idx >= 0) view.selected.splice(idx, 1);
      ev.target.closest('.card').classList.toggle('sel', ev.target.checked);
      renderSelbar();
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') window.close();
  });

  $('site').textContent = HOST;
  render();
  status('');
})();
/*POPUP_JS_END*/
</script>
</body>
</html>`;
  }

  /* ================================================================
   * 入口
   * ================================================================ */

  function main() {
    if (window.top !== window.self) return;
    ensureLauncher();

    // 命中预设（或有手动配置）且当前在收藏类页面 → 自动静默增量同步
    const preset = getPreset();
    const hasUserCfg = Object.keys(store.get(cfgKey(), {})).length > 0;
    if ((preset || hasUserCfg) && /(favorite|collect|bookmark|shelf|subscri)/i.test(location.pathname)) {
      setTimeout(() => {
        try { scanPage(); } catch { /* 静默 */ }
      }, 1500);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
