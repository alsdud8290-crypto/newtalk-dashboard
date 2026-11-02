// 한국 지도(제주 포함): 시·도 경계 위에 출장지를 점으로 표시. 점 넓이 = 출장 횟수
// 시·도 경계 GeoJSON(통계청 2013, 간소화)을 SVG로 직접 그린다 — 배경 지도 타일·외부 서버가 필요 없다.
import { esc } from './core.js';
import { SERIES } from './charts.js';
import { pointOf, REGION_ALIASES } from './regions.js';

let geo = null;
const loadGeo = async () => (geo ||= await (await fetch('/data/skorea_provinces.json')).json());

// 위도 36° 근처라 경도에 cos(36°)를 곱한 단순 투영 (한국 범위에서는 충분)
const K = Math.cos((36 * Math.PI) / 180);
const BOUNDS = { minX: 124.6 * K, maxX: 131.0 * K, minY: 33.0, maxY: 38.7 };
const W = 520;
const H = Math.round(W * (BOUNDS.maxY - BOUNDS.minY) / (BOUNDS.maxX - BOUNDS.minX));
const proj = ([lon, lat]) => [((lon * K - BOUNDS.minX) / (BOUNDS.maxX - BOUNDS.minX)) * W, ((BOUNDS.maxY - lat) / (BOUNDS.maxY - BOUNDS.minY)) * H];
const ringPath = (ring) => ring.map((pt, i) => { const [x, y] = proj(pt); return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`; }).join('') + 'Z';
const featurePath = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map((poly) => poly.map(ringPath).join('')).join('');

let tip;
function showTip(e, text) {
  if (!tip) { tip = document.createElement('div'); tip.className = 'chart-tip'; document.body.appendChild(tip); }
  tip.innerHTML = `<div class="tip-row">${esc(text)}</div>`;
  tip.style.opacity = '1';
  tip.style.left = `${Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8)}px`;
  tip.style.top = `${e.clientY - tip.offsetHeight - 10}px`;
}
export const hideMapTip = () => { if (tip) tip.style.opacity = '0'; };

// items: [{ name, quantity, region, district }], small: 시·군별처럼 점이 많을 때 점을 작게
export async function koreaMap(el, items, { small = false } = {}) {
  const g = await loadGeo();
  const max = Math.max(1, ...items.map((i) => i.quantity));
  const dots = items.filter((i) => i.quantity && pointOf(i)).sort((a, b) => b.quantity - a.quantity).map((i) => {
    const [lat, lon] = pointOf(i);
    const [x, y] = proj([lon, lat]);
    // 원의 넓이가 횟수에 비례하도록 반지름은 제곱근으로
    const r = small ? 4 + 12 * Math.sqrt(i.quantity / max) : 6 + 18 * Math.sqrt(i.quantity / max);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" data-tip="${esc(`${i.name} ${i.quantity}회`)}"/>`;
  }).join('');
  el.innerHTML = `
    <svg class="korea-map" viewBox="0 0 ${W} ${H}" role="img" aria-label="지역별 출장 횟수 지도">
      <g class="prov">${g.features.map((f) => `<path d="${featurePath(f.geometry)}" data-tip="${esc(REGION_ALIASES[f.properties.name] || f.properties.name)}"/>`).join('')}</g>
      <g class="dots" fill="${SERIES[0]}">${dots}</g>
    </svg>
    <div class="map-credit">시·도 경계: 통계청(2013)</div>`;
  const svg = el.querySelector('svg');
  svg.addEventListener('mousemove', (e) => { const t = e.target.closest('[data-tip]'); if (t) showTip(e, t.dataset.tip); else hideMapTip(); });
  svg.addEventListener('mouseleave', hideMapTip);
}
