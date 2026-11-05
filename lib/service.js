// 서비스팀 — ITB2026(생산·서비스 웹)의 service 기능을 옮겨 온 것
//  - 출장 실적: 출장 횟수(출장 시작일 기준, 여러 날 출장도 1회), 유상·무상 비율, 월별 추이(유상·무상)
//  - 지역: 시·도별·시·군별 출장 (특별·광역시·세종시는 시·도 하나로), 한국 지도
//  - 순위: 교체 부품(사용 횟수 + 현재 단가·직전 대비), A/S 제품 모델(유상·무상), 출장 담당자(보고서 1건당 1인 1회)
//  - 출장보고서 목록·상세·직접 입력(중복 기준: 출장 시작일 + 요청처), 요청처 지역 대응표
import { db, nowStr } from './db.js';
import { periodFrom, periodInfo, todayStr, withShare, summarySheet } from './production.js';

export class ServiceError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; Object.assign(this, extra); }
}

// ---------------- 시·도·시·군 (도는 시·군까지, 일반구는 시로 묶음. 특별·광역시·세종시는 시·도 하나) ----------------
export const REGIONS = ['서울특별시', '부산광역시', '대구광역시', '인천광역시', '광주광역시', '대전광역시', '울산광역시', '세종특별자치시',
  '경기도', '강원특별자치도', '충청북도', '충청남도', '전북특별자치도', '전라남도', '경상북도', '경상남도', '제주특별자치도'];
export const DISTRICTS = {
  경기도: ['수원시', '성남시', '의정부시', '안양시', '부천시', '광명시', '평택시', '동두천시', '안산시', '고양시', '과천시', '구리시', '남양주시', '오산시', '시흥시', '군포시',
    '의왕시', '하남시', '용인시', '파주시', '이천시', '안성시', '김포시', '화성시', '광주시', '양주시', '포천시', '여주시', '연천군', '가평군', '양평군'],
  강원특별자치도: ['춘천시', '원주시', '강릉시', '동해시', '태백시', '속초시', '삼척시', '홍천군', '횡성군', '영월군', '평창군', '정선군', '철원군', '화천군', '양구군', '인제군', '고성군', '양양군'],
  충청북도: ['청주시', '충주시', '제천시', '보은군', '옥천군', '영동군', '증평군', '진천군', '괴산군', '음성군', '단양군'],
  충청남도: ['천안시', '공주시', '보령시', '아산시', '서산시', '논산시', '계룡시', '당진시', '금산군', '부여군', '서천군', '청양군', '홍성군', '예산군', '태안군'],
  전북특별자치도: ['전주시', '군산시', '익산시', '정읍시', '남원시', '김제시', '완주군', '진안군', '무주군', '장수군', '임실군', '순창군', '고창군', '부안군'],
  전라남도: ['목포시', '여수시', '순천시', '나주시', '광양시', '담양군', '곡성군', '구례군', '고흥군', '보성군', '화순군', '장흥군', '강진군', '해남군', '영암군', '무안군',
    '함평군', '영광군', '장성군', '완도군', '진도군', '신안군'],
  // 군위군은 2023년 대구광역시로 편입되어 뺌
  경상북도: ['포항시', '경주시', '김천시', '안동시', '구미시', '영주시', '영천시', '상주시', '문경시', '경산시', '의성군', '청송군', '영양군', '영덕군', '청도군', '고령군',
    '성주군', '칠곡군', '예천군', '봉화군', '울진군', '울릉군'],
  경상남도: ['창원시', '진주시', '통영시', '사천시', '김해시', '밀양시', '거제시', '양산시', '의령군', '함안군', '창녕군', '고성군', '남해군', '하동군', '산청군', '함양군', '거창군', '합천군'],
  제주특별자치도: ['제주시', '서귀포시'],
};
// 시·군 앞에 붙이는 짧은 도 이름 (고성군처럼 이름이 같은 군을 구분)
const SHORT_NAMES = { 경기도: '경기', 강원특별자치도: '강원', 충청북도: '충북', 충청남도: '충남', 전북특별자치도: '전북', 전라남도: '전남', 경상북도: '경북', 경상남도: '경남', 제주특별자치도: '제주' };
export function districtLabel(region, district) {
  if (district) return `${SHORT_NAMES[region] || region} ${district}`;
  if (DISTRICTS[region]) return `${region} (시·군 미지정)`;
  return region;
}
export function regionErrors(region, district) {
  if (!REGIONS.includes(region)) return { region: '시·도를 골라 주세요.' };
  const list = DISTRICTS[region] || [];
  if (list.length && !list.includes(district)) return { district: '시·군을 골라 주세요.' };
  if (!list.length && district) return { district: '특별·광역시는 시·군을 비워 주세요.' };
  return {};
}

