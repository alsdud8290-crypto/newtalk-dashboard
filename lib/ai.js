import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.AI_MODEL || 'claude-opus-5-5';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'status', 'shortfalls', 'nextActions'],
  properties: {
    headline: { type: 'string', description: '한 문장 핵심 요약' },
    status: { type: 'array', items: { type: 'string' }, description: '이번 기간 매출·비용 현황 (2~4개)' },
    shortfalls: { type: 'array', items: { type: 'string' }, description: '부족하거나 주의할 점 (1~4개)' },
    nextActions: { type: 'array', items: { type: 'string' }, description: '다음 기간에 개선할 점 (2~4개)' },
  },
};

const SYSTEM = `당신은 제조기업 뉴토크 코리아 경영지원팀의 재무 분석 담당자입니다.
경영 대시보드에 표시할 짧은 분석 코멘트를 작성합니다. 독자는 대표와 경영지원팀입니다.

규칙:
- 한국어, 각 항목은 한 문장. 금액은 '억원'/'만원' 단위로 반올림해 표기합니다.
- 제공된 데이터에 있는 숫자만 근거로 씁니다. 데이터가 0이거나 비어 있으면 "입력되지 않음"으로 보고 추측하지 않습니다.
- 목표 대비 진도(기간 경과 대비 달성률), 전기·전년 동기 대비 증감, 비용 구조, 산업분야·거래처 편중, 미수금(특히 90일 초과·연체)을 우선 살핍니다.
- nextActions는 다음 기간에 실제로 할 수 있는 구체적 행동으로 씁니다.`;

let client;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

// 프롬프트에 넣을 핵심 수치만 추린다 (불필요한 배열은 제외).
function compact(s) {
  return {
    기간: s.label,
    비교기간: s.prevLabel,
    연간목표매출: s.target,
    기간목표매출_안분: Math.round(s.periodTarget),
    이번기간: s.current,
    직전기간: s.prev,
    전년동기: s.lastYearSame,
    연간누적: s.ytd,
    달성현황: s.achievement,
    기간별추이: s.buckets.map((b) => ({ 기간: b.label, 매출: b.sales.total, 비용: b.costs.total })),
    산업분야별_이번기간: s.industry.period,
    제품시리즈별_이번기간: s.series.period,
    상위거래처_이번기간: s.customers.period.slice(0, 5),
    미수금: {
      잔액: s.receivables.outstanding,
      건수: s.receivables.openCount,
      연체액: s.receivables.overdueAmount,
      경과일별: s.receivables.aging,
      상위거래처: s.receivables.topCustomers.slice(0, 5),
      이번기간_청구액: s.receivables.period.invoiced,
      이번기간_수금액: s.receivables.period.collected,
    },
  };
}

export async function generateWithClaude(summary) {
  const res = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `다음은 ${summary.label} 경영 데이터(단위: 원)입니다. 분석 코멘트를 작성해 주세요.\n\n${JSON.stringify(compact(summary))}`,
    }],
  });
  if (res.stop_reason === 'refusal') throw new Error('AI가 응답을 거절했습니다.');
  if (res.stop_reason === 'max_tokens') throw new Error('AI 응답이 길이 제한으로 잘렸습니다.');
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { ...JSON.parse(text), model: res.model };
}

// API 키가 없거나 호출 실패 시 사용하는 규칙 기반 요약
const won = (v) => {
  const a = Math.abs(v);
  const s = a >= 1e8 ? `${(a / 1e8).toFixed(2)}억원` : a >= 1e4 ? `${Math.round(a / 1e4).toLocaleString()}만원` : `${Math.round(a).toLocaleString()}원`;
  return (v < 0 ? '-' : '') + s;
};
const pct = (v) => `${(v * 100).toFixed(1)}%`;

