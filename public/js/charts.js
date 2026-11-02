// Chart.js 공통 설정. 색상은 역할(분야·구분)에 고정 — 순위가 바뀌어도 색이 따라가지 않는다.
import { won, pct, esc } from './core.js';

// NEWTORK 브랜드 기반 분류색 (네이비 → 오렌지 → …). 색각 이상 구분·명도·채도 검사(validate_palette) 통과한 순서
export const SERIES = ['#2e5aa0', '#e0612f', '#169c8c', '#d7a12a', '#b85c9e', '#6f9b3c', '#8a63d2'];
export const OTHER = '#b3ada3';
export const REMAIN = '#ece8e1';
export const INK = { primary: '#1d2433', secondary: '#565d6b', muted: '#979ba4', grid: '#efebe5' };

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
  Chart.defaults.devicePixelRatio = Math.max(2, window.devicePixelRatio || 1); // 이미지 저장 시에도 선명하게
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
// opts.fmt: 값 표시 (기본 원 단위), opts.onSelect(label): 조각·범례를 누를 때
export function donut(canvas, legendEl, items, colorOf, opts = {}) {
  const fmt = opts.fmt || won;
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
        tooltip: { callbacks: { title: () => '', label: (c) => `${c.label}: ${fmt(c.parsed)} (${pct(c.parsed / total)})` } },
      },
      onClick: (_, els) => { if (els.length && opts.onSelect) opts.onSelect(shown[els[0].index].label); },
      onHover: (e, els) => { e.native.target.style.cursor = els.length && opts.onSelect ? 'pointer' : 'default'; },
    },
  });
  if (legendEl) {
    legendEl.innerHTML = items.length
      ? items.map((x) => `
        <div class="row ${x.value > 0 ? '' : 'zero'} ${opts.onSelect ? 'click' : ''}" data-label="${esc(x.label)}">
          <span class="sw" style="background:${colorOf(x.label)}"></span>
          <span class="lab">${esc(x.label)}</span>
          <span class="val">${fmt(x.value)}</span>
          <span class="pct">${total ? pct(x.value / total, 1) : '-'}</span>
        </div>`).join('')
      : '';
    if (opts.onSelect) legendEl.onclick = (e) => { const r = e.target.closest('[data-label]'); if (r) opts.onSelect(r.dataset.label); };
  }
  return chart;
}

