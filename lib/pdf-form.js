// PDF 양식(수주서·출장보고서·견적서) 읽기 도구 — ITB2026 uploads/handlers/pdf_form.py를 옮긴 것
// 샘플 PDF에서 확인한 내용
//  1) 글꼴이 숫자·일부 기호를 특수 코드로 저장한다 → U+E071~U+E07A → 0~9, U+E093 → , U+E094 → . U+E095 → :
//  2) 항목 이름 바로 아래(또는 오른쪽)에 값이 있다 → 글자 위치로 값을 읽는다
//  3) 긴 값은 "…"로 잘려 있다 → 확인 화면에서 사람이 고친다
// 글자 위치는 pdfjs로 한 글자씩 읽은 뒤, 원본(pdfplumber extract_words, keep_blank_chars, x_tolerance=2)과 같은 규칙으로 낱말로 묶는다.
import { createRequire } from 'node:module';

export const TRUNCATED = '…';
const fixChars = (s) => s.replace(/[-]/g, (c) => String(c.charCodeAt(0) - 0xE071))
  .replace(//g, ',').replace(//g, '.').replace(//g, ':');

let pdfjs;
async function lib() {
  if (!pdfjs) {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const require = createRequire(import.meta.url);
    pdfjs.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
  }
  return pdfjs;
}

// 한 페이지의 글자들 → 낱말 (pdfplumber와 같은 규칙)
//  - 줄: 글자 top이 3 이내로 이어지면 같은 줄 / 줄 안에서는 x0 순서
//  - 새 낱말: 앞 글자보다 왼쪽에서 시작, 앞 글자 끝 + 2보다 오른쪽, 또는 top이 3 넘게 아래
function charsToWords(chars) {
  const sorted = [...chars].sort((a, b) => a.top - b.top);
  const lines = [];
  for (const c of sorted) {
    const last = lines[lines.length - 1];
    if (last && c.top - last.lastTop <= 3) { last.chars.push(c); last.lastTop = c.top; } else lines.push({ chars: [c], lastTop: c.top });
  }
  const words = [];
  for (const line of lines) {
    let cur = [];
    const flush = () => {
      if (!cur.length) return;
      const text = fixChars(cur.map((c) => c.text).join('')).trim();
      if (text) words.push({ text, x0: Math.min(...cur.map((c) => c.x0)), x1: Math.max(...cur.map((c) => c.x1)), top: Math.min(...cur.map((c) => c.top)), bottom: Math.max(...cur.map((c) => c.bottom)) });
      cur = [];
    };
    for (const c of line.chars.sort((a, b) => a.x0 - b.x0 || a.top - b.top)) {
      const p = cur[cur.length - 1];
      if (p && (c.x0 < p.x0 || c.x0 > p.x1 + 2 || c.top > p.top + 3)) flush();
      cur.push(c);
    }
    flush();
  }
  return words;
}

const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];

// 페이지의 그리기 명령(글자 표시·위치 이동)을 따라가며 글자마다 위치를 계산한다 (pdfminer와 같은 방식)
//  x0 = 글자 시작, x1 = x0 + 글자 폭(자간 제외), bottom = 페이지 높이 − (기준선 + descent × 크기), top = bottom − 크기
// 공백 글자도 실제 글자로 남긴다 → 낱말 묶기에서 원본과 같게 "날       짜"는 한 낱말, 칸 사이 빈 곳은 나뉜다
async function pageChars(page, OPS) {
  const { height } = page.getViewport({ scale: 1 });
  const ol = await page.getOperatorList();
  const fontCache = {};
  const fontOf = (name) => {
    if (!(name in fontCache)) { try { fontCache[name] = page.commonObjs.get(name); } catch { fontCache[name] = null; } }
    return fontCache[name];
  };
  const chars = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let ts = { font: null, size: 0, tc: 0, tw: 0, th: 1, tl: 0, rise: 0 };
  let tm = [1, 0, 0, 1, 0, 0];
  let tlm = [1, 0, 0, 1, 0, 0];
  const moveTo = (tx, ty) => { tlm = mul([1, 0, 0, 1, tx, ty], tlm); tm = tlm.slice(); };
  const show = (glyphs) => {
    const font = fontOf(ts.font);
    const fm = font?.fontMatrix?.[0] || 0.001;
    // 글꼴 정보에 descent가 없으면(일부 글꼴은 NaN) 0으로 본다
    const descent = Number.isFinite(font?.descent) ? font.descent : 0;
    for (const g of glyphs) {
      if (typeof g === 'number') { tm = mul([1, 0, 0, 1, (-g / 1000) * ts.size * ts.th, 0], tm); continue; }
      if (!g) continue;
      const adv = (g.width || 0) * fm * ts.size;
      const trm = mul(mul([ts.size * ts.th, 0, 0, ts.size, 0, ts.rise], tm), ctm);
      const size = Math.hypot(trm[2], trm[3]);
      if (Math.abs(trm[1]) < 0.01 && g.unicode) {
        const x0 = trm[4];
        const x1 = x0 + adv * ts.th * Math.hypot(tm[0], tm[1]) * Math.hypot(ctm[0], ctm[1]);
        const bottom = height - (trm[5] + descent * size);
        chars.push({ text: g.unicode, x0, x1, top: bottom - size, bottom, size });
      }
      const tx = (adv + ts.tc + (g.isSpace ? ts.tw : 0)) * ts.th;
      tm = mul([1, 0, 0, 1, tx, 0], tm);
    }
  };
  for (let i = 0; i < ol.fnArray.length; i += 1) {
    const fn = ol.fnArray[i];
    const a = ol.argsArray[i];
    switch (fn) {
      case OPS.save: stack.push({ ctm, ts: { ...ts } }); break;
      case OPS.restore: { const s = stack.pop(); if (s) { ctm = s.ctm; ts = s.ts; } break; }
      case OPS.transform: ctm = mul(a, ctm); break;
      case OPS.beginText: tm = [1, 0, 0, 1, 0, 0]; tlm = tm.slice(); break;
      case OPS.setFont: ts.font = a[0]; ts.size = a[1]; break;
      case OPS.setCharSpacing: ts.tc = a[0]; break;
      case OPS.setWordSpacing: ts.tw = a[0]; break;
      case OPS.setHScale: ts.th = a[0] / 100; break;
      case OPS.setLeading: ts.tl = a[0]; break;
      case OPS.setTextRise: ts.rise = a[0]; break;
      case OPS.setTextMatrix: tm = a.slice(0, 6); tlm = tm.slice(); break;
      case OPS.moveText: moveTo(a[0], a[1]); break;
      case OPS.setLeadingMoveText: ts.tl = -a[1]; moveTo(a[0], a[1]); break;
      case OPS.nextLine: moveTo(0, -ts.tl); break;
      case OPS.showText: case OPS.showSpacedText: show(a[0]); break;
      case OPS.nextLineShowText: moveTo(0, -ts.tl); show(a[0]); break;
      case OPS.nextLineSetSpacingShowText: ts.tw = a[0]; ts.tc = a[1]; moveTo(0, -ts.tl); show(a[2]); break;
      default:
    }
  }
  return chars;
}

