// Chart.js 공통 설정. 색상은 역할(분야·구분)에 고정 — 순위가 바뀌어도 색이 따라가지 않는다.
import { won, pct, esc } from './core.js';

export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
export const OTHER = '#a3a8b0';
export const REMAIN = '#e6e9ee';
export const INK = { primary: '#1d2129', secondary: '#4e5560', muted: '#8a919c', grid: '#eef0f3' };

export const INDUSTRY_COLORS = {
  상하수도: SERIES[0], 발전소: SERIES[1], 가스: SERIES[2], 오일: SERIES[3],
  석유: SERIES[4], '민간 플랜트': SERIES[5], 기타: OTHER,
};

// 제품 시리즈: 처음 본 순서대로 슬롯 배정 후 브라우저에 기억 → 기간을 바꿔도 같은 시리즈는 같은 색
const seriesSlots = (() => { try { return JSON.parse(localStorage.getItem('seriesColors') || '{}'); } catch { return {}; } })();
export function seriesColor(label) {
  if (label === '기타' || label === '(미지정)') return OTHER;
  if (!(label in seriesSlots)) {
    seriesSlots[label] = Object.keys(seriesSlots).length % SERIES.length;
    try { localStorage.setItem('seriesColors', JSON.stringify(seriesSlots)); } catch { /* 무시 */ }
  }
  return SERIES[seriesSlots[label]];
}

if (window.Chart) {
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.font.size = 12;
  Chart.defaults.color = INK.secondary;
  Chart.defaults.plugins.legend.display = false;
  // 툴팁은 그래프 안이 아니라 페이지 맨 위층의 HTML 상자로 그린다 → 작은 원형에서도 잘리거나 글자와 겹치지 않음
  Chart.defaults.plugins.tooltip.enabled = false;
  Chart.defaults.plugins.tooltip.external = externalTooltip;
  Chart.defaults.maintainAspectRatio = false;
}

let tipEl;
export function hideTooltip() {
  if (tipEl) tipEl.style.opacity = '0';
}
function externalTooltip({ chart, tooltip }) {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'chart-tip';
    document.body.appendChild(tipEl);
    // 스크롤하면 위치가 어긋나므로 숨김
    document.addEventListener('scroll', hideTooltip, true);
  }
  if (tooltip.opacity === 0 || !tooltip.body?.length) { hideTooltip(); return; }
  const title = (tooltip.title || []).filter(Boolean);
  const rows = tooltip.body.map((b, i) => {
    const c = tooltip.labelColors[i] || {};
    const color = typeof c.backgroundColor === 'string' ? c.backgroundColor : (c.borderColor || '#888');
    return `<div class="tip-row"><span class="tip-sw" style="background:${esc(color)}"></span>${esc(b.lines.join(' ').trim())}</div>`;
  }).join('');
  const footer = (tooltip.footer || []).filter(Boolean).map((f) => `<div class="tip-foot">${esc(f)}</div>`).join('');
  tipEl.innerHTML = `${title.length ? `<div class="tip-title">${esc(title.join(' '))}</div>` : ''}${rows}${footer}`;
  tipEl.style.opacity = '1';
  const r = chart.canvas.getBoundingClientRect();
  const w = tipEl.offsetWidth;
  const h = tipEl.offsetHeight;
  let x = r.left + tooltip.caretX + 14;
  if (x + w > window.innerWidth - 8) x = r.left + tooltip.caretX - w - 14; // 오른쪽이 모자라면 왼쪽에
  let y = r.top + tooltip.caretY - h / 2;
  y = Math.max(8, Math.min(y, window.innerHeight - h - 8));
  tipEl.style.left = `${Math.max(8, x)}px`;
  tipEl.style.top = `${y}px`;
}

const tooltipWon = {
  callbacks: {
    label: (ctx) => `${ctx.dataset.label || ctx.label}: ${won(ctx.parsed.y ?? ctx.parsed)}`,
  },
};

// 도넛 + 직접 라벨 범례 (색 + 이름 + 금액 + 비율)
export function donut(canvas, legendEl, items, colorOf) {
  const total = items.reduce((a, b) => a + b.value, 0);
  const shown = items.filter((x) => x.value > 0);
  const chart = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: shown.map((x) => x.label),
      datasets: [{
        data: shown.map((x) => x.value),
        backgroundColor: shown.map((x) => colorOf(x.label)),
        borderColor: '#ffffff', borderWidth: 2, hoverOffset: 4,
      }],
    },
    options: {
      cutout: '62%',
      plugins: {
        tooltip: { callbacks: { title: () => '', label: (c) => `${c.label}: ${won(c.parsed)} (${pct(c.parsed / total)})` } },
      },
    },
  });
  if (legendEl) {
    legendEl.innerHTML = items.length
      ? items.map((x) => `
        <div class="row ${x.value > 0 ? '' : 'zero'}">
          <span class="sw" style="background:${colorOf(x.label)}"></span>
          <span class="lab">${esc(x.label)}</span>
          <span class="val">${won(x.value)}</span>
          <span class="pct">${total ? pct(x.value / total, 1) : '-'}</span>
        </div>`).join('')
      : '';
  }
  return chart;
}