// ---------------- 대시보드 집계 ----------------
const ranking = (counts) => Object.entries(counts).map(([name, quantity]) => ({ name, quantity })).sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name));
const tally = (rows, key, val = () => 1) => rows.reduce((m, r) => { const k = key(r); m[k] = (m[k] || 0) + val(r); return m; }, {});

// 교체 부품의 현재 단가·직전 대비 (부품명 기준: 적용 시작일이 오늘 이전인 단가 중 가장 최근 / 그 바로 앞)
async function partPriceMap() {
  const today = todayStr();
  const rows = await db.all('SELECT part_name, unit_price, effective_date FROM part_prices WHERE effective_date <= ? ORDER BY part_name, effective_date, id', today);
  const by = {};
  for (const r of rows) (by[r.part_name] ||= []).push(r);
  return Object.fromEntries(Object.entries(by).map(([name, list]) => {
    const cur = list[list.length - 1];
    const prev = list.length > 1 ? list[list.length - 2] : null;
    const change = prev ? cur.unit_price - prev.unit_price : null;
    return [name, { current_price: cur.unit_price, change, change_rate: prev && prev.unit_price ? Math.round(change / prev.unit_price * 1000) / 10 : null }];
  }));
}

export async function dashboard(q) {
  const p = periodFrom(q);
  const reports = await db.all('SELECT id, paid_type, region, district, author FROM trip_reports WHERE start_date BETWEEN ? AND ?', p.start, p.end);
  const ids = reports.map((r) => r.id);
  const inIds = (sql) => (ids.length ? db.all(`${sql} WHERE report_id IN (SELECT id FROM trip_reports WHERE start_date BETWEEN ? AND ?)`, p.start, p.end) : []);
  const [parts, products, companions, monthRows, prices] = await Promise.all([
    inIds('SELECT report_id, part_name FROM trip_parts'),
    inIds('SELECT report_id, model_name, quantity FROM trip_products'),
    inIds('SELECT report_id, name FROM trip_companions'),
    db.all(`SELECT CAST(substr(start_date, 6, 2) AS INTEGER) AS m, paid_type, COUNT(*) AS n FROM trip_reports
            WHERE substr(start_date, 1, 4) = ? GROUP BY m, paid_type`, String(p.year)),
    partPriceMap(),
  ]);
  const paidOf = Object.fromEntries(reports.map((r) => [r.id, r.paid_type]));
  // 담당자: 보고서마다 작성자 + 동행자를 집합으로 모아 같은 사람은 1번만
  const people = {};
  for (const r of reports) {
    const names = new Set([r.author, ...companions.filter((c) => c.report_id === r.id).map((c) => c.name)].filter(Boolean));
    names.forEach((n) => { people[n] = (people[n] || 0) + 1; });
  }
  const byMonth = {};
  for (const r of monthRows) byMonth[`${r.m}|${r.paid_type}`] = Number(r.n);
  const models = tally(products, (x) => x.model_name, (x) => Number(x.quantity));
  const modelPaid = {};
  for (const x of products) {
    const mp = (modelPaid[x.model_name] ||= { paid: 0, unpaid: 0 });
    mp[paidOf[x.report_id] === '유상' ? 'paid' : 'unpaid'] += Number(x.quantity);
  }
  const districts = tally(reports, (r) => `${r.region}|${r.district}`);
  const paid = tally(reports, (r) => r.paid_type);
  return {
    period: periodInfo(p),
    service: {
      trip_count: reports.length,
      // 월별 추이: 선택한 연도의 1~12월 (기간 보기와 관계없이 연간 흐름), 달마다 유상·무상
      monthly: Array.from({ length: 12 }, (_, i) => i + 1).map((m) => {
        const pd = byMonth[`${m}|유상`] || 0;
        const un = byMonth[`${m}|무상`] || 0;
        return { month: m, count: pd + un, paid: pd, unpaid: un };
      }),
      paid: ['유상', '무상'].map((name) => ({ name, quantity: paid[name] || 0 })),
      by_region: ranking(tally(reports, (r) => r.region)).map((x) => ({ ...x, region: x.name, district: '' })),
      by_district: Object.entries(districts).map(([k, n]) => { const [region, district] = k.split('|'); return { name: districtLabel(region, district), quantity: n, region, district }; })
        .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name)),
      by_part: ranking(tally(parts, (x) => x.part_name)).map((x) => ({ ...x, current_price: prices[x.name]?.current_price ?? null, change: prices[x.name]?.change ?? null, change_rate: prices[x.name]?.change_rate ?? null })),
      by_model: ranking(models).map((x) => ({ ...x, ...modelPaid[x.name] })),
      by_person: ranking(people),
    },
  };
}

