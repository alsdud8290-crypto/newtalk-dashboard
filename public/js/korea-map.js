// 한국 지도(제주 포함): 시·도 경계 위에 출장지를 원으로 표시. 원 넓이 = 출장 횟수
// 시·도 경계 GeoJSON(통계청 2013, 간소화)을 SVG로 직접 그린다 — 배경 지도 타일·외부 서버가 필요 없다.
//  - 상위 지역(기본 5곳, 좁은 화면 3곳)은 "포항시 10회·12.7%"를 항상 표시. 원이 몰려 글자가 겹치면 조금 떨어진 곳에 두고 선으로 잇고, 그래도 겹치면 생략
//  - 마우스를 올리면 지역 이름 · 출장 N회 · 전체 대비 %. 시·도 경계에 올리면 그 시·도 합계
//  - 색·글꼴은 SVG 속성으로 직접 넣는다 (PDF 저장 때 html2canvas가 CSS 클래스 없이 SVG만 그려도 같게 보이도록). CSS는 강조(on)만
//  - 시·군 없이 시·도 위치에 찍는 원(특별·광역시, 시·군 미지정)은 속이 빈 원
import { esc } from './core.js';
import { SERIES } from './charts.js';
import { pointOf, REGION_ALIASES } from './regions.js';

let geo = null;
async function loadGeo() {
  if (!geo) {
    const res = await fetch('/data/skorea_provinces.json');
    if (!res.ok) throw new Error('지도 경계 파일을 불러오지 못했습니다.');
    geo = await res.json();
  }
  return geo;
}

