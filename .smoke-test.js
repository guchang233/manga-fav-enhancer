/* 冒烟测试：抽取 userscript 里的角色识别逻辑，用最小 DOM 桩验证分类准确性 */
const fs = require('fs');
const path = 'C:/Users/sow/WorkBuddy/2026-09-23-23-14-38/manga-fav-enhancer/manga-fav-enhancer.user.js';
const s = fs.readFileSync(path, 'utf8');
const start = s.indexOf('const EXT_KIND');
const end = s.indexOf('/** HEAD 探测体积');
const code = s.slice(start, end);
const api = new Function('document', 'location', 'getComputedStyle', code + '; return { collectResources, elSignature, ROLE_RE };');

/* ---------- 最小 DOM 桩 ---------- */
class El {
  constructor(tag, attrs = {}, children = []) {
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.attributes = attrs;
    this.children = children;
    this.parentElement = null;
    children.forEach(c => { c.parentElement = this; });
    this.naturalWidth = attrs.naturalWidth || 0;
    this.naturalHeight = attrs.naturalHeight || 0;
    this.currentSrc = attrs.src || '';
    this.backgroundImage = attrs.styleBackground || 'none';
    this.rect = attrs.rect || { width: 0, height: 0 };
  }
  get id() { return this.attributes.id || ''; }
  get className() { return this.attributes.class || ''; }
  get src() { return this.attributes.src || ''; }
  get href() { return this.attributes.href || ''; }
  get poster() { return this.attributes.poster || ''; }
  get videoWidth() { return this.attributes.videoWidth || 0; }
  get videoHeight() { return this.attributes.videoHeight || 0; }
  getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attributes, n) ? this.attributes[n] : null; }
  matches(sel) {
    return sel.split(',').map(x => x.trim()).some(p => this.matchOne(p));
  }
  matchOne(sel) {
    const attr = sel.match(/^([a-z]+)?\[([a-z]+)\]$/i);
    if (attr) return (!attr[1] || this.tagName === attr[1].toUpperCase()) && this.getAttribute(attr[2]) !== null;
    if (sel.startsWith('#')) return this.id === sel.slice(1);
    if (sel.startsWith('.')) return (' ' + this.className + ' ').includes(' ' + sel.slice(1) + ' ');
    return this.tagName === sel.toUpperCase();
  }
  closest(sel) {
    let n = this;
    while (n) { if (n !== this && n.matchSimple(sel)) return n; n = n.parentElement; }
    return null;
  }
  matchSimple(sel) {
    return sel.split(',').map(x => x.trim()).some(p => this.matchOne(p));
  }
  getBoundingClientRect() { return this.rect; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => n.children.forEach(c => { if (c.matchOne(sel)) out.push(c); walk(c); });
    walk(this);
    return out;
  }
}

function all(doc) {
  const out = [];
  const walk = (n) => n.children.forEach(c => { out.push(c); walk(c); });
  walk(doc);
  return out;
}