// 목표 달성 게이지 (달성 / 남은 목표)
export function gauge(canvas, achieved, target) {
  const done = Math.min(achieved, target || achieved);
  return new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: ['달성', '남은 목표'],
      datasets: [{
        data: target ? [done, Math.max(0, target - done)] : [1, 0],
        backgroundColor: [target ? SERIES[0] : REMAIN, REMAIN],
        borderColor: '#ffffff', borderWidth: 2,
      }],
    },
    options: {
      cutout: '74%', rotation: -90, circumference: 360,
      plugins: { tooltip: { external: target ? externalTooltip : () => {}, callbacks: {
        title: () => '',
        // 고리는 100%까지만 채우지만, 툴팁은 실제 실적·남은 금액을 보여준다
        label: (c) => (c.dataIndex === 0
          ? `실적: ${won(achieved)} (${pct(achieved / target, 1)})`
          : `남은 목표: ${won(Math.max(0, target - achieved))}`),
      } } },
    },
  });
}

// 누적 막대 (+ 선택: 같은 축의 목표 페이스 선)
export function stackedBar(canvas, labels, stacks, { line, highlightIndex } = {}) {
  const datasets = stacks.map((s) => ({
    type: 'bar', label: s.label, data: s.data, stack: 'a',
    backgroundColor: s.data.map((_, i) => (highlightIndex === undefined || i === highlightIndex ? s.color : s.color + '73')),
    borderColor: '#ffffff', borderWidth: { top: 2 }, borderRadius: 4, borderSkipped: 'start', maxBarThickness: 32,
  }));
  if (line) {
    datasets.push({
      type: 'line', label: line.label, data: line.data, borderColor: INK.primary, borderWidth: 2,
      borderDash: [5, 4], pointRadius: 0, pointHoverRadius: 4, fill: false, order: -1,
    });
  }
  return new Chart(canvas, {
    data: { labels, datasets },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { stacked: true, grid: { display: false }, border: { color: INK.grid } },
        y: { stacked: true, grid: { color: INK.grid }, border: { display: false }, ticks: { callback: (v) => won(v, { digits: 1 }) } },
      },
      plugins: {
        legend: { display: true, position: 'top', align: 'end', labels: { boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 2 } },
        tooltip: {
          ...tooltipWon,
          footer: (items) => `합계: ${won(items.filter((i) => i.dataset.type === 'bar').reduce((a, i) => a + i.parsed.y, 0))}`,
        },
      },
    },
  });
}

// 가로 막대 (미수금 경과일)
export function hbar(canvas, labels, values, colors) {
  return new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ label: '미수금', data: values, backgroundColor: colors, borderRadius: 4, borderSkipped: 'start', maxBarThickness: 22 }] },
    options: {
      indexAxis: 'y',
      scales: {
        x: { grid: { color: INK.grid }, border: { display: false }, ticks: { callback: (v) => won(v, { digits: 1 }) } },
        y: { grid: { display: false }, border: { color: INK.grid } },
      },
      plugins: { tooltip: { callbacks: { label: (c) => ` ${won(c.parsed.x)}` } } },
    },
  });
}

// 매출·지출 나란히 비교 막대 (+ 같은 축의 목표 매출 선). 선택되지 않은 기간은 옅게.
export function compareBar(canvas, labels, series, { line, selected } = {}) {
  const fade = (c, i) => (!selected || selected[i] ? c : c + '59');
  const datasets = series.map((s) => ({
    type: 'bar', label: s.label, data: s.data,
    backgroundColor: s.data.map((_, i) => fade(s.color, i)),
    borderRadius: 4, borderSkipped: 'start', maxBarThickness: 22, categoryPercentage: 0.7, barPercentage: 0.9,
  }));
  if (line) {
    datasets.push({
      type: 'line', label: line.label, data: line.data, borderColor: INK.primary, borderWidth: 2,
      borderDash: [5, 4], pointRadius: 0, pointHoverRadius: 4, fill: false, order: -1, stepped: 'middle',
    });
  }
  return new Chart(canvas, {
    data: { labels, datasets },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { grid: { display: false }, border: { color: INK.grid } },
        y: { beginAtZero: true, grid: { color: INK.grid }, border: { display: false }, ticks: { callback: (v) => won(v, { digits: 1 }) } },
      },
      plugins: {
        legend: { display: true, position: 'top', align: 'end', labels: { boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 2 } },
        tooltip: {
          ...tooltipWon,
          footer: (items) => {
            const v = Object.fromEntries(items.map((i) => [i.dataset.label, i.parsed.y]));
            return v['매출'] !== undefined && v['지출'] !== undefined ? `추정 이익: ${won(v['매출'] - v['지출'])}` : '';
          },
        },
      },
    },
  });
}