// 위도 36° 근처라 경도에 cos(36°)를 곱한 단순 투영 (한국 범위에서는 충분)
const K = Math.cos((36 * Math.PI) / 180);
const BOUNDS = { minX: 124.6 * K, maxX: 131.0 * K, minY: 33.0, maxY: 38.7 };
const W = 520;
const H = Math.round(W * (BOUNDS.maxY - BOUNDS.minY) / (BOUNDS.maxX - BOUNDS.minX));
const proj = ([lon, lat]) => [((lon * K - BOUNDS.minX) / (BOUNDS.maxX - BOUNDS.minX)) * W, ((BOUNDS.maxY - lat) / (BOUNDS.maxY - BOUNDS.minY)) * H];
const ringPath = (ring) => ring.map((pt, i) => { const [x, y] = proj(pt); return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`; }).join('') + 'Z';
const featurePath = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map((poly) => poly.map(ringPath).join('')).join('');

const pct = (n, total) => (total ? ((n / total) * 100).toFixed(1) : '0.0');
export const mapKey = (i) => `${i.region || i.name}|${i.district || ''}`;

let tip;
function showTip(e, title, lines) {
  if (!tip) { tip = document.createElement('div'); tip.className = 'chart-tip'; document.body.appendChild(tip); }
  tip.innerHTML = `<div class="tip-title">${esc(title)}</div>${lines.map((l) => `<div class="tip-row">${esc(l)}</div>`).join('')}`;
  tip.style.opacity = '1';
  tip.style.left = `${Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8)}px`;
  tip.style.top = `${Math.max(8, e.clientY - tip.offsetHeight - 10)}px`;
}
export const hideMapTip = () => { if (tip) tip.style.opacity = '0'; };

// ---------- 상위 지역 글자 배치 ----------
const FS = 12; // 글자 크기 (지도 좌표 기준)
const textWidth = (s) => [...s].reduce((w, ch) => w + (/[가-힣]/.test(ch) ? FS * 0.98 : /[0-9.%·]/.test(ch) ? FS * 0.6 : FS * 0.55), 0);
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const boxOfCircle = (d) => ({ x: d.x - d.r, y: d.y - d.r, w: d.r * 2, h: d.r * 2 });
// 원 옆(가까운 자리) → 조금 떨어진 자리(선으로 이음) 순서로 겹치지 않는 자리를 찾는다
function placeLabels(top, allDots) {
  const taken = top.map(boxOfCircle); // 글자 붙는 원은 가리지 않게
  // 다른 큰 원도 되도록 가리지 않게 (작은 원은 가려도 마우스를 올리면 보임)
  for (const d of allDots) if (!top.includes(d) && d.r >= 9) taken.push(boxOfCircle(d));
  const out = [];
  for (const d of top) {
    const w = textWidth(d.label);
    const h = FS + 4;
    const gap = 5;
    const near = [
      [d.x + d.r + gap, d.y - h / 2, 'start'], [d.x - d.r - gap - w, d.y - h / 2, 'end'],
      [d.x - w / 2, d.y - d.r - gap - h, 'middle'], [d.x - w / 2, d.y + d.r + gap, 'middle'],
    ].map(([x, y, anchor]) => ({ x, y, w, h, anchor, line: false }));
    const far = [];
    for (const dist of [22, 38]) {
      for (const [dx, dy] of [[1, -1], [-1, -1], [1, 1], [-1, 1], [1, 0], [-1, 0]]) {
        const cx = d.x + dx * (d.r + dist);
        const cy = d.y + dy * (d.r + dist * 0.7);
        far.push({ x: dx > 0 ? cx : dx < 0 ? cx - w : cx - w / 2, y: cy - h / 2, w, h, anchor: dx > 0 ? 'start' : dx < 0 ? 'end' : 'middle', line: true, lx: cx, ly: cy });
      }
    }
    const inside = (b) => b.x >= 2 && b.y >= 2 && b.x + b.w <= W - 2 && b.y + b.h <= H - 14;
    // 가까운 자리는 자기 원과 겹쳐도 됨(원 테두리 바로 옆), 다른 것과는 겹치면 안 됨
    const ok = (b) => inside(b) && !taken.some((t, i) => (i === top.indexOf(d) ? false : overlap(b, t)));
    const pick = near.find(ok) || far.find((b) => ok(b) && !overlap(b, boxOfCircle(d)));
    if (!pick) continue; // 자리가 없으면 생략 (마우스를 올리면 보임)
    taken.push(pick);
    out.push({ d, ...pick });
  }
  return out;
}
function labelSvg({ d, x, y, w, h, anchor, line, lx, ly }) {
  const tx = anchor === 'start' ? x : anchor === 'end' ? x + w : x + w / 2;
  const ty = y + h / 2;
  // 선: 원 테두리에서 글자 쪽으로
  let lineSvg = '';
  if (line) {
    const ang = Math.atan2(ly - d.y, lx - d.x);
    const sx = d.x + Math.cos(ang) * d.r;
    const sy = d.y + Math.sin(ang) * d.r;
    lineSvg = `<line stroke="#565d6b" stroke-width="1" x1="${sx.toFixed(1)}" y1="${sy.toFixed(1)}" x2="${lx.toFixed(1)}" y2="${ly.toFixed(1)}"/>`;
  }
  return `<g data-key="${esc(d.key)}">${lineSvg}<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" text-anchor="${anchor}" dy="0.35em" fill="#1d2433" stroke="#fff" stroke-width="3.5" stroke-linejoin="round" paint-order="stroke">${esc(d.label)}</text></g>`;
}