// 목표 달성 게이지 (달성 / 남은 목표)
// opts: 강조 카드(오렌지 배경)에서는 흰 고리 { color, rest, gap }
export function gauge(canvas, achieved, target, opts = {}) {
  const fmt = opts.fmt || won;
  const done = Math.min(achieved, target || achieved);
  const color = opts.color || SERIES[0];
  const rest = opts.rest || REMAIN;
  return new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: ['달성', '남은 목표'],
      datasets: [{
        data: target ? [done, Math.max(0, target - done)] : [1, 0],
        backgroundColor: [target ? color : rest, rest],
        borderColor: opts.gap || '#ffffff', borderWidth: 2, borderRadius: target && done < target ? 6 : 0,
      }],
    },
    options: {
      cutout: '74%', rotation: -90, circumference: 360,
      plugins: { tooltip: { external: target ? externalTooltip : () => {}, callbacks: {
        title: () => '',
        // 고리는 100%까지만 채우지만, 툴팁은 실제 실적·남은 금액을 보여준다
        label: (c) => (c.dataIndex === 0
          ? `실적: ${fmt(achieved)} (${pct(achieved / target, 1)})`
          : `남은 목표: ${fmt(Math.max(0, target - achieved))}`),
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

// 기준값 대비 차이율(%) 가로 막대 — 0(뉴토크 기준값)에서 오른쪽은 비쌈(주황), 왼쪽은 쌈(남색)
// items: [{ key, label, rate, detail }]. 색만으로 읽지 않게 툴팁·표에 +/− 기호와 숫자를 함께 보여 준다
export const DIFF_ABOVE = SERIES[1];
export const DIFF_BELOW = SERIES[0];
export function diffBar(canvas, items, { selected = null, onSelect } = {}) {
  const colorOf = (i) => (i.rate > 0 ? DIFF_ABOVE : i.rate < 0 ? DIFF_BELOW : OTHER);
  const bound = Math.ceil(Math.max(5, ...items.map((i) => Math.abs(i.rate))) / 5) * 5;
  const signed = (r) => `${r > 0 ? '+' : ''}${r}%`;
  canvas.parentElement.style.height = `${Math.max(items.length, 1) * 30 + 40}px`;
  return new Chart(canvas, {
    type: 'bar',
    data: {
      labels: items.map((i) => i.label),
      datasets: [{
        data: items.map((i) => i.rate),
        backgroundColor: items.map((i) => (selected === null || selected === i.key ? colorOf(i) : `${colorOf(i)}55`)),
        borderRadius: 4, borderSkipped: false, barThickness: 14,
      }],
    },
    options: {
      indexAxis: 'y',
      animation: false,
      onClick: (_, els) => { if (els.length && onSelect) onSelect(items[els[0].index].key); },
      onHover: (e, els) => { e.native.target.style.cursor = els.length && onSelect ? 'pointer' : 'default'; },
      scales: {
        x: {
          min: -bound, max: bound,
          ticks: { callback: (v) => signed(v) },
          // 0% 선(= 뉴토크 기준값)만 진하게
          grid: { color: (c) => (c.tick.value === 0 ? INK.secondary : INK.grid), lineWidth: (c) => (c.tick.value === 0 ? 1.5 : 1) },
          border: { display: false },
        },
        y: { grid: { display: false }, border: { display: false } },
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: (c) => {
              const i = items[c.dataIndex];
              return `기준값 대비 ${signed(i.rate)}${i.detail ? ` · ${i.detail}` : ''}`;
            },
          },
        },
      },
    },
  });
}

// 생산량 막대 (월별·분기별): 생산량 막대 + 목표 점선 + (선택) 전년 같은 달·분기(점선 테두리 막대) + (선택) 수주량 선
// bars: [{ value, label, actual, orders, lastYear, selected, inProgress }] — 선택한 기간은 진하게, 누르면 onSelect(value)
export const ORDER_LINE = SERIES[1];
export function prodBars(canvas, bars, { target, targetName = '목표', unitName = '달', showOrders, showLastYear, onSelect } = {}) {
  const color = SERIES[0];
  const anySelected = bars.some((b) => b.selected);
  const datasets = [];
  if (showLastYear) {
    datasets.push({ type: 'bar', label: `전년 같은 ${unitName}`, data: bars.map((b) => b.lastYear ?? 0), backgroundColor: 'rgba(0,0,0,0)',
      borderColor: INK.muted, borderWidth: 1.5, borderDash: [4, 3], borderRadius: 4, borderSkipped: false, maxBarThickness: 22, order: 2 });
  }
  datasets.push({ type: 'bar', label: '생산량', data: bars.map((b) => b.actual),
    backgroundColor: bars.map((b) => (!anySelected || b.selected ? color : `${color}59`)), borderRadius: 4, borderSkipped: 'start', maxBarThickness: 22, order: 1 });
  if (showOrders) {
    datasets.push({ type: 'line', label: '수주량', data: bars.map((b) => b.orders), borderColor: ORDER_LINE, backgroundColor: ORDER_LINE,
      borderWidth: 2, pointRadius: 2.5, pointHoverRadius: 4, tension: 0.25, order: 0 });
  }
  if (target !== null && target !== undefined) {
    datasets.push({ type: 'line', label: targetName, data: bars.map(() => target), borderColor: INK.primary, borderWidth: 1.5,
      borderDash: [5, 4], pointRadius: 0, pointHoverRadius: 0, fill: false, order: -1 });
  }
  const unit = (v) => `${Number(v).toLocaleString('ko-KR')}대`;
  return new Chart(canvas, {
    data: { labels: bars.map((b) => (b.inProgress ? [b.label, '진행 중'] : b.label)), datasets },
    options: {
      interaction: { mode: 'index', intersect: false },
      onClick: (_, els) => { if (els.length && onSelect) onSelect(bars[els[0].index].value); },
      onHover: (e, els) => { e.native.target.style.cursor = els.length && onSelect ? 'pointer' : 'default'; },
      scales: {
        x: { grid: { display: false }, border: { color: INK.grid }, ticks: { color: (c) => (bars[c.index]?.inProgress ? SERIES[1] : INK.secondary) } },
        y: { beginAtZero: true, grid: { color: INK.grid }, border: { display: false }, ticks: { precision: 0 } },
      },
      plugins: {
        tooltip: {
          callbacks: {
            title: (items) => bars[items[0].dataIndex].label,
            label: (c) => `${c.dataset.label}: ${unit(c.parsed.y)}`,
            footer: (items) => {
              const b = bars[items[0].dataIndex];
              const out = [];
              if (target) out.push(`${targetName} 대비 ${b.actual - target >= 0 ? '+' : ''}${Math.round((b.actual - target) * 10) / 10}대 (${Math.round(b.actual / target * 1000) / 10}%)`);
              if (b.inProgress) out.push('아직 끝나지 않아 낮게 보일 수 있음');
              return out;
            },
          },
        },
      },
    },
  });
}