// 대시보드 엑셀: 고른 기간의 내용만. 시트 = [이름, 열, 행]
const RANK_COLUMNS = [['이름', 'name', 26], ['횟수(회)', 'quantity', 11, 'won'], ['비중(%)', 'share', 10, '0.0']];
export async function dashboardSheets(q) {
  const [d, list] = await Promise.all([dashboard(q), reportList(q)]);
  const s = d.service;
  const label = d.period.label;
  const paid = Object.fromEntries(s.paid.map((x) => [x.name, x.quantity]));
  const year = d.period.start.slice(0, 4);
  return {
    label,
    sheets: [
      summarySheet([['기간', label], ['날짜 범위', `${d.period.start} ~ ${d.period.end}`], ['내려받은 날', todayStr()],
        ['출장 횟수(회, 출장 시작일 기준)', s.trip_count], ['유상(회)', paid.유상], ['무상(회)', paid.무상],
        ['출장 지역 수(시·도)', s.by_region.length], ['교체 부품 종류', s.by_part.length], ['출장 담당자 수', s.by_person.length]]),
      ['월별 출장', [['월', 'month', 10], ['유상(회)', 'paid', 10, 'won'], ['무상(회)', 'unpaid', 10, 'won'], ['합계(회)', 'count', 10, 'won']],
        s.monthly.filter((m) => d.period.months.includes(m.month)).map((m) => ({ ...m, month: `${year}년 ${m.month}월` }))],
      ['시·도별', RANK_COLUMNS, withShare(s.by_region)],
      ['시·군별', RANK_COLUMNS, withShare(s.by_district)],
      ['교체 부품', [['부품명', 'name', 26], ['사용 횟수(회)', 'quantity', 13, 'won'], ['현재 단가(원)', 'current_price', 14, 'won'],
        ['직전 대비(원)', 'change', 13, 'won'], ['직전 대비(%)', 'change_rate', 12, '0.0']], s.by_part],
      ['AS 제품 모델', [['모델', 'name', 20], ['유상(대)', 'paid', 10, 'won'], ['무상(대)', 'unpaid', 10, 'won'], ['합계(대)', 'quantity', 10, 'won']], s.by_model],
      ['출장 담당자', RANK_COLUMNS, withShare(s.by_person)],
      ['출장보고서', [['출장 시작일', 'start_date', 12], ['출장 종료일', 'end_date', 12], ['요청처', 'requester', 22], ['시·도', 'region', 14], ['시·군', 'district', 12],
        ['유상/무상', 'paid_type', 10], ['작업 구분', 'work_type', 14], ['작성자', 'author', 14], ['제품 모델', 'models', 22]],
      list.results.map((r) => ({ ...r, models: r.models.join(', ') }))],
    ],
  };
}