// items: [{ name, quantity, region, district }]
//  small: 시·군별처럼 원이 많을 때 원을 작게 / labelCount: 항상 표시할 상위 지역 수 (없으면 화면 폭에 따라 5 또는 3)
//  shortName(item): 지도 글자에 쓸 짧은 이름 / onHover(key | null): 원에 마우스가 올라가거나 빠질 때 (순위표 강조용)
// 돌려주는 값: { highlight(key | null) } — 순위표에서 마우스를 올린 지역의 원을 강조
export async function koreaMap(el, items, { small = false, labelCount, shortName = (i) => i.name, onHover = () => {} } = {}) {
  const g = await loadGeo();
  const total = items.reduce((a, i) => a + i.quantity, 0);
  const max = Math.max(1, ...items.map((i) => i.quantity));
  const byRegion = {};
  for (const i of items) byRegion[i.region || i.name] = (byRegion[i.region || i.name] || 0) + i.quantity;
  const dots = items.filter((i) => i.quantity && pointOf(i)).sort((a, b) => b.quantity - a.quantity).map((i) => {
    const [lat, lon] = pointOf(i);
    const [x, y] = proj([lon, lat]);
    // 원의 넓이가 횟수에 비례하도록 반지름은 제곱근으로
    const r = small ? 4 + 12 * Math.sqrt(i.quantity / max) : 6 + 18 * Math.sqrt(i.quantity / max);
    return { item: i, key: mapKey(i), x, y, r, hollow: small && !i.district, label: `${shortName(i)} ${i.quantity.toLocaleString('ko-KR')}회·${pct(i.quantity, total)}%` };
  });
  const n = labelCount ?? ((el.clientWidth || W) < 420 ? 3 : 5);
  const labels = placeLabels(dots.slice(0, n), dots);
  el.innerHTML = `
    <svg class="korea-map" viewBox="0 0 ${W} ${H}" role="img" aria-label="지역별 출장 횟수 지도">
      <g class="prov" fill="#e9e5dd" stroke="#fff" stroke-width="1">${g.features.map((f) => `<path d="${featurePath(f.geometry)}" data-region="${esc(REGION_ALIASES[f.properties.name] || f.properties.name)}"/>`).join('')}</g>
      <g class="dots">${dots.map((d) => `<circle class="${d.hollow ? 'hollow' : ''}" cx="${d.x.toFixed(1)}" cy="${d.y.toFixed(1)}" r="${d.r.toFixed(1)}" data-key="${esc(d.key)}"
        ${d.hollow ? `fill="#fff" fill-opacity="0.85" stroke="${SERIES[0]}" stroke-width="2"` : `fill="${SERIES[0]}" fill-opacity="0.78" stroke="#fff" stroke-width="1.5"`}/>`).join('')}</g>
      <g class="labels" font-size="${FS}" font-weight="700" font-family="Pretendard, 'Malgun Gothic', sans-serif">${labels.map(labelSvg).join('')}</g>
    </svg>
    <div class="map-credit">시·도 경계: 통계청(2013)</div>`;
  const svg = el.querySelector('svg');
  const dotOf = Object.fromEntries(dots.map((d) => [d.key, d]));
  let current = null;
  const highlight = (key) => {
    if (key === current) return;
    current = key;
    svg.querySelectorAll('[data-key].on').forEach((x) => x.classList.remove('on'));
    if (key) svg.querySelectorAll(`[data-key="${CSS.escape(key)}"]`).forEach((x) => x.classList.add('on'));
    // 강조한 원을 맨 위로 (큰 원에 가려지지 않게)
    const c = key && svg.querySelector(`circle[data-key="${CSS.escape(key)}"]`);
    if (c) c.parentNode.appendChild(c);
  };
  svg.addEventListener('mousemove', (e) => {
    const t = e.target.closest('[data-key], [data-region]');
    const d = t?.dataset.key && dotOf[t.dataset.key];
    if (d) {
      showTip(e, d.item.name, [`출장 ${d.item.quantity.toLocaleString('ko-KR')}회`, `전체 대비 ${pct(d.item.quantity, total)}%`]);
      highlight(d.key);
      onHover(d.key);
      return;
    }
    highlight(null);
    onHover(null);
    if (t?.dataset.region) {
      const q = byRegion[t.dataset.region] || 0;
      showTip(e, t.dataset.region, q ? [`출장 ${q.toLocaleString('ko-KR')}회`, `전체 대비 ${pct(q, total)}%`] : ['출장 없음']);
    } else hideMapTip();
  });
  svg.addEventListener('mouseleave', () => { hideMapTip(); highlight(null); onHover(null); });
  return { highlight, total };
}
