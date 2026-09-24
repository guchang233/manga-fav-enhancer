// ==UserScript==
// @name         网页资源库 / 漫画收藏助手 (Web Resource Harvester)
// @namespace    https://github.com/local/manga-fav-enhancer
// @version      5.0.0
// @description  两种模式的独立弹窗工具：🌐 全局模式——精准识别网页中所有资源并按「角色」细分（主图/卡片配图/缩略图/头像/Logo/背景图/画廊/视频封面/装饰图/视频/音频/文档/压缩包/字体），带体积探测、预览与单个或批量下载；📚 漫画模式——为漫画站收藏提供标签分类、搜索、封面网格、批量打标（内置 18comic 系精确预设）。
// @author       you
// @match        *://*/*
// @run-at       document-idle
// @grant        unsafeWindow
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  /* ==================================================================
   * 存储层（按站点主机名分库；弹窗同源共享同一 localStorage）
   * ================================================================== */

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

  /* ==================================================================
   * 漫画模式：站点预设（精确选择器，防误抓）
   * ================================================================== */

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

  /* ==================================================================
   * 漫画模式：收藏抓取
   * ================================================================== */

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

  /* ==================================================================
   * 全局模式：资源种类（kind）与页面角色（role）识别
   * ================================================================== */

  const EXT_KIND = {
    image: 'jpg jpeg png gif webp avif svg bmp ico tiff heic',
    video: 'mp4 webm mkv m4v mov avi flv ogv ts m3u8',
    audio: 'mp3 m4a wav ogg oga flac aac opus wma mid',
    doc: 'pdf doc docx xls xlsx ppt pptx txt epub mobi csv md',
    archive: 'zip rar 7z tar gz bz2 xz iso apk exe dmg',
    font: 'woff woff2 ttf otf eot',
  };

  const ROLE_RE = {
    logo: /(logo|brand|favicon|siteicon|site-?icon)/i,
    avatar: /(avatar|user|author|profile|member|uploader|account|upzhu|poster-?avatar)/i,
    gallery: /(gallery|slider|swiper|carousel|album|photos|lightbox|viewer|van-?list)/i,
    card: /(card|tile|item|list-?item|entry|feed|video-?card|gallery-?item)/i,
    content: /(article|content|post|editor|rich|detail|markdown|body)/i,
    thumb: /(thumb|thumbnal|mini|small-?img|preview)/i,
  };

  function guessKind(url, hint) {
    if (hint) return hint;
    const clean = url.split(/[?#]/)[0];
    const ext = (clean.split('.').pop() || '').toLowerCase();
    for (const [kind, exts] of Object.entries(EXT_KIND)) {
      if (exts.split(' ').includes(ext)) return kind;
    }
    return 'other';
  }

  /** 生成元素签名：自身 + 上溯 4 层的 id/class，用于角色判定 */
  function elSignature(el) {
    const parts = [el.tagName];
    let n = el;
    for (let i = 0; i < 4 && n && n.nodeType === 1; i++) {
      if (n.id) parts.push('#' + n.id);
      const c = typeof n.className === 'string' ? n.className : '';
      if (c) parts.push('.' + c.trim().replace(/\s+/g, '.'));
      n = n.parentElement;
    }
    return parts.join(' ');
  }

  /**
   * 资源采集 + 角色识别
   * @returns {Array<{url,kind,role,w,h,area,host,src,label}>}
   */
  function collectResources() {
    const doc = document;
    const out = new Map();

    const add = (raw, kind, role, meta) => {
      if (!raw) return;
      const s = String(raw).trim();
      if (!s || /^(blob:|javascript:|about:|mailto:|tel:)/i.test(s)) return;
      let url;
      try { url = new URL(s, location.href).href; } catch { return; }
      if (!/^https?:/.test(url)) return;

      const prev = out.get(url);
      if (prev) {
        // 保留信息更完整的一条；已有明确角色时不覆盖
        if (meta && meta.w && !prev.w) Object.assign(prev, { w: meta.w, h: meta.h, area: meta.area });
        if (role && role !== 'other' && (!prev.role || prev.role === 'other')) prev.role = role;
        return;
      }
      let host = '';
      try { host = new URL(url).hostname; } catch { host = ''; }
      const w = (meta && meta.w) || 0;
      const h = (meta && meta.h) || 0;
      out.set(url, Object.assign({
        url, kind: guessKind(url, kind), role: role || 'other',
        w, h, area: w * h, host, src: (meta && meta.src) || 'attr',
      }, meta || {}));
    };

    const rectSize = (el) => {
      try {
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      } catch { return { w: 0, h: 0 }; }
    };

    /* --- <img> / <picture>：角色取决于所在容器 --- */
    doc.querySelectorAll('img').forEach(el => {
      const sig = elSignature(el);
      let w = el.naturalWidth || 0, h = el.naturalHeight || 0;
      if (!w || !h) { const r = rectSize(el); w = w || r.w; h = h || r.h; }

      let role = 'other';
      if (ROLE_RE.logo.test(sig)) role = 'logo';
      else if (ROLE_RE.avatar.test(sig)) role = 'avatar';
      else if (ROLE_RE.gallery.test(sig)) role = 'gallery';
      else if (ROLE_RE.thumb.test(sig)) role = 'thumbnail';
      else if (ROLE_RE.card.test(sig)) role = 'card';
      else if (el.closest('a')) role = 'card';
      else if (ROLE_RE.content.test(sig) || el.closest('article, main, #content, .content')) role = 'content';

      if ((w && w < 64) || (h && h < 64)) {
        if (role === 'other' || role === 'content' || role === 'card') role = 'sprite';
      }
      if (!role || role === 'other') role = (w >= 400 || h >= 400) ? 'content' : 'other';
      if (role === 'card' && (w <= 180 || h <= 180)) role = 'thumbnail';

      add(el.currentSrc || el.src, 'image', role, { w, h, area: w * h, src: 'img' });
      (el.getAttribute('srcset') || '').split(',').forEach(part => {
        const u = part.trim().split(/\s+/)[0];
        add(u, 'image', role, { src: 'srcset' });
      });
      // 懒加载属性
      ['data-src', 'data-original', 'data-lazy-src', 'data-url', 'data-echo'].forEach(attr => {
        add(el.getAttribute(attr), 'image', role, { src: attr });
      });
    });

    doc.querySelectorAll('picture source').forEach(s => {
      const set = s.getAttribute('srcset') || '';
      set.split(',').forEach(part => {
        const u = part.trim().split(/\s+/)[0];
        add(u, 'image', elSignature(s).match(ROLE_RE.gallery) ? 'gallery' : 'content', { src: 'srcset' });
      });
    });

    /* --- <video> --- */
    doc.querySelectorAll('video').forEach(el => {
      const sig = elSignature(el);
      const role = ROLE_RE.gallery.test(sig) ? 'gallery' : 'video';
      add(el.currentSrc || el.src, 'video', role, { w: el.videoWidth, h: el.videoHeight, area: el.videoWidth * el.videoHeight, src: 'video' });
      el.querySelectorAll('source').forEach(s => {
        add(s.getAttribute('src'), 'video', role, { src: 'video-source' });
      });
      if (el.poster) add(el.poster, 'image', 'poster', { src: 'poster' });
    });

    /* --- <audio> --- */
    doc.querySelectorAll('audio').forEach(el => {
      add(el.currentSrc || el.src, 'audio', 'audio', { src: 'audio' });
      el.querySelectorAll('source').forEach(s => add(s.getAttribute('src'), 'audio', 'audio', { src: 'audio-source' }));
    });

    /* --- <embed> / <object> --- */
    doc.querySelectorAll('embed,object').forEach(el => {
      add(el.src || el.data, null, 'other-file', { src: 'embed' });
    });

    /* --- <iframe src>（不递归读内容，只列框架地址） --- */
    doc.querySelectorAll('iframe[src]').forEach(el => {
      add(el.src, 'other', 'iframe', { src: 'iframe' });
    });

    /* --- 直接指向资源文件的链接 --- */
    const FILE_LINK_RE = /\.(zip|rar|7z|tar|gz|pdf|docx?|xlsx?|pptx?|epub|mp4|mkv|webm|mp3|flac|wav|ogg|woff2?|ttf|otf)([?#]|$)/i;
    doc.querySelectorAll('a[href]').forEach(a => {
      if (FILE_LINK_RE.test(a.href)) add(a.href, null, 'file-link', { src: 'link' });
    });

    /* --- CSS 背景图 --- */
    const all = doc.querySelectorAll('*');
    const limit = Math.min(all.length, 5000);
    for (let i = 0; i < limit; i++) {
      const el = all[i];
      if (!el.getBoundingClientRect) continue;
      let bg = '';
      try { bg = getComputedStyle(el).backgroundImage; } catch { /* noop */ }
      if (!bg || bg === 'none' || bg.indexOf('gradient') >= 0) continue;
      const m = bg.match(/url\((['"]?)([^)'"]+)\1\)/g);
      if (!m) continue;
      const size = rectSize(el);
      const sig = elSignature(el);
      let role = 'background';
      if (ROLE_RE.card.test(sig)) role = 'background';       // 卡片背景仍归背景图
      m.forEach(x => {
        const u = x.replace(/^url\((['"]?)/, '').replace(/(['"]?)\)$/, '');
        add(u, 'image', role, { w: size.w, h: size.h, area: size.w * size.h, src: 'css-bg' });
      });
    }

    /* --- 主图识别：非装饰类里面积最大的前若干张标记为 hero --- */
    const list = [];
    out.forEach(v => list.push(v));
    const candidates = list.filter(v => v.kind === 'image' && ['content', 'card', 'gallery', 'other'].includes(v.role) && v.area > 0);
    if (candidates.length) {
      const maxArea = candidates.reduce((mx, v) => Math.max(mx, v.area), 0);
      candidates.filter(v => v.area >= maxArea * 0.6).slice(0, 3).forEach(v => { v.role = 'hero'; });
    }

    return list;
  }

  /** HEAD 探测体积与真实 MIME */
  function probeSize(url) {
    return new Promise((resolve) => {
      const done = (size, type) => resolve({ size: size || 0, type: type || '' });
      try {
        if (typeof GM_xmlhttpRequest !== 'function') return done(0, '');
        GM_xmlhttpRequest({
          method: 'HEAD',
          url,
          timeout: 20000,
          onload: (r) => {
            const headers = String(r.responseHeaders || '');
            const size = Number((headers.match(/content-length:\s*(\d+)/i) || [])[1] || 0);
            const type = ((headers.match(/content-type:\s*([^;\r\n]+)/i) || [])[1] || '').trim();
            done(size, type);
          },
          onerror: () => done(0, ''),
          ontimeout: () => done(0, ''),
        });
      } catch { done(0, ''); }
    });
  }

  /** 下载资源（GM_download 跨域，失败回退新标签） */
  function downloadResource(url, filename) {
    return new Promise((resolve) => {
      const fallback = () => {
        try {
          const a = document.createElement('a');
          a.href = url;
          a.download = filename || '';
          a.target = '_blank';
          a.rel = 'noopener';
          document.body.appendChild(a);
          a.click();
          a.remove();
        } catch { /* noop */ }
        resolve(false);
      };
      try {
        if (typeof GM_download === 'function') {
          GM_download({ url, name: filename || 'mfe-download', onsave: () => resolve(true), onerror: fallback, ontimeout: fallback });
        } else fallback();
      } catch { fallback(); }
    });
  }

  // 弹窗同源调用的 API（扫描/下载/探测必须在原页面上下文执行）
  const PAGE = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  PAGE.__MFE__ = {
    siteKey, getPreset, getCfg,
    loadEntries, saveEntries, store,
    scanPage, crawlNextPage, testPage,
    collectResources, downloadResource, probeSize,
  };

  /* ==================================================================
   * 📚 启动按钮（可拖动；点击打开独立弹窗）
   * ================================================================== */

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
    btn.title = '资源库 / 收藏库（拖动移动，点击打开）';

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
      if (d.moved) store.set('ui:launcher', { left: parseInt(btn.style.left, 10), top: parseInt(btn.style.top, 10) });
      else openPopup();
    });

    shadow.append(style, btn);
    document.documentElement.appendChild(host);
  }

  /* ==================================================================
   * 独立弹窗窗口
   * ================================================================== */

  function openPopup() {
    const g = loadGeom('ui:win', {});
    const W = g.width || 920, H = g.height || 660;
    const left = g.left != null ? g.left : Math.max(0, Math.round((screen.width - W) / 2));
    const top = g.top != null ? g.top : Math.max(0, Math.round((screen.height - H) / 2));
    const win = window.open('', 'mfe_library',
      `popup=yes,width=${W},height=${H},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no`);
    if (!win) { alert('弹窗被浏览器拦截了，请允许本站弹出窗口后重试。'); return; }
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
<title>资源库 / 收藏库</title>
<style>
  * { box-sizing: border-box; font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; }
  html, body { margin: 0; height: 100%; }
  body { background: #14151a; color: #e6e6e9; display: flex; flex-direction: column; overflow: hidden; }
  .top {
    display: flex; align-items: center; gap: 8px; padding: 8px 12px; flex-wrap: wrap;
    background: #1e1f26; border-bottom: 1px solid #30313a; flex-shrink: 0;
  }
  .site { font-size: 11px; color: #7a7b85; }
  .top input[type=text] {
    flex: 1; min-width: 110px; background: #101116; border: 1px solid #3a3b44; color: #e6e6e9;
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
  .tab { border: none; background: transparent; color: #9a9ba6; font-size: 13px; padding: 6px 12px; border-radius: 7px; cursor: pointer; }
  .tab.on { background: #7c5cff; color: #fff; }
  .tab:hover:not(.on) { background: #26272e; }
  .top label { font-size: 12px; color: #9a9ba6; display: flex; align-items: center; gap: 4px; cursor: pointer; white-space: nowrap; }
  .body { display: flex; flex: 1; min-height: 0; }
  .side { width: 200px; flex-shrink: 0; background: #1a1b21; border-right: 1px solid #30313a; overflow-y: auto; padding: 8px; }
  .side h4 { margin: 8px 6px 6px; font-size: 11px; color: #7a7b85; font-weight: 600; letter-spacing: .05em; }
  .cat {
    display: flex; align-items: center; justify-content: space-between; gap: 6px;
    padding: 6px 9px; border-radius: 7px; cursor: pointer; font-size: 12px; color: #c9cad2;
    margin-bottom: 2px; user-select: none;
  }
  .cat span.l { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cat:hover { background: #24252d; }
  .cat.on { background: #7c5cff; color: #fff; }
  .cat .n { font-size: 11px; opacity: .65; }
  .main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .status { padding: 6px 16px; font-size: 12px; color: #8d8e99; min-height: 24px; flex-shrink: 0; }
  .status.err { color: #ff7a7a; }
  .grid {
    flex: 1; overflow-y: auto; padding: 4px 16px 80px;
    display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 14px; align-content: start;
  }
  .card { cursor: pointer; border-radius: 10px; overflow: hidden; background: #1e1f26; position: relative; border: 1px solid transparent; }
  .card:hover { border-color: #4a4b55; }
  .card.sel { border-color: #7c5cff; }
  .card .cover, .card .land { width: 100%; display: block; background: #101116; object-fit: cover; }
  .card .cover { aspect-ratio: 3/4; }
  .card .land { aspect-ratio: 4/3; }
  .card .noimg { width: 100%; aspect-ratio: 4/3; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #4a4b55; font-size: 28px; gap: 4px; }
  .card .noimg small { font-size: 10px; letter-spacing: .05em; }
  .card .t, .card .fn {
    padding: 7px 8px 2px; font-size: 11px; line-height: 1.4; color: #c9cad2;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-all;
  }
  .card .meta { padding: 0 8px 8px; font-size: 10px; color: #6f707a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .card .tagrow { padding: 2px 8px 8px; display: flex; flex-wrap: wrap; gap: 4px; }
  .badge {
    position: absolute; top: 6px; left: 6px; z-index: 2;
    font-size: 10px; padding: 2px 7px; border-radius: 999px;
    background: rgba(124,92,255,.92); color: #fff; letter-spacing: .02em;
  }
  .badge.grey { background: rgba(0,0,0,.66); color: #d7d8de; }
  .mini { font-size: 10px; padding: 1px 7px; border-radius: 999px; background: #2c2d35; color: #a9aab4; border: 1px solid #3a3b44; }
  .mini.ut { background: rgba(124,92,255,.18); color: #b9a8ff; border-color: #5b45c7; }
  .card .pick { position: absolute; bottom: 6px; left: 6px; width: 20px; height: 20px; cursor: pointer; display: none; accent-color: #7c5cff; z-index: 3; }
  .card:hover .pick, .card.sel .pick { display: block; }
  .card .act { position: absolute; top: 6px; right: 6px; display: none; gap: 4px; z-index: 2; }
  .card:hover .act { display: flex; }
  .card .act button, .card .edit {
    width: 24px; height: 24px; border-radius: 6px; border: none; cursor: pointer;
    background: rgba(0,0,0,.66); color: #fff; font-size: 12px; display: flex; align-items: center; justify-content: center;
  }
  .card .act button:hover, .card .edit:hover { background: #7c5cff; }
  .card .edit { position: absolute; top: 34px; right: 6px; display: none; z-index: 2; }
  .card:hover .edit { display: flex; }
  .selbar {
    position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
    display: flex; align-items: center; gap: 8px; padding: 9px 14px;
    background: #26272e; border: 1px solid #4a4b55; border-radius: 10px;
    box-shadow: 0 8px 30px rgba(0,0,0,.5); font-size: 12px; z-index: 5;
  }
  .selbar.hidden { display: none; }
  .empty { grid-column: 1/-1; text-align: center; color: #6a6b75; padding: 70px 0; font-size: 14px; line-height: 2; }
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
  .pv { width: min(800px, 94%); }
  .pv-img { max-width: 100%; max-height: 60vh; display: block; margin: 0 auto; border-radius: 8px; }
  .pv-vid { width: 100%; max-height: 60vh; border-radius: 8px; background: #000; }
  .pv-url { font-size: 11px; color: #8d8e99; word-break: break-all; margin-bottom: 8px; }
  .pv-meta { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 12px; }
  .filebtn { display: none; }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-thumb { background: #33343c; border-radius: 5px; }
</style>
</head>
<body>
  <div class="top">
    <button class="tab on" id="tab-res">🌐 全局模式</button>
    <button class="tab" id="tab-fav">📚 漫画模式</button>

    <span id="res-top" style="display:contents">
      <input type="text" id="rq" placeholder="文件名 / URL / 域名…">
      <select id="rsort">
        <option value="area">大图优先</option>
        <option value="size">体积降序</option>
        <option value="host">按域名分组</option>
        <option value="kind">按种类分组</option>
      </select>
      <label><input type="checkbox" id="r-hidesmall" checked> 隐藏小图标</label>
      <label><input type="checkbox" id="r-onlysite"> 仅本站</label>
      <button class="btn primary" id="r-scan">扫描本页资源</button>
      <button class="btn" id="r-selall">全选</button>
      <button class="btn" id="r-probe">获取体积</button>
    </span>

    <span id="fav-top" style="display:none">
      <span class="site" id="site"></span>
      <input type="text" id="q" placeholder="标题 / 作者 / 标签…">
      <select id="sort">
        <option value="recent">最近添加</option>
        <option value="old">最早添加</option>
        <option value="title">标题 A→Z</option>
      </select>
      <button class="btn primary" id="b-scan">扫描本页</button>
      <button class="btn" id="b-crawl">连续扫描</button>
      <button class="btn" id="b-cfg">设置</button>
      <button class="btn" id="b-io">备份</button>
    </span>

    <button class="btn" id="b-close">✕</button>
  </div>

  <div class="body" id="res-body">
    <aside class="side" id="rside"></aside>
    <div class="main">
      <div class="status" id="rstatus"></div>
      <div class="grid" id="rgrid"></div>
    </div>
  </div>

  <div class="body" id="fav-body" style="display:none">
    <aside class="side" id="side"></aside>
    <div class="main">
      <div class="status" id="status"></div>
      <div class="grid" id="grid"></div>
    </div>
  </div>

  <div class="selbar hidden" id="res-selbar"></div>
  <div class="selbar hidden" id="fav-selbar"></div>
<script>
/*POPUP_JS_START*/
(function () {
  'use strict';

  var OP = window.opener;
  if (!OP || !OP.__MFE__) {
    document.body.innerHTML = '<div style="padding:40px;color:#888;font-size:14px;line-height:2">无法连接原页面。<br>请从安装了脚本、且已加载出 📚 按钮的页面打开（弹窗需与主页面同源）。</div>';
    return;
  }
  var M = OP.__MFE__;
  var HOST = M.siteKey();

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function S_get(k, f) {
    try { var r = localStorage.getItem('mfe:' + k); return r == null ? f : JSON.parse(r); } catch (e) { return f; }
  }
  function S_set(k, v) { localStorage.setItem('mfe:' + k, JSON.stringify(v)); }
  function alive() {
    try { return OP && !OP.closed && !!OP.__MFE__; } catch (e) { return false; }
  }
  function loadEntries() { return S_get('data:' + HOST, {}); }
  function saveEntries(e) { S_set('data:' + HOST, e); }
  function bytes(n) {
    if (!n) return '';
    var u = ['B', 'KB', 'MB', 'GB'];
    var i = Math.floor(Math.log(n) / Math.log(1024));
    if (i < 0) i = 0;
    if (i > 3) i = 3;
    return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + u[i];
  }
  function fileBase(url) {
    try {
      var p = new URL(url).pathname;
      var s = decodeURIComponent(p.split('/').pop() || '');
      return s || '';
    } catch (e) { return ''; }
  }

  var curTab = 'res';

  function switchTab(t) {
    curTab = t;
    $('tab-res').className = 'tab' + (t === 'res' ? ' on' : '');
    $('tab-fav').className = 'tab' + (t === 'fav' ? ' on' : '');
    $('res-top').style.display = t === 'res' ? 'contents' : 'none';
    $('fav-top').style.display = t === 'fav' ? 'contents' : 'none';
    $('res-body').style.display = t === 'res' ? 'flex' : 'none';
    $('fav-body').style.display = t === 'fav' ? 'flex' : 'none';
    renderSelbars();
  }
  $('tab-res').addEventListener('click', function () { switchTab('res'); });
  $('tab-fav').addEventListener('click', function () { switchTab('fav'); });
  function renderSelbars() {
    $('res-selbar').className = 'selbar' + (curTab === 'res' && resSel.length ? '' : ' hidden');
    $('fav-selbar').className = 'selbar' + (curTab === 'fav' && favSel.length ? '' : ' hidden');
  }

  /* ================= 全局模式：资源库 ================= */

  var ROLE_LABEL = {
    hero: '主图', gallery: '画廊图', card: '卡片配图', content: '正文配图', thumbnail: '缩略图',
    avatar: '头像', logo: 'Logo/图标', background: '背景图', poster: '视频封面', sprite: '装饰小图',
    video: '视频', audio: '音频', file: '文件', 'file-link': '文件链接', iframe: '内嵌页面', other: '其他', 'other-file': '其他文件',
  };
  var KIND_LABEL = { image: '图片', video: '视频', audio: '音频', doc: '文档', archive: '压缩包', font: '字体', other: '其他' };
  var KIND_ICON = { image: '🖼', video: '🎬', audio: '🎵', doc: '📄', archive: '🗜', font: '🔤', other: '🔗' };
  var SIDE_GROUPS = [
    ['-', 'all'],
    ['图片（按角色）', 'hero', 'gallery', 'card', 'content', 'thumbnail', 'avatar', 'logo', 'background', 'poster', 'sprite'],
    ['媒体', 'video', 'audio'],
    ['文件', 'doc', 'archive', 'font', 'file-link', 'iframe', 'other'],
  ];

  var resList = [];
  var resSel = [];
  var resView = { q: '', role: 'all', onlySite: false, hideSmall: true, sort: 'area' };

  function rstatus(msg, isErr) {
    var el = $('rstatus');
    if (el) { el.textContent = msg || ''; el.className = 'status' + (isErr ? ' err' : ''); }
  }

  function doResScan() {
    if (!alive()) { rstatus('原页面已关闭，请回到原页面重新打开', true); return; }
    try {
      resList = M.collectResources();
      resSel = [];
      rstatus('共发现 ' + resList.length + ' 个资源（已去重并按角色分类）');
      renderRes();
    } catch (e) { rstatus('扫描失败：' + e.message, true); }
  }

  function resFiltered() {
    var list = resList;
    if (resView.role !== 'all') list = list.filter(function (r) { return r.role === resView.role; });
    if (resView.onlySite) list = list.filter(function (r) { return r.host === HOST; });
    if (resView.hideSmall) list = list.filter(function (r) { return r.role !== 'sprite' && !(r.kind === 'image' && r.w && r.w < 96); });
    if (resView.q) {
      var q = resView.q.toLowerCase();
      list = list.filter(function (r) { return r.url.toLowerCase().indexOf(q) >= 0; });
    }
    var cmp = {
      area: function (a, b) { return (b.area || 0) - (a.area || 0); },
      size: function (a, b) { return (b.size || 0) - (a.size || 0); },
      host: function (a, b) { return String(a.host).localeCompare(String(b.host)) || (b.area || 0) - (a.area || 0); },
      kind: function (a, b) { return String(a.kind).localeCompare(String(b.kind)) || (b.area || 0) - (a.area || 0); },
    }[resView.sort];
    return list.slice().sort(cmp || function () { return 0; });
  }

  function renderResSide() {
    var count = {};
    for (var i = 0; i < resList.length; i++) count[resList[i].role] = (count[resList[i].role] || 0) + 1;
    var html = '';
    for (var g = 0; g < SIDE_GROUPS.length; g++) {
      var group = SIDE_GROUPS[g];
      if (g > 0) {
        var has = false;
        for (var k = 1; k < group.length; k++) if (count[group[k]]) { has = true; break; }
        if (!has) continue;
        html += '<h4>' + group[0] + '</h4>';
      } else {
        html += '<h4>全部</h4>';
      }
      for (var j = 1; j < group.length; j++) {
        var role = group[j];
        if (role !== 'all' && !count[role]) continue;
        var n = role === 'all' ? resList.length : (count[role] || 0);
        var label = role === 'all' ? '全部资源' : (ROLE_LABEL[role] || role);
        html += '<div class="cat' + (resView.role === role ? ' on' : '') + '" data-role="' + role + '"><span class="l">' + label + '</span><span class="n">' + n + '</span></div>';
      }
    }
    $('rside').innerHTML = html;
  }

  function renderRes() {
    renderResSide();
    var list = resFiltered();
    var g = $('rgrid');
    if (!resList.length) {
      g.innerHTML = '<div class="empty">还没有扫描<br>点上方「扫描本页资源」读取当前网页的全部资源<br>（图片 / 视频 / 音频 / 文档 / 压缩包 / 字体）</div>';
    } else if (!list.length) {
      g.innerHTML = '<div class="empty">没有匹配的资源<br>（可尝试取消「隐藏小图标」或「仅本站」）</div>';
    } else {
      var out = '';
      for (var i = 0; i < list.length; i++) {
        var r = list[i];
        var sel = resSel.indexOf(r.url) >= 0;
        var name = fileBase(r.url) || r.url;
        out += '<div class="card' + (sel ? ' sel' : '') + '" data-url="' + esc(r.url) + '" title="' + esc(r.url) + '">';
        out += '<span class="badge">' + esc(ROLE_LABEL[r.role] || r.role) + '</span>';
        out += '<span class="act">'
          + '<button class="dl" title="下载">⬇</button>'
          + '<button class="op" title="新标签打开">↗</button></span>';
        out += '<input type="checkbox" class="pick"' + (sel ? ' checked' : '') + '>';
        if (r.kind === 'image') {
          out += '<img class="land" loading="lazy" src="' + esc(r.url) + '">';
        } else {
          out += '<div class="noimg">' + (KIND_ICON[r.kind] || '🔗') + '<small>' + (KIND_LABEL[r.kind] || '') + '</small></div>';
        }
        out += '<div class="fn">' + esc(name) + '</div>';
        var meta = [];
        if (r.w && r.h) meta.push(r.w + '×' + r.h);
        if (r.size) meta.push(bytes(r.size));
        meta.push(KIND_LABEL[r.kind] || r.kind);
        out += '<div class="meta">' + esc(meta.join(' · ')) + '</div>';
        out += '</div>';
      }
      g.innerHTML = out;
    }
    renderResSelbar();
  }

  function renderResSelbar() {
    var bar = $('res-selbar');
    if (!resSel.length || curTab !== 'res') { bar.className = 'selbar hidden'; bar.innerHTML = ''; return; }
    bar.className = 'selbar';
    bar.innerHTML = '已选 ' + resSel.length + ' 个'
      + ' <button class="btn primary" id="rs-dl">⬇ 下载所选</button>'
      + ' <button class="btn" id="rs-probe">获取体积</button>'
      + ' <button class="btn" id="rs-copy">复制 URL</button>'
      + ' <button class="btn" id="rs-clear">取消</button>';
  }

  function resByName(r) {
    var name = fileBase(r.url);
    if (!name || name.length > 80) name = 'resource_' + Math.abs(hash(r.url));
    if (!/\\.[a-z0-9]{2,5}$/i.test(name)) {
      var ext = { image: '.jpg', video: '.mp4', audio: '.mp3', doc: '.pdf', archive: '.zip', font: '.woff2', other: '.bin' };
      name += ext[r.kind] || '.bin';
    }
    return name.replace(/[\\/:*?"<>|]/g, '_');
  }
  function hash(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
    return h;
  }

  function dlRes(r) {
    if (!alive()) { rstatus('原页面已关闭，无法下载', true); return Promise.resolve(); }
    var name = resByName(r);
    return M.downloadResource(r.url, name).then(function (ok) {
      rstatus((ok ? '已下载：' : '已在新标签打开（可能被浏览器拦截）：') + name);
    });
  }

  function dlResSelected() {
    var urls = resSel.slice();
    if (!urls.length) return;
    var map = {};
    for (var i = 0; i < resList.length; i++) map[resList[i].url] = resList[i];
    var i = 0;
    var step = function () {
      if (i >= urls.length) { rstatus('批量下载完成：共 ' + urls.length + ' 个'); return; }
      var r = map[urls[i]];
      rstatus('下载 ' + (i + 1) + '/' + urls.length + '：' + resByName(r));
      dlRes(r).then(function () { i++; setTimeout(step, 350); });
    };
    step();
  }

  function probeSelected() {
    var urls = resSel.length ? resSel.slice() : resFiltered().slice(0, 120).map(function (r) { return r.url; });
    if (!urls.length) { rstatus('没有可探测的资源', true); return; }
    var map = {};
    for (var i = 0; i < resList.length; i++) map[resList[i].url] = resList[i];
    var done = 0, total = urls.length;
    rstatus('正在探测体积 0/' + total + '…');
    var concurrency = 0, idx = 0;
    var next = function () {
      while (concurrency < 6 && idx < urls.length) {
        (function (url) {
          var r = map[url];
          concurrency++;
          M.probeSize(url).then(function (info) {
            if (r && info && info.size) { r.size = info.size; if (info.type) r.mime = info.type; }
          }).catch(function () { /* noop */ })
            .then(function () {
              concurrency--; done++;
              rstatus('正在探测体积 ' + done + '/' + total + '…');
              if (done % 10 === 0 || done === total) renderRes();
              if (done === total) { renderRes(); rstatus('体积探测完成（' + total + ' 项）'); }
              else next();
            });
        })(urls[idx]);
        idx++;
      }
    };
    next();
  }

  function copyText(text, label) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { rstatus(label); }, function () { fallbackCopy(text, label); });
    } else fallbackCopy(text, label);
  }
  function fallbackCopy(text, label) {
    var ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); rstatus(label); } catch (e) { rstatus('复制失败', true); }
    ta.remove();
  }

  function openResPreview(r) {
    var back = document.createElement('div');
    back.className = 'dlgback';
    var inner;
    if (r.kind === 'image') inner = '<img class="pv-img" src="' + esc(r.url) + '">';
    else if (r.kind === 'video') inner = '<video class="pv-vid" src="' + esc(r.url) + '" controls autoplay></video>';
    else if (r.kind === 'audio') inner = '<audio src="' + esc(r.url) + '" controls autoplay style="width:100%"></audio>';
    else inner = '<div style="text-align:center;padding:24px 0;font-size:40px">' + (KIND_ICON[r.kind] || '🔗') + '<div class="hint">该类型不支持内嵌预览，可直接下载</div></div>';

    var chips = '';
    chips += '<span class="mini ut">' + esc(ROLE_LABEL[r.role] || r.role) + '</span>';
    chips += '<span class="mini">' + esc(KIND_LABEL[r.kind] || r.kind) + '</span>';
    if (r.w && r.h) chips += '<span class="mini">' + r.w + '×' + r.h + '</span>';
    if (r.size) chips += '<span class="mini">' + bytes(r.size) + '</span>';
    chips += '<span class="mini">' + esc(r.src || '') + '</span>';

    back.innerHTML = '<div class="dlg pv">'
      + '<h3>' + esc(fileBase(r.url) || '资源预览') + '</h3>'
      + '<div class="pv-meta">' + chips + '</div>'
      + '<div class="pv-url">' + esc(r.url) + '</div>'
      + inner
      + '<div class="actions">'
      + '<button class="btn primary" id="pv-dl">⬇ 下载</button>'
      + '<button class="btn" id="pv-copy">复制 URL</button>'
      + '<button class="btn" id="pv-open">↗ 新标签打开</button>'
      + '<button class="btn" id="pv-close">关闭</button></div></div>';
    document.body.appendChild(back);
    $('pv-close').addEventListener('click', function () { back.remove(); });
    $('pv-open').addEventListener('click', function () { window.open(r.url, '_blank'); });
    $('pv-copy').addEventListener('click', function () { copyText(r.url, '已复制 URL'); });
    $('pv-dl').addEventListener('click', function () { dlRes(r); });
    back.addEventListener('click', function (ev) { if (ev.target === back) back.remove(); });
  }

  var rqEl = $('rq'), rdeb;
  rqEl.addEventListener('input', function () {
    clearTimeout(rdeb);
    rdeb = setTimeout(function () { resView.q = rqEl.value.trim().toLowerCase(); renderRes(); }, 150);
  });
  $('rsort').addEventListener('change', function () { resView.sort = this.value; renderRes(); });
  $('r-onlysite').addEventListener('change', function () { resView.onlySite = this.checked; renderRes(); });
  $('r-hidesmall').addEventListener('change', function () { resView.hideSmall = this.checked; renderRes(); });
  $('r-scan').addEventListener('click', doResScan);
  $('r-selall').addEventListener('click', function () {
    resSel = resFiltered().map(function (r) { return r.url; });
    renderRes();
  });
  $('r-probe').addEventListener('click', probeSelected);
  $('rside').addEventListener('click', function (ev) {
    var cat = ev.target.closest && ev.target.closest('.cat');
    if (cat) { resView.role = cat.getAttribute('data-role'); renderRes(); }
  });
  $('res-selbar').addEventListener('click', function (ev) {
    var id = ev.target.id;
    if (id === 'rs-dl') dlResSelected();
    else if (id === 'rs-probe') probeSelected();
    else if (id === 'rs-copy') copyText(resSel.join('\\n'), '已复制 ' + resSel.length + ' 个 URL');
    else if (id === 'rs-clear') { resSel = []; renderRes(); }
  });
  $('rgrid').addEventListener('click', function (ev) {
    var card = ev.target.closest && ev.target.closest('.card');
    if (!card) return;
    var url = card.getAttribute('data-url');
    var r = null;
    for (var i = 0; i < resList.length; i++) if (resList[i].url === url) { r = resList[i]; break; }
    if (!r) return;
    var cls = ev.target.classList;
    if (cls && cls.contains('dl')) { ev.stopPropagation(); dlRes(r); return; }
    if (cls && cls.contains('op')) { ev.stopPropagation(); window.open(r.url, '_blank'); return; }
    if (cls && cls.contains('pick')) return;
    openResPreview(r);
  });
  $('rgrid').addEventListener('change', function (ev) {
    if (ev.target.classList && ev.target.classList.contains('pick')) {
      var url = ev.target.closest('.card').getAttribute('data-url');
      var idx = resSel.indexOf(url);
      if (ev.target.checked && idx < 0) resSel.push(url);
      if (!ev.target.checked && idx >= 0) resSel.splice(idx, 1);
      ev.target.closest('.card').classList.toggle('sel', ev.target.checked);
      renderResSelbar();
    }
  });

  /* ================= 漫画模式：收藏库 ================= */

  var view = { q: '', sort: 'recent', activeTag: '__all__' };
  var favSel = [];

  function fstatus(msg, isErr) {
    var el = $('status');
    if (el) { el.textContent = msg || ''; el.className = 'status' + (isErr ? ' err' : ''); }
  }

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

  function renderFav() {
    var tags = allTags();
    var es = loadEntries();
    var total = 0, untagged = 0, k;
    for (k in es) { total++; if (!(es[k].userTags || []).length && !(es[k].tags || []).length) untagged++; }
    var html = '<h4>分类</h4>';
    html += '<div class="cat' + (view.activeTag === '__all__' ? ' on' : '') + '" data-tag="__all__"><span class="l">全部</span><span class="n">' + total + '</span></div>';
    html += '<div class="cat' + (view.activeTag === '__untagged__' ? ' on' : '') + '" data-tag="__untagged__"><span class="l">未分类</span><span class="n">' + untagged + '</span></div>';
    if (tags.length) {
      html += '<h4>标签</h4>';
      for (var i = 0; i < tags.length; i++) {
        html += '<div class="cat' + (view.activeTag === tags[i][0] ? ' on' : '') + '" data-tag="' + esc(tags[i][0]) + '"><span class="l">' + esc(tags[i][0]) + '</span><span class="n">' + tags[i][1] + '</span></div>';
      }
    }
    $('side').innerHTML = html;

    var list = filteredList();
    var g = $('grid');
    if (!total) {
      g.innerHTML = '<div class="empty">收藏库还是空的<br>回到漫画站的收藏列表页，点「扫描本页」开始收集<br>或用「连续扫描」自动抓完所有分页</div>';
    } else if (!list.length) {
      g.innerHTML = '<div class="empty">没有匹配的收藏</div>';
    } else {
      var out = '';
      for (var j = 0; j < list.length; j++) {
        var e = list[j];
        var sel = favSel.indexOf(e.url) >= 0;
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
    renderFavSelbar();
  }

  function renderFavSelbar() {
    var bar = $('fav-selbar');
    if (!favSel.length || curTab !== 'fav') { bar.className = 'selbar hidden'; bar.innerHTML = ''; return; }
    bar.className = 'selbar';
    bar.innerHTML = '已选 ' + favSel.length + ' 条'
      + ' <button class="btn primary" id="fb-tag">打标签</button>'
      + ' <button class="btn danger" id="fb-del">删除</button>'
      + ' <button class="btn" id="fb-clear">取消</button>';
  }

  var crawling = false;
  function doFavScan() {
    if (!alive()) { fstatus('原页面已关闭，请回到原页面重新打开', true); return; }
    try {
      var r = M.scanPage();
      fstatus('本页识别 ' + r.found + ' 张卡片，新增 ' + r.added + '（累计 ' + Object.keys(loadEntries()).length + ' 条）');
      renderFav();
    } catch (e) { fstatus('扫描失败：' + e.message, true); }
  }

  function doFavCrawl() {
    if (crawling) return;
    if (!alive()) { fstatus('原页面已关闭，请回到原页面重新打开', true); return; }
    crawling = true;
    var cfg = M.getCfg();
    var url = OP.location.href.split('#')[0];
    var pages = 0;
    var step = function () {
      if (!url || pages >= (cfg.maxCrawl || 20)) {
        crawling = false;
        fstatus('完成：共抓取 ' + pages + ' 页' + (url ? '（达到最大页数限制）' : '，没有更多分页'));
        renderFav();
        return;
      }
      pages++;
      fstatus('正在抓取第 ' + pages + ' 页…');
      M.crawlNextPage(url).then(function (r) {
        fstatus('第 ' + pages + ' 页：识别 ' + r.found + '，新增 ' + r.added + '，累计 ' + Object.keys(loadEntries()).length + ' 条');
        renderFav();
        if (!r.nextUrl) { crawling = false; fstatus('完成：共抓取 ' + pages + ' 页，没有更多分页'); return; }
        url = r.nextUrl;
        setTimeout(step, cfg.crawlDelay || 800);
      }).catch(function (err) {
        crawling = false;
        fstatus('抓取中断：' + err.message + '（已抓 ' + pages + ' 页，数据已保存）', true);
      });
    };
    step();
  }

  function openTagEditor(singleUrl) {
    var urls = singleUrl ? [singleUrl] : favSel.slice();
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
        } else e.userTags = draft.slice();
      }
      saveEntries(fresh);
      back.remove();
      fstatus('已更新 ' + items.length + ' 条的标签');
      renderFav();
    });
  }

  function deleteFavSelected() {
    if (!favSel.length) return;
    if (!confirm('确定从收藏库删除选中的 ' + favSel.length + ' 条？（只删本地记录，不影响网站收藏）')) return;
    var fresh = loadEntries();
    for (var i = 0; i < favSel.length; i++) delete fresh[favSel[i]];
    saveEntries(fresh);
    favSel = [];
    fstatus('已删除');
    renderFav();
  }

  function openFavSettings() {
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
      ['urlPattern', 'URL 特征', '详情页 URL 正则'],
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
    html += '<div class="row"><label>通用启发式探测</label><input type="checkbox" name="allowGeneric"' + (cfg.allowGeneric ? ' checked' : '') + ' style="flex:none"><span style="font-size:11px;color:#7a7b85">关闭后只按精确选择器抓</span></div>';
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
      fstatus('设置已保存（仅对本站生效）');
    });
    $('st-test').addEventListener('click', function () {
      if (!alive()) { $('st-out').textContent = '原页面已关闭，无法测试。'; return; }
      try {
        var r = M.testPage(readForm());
        $('st-out').textContent = '识别 ' + r.containers + ' 个条目容器，解析成功 ' + r.ok + ' 条。首条：' + r.first;
      } catch (e) { $('st-out').textContent = '测试失败：' + e.message; }
    });
  }

  function openIO() {
    var back = document.createElement('div');
    back.className = 'dlgback';
    back.innerHTML = '<div class="dlg"><h3>备份 / 恢复</h3>'
      + '<div class="hint">导出全部站点的收藏数据（含自建标签）。导入按 URL 合并。</div>'
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
          fstatus('导入完成：' + n + ' 个站点');
          renderFav();
        } catch (e) { fstatus('导入失败：' + e.message, true); }
      };
      reader.readAsText(f);
    });
  }

  var qEl = $('q'), fdeb;
  qEl.addEventListener('input', function () {
    clearTimeout(fdeb);
    fdeb = setTimeout(function () { view.q = qEl.value.trim().toLowerCase(); renderFav(); }, 150);
  });
  $('sort').addEventListener('change', function () { view.sort = this.value; renderFav(); });
  $('b-scan').addEventListener('click', doFavScan);
  $('b-crawl').addEventListener('click', doFavCrawl);
  $('b-cfg').addEventListener('click', openFavSettings);
  $('b-io').addEventListener('click', openIO);
  $('side').addEventListener('click', function (ev) {
    var cat = ev.target.closest && ev.target.closest('.cat');
    if (cat) { view.activeTag = cat.getAttribute('data-tag'); renderFav(); }
  });
  $('fav-selbar').addEventListener('click', function (ev) {
    var id = ev.target.id;
    if (id === 'fb-tag') openTagEditor();
    else if (id === 'fb-del') deleteFavSelected();
    else if (id === 'fb-clear') { favSel = []; renderFav(); }
  });
  $('grid').addEventListener('click', function (ev) {
    if (ev.target.classList && ev.target.classList.contains('edit')) {
      ev.stopPropagation();
      openTagEditor(ev.target.closest('.card').getAttribute('data-url'));
      return;
    }
    var card = ev.target.closest && ev.target.closest('.card');
    if (card && !(ev.target.classList && ev.target.classList.contains('pick'))) window.open(card.getAttribute('data-url'), '_blank');
  });
  $('grid').addEventListener('change', function (ev) {
    if (ev.target.classList && ev.target.classList.contains('pick')) {
      var url = ev.target.closest('.card').getAttribute('data-url');
      var idx = favSel.indexOf(url);
      if (ev.target.checked && idx < 0) favSel.push(url);
      if (!ev.target.checked && idx >= 0) favSel.splice(idx, 1);
      ev.target.closest('.card').classList.toggle('sel', ev.target.checked);
      renderFavSelbar();
    }
  });

  /* ================= 全局 ================= */

  $('b-close').addEventListener('click', function () { window.close(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      var dlg = document.querySelector('.dlgback');
      if (dlg) dlg.remove();
      else window.close();
    }
  });
  window.addEventListener('pagehide', function () {
    try {
      OP.localStorage.setItem('mfe:ui:win', JSON.stringify({
        left: window.screenX, top: window.screenY,
        width: window.outerWidth, height: window.outerHeight,
      }));
    } catch (e) { /* noop */ }
  });

  $('site').textContent = HOST;
  renderRes();
  renderFav();
  fstatus('');
  rstatus('点「扫描本页资源」开始识别当前网页的资源');
})();
/*POPUP_JS_END*/
</script>
</body>
</html>`;
  }

  /* ==================================================================
   * 入口
   * ================================================================== */

  function main() {
    if (window.top !== window.self) return;
    ensureLauncher();

    // 漫画模式：命中预设（或有手动配置）且当前在收藏类页面 → 自动静默增量同步
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
