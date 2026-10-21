const PLANS = {
  production: {
    title: '생산팀 대시보드',
    items: [
      '연간 목표 생산량 설정, 월별·분기별 생산량과 목표 대비 달성/부족치',
      '산업 분야별·거래처별·제품별 판매량',
      '제조내역 엑셀 업로드 → 일련번호로 제품 사양·제조년월·검사·수주·출고·납기 조회',
      '당월 납기일 캘린더 (수주번호별 표시)',
    ],
  },
  service: {
    title: '서비스팀(A/S) 대시보드',
    items: [
      '출장보고서(워드/PDF) 업로드 → 지역·업체·담당자·물품·요청 사유 자동 정리',
      '출장 횟수, 유상/무상 비율, 교체 부품·A/S 모델 순위, 부품 단가 변동',
      '한국 지도(제주 포함) 위 지역별 출장 건수 표시',
      '출장 담당자 순위 (작성자·동행자)',
    ],
  },
};

export async function render(main, ctx) {
  const p = PLANS[ctx.team];
  main.innerHTML = `
    <div class="page-head"><div><h2>${p.title}</h2><div class="sub">다음 단계에서 구현 예정입니다.</div></div></div>
    <div class="card placeholder">
      <h3>준비 중입니다</h3>
      <p>메뉴 권한 구조는 이미 적용되어 있어, 이 팀 권한이 있는 사용자만 이 화면을 볼 수 있습니다.</p>
      <ul>${p.items.map((i) => `<li>${i}</li>`).join('')}</ul>
    </div>`;
}
