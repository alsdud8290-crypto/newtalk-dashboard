// 화면 확인용 샘플 데이터 생성. 실제 데이터가 아닙니다. 거래처명에 (샘플)이 붙습니다.
// 사용: npm run seed:demo           (데이터가 비어 있을 때만)
//       npm run seed:demo -- --force (기존 경영 데이터를 지우고 샘플로 교체)
import { db } from '../lib/db.js';

const force = process.argv.includes('--force');
const existing = Number((await db.get('SELECT (SELECT COUNT(*) FROM monthly) + (SELECT COUNT(*) FROM sales) + (SELECT COUNT(*) FROM receivables) AS n')).n);
if (existing && !force) {
  console.error('이미 경영 데이터가 있습니다. 덮어쓰려면 --force 옵션을 붙여 주세요.');
  process.exit(1);
}

let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const round = (v, unit = 10000) => Math.round(v / unit) * unit;
const pad = (n) => String(n).padStart(2, '0');

const customers = [
  ['한강수자원(샘플)', '상하수도'], ['서해환경(샘플)', '상하수도'], ['동부발전(샘플)', '발전소'], ['남부에너지(샘플)', '발전소'],
  ['대한가스산업(샘플)', '가스·오일·석유화학'], ['오션오일(샘플)', '가스·오일·석유화학'], ['울산석유화학(샘플)', '가스·오일·석유화학'], ['미래플랜트(샘플)', '민간 플랜트'],
  ['정수엔지니어링(샘플)', '상하수도'], ['그린테크(샘플)', '기타'],
];
const series = ['A 시리즈(샘플)', 'B 시리즈(샘플)', 'C 시리즈(샘플)', 'D 시리즈(샘플)', 'E 시리즈(샘플)'];
const today = new Date();
const curY = today.getFullYear();
const curM = today.getMonth() + 1;

// 모든 문장을 모아 한 번에(원자적으로) 실행
const stmts = ['monthly', 'sales', 'receivables', 'targets', 'ai_comments'].map((t) => [`DELETE FROM ${t}`, []]);
stmts.push(['INSERT INTO targets (year, revenue) VALUES (?, ?), (?, ?)', [curY - 1, 4_500_000_000, curY, 5_000_000_000]]);
const insS = { run: (...a) => stmts.push(['INSERT INTO sales (date, customer, industry, series, sales_type, amount, note) VALUES (?,?,?,?,?,?,?)', a]) };
const insR = { run: (...a) => stmts.push(['INSERT INTO receivables (customer, invoice_date, amount, collected, collected_date, due_date, note) VALUES (?,?,?,?,?,?,?)', a]) };
const insM = { run: (...a) => stmts.push([`INSERT INTO monthly (year, month, product_purchase, material_purchase, expense, sga_expense, labor_cost,
                           non_op_income, non_op_expense, receivables_total, product_sales, goods_sales, service_sales)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, a]) };
{

  for (const year of [curY - 1, curY]) {
    const lastMonth = year === curY ? curM - 1 : 12; // 올해는 지난달까지
    for (let m = 1; m <= lastMonth; m++) {
      const season = 1 + 0.25 * Math.sin((m / 12) * Math.PI * 2 - 1);
      const growth = year === curY ? 1.04 : 1;
      let totals = { 제품: 0, 상품: 0, 용역: 0 };
      const n = 6 + Math.floor(rand() * 6);
      for (let i = 0; i < n; i++) {
        const [c, ind] = pick(customers);
        const type = rand() < 0.72 ? '제품' : rand() < 0.6 ? '상품' : '용역';
        const amt = round((type === '용역' ? 8e6 : 35e6) * (0.4 + rand() * 1.4) * season * growth);
        const day = 1 + Math.floor(rand() * 27);
        insS.run(`${year}-${pad(m)}-${pad(day)}`, c, ind, type === '용역' ? '' : pick(series), type, amt, '');
        totals[type] += amt;
        // 매출의 일부는 미수금으로
        const due = new Date(year, m - 1 + 2, day);
        const dueStr = `${due.getFullYear()}-${pad(due.getMonth() + 1)}-${pad(due.getDate())}`;
        const invoice = `${year}-${pad(m)}-${pad(day)}`;
        const ageMonths = (curY - year) * 12 + (curM - m);
        const paid = ageMonths > 3 ? rand() < 0.93 : ageMonths > 1 ? rand() < 0.6 : rand() < 0.15;
        const vat = Math.round(amt * 1.1);
        insR.run(c, invoice, vat, paid ? vat : 0, paid ? dueStr : '', dueStr, '');
      }
      const sales = totals.제품 + totals.상품 + totals.용역;
      insM.run(year, m,
        round(totals.상품 * 0.7), round(totals.제품 * (0.32 + rand() * 0.08)), round(sales * (0.06 + rand() * 0.02)),
        round(sales * (0.1 + rand() * 0.03)), round(sales * (0.08 + rand() * 0.02)),
        round(0.5e6 + rand() * 1.5e6), round(0.3e6 + rand() * 1e6), round(sales * (0.8 + rand() * 0.6)),
        0, 0, 0); // 매출은 0으로 두어 매출 내역 합계를 사용
    }
  }
  // 월별 매출을 매출 내역 합계로 채움 (월별 입력과 내역이 일치하는 상태)
  stmts.push([`UPDATE monthly SET
    product_sales = COALESCE((SELECT SUM(amount) FROM sales s WHERE substr(s.date,1,7) = printf('%04d-%02d', monthly.year, monthly.month) AND sales_type='제품'),0),
    goods_sales   = COALESCE((SELECT SUM(amount) FROM sales s WHERE substr(s.date,1,7) = printf('%04d-%02d', monthly.year, monthly.month) AND sales_type='상품'),0),
    service_sales = COALESCE((SELECT SUM(amount) FROM sales s WHERE substr(s.date,1,7) = printf('%04d-%02d', monthly.year, monthly.month) AND sales_type='용역'),0)`, []]);
}
await db.batch(stmts);

const c = await db.get('SELECT (SELECT COUNT(*) FROM monthly) AS m, (SELECT COUNT(*) FROM sales) AS s, (SELECT COUNT(*) FROM receivables) AS r');
console.log(`샘플 데이터 생성 완료: 월별실적 ${c.m}건, 매출내역 ${c.s}건, 미수금 ${c.r}건`);