// ---------------- 출장보고서 목록·상세 ----------------
export async function reportList(q) {
  const p = periodFrom(q);
  const rows = await db.all('SELECT * FROM trip_reports WHERE start_date BETWEEN ? AND ? ORDER BY start_date DESC, id DESC', p.start, p.end);
  const models = rows.length ? await db.all(`SELECT report_id, model_name FROM trip_products WHERE report_id IN (SELECT id FROM trip_reports WHERE start_date BETWEEN ? AND ?)`, p.start, p.end) : [];
  const mBy = models.reduce((m, x) => ((m[x.report_id] ||= []).push(x.model_name), m), {});
  return {
    period: periodInfo(p),
    results: rows.map((r) => ({ id: r.id, start_date: r.start_date, end_date: r.end_date, requester: r.requester, region: r.region, district: r.district,
      paid_type: r.paid_type, work_type: r.work_type, author: r.author, input_method: r.input_method, models: mBy[r.id] || [] })),
  };
}
export async function reportDetail(id) {
  const r = await db.get('SELECT * FROM trip_reports WHERE id = ?', Number(id));
  if (!r) throw new ServiceError(404, '없는 출장보고서입니다.');
  const [comps, prods, parts] = await Promise.all([
    db.all('SELECT name FROM trip_companions WHERE report_id = ? ORDER BY id', r.id),
    db.all('SELECT model_name, spec, serial_no_raw, quantity FROM trip_products WHERE report_id = ? ORDER BY id', r.id),
    db.all('SELECT part_name FROM trip_parts WHERE report_id = ? ORDER BY id', r.id),
  ]);
  return { ...r, companions: comps.map((c) => c.name), products: prods.map((x) => ({ ...x, quantity: Number(x.quantity) })), parts: parts.map((x) => x.part_name),
    input_method_display: r.input_method === 'manual' ? '직접 입력' : 'PDF 업로드' };
}

// ---------------- 보고서 1건 검사·저장 (직접 입력과 PDF 업로드가 같이 씀) ----------------
const PAID_TYPES = ['유상', '무상'];
const TRUNCATED = '…'; // PDF에서 긴 값이 잘리면 붙는 글자
export const SCALAR_FIELDS = ['start_date', 'end_date', 'extra_trip', 'paid_type', 'requester_type', 'requester', 'region', 'district',
  'work_type', 'purpose', 'fault_description', 'work_description', 'work_result', 'author'];
const LIMITS = { requester: 100, author: 50, purpose: 200, work_type: 30, requester_type: 30, extra_trip: 50 };
const LIST_LIMITS = { companions: 50, parts: 100 };
const PRODUCT_LIMITS = { model_name: 50, spec: 100, serial_no_raw: 50 };
const isDate = (t) => {
  const m = String(t).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};

export function cleanReport(data) {
  const clean = Object.fromEntries(SCALAR_FIELDS.map((k) => [k, String(data[k] ?? '').trim()]));
  const list = (v) => (Array.isArray(v) ? v : String(v || '').split('\n')).map((x) => String(x).trim()).filter(Boolean);
  clean.companions = list(data.companions);
  clean.parts = list(data.parts);
  clean.products = (Array.isArray(data.products) ? data.products : []).map((p) => Object.fromEntries(['model_name', 'spec', 'serial_no_raw', 'quantity'].map((k) => [k, String(p?.[k] ?? '').trim()])))
    .filter((p) => Object.values(p).some(Boolean)); // 완전히 빈 줄은 무시
  return clean;
}
export function validateReport(d) {
  const errors = {};
  if (!d.start_date) errors.start_date = '출장 시작일이 없습니다 (월 집계 기준).';
  else if (!isDate(d.start_date)) errors.start_date = '날짜 형식: YYYY-MM-DD';
  if (d.end_date && !isDate(d.end_date)) errors.end_date = '날짜 형식: YYYY-MM-DD';
  else if (d.end_date && !errors.start_date && d.end_date < d.start_date) errors.end_date = '종료일이 시작일보다 빠릅니다.';
  if (!d.requester) errors.requester = '요청처가 없습니다.';
  if (!d.author) errors.author = '작성자가 없습니다.';
  Object.assign(errors, regionErrors(d.region, d.district));
  if (!PAID_TYPES.includes(d.paid_type)) errors.paid_type = '유상 또는 무상을 골라 주세요.';
  for (const p of d.products) {
    if (!p.model_name || !/^\d+$/.test(p.quantity) || +p.quantity === 0) { errors.products = '제품마다 모델명과 수량(1 이상의 숫자)이 필요합니다.'; break; }
    if (Object.entries(PRODUCT_LIMITS).some(([k, n]) => p[k].length > n)) { errors.products = '모델명 50자, 사양 100자, 일련번호 50자 이하로 입력해 주세요.'; break; }
  }
  const texts = { ...Object.fromEntries(SCALAR_FIELDS.map((k) => [k, d[k]])), companions: d.companions.join('\n'), parts: d.parts.join('\n'),
    products: d.products.map((p) => Object.values(p).join(' ')).join('\n') };
  for (const [k, t] of Object.entries(texts)) if (t.includes(TRUNCATED) && !errors[k]) errors[k] = '잘린 값(…)입니다. 전체 값으로 고쳐 주세요.';
  for (const [k, n] of Object.entries(LIMITS)) if (d[k].length > n && !errors[k]) errors[k] = `${n}자 이하로 입력해 주세요.`;
  for (const [k, n] of Object.entries(LIST_LIMITS)) if (d[k].some((x) => x.length > n) && !errors[k]) errors[k] = `한 개당 ${n}자 이하로 입력해 주세요.`;
  return errors;
}
// 중복 확인 기준: 출장 시작일 + 요청처 (보고서 고유 번호가 없어서 — 기업 확인 필요)
export const findDuplicates = (d) => (d.start_date && d.requester
  ? db.all('SELECT id, start_date, requester, author FROM trip_reports WHERE start_date = ? AND requester = ?', d.start_date, d.requester) : Promise.resolve([]));