const doc = new El('body', {}, [
  new El('img', { id: 'main-banner', class: 'big-banner', src: 'https://ex.com/hero.jpg', naturalWidth: 1600, naturalHeight: 900 }),
  new El('div', { class: 'card' }, [new El('img', { class: 'cover-img', src: 'https://ex.com/card.jpg', naturalWidth: 400, naturalHeight: 600 })]),
  new El('div', { class: 'card' }, [new El('img', { class: 'thumb', src: 'https://ex.com/thumb.jpg', naturalWidth: 120, naturalHeight: 160 })]),
  new El('div', { class: 'user-info' }, [new El('img', { class: 'avatar', src: 'https://ex.com/u.png', naturalWidth: 80, naturalHeight: 80 })]),
  new El('div', { class: 'gallery' }, [new El('img', { class: 'pic', src: 'https://ex.com/g1.jpg', naturalWidth: 800, naturalHeight: 800 })]),
  new El('div', { class: 'header' }, [new El('img', { class: 'site-logo', src: 'https://ex.com/logo.png', naturalWidth: 120, naturalHeight: 40 })]),
  new El('div', { class: 'decor', styleBackground: 'url(https://ex.com/bg.jpg)', rect: { width: 1200, height: 400 } }),
  new El('video', { src: 'https://ex.com/v.mp4', poster: 'https://ex.com/poster.jpg', videoWidth: 1280, videoHeight: 720 },
    [new El('source', { src: 'https://ex.com/v-alt.mp4' })]),
  new El('audio', { src: 'https://ex.com/a.mp3' }),
  new El('a', { href: 'https://ex.com/book.pdf' }),
  new El('a', { href: 'https://ex.com/pack.zip' }),
  new El('img', { class: 'icon-play', src: 'https://ex.com/sp.png', naturalWidth: 24, naturalHeight: 24 }),
  new El('iframe', { src: 'https://player.example/embed' }),
  new El('article', { class: 'content' }, [new El('img', { class: 'rich-pic', src: 'https://ex.com/inline.png', naturalWidth: 640, naturalHeight: 480 })]),
]);

const documentStub = {
  querySelectorAll(sel) {
    const list = all(doc);
    if (sel === '*') return list;
    if (sel === 'picture source') return list.filter(e => e.tagName === 'SOURCE' && e.closest('picture'));
    const attr = sel.match(/^([a-z]+)\[([a-z]+)\]$/i);
    return sel.split(',').map(x => x.trim()).flatMap(p => {
      if (attr) return list.filter(e => (!attr[1] || e.tagName === attr[1].toUpperCase()) && e.getAttribute(attr[2]) !== null);
      return list.filter(e => e.tagName === p.toUpperCase());
    });
  },
};
const getComputedStyleStub = (el) => ({ backgroundImage: el.backgroundImage });

const { collectResources, elSignature, ROLE_RE } = api(documentStub, { href: 'https://ex.com/' }, getComputedStyleStub);
console.log('--- 调试：签名与命中 ---');
all(doc).forEach(e => {
  if (e.tagName !== 'IMG') return;
  const sig = elSignature(e);
  console.log('  src=' + String(e.src).padEnd(30) + ' sig=[' + sig + ']  card=' + ROLE_RE.card.test(sig) + ' thumb=' + ROLE_RE.thumb.test(sig) + ' avatar=' + ROLE_RE.avatar.test(sig));
});
console.log('');
const res = collectResources();

const byUrl = {};
res.forEach(r => { byUrl[r.url] = r; });
const checks = [
  ['hero.jpg', 'hero'],
  ['card.jpg', 'card'],
  ['thumb.jpg', 'thumbnail'],
  ['u.png', 'avatar'],
  ['g1.jpg', 'gallery'],
  ['logo.png', 'logo'],
  ['bg.jpg', 'background'],
  ['v.mp4', 'video'],
  ['poster.jpg', 'poster'],
  ['a.mp3', 'audio'],
  ['book.pdf', 'file-link'],
  ['pack.zip', 'file-link'],
  ['sp.png', 'sprite'],
  ['inline.png', 'content'],
];

let pass = 0, fail = 0;
for (const [frag, expected] of checks) {
  const entry = res.find(r => r.url.includes(frag));
  const got = entry ? entry.role : '(未采集)';
  const ok = got === expected || (expected === 'file-link' && got === 'file-link');
  if (ok) pass++; else fail++;
  console.log((ok ? '  OK  ' : ' FAIL ') + frag.padEnd(14) + ' 期望 ' + expected.padEnd(11) + ' 实际 ' + got + (entry ? ('  kind=' + entry.kind + ' w=' + entry.w) : ''));
}
console.log('\n总计 ' + res.length + ' 条资源 | 角色 ' + new Set(res.map(r => r.role)).size + ' 类');
console.log('kind 分布: ' + JSON.stringify(res.reduce((a, r) => (a[r.kind] = (a[r.kind] || 0) + 1, a), {})));
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
