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
  Chart.defaults.plugins.tooltip.backgroundColor = '#1d2129';
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.boxPadding = 4;
  Chart.defaults.maintainAspectRatio = false;
}

const tooltipWon = {
  callbacks: {
    label: (ctx) => ` ${ctx.dataset.label || ctx.label}: ${won(ctx.parsed.y ?? ctx.parsed)}`,
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
        tooltip: { callbacks: { label: (c) => ` ${c.label}: ${won(c.parsed)} (${pct(c.parsed / total)})` } },
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
      plugins: { tooltip: { enabled: !!target, callbacks: { label: (c) => ` ${c.label}: ${won(c.parsed)}` } } },
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