export async function saveReport(d, userId, inputMethod) {
  const cols = SCALAR_FIELDS;
  const res = await db.run(`INSERT INTO trip_reports (${cols.join(', ')}, input_method, created_by, created_at) VALUES (${cols.map(() => '?').join(', ')}, ?, ?, ?)`,
    ...cols.map((c) => (c === 'end_date' ? d[c] || null : d[c])), inputMethod, userId, nowStr());
  const id = res.lastInsertRowid;
  await db.batch([
    ...d.companions.map((n) => ['INSERT INTO trip_companions (report_id, name) VALUES (?, ?)', [id, n]]),
    ...d.products.map((p) => ['INSERT INTO trip_products (report_id, model_name, spec, serial_no_raw, quantity) VALUES (?,?,?,?,?)', [id, p.model_name, p.spec, p.serial_no_raw, Number(p.quantity)]]),
    ...d.parts.map((n) => ['INSERT INTO trip_parts (report_id, part_name) VALUES (?, ?)', [id, n]]),
    // 다음 입력·업로드부터 시·도·시·군을 자동으로 채운다
    [`INSERT INTO requester_regions (requester, region, district) VALUES (?, ?, ?)
      ON CONFLICT(requester) DO UPDATE SET region = excluded.region, district = excluded.district`, [d.requester, d.region, d.district]],
  ]);
  return id;
}

// 직접 입력: 같은 시작일·요청처가 있으면 409로 알리고, allow_duplicate=true로 다시 보내면 저장
export async function createReport(body, userId) {
  const d = cleanReport(body || {});
  const errors = validateReport(d);
  if (Object.keys(errors).length) throw new ServiceError(400, '입력 내용을 확인해 주세요.', { fields: errors });
  const dups = await findDuplicates(d);
  if (dups.length && body.allow_duplicate !== true) {
    throw new ServiceError(409, '같은 출장 시작일·요청처의 보고서가 이미 있습니다. 같은 곳에 실제로 두 번 간 경우에만 \'중복 아님\'을 체크해 저장하세요.', { existing: dups });
  }
  return reportDetail(await saveReport(d, userId, 'manual'));
}