export async function readPages(buffer) {
  const { getDocument, OPS } = await lib();
  const doc = await getDocument({ data: new Uint8Array(buffer), disableFontFace: true, isEvalSupported: false, verbosity: 0 }).promise;
  const pages = [];
  try {
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      const { width, height } = page.getViewport({ scale: 1 });
      pages.push(new FormPage(charsToWords(await pageChars(page, OPS)), width, height));
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}

export class FormPage {
  constructor(words, width, height) { Object.assign(this, { words, width, height }); }
  find(text) { return this.words.find((w) => w.text === text) || null; }
  sameLine(a, b) { return Math.abs(a.top - b.top) < 1.5; }
  // 같은 줄에서 오른쪽에 있는 다음 항목 이름의 x 위치 = 이 칸의 오른쪽 끝
  rightBound(label) {
    const lefts = this.words.filter((w) => this.sameLine(w, label) && w.x0 > label.x1).map((w) => w.x0);
    return lefts.length ? Math.min(...lefts) : this.width;
  }
  // 글자들을 줄 단위로 묶어 왼쪽부터 이어 붙인다
  lines(words) {
    const lines = [];
    for (const w of [...words].sort((a, b) => Math.round(a.top) - Math.round(b.top) || a.x0 - b.x0)) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.top - w.top) < 1.5) last.parts.push(w.text); else lines.push({ top: w.top, parts: [w.text] });
    }
    return lines.map((l) => l.parts.join(' '));
  }
  // 항목 이름 아래 값. labels: 이 양식의 모든 항목 이름, headings: 구역 제목(가로 전체를 나눔)
  value(labelText, labels, headings) {
    const label = this.find(labelText);
    if (!label) return null;
    const left = label.x0 - 3;
    const right = this.rightBound(label);
    const inCol = (w) => left <= w.x0 && w.x0 < right;
    const stops = this.words.filter((w) => w.top > label.top + 1 && ((labels.includes(w.text) && inCol(w)) || headings.includes(w.text))).map((w) => w.top);
    const bottom = stops.length ? Math.min(...stops) : this.height + 1;
    const words = this.words.filter((w) => label.top + 1 < w.top && w.top < bottom && inCol(w) && !labels.includes(w.text));
    return this.lines(words).join('\n');
  }
  // 표 읽기: 머리글 칸의 x 위치로 열을 나누고, 머리글 아래부터 stop 글자 전까지를 행으로 읽는다
  table(headerTexts, stopTexts) {
    const header = headerTexts.map((t) => this.find(t));
    if (header.some((h) => !h)) return [];
    const top = header[0].top;
    const stops = this.words.filter((w) => w.top > top + 1 && stopTexts.some((s) => w.text.startsWith(s))).map((w) => w.top);
    const bottom = stops.length ? Math.min(...stops) : this.height + 1;
    const bounds = [...header.map((h) => h.x0 - 3), this.width];
    const body = this.words.filter((w) => top + 1 < w.top && w.top < bottom);
    const rows = [];
    for (const lineTop of [...new Set(body.map((w) => Math.round(w.top)))].sort((a, b) => a - b)) {
      const line = body.filter((w) => Math.abs(Math.round(w.top) - lineTop) < 1.5).sort((a, b) => a.x0 - b.x0);
      const row = Object.fromEntries(headerTexts.map((name, i) => [name, line.filter((w) => bounds[i] <= w.x0 && w.x0 < bounds[i + 1]).map((w) => w.text).join(' ')]));
      if (Object.values(row).some(Boolean) && !rows.some((r) => JSON.stringify(r) === JSON.stringify(row))) rows.push(row);
    }
    return rows;
  }
}