export function generateRuleBased(s) {
  const status = [];
  const shortfalls = [];
  const nextActions = [];
  const cur = s.current;
  const a = s.achievement;

  if (cur.sales.total === 0 && cur.costs.total === 0) {
    return {
      headline: `${s.label} 실적 데이터가 아직 입력되지 않았습니다.`,
      status: ['월별 실적 입력 또는 엑셀 업로드 후 분석이 가능합니다.'],
      shortfalls: [],
      nextActions: ['데이터 입력 메뉴에서 매출·매입·경비를 입력해 주세요.'],
    };
  }

  status.push(`${s.label} 매출은 ${won(cur.sales.total)}(제품 ${won(cur.sales.product)}, 상품 ${won(cur.sales.goods)}, 용역 ${won(cur.sales.service)})입니다.`);
  if (s.prev.sales.total > 0) {
    const g = cur.sales.total / s.prev.sales.total - 1;
    status.push(`${s.prevLabel} 대비 매출이 ${pct(Math.abs(g))} ${g >= 0 ? '증가' : '감소'}했습니다.`);
  }
  status.push(`매입·경비 합계는 ${won(cur.costs.total)}로, 매출 대비 추정 손익은 ${won(cur.profit)}입니다.`);

  let headline;
  if (s.target > 0) {
    headline = `연간 목표 ${won(s.target)} 중 ${won(a.ytdSales)}(${pct(a.rate)})를 달성했습니다.`;
    if (a.paceRate !== null && a.paceRate < 0.95) {
      shortfalls.push(`기간 경과 기준 기대치 ${won(a.expectedToDate)}보다 ${won(a.expectedToDate - a.ytdSales)} 부족합니다(진도율 ${pct(a.paceRate)}).`);
      if (a.monthsLeft > 0) nextActions.push(`남은 ${a.monthsLeft}개월 동안 월평균 ${won(a.remaining / a.monthsLeft)}의 매출이 필요합니다. 수주 파이프라인을 점검해 주세요.`);
    } else if (a.paceRate !== null) {
      status.push(`기간 경과 대비 진도율은 ${pct(a.paceRate)}로 목표 페이스를 유지하고 있습니다.`);
    }
  } else {
    headline = `${s.label} 매출 ${won(cur.sales.total)}, 연간 목표매출액이 설정되지 않았습니다.`;
    nextActions.push('연간 목표매출액을 설정하면 달성률과 진도율을 확인할 수 있습니다.');
  }

  if (cur.sales.total > 0 && cur.costs.total / cur.sales.total > 0.9) {
    shortfalls.push(`매출 대비 매입·경비 비율이 ${pct(cur.costs.total / cur.sales.total)}로 높습니다.`);
    nextActions.push('원재료·상품 매입 단가와 경비 항목을 점검해 주세요.');
  }

  const ind = s.industry.period.filter((x) => x.value > 0);
  const indTotal = ind.reduce((t, x) => t + x.value, 0);
  if (indTotal > 0) {
    const top = [...ind].sort((x, y) => y.value - x.value)[0];
    if (top.value / indTotal > 0.6) {
      shortfalls.push(`매출의 ${pct(top.value / indTotal)}가 ${top.label} 분야에 집중되어 있습니다.`);
      nextActions.push(`${top.label} 외 분야(발전소·가스·민간 플랜트 등) 영업을 강화해 편중을 낮춰 주세요.`);
    }
  }

  const r = s.receivables;
  const over90 = r.aging[3];
  if (over90.value > 0) {
    shortfalls.push(`90일 초과 미수금이 ${won(over90.value)}(${over90.count}건) 있습니다.`);
    nextActions.push(`장기 미수 거래처(${r.topCustomers.slice(0, 2).map((c) => c.customer).join(', ')})에 수금 일정을 확인해 주세요.`);
  } else if (r.outstanding > 0) {
    status.push(`미수금 잔액은 ${won(r.outstanding)}(${r.openCount}건)입니다.`);
  }

  if (!nextActions.length) nextActions.push('현재 추세를 유지하면서 신규 거래처 발굴에 집중해 주세요.');
  return { headline, status, shortfalls, nextActions };
}

export async function generateComment(summary) {
  try {
    return { ...(await generateWithClaude(summary)), source: 'claude' };
  } catch (e) {
    console.warn('[ai] Claude 호출 실패, 규칙 기반 요약으로 대체:', e.message);
    return { ...generateRuleBased(summary), source: 'rules', error: e.message };
  }
}