// 입력 화면용: 시·도·시·군 목록, 요청처 대응표, 이미 쓴 이름들(추천)
export async function formChoices() {
  const [map, people, models, partNames, catalog] = await Promise.all([
    db.all('SELECT requester, region, district FROM requester_regions ORDER BY requester'),
    db.all('SELECT name FROM (SELECT author AS name FROM trip_reports UNION SELECT name FROM trip_companions) ORDER BY name'),
    db.all('SELECT DISTINCT model_name FROM trip_products ORDER BY model_name'),
    db.all('SELECT DISTINCT part_name FROM trip_parts ORDER BY part_name'),
    db.all('SELECT DISTINCT name FROM part_catalog ORDER BY name'),
  ]);
  return {
    regions: REGIONS, districts: DISTRICTS, requesters: map,
    people: people.map((r) => r.name), models: models.map((r) => r.model_name),
    parts: [...new Set([...partNames.map((r) => r.part_name), ...catalog.map((r) => r.name)])].sort(),
  };
}

// ---------------- 가상 데이터 (처음 한 번, 작년·올해) — 실제 기업 데이터가 아니다 ----------------
const REQUESTERS = [
  ['가람정수장', '서울특별시', ''], ['나래하수처리장', '경기도', '화성시'], ['누리배수지', '경기도', '용인시'], ['다온산업단지', '충청북도', '청주시'],
  ['라온발전소', '충청남도', '당진시'], ['마루정수센터', '부산광역시', ''], ['바다가스기지', '울산광역시', ''], ['사랑하수처리장', '전라남도', '여수시'],
  ['아름정수장', '경상북도', '포항시'], ['보람정수장', '경상북도', '구미시'], ['자람배수지', '강원특별자치도', '강릉시'], ['솔빛정수장', '강원특별자치도', '원주시'],
  ['하늘정수장', '제주특별자치도', '제주시'], ['푸른처리장', '대전광역시', ''], ['새솔정수센터', '경상남도', '창원시'],
];
const PEOPLE = ['김가상 대리', '이가상 과장', '박가상 사원', '최가상 대리'];
const MODELS = ['AVA01', 'AVA03', 'AVA05', 'AVB02', 'NTI-03'];
const PARTS = ['Main Board', 'Power Board', 'Magnetic Contactor', 'Control PCB', 'Limit Switch', 'Motor'];
function rng(seed) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)), pick: (arr) => arr[Math.floor(next() * arr.length)],
    sample: (arr, k) => [...arr].sort(() => next() - 0.5).slice(0, k) };
}
export async function seedVirtualService() {
  if (await db.get('SELECT 1 FROM trip_reports LIMIT 1')) return;
  const today = todayStr();
  const ty = +today.slice(0, 4);
  await db.batch(REQUESTERS.map(([r, g, d]) => ['INSERT OR IGNORE INTO requester_regions (requester, region, district) VALUES (?, ?, ?)', [r, g, d]]));
  for (const year of [ty - 1, ty]) {
    const r = rng(year * 7 + 3);
    const lastMonth = year === ty ? +today.slice(5, 7) : 12;
    for (let m = 1; m <= lastMonth; m += 1) {
      for (let k = r.int(4, 10); k > 0; k -= 1) {
        const lastDay = year === ty && m === lastMonth ? +today.slice(8, 10) : 28;
        const start = `${year}-${String(m).padStart(2, '0')}-${String(r.int(1, lastDay)).padStart(2, '0')}`;
        const end = new Date(Date.parse(`${start}T00:00:00Z`) + r.pick([0, 0, 1, 2]) * 86400000).toISOString().slice(0, 10);
        const [requester, region, district] = r.pick(REQUESTERS);
        const d = {
          start_date: start, end_date: end, extra_trip: '없음', paid_type: r.next() < 0.6 ? '유상' : '무상', requester_type: '검색 불가', requester, region, district,
          work_type: r.pick(['수리', '점검', '설치']), purpose: '가상 출장', fault_description: '1. 가상 고장 내용', work_description: '1. 가상 작업 내용', work_result: '정상작동',
          author: r.pick(PEOPLE), companions: r.sample(PEOPLE, r.int(0, 2)), // 작성자가 동행자에도 들어가는 경우를 섞음 (중복 집계 확인용)
          products: [{ model_name: r.pick(MODELS), spec: '', serial_no_raw: `A800${r.int(10 ** 7, 10 ** 8)}`, quantity: String(r.int(1, 3)) }],
          parts: r.sample(PARTS, r.int(0, 3)),
        };
        await saveReport(d, null, 'pdf');
      }
    }
  }
}
