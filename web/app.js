// Nostra 웹 화면 (프레임워크 없음). 해시 라우팅: #/, #/event/:id, #/portfolio, #/leaderboard, #/admin
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => Number(n).toLocaleString('ko-KR');
const signed = (n) => (n > 0 ? `+${fmt(n)}` : fmt(n));
const view = $('#view');

const state = { me: null, filter: '전체', sel: null, side: 'yes', price: 50, qty: 10, timer: null };

async function api(method, path, body, headers = {}) {
  const res = await fetch(path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `오류 (${res.status})`);
  return data;
}

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${err ? ' err' : ''}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.className = 'toast'), 2600);
}

function timeLeft(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return '마감됨';
  const h = Math.floor(ms / 3600000);
  if (h >= 48) return `${Math.floor(h / 24)}일 남음`;
  if (h >= 1) return `${h}시간 남음`;
  return `${Math.max(1, Math.floor(ms / 60000))}분 남음`;
}
const kTime = (iso) => new Date(iso).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const STATUS = { open: '거래 중', closed: '결과 대기', settled: '정산 완료', void: '무효' };

/** 화면에 보여줄 확률: 직전 체결가, 없으면 호가 중간값 */
function chance(m) {
  if (m.lastYesPrice != null) return m.lastYesPrice;
  if (m.yesAsk != null && m.noAsk != null) return Math.round((m.yesAsk + (100 - m.noAsk)) / 2);
  return null;
}

// ---------- 계정 ----------
function renderAccount() {
  const el = $('#account');
  if (!state.me) {
    el.innerHTML = `<button class="btn primary sm" id="loginBtn">본인인증으로 시작</button>`;
    $('#loginBtn').onclick = openLogin;
    return;
  }
  const m = state.me;
  el.innerHTML = `
    <span class="chip-egg num" title="사용 가능한 알"><span class="egg sm"></span>${fmt(m.balance)}알</span>
    ${m.protectedPrincipal > 0 ? `<span class="chip-shield num" title="열린 이벤트에 들어간 보호 원금"><span class="shield-ico"></span>${fmt(m.protectedPrincipal)}</span>` : ''}
    <span class="nick">${esc(m.nickname)}</span>
    <button class="btn ghost sm" id="logoutBtn">로그아웃</button>`;
  $('#logoutBtn').onclick = async () => {
    await api('POST', '/api/auth/logout');
    state.me = null;
    renderAccount();
    route();
  };
}

function openLogin() {
  const d = $('#login');
  d.innerHTML = `
    <form method="dialog" id="loginForm">
      <h2>본인인증</h2>
      <p>한 사람당 한 계정만 만들 수 있습니다. 가입하면 1,000알을 무료로 드립니다.<br><small>개발용 화면입니다. 실제 서비스는 휴대폰 본인인증(PASS)으로 대체됩니다.</small></p>
      <div class="field"><label for="phone">휴대폰 번호</label><input class="in" id="phone" inputmode="numeric" placeholder="010-0000-0000" required></div>
      <div class="field" id="nickField" hidden><label for="nick">닉네임 (2~16자)</label><input class="in" id="nick" maxlength="16"></div>
      <div class="actions"><button class="btn" value="cancel" formnovalidate>취소</button><button class="btn primary" id="loginGo">인증</button></div>
    </form>`;
  d.showModal();
  $('#loginGo').onclick = async (e) => {
    e.preventDefault();
    const phone = $('#phone').value;
    const nickField = $('#nickField');
    const body = { phone };
    if (!nickField.hidden) body.nickname = $('#nick').value;
    try {
      const r = await api('POST', '/api/auth/verify', body);
      if (r.status === 'needs_nickname') {
        nickField.hidden = false;
        $('#nick').focus();
        $('#loginGo').textContent = '가입하고 1,000알 받기';
        return;
      }
      state.me = r.me;
      d.close();
      toast(r.status === 'registered' ? '가입 완료! 1,000알을 받았습니다' : `${r.me.nickname}님, 반가워요`);
      renderAccount();
      route();
    } catch (err) {
      toast(err.message, true);
    }
  };
}

async function refreshMe() {
  const r = await api('GET', '/api/me');
  state.me = r.me;
  renderAccount();
}

// ---------- 마켓 목록 ----------
async function pageMarkets() {
  const { events } = await api('GET', '/api/events');
  const cats = ['전체', ...new Set(events.map((e) => e.category))];
  const shown = events.filter((e) => (state.filter === '전체' || e.category === state.filter) && e.status !== 'void');
  shown.sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1));
  view.innerHTML = `
    <section class="hero">
      <div><h1>무료 알로 미래를 예측하세요</h1><p>결과에 따라 100알을 받는 계약을 1~99알에 사고팝니다. 가격이 곧 시장이 보는 확률입니다.</p></div>
      <div class="shield-badge"><span class="shield-ico"></span>예측이 틀려도 이벤트가 끝나면 넣은 알을 모두 돌려받습니다.</div>
    </section>
    <div class="filters">${cats.map((c) => `<button data-cat="${esc(c)}" class="${c === state.filter ? 'on' : ''}">${esc(c)}</button>`).join('')}</div>
    <div class="grid">${shown.map(cardHtml).join('') || '<p class="empty">아직 열린 마켓이 없습니다.</p>'}</div>`;
  $$('.filters button').forEach((b) => (b.onclick = () => { state.filter = b.dataset.cat; pageMarkets(); }));
}

function cardHtml(e) {
  const head = `<div class="card-head"><span>${esc(e.category)}</span><span class="status ${e.status}">${e.status === 'open' ? timeLeft(e.closesAt) : STATUS[e.status]}</span></div>`;
  if (e.markets.length === 1) {
    const m = e.markets[0];
    const c = chance(m);
    return `<a class="card" href="#/event/${encodeURIComponent(e.id)}">${head}<h3>${esc(e.title)}</h3>
      <div class="row-mkt"><div class="prob num">${c == null ? '—' : `${c}%`}<small>예 확률</small></div>
      <div class="pair"><span class="btn-yes num">예 ${m.yesAsk ?? '—'}</span><span class="btn-no num">아니오 ${m.noAsk ?? '—'}</span></div></div>
      <div class="meta"><span class="num">거래량 ${fmt(m.volume)}계약</span></div></a>`;
  }
  const rows = [...e.markets].sort((a, b) => (chance(b) ?? -1) - (chance(a) ?? -1)).slice(0, 3);
  return `<a class="card" href="#/event/${encodeURIComponent(e.id)}">${head}<h3>${esc(e.title)}</h3>
    ${rows.map((m) => `<div class="row-mkt"><span class="name">${esc(m.title)}</span><span class="pct num">${chance(m) == null ? '—' : `${chance(m)}%`}</span></div>`).join('')}
    <div class="meta"><span>선택지 ${e.markets.length}개</span><span class="num">거래량 ${fmt(e.markets.reduce((s, m) => s + m.volume, 0))}계약</span></div></a>`;
}

// ---------- 이벤트 상세 ----------
async function pageEvent(id, keepForm = false) {
  let e;
  try {
    e = await api('GET', `/api/events/${encodeURIComponent(id)}`);
  } catch (err) {
    view.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
    return;
  }
  if (!keepForm || !e.markets.some((m) => m.id === state.sel)) {
    state.sel = e.markets[0].id;
    state.side = 'yes';
    const m0 = e.markets[0];
    state.price = m0.yesAsk ?? chance(m0) ?? 50;
  }
  const sel = e.markets.find((m) => m.id === state.sel);
  const multi = e.markets.length > 1;
  view.innerHTML = `
    <div class="event-layout">
        <div class="panel ev-main">
          <div class="meta"><span>${esc(e.category)}</span><span class="status ${e.status}">${STATUS[e.status]}</span><span>마감 ${kTime(e.closesAt)}</span></div>
          <h1 class="event-title">${esc(e.title)}</h1>
          <table class="mkt-table">
            <thead><tr><th>${multi ? '선택지' : ''}</th><th class="r">확률</th><th class="r vol">거래량</th><th></th></tr></thead>
            <tbody>${e.markets.map((m) => `
              <tr class="${m.id === state.sel ? 'sel' : ''}">
                <td>${esc(m.title)} ${e.result === m.id ? '<span class="winner">· 정답</span>' : ''}</td>
                <td class="r num"><b>${chance(m) == null ? '—' : `${chance(m)}%`}</b></td>
                <td class="r num vol">${fmt(m.volume)}</td>
                <td class="r"><div class="pair">
                  <button class="btn-yes num ${m.id === state.sel && state.side === 'yes' ? 'on' : ''}" data-m="${esc(m.id)}" data-s="yes">예 ${m.yesAsk ?? '—'}</button>
                  <button class="btn-no num ${m.id === state.sel && state.side === 'no' ? 'on' : ''}" data-m="${esc(m.id)}" data-s="no">아니오 ${m.noAsk ?? '—'}</button>
                </div></td>
              </tr>`).join('')}
            </tbody>
          </table>
          ${e.status === 'settled' && e.result === null ? '<p class="winner">결과: 해당 없음</p>' : ''}
        </div>
      <aside class="panel order ${state.side}" id="orderPanel"></aside>
        <div class="panel ev-book">
          <h2>호가 · ${esc(sel.title)}</h2>
          <div class="book">
            <div><h4>예 매수 대기 (가격 · 수량)</h4>${levels(sel.book.yesBids, 'yes')}</div>
            <div><h4>아니오 매수 대기 (가격 · 수량)</h4>${levels(sel.book.noBids, 'no')}</div>
          </div>
          <p class="meta">예 p알과 아니오 q알 주문은 p + q ≥ 100이면 체결됩니다. 예를 팔려면 아니오를 사면 됩니다(자동 상계).</p>
        </div>
        <div class="panel ev-rules"><h2>정산 규칙</h2><p class="rules">${esc(e.rules)}</p></div>
    </div>`;
  $$('[data-m]').forEach((b) => (b.onclick = () => {
    state.sel = b.dataset.m;
    state.side = b.dataset.s;
    const m = e.markets.find((x) => x.id === state.sel);
    state.price = (state.side === 'yes' ? m.yesAsk : m.noAsk) ?? (state.side === 'yes' ? chance(m) : 100 - (chance(m) ?? 50)) ?? 50;
    pageEvent(id, true);
  }));
  $$('.lvl .bar').forEach((b) => (b.style.width = `${b.dataset.w}%`));
  renderOrder(e, sel);
}

function levels(ls, cls) {
  if (!ls.length) return '<div class="empty">대기 주문 없음</div>';
  const max = Math.max(...ls.map((l) => l.qty));
  return ls.slice(0, 8).map((l) => `<div class="lvl ${cls} num"><i class="bar" data-w="${Math.round((l.qty / max) * 100)}"></i><span>${l.price}알</span><span>${fmt(l.qty)}</span></div>`).join('');
}

function renderOrder(e, m) {
  const el = $('#orderPanel');
  if (e.status !== 'open') {
    el.innerHTML = `<h2>거래 마감</h2><p class="meta">${e.status === 'closed' ? '결과 발표를 기다리는 중입니다. 정산되면 손실은 자동으로 보전됩니다.' : '이 이벤트는 끝났습니다.'}</p>`;
    return;
  }
  const s = state.side;
  el.className = `panel order ${s}`;
  el.innerHTML = `
    <h2>${esc(m.title)}</h2>
    <div class="side-tabs">
      <button class="btn-yes ${s === 'yes' ? 'on' : ''}" data-side="yes">예 사기</button>
      <button class="btn-no ${s === 'no' ? 'on' : ''}" data-side="no">아니오 사기</button>
    </div>
    <div class="field"><label for="price">가격 (1계약, 1~99알)</label>
      <div class="stepper"><button data-d="price" data-v="-1" aria-label="가격 내리기">−</button><input id="price" class="num" inputmode="numeric" value="${state.price}"><button data-d="price" data-v="1" aria-label="가격 올리기">+</button></div></div>
    <div class="field"><label for="qty">수량 (계약)</label>
      <div class="stepper"><button data-d="qty" data-v="-1" aria-label="수량 줄이기">−</button><input id="qty" class="num" inputmode="numeric" value="${state.qty}"><button data-d="qty" data-v="1" aria-label="수량 늘리기">+</button></div></div>
    <div class="sum" id="sum"></div>
    <div class="shield-note"><span class="shield-ico"></span><span>틀려도 이벤트가 끝나면 넣은 알을 모두 돌려받습니다. 맞히면 이익의 10%는 소멸됩니다.</span></div>
    <button class="btn primary" id="submit">${state.me ? `${s === 'yes' ? '예' : '아니오'} 주문하기` : '본인인증 후 주문'}</button>
    ${state.me ? `<p class="meta num">거래 한도 ${fmt(state.me.exposureUsed)} / ${fmt(state.me.exposureCap)}알 · 이벤트당 ${fmt(state.me.eventExposureCap)}알</p>` : ''}`;
  const clamp = () => {
    state.price = Math.min(99, Math.max(1, parseInt($('#price').value, 10) || 1));
    state.qty = Math.min(100000, Math.max(1, parseInt($('#qty').value, 10) || 1));
  };
  const sum = () => {
    clamp();
    const cost = state.price * state.qty;
    const win = 100 * state.qty;
    $('#sum').innerHTML = `
      <div><span>필요한 알</span><span class="num">${fmt(cost)}알</span></div>
      <div><span>맞히면 받는 알</span><span class="num">${fmt(win)}알</span></div>
      <div class="big"><span>예상 이익 (수수료 후)</span><span class="num pos">+${fmt(win - cost - Math.floor((win - cost) * 0.1))}알</span></div>
      <div><span>틀렸을 때</span><span class="num">0알 손실 (보전)</span></div>`;
  };
  sum();
  $('#price').oninput = sum;
  $('#qty').oninput = sum;
  $$('[data-d]', el).forEach((b) => (b.onclick = () => {
    const inp = $(`#${b.dataset.d}`);
    inp.value = (parseInt(inp.value, 10) || 0) + Number(b.dataset.v);
    sum();
    $(`#${b.dataset.d}`).value = state[b.dataset.d];
  }));
  $$('[data-side]', el).forEach((b) => (b.onclick = () => {
    state.side = b.dataset.side;
    state.price = (state.side === 'yes' ? m.yesAsk : m.noAsk) ?? Math.max(1, 100 - state.price);
    pageEvent(e.id, true);
  }));
  $('#submit').onclick = async () => {
    if (!state.me) return openLogin();
    clamp();
    try {
      const r = await api('POST', '/api/orders', { marketId: m.id, side: state.side, price: state.price, qty: state.qty });
      state.me = r.me;
      renderAccount();
      const filled = r.fills.reduce((s, f) => s + f.qty, 0);
      toast(filled === state.qty ? `${fmt(filled)}계약 체결` : filled > 0 ? `${fmt(filled)}계약 체결, 나머지는 대기 주문` : '대기 주문으로 등록했습니다');
      pageEvent(e.id, true);
    } catch (err) {
      toast(err.message, true);
    }
  };
}

// ---------- 내 자산 ----------
async function pagePortfolio() {
  if (!state.me) {
    view.innerHTML = `<div class="panel"><h2>내 자산</h2><p class="meta">본인인증 후 볼 수 있습니다.</p><button class="btn primary" id="lg">본인인증으로 시작</button></div>`;
    $('#lg').onclick = openLogin;
    return;
  }
  await refreshMe();
  const [p, me] = [await api('GET', '/api/portfolio'), state.me];
  const usedPct = Math.min(100, Math.round((me.exposureUsed / me.exposureCap) * 100));
  view.innerHTML = `
    <div class="tiles">
      <div class="tile"><div class="k">사용 가능한 알</div><div class="v num">${fmt(me.balance)}</div>
        ${me.allowanceClaimable ? '<button class="btn sm" id="allow">오늘 출석 100알 받기</button>' : '<div class="s">출석 보상은 하루 한 번</div>'}</div>
      <div class="tile shield"><div class="k">보호 원금</div><div class="v num">${fmt(me.protectedPrincipal)}</div><div class="s">진행 중 이벤트에 들어간 알. 결과와 상관없이 정산 때 최소 이만큼 돌려받습니다.</div></div>
      <div class="tile"><div class="k">보장된 최소 자산</div><div class="v num">${fmt(me.balance + me.protectedPrincipal)}</div><div class="s">사용 가능 + 보호 원금</div></div>
      <div class="tile"><div class="k">거래 한도</div><div class="v num">${fmt(me.exposureUsed)} / ${fmt(me.exposureCap)}</div><div class="meter"><i id="meter" data-w="${usedPct}"></i></div><div class="s">실력 점수가 오르면 천천히 늘어납니다</div></div>
      <div class="tile"><div class="k">시즌 ${me.season} 점수</div><div class="v num ${me.seasonScore >= 0 ? 'pos' : 'neg'}">${signed(me.seasonScore)}</div><div class="s">보전 전 실제 손익. 랭킹에 쓰입니다</div></div>
    </div>
    <div class="panel"><h2>보유 계약</h2>${p.positions.length ? `<div class="scroll"><table class="list">
      <tr><th>이벤트</th><th>선택지</th><th>방향</th><th class="r">수량</th><th class="r">현재 예 가격</th></tr>
      ${p.positions.map((x) => `<tr><td><a href="#/event/${encodeURIComponent(x.eventId)}">${esc(x.eventTitle)}</a></td><td>${esc(x.marketTitle)}</td>
        <td>${x.yes ? '<span class="tag-yes">예</span>' : '<span class="tag-no">아니오</span>'}</td><td class="r num">${fmt(x.yes || x.no)}</td><td class="r num">${x.lastYesPrice ?? '—'}</td></tr>`).join('')}
      </table></div>` : '<p class="empty">보유한 계약이 없습니다.</p>'}</div>
    <div class="panel"><h2>대기 주문</h2>${p.orders.length ? `<div class="scroll"><table class="list">
      <tr><th>이벤트</th><th>선택지</th><th>방향</th><th class="r">가격</th><th class="r">남은 수량</th><th></th></tr>
      ${p.orders.map((o) => `<tr><td>${esc(o.eventTitle)}</td><td>${esc(o.marketTitle)}</td><td>${o.side === 'yes' ? '<span class="tag-yes">예</span>' : '<span class="tag-no">아니오</span>'}</td>
        <td class="r num">${o.price}</td><td class="r num">${fmt(o.qty)}</td><td class="r"><button class="btn sm" data-cancel="${o.id}">취소</button></td></tr>`).join('')}
      </table></div>` : '<p class="empty">대기 중인 주문이 없습니다.</p>'}</div>
    <div class="panel"><h2>정산 내역</h2>${p.history.length ? `<div class="scroll"><table class="list">
      <tr><th>이벤트</th><th class="r">실제 손익</th><th class="r">손실 보전</th><th class="r">수수료(소멸)</th><th class="r">최종</th></tr>
      ${p.history.map((h) => `<tr><td>${esc(h.eventTitle)}${h.kind === 'void' ? ' <span class="status">무효</span>' : ''}</td>
        <td class="r num ${h.rawPnl >= 0 ? 'pos' : 'neg'}">${signed(h.rawPnl)}</td><td class="r num">${h.refund ? `+${fmt(h.refund)}` : '—'}</td>
        <td class="r num">${h.fee ? `−${fmt(h.fee)}` : '—'}</td><td class="r num"><b>${signed(h.rawPnl + h.refund - h.fee)}</b></td></tr>`).join('')}
      </table></div>` : '<p class="empty">아직 정산된 이벤트가 없습니다.</p>'}</div>`;
  const meter = $('#meter');
  if (meter) meter.style.width = `${meter.dataset.w}%`;
  const allow = $('#allow');
  if (allow) allow.onclick = async () => {
    try {
      const r = await api('POST', '/api/allowance');
      toast(r.granted ? `${r.granted}알을 받았습니다` : '오늘은 이미 받았습니다');
      pagePortfolio();
    } catch (err) { toast(err.message, true); }
  };
  $$('[data-cancel]').forEach((b) => (b.onclick = async () => {
    try {
      await api('DELETE', `/api/orders/${b.dataset.cancel}`);
      toast('주문을 취소했습니다');
      pagePortfolio();
    } catch (err) { toast(err.message, true); }
  }));
}

// ---------- 랭킹 ----------
async function pageLeaderboard() {
  const lb = await api('GET', '/api/leaderboard');
  view.innerHTML = `
    <div class="panel">
      <h2>시즌 ${lb.season} 랭킹</h2>
      <p class="meta">손실 보전 전 실제 손익으로 매깁니다. 시즌이 바뀌면 점수만 초기화되고 알은 그대로입니다. 랭킹 보상은 배지와 칭호뿐입니다.</p>
      <div class="scroll"><table class="list">
        <tr><th>순위</th><th>닉네임</th><th class="r">점수</th></tr>
        ${lb.rows.map((r) => `<tr class="${r.rank <= 3 ? 'lb-top' : ''}"><td class="lb-rank num">${r.rank}</td><td>${esc(r.nickname)}${state.me && r.nickname === state.me.nickname ? ' (나)' : ''}</td><td class="r num ${r.score >= 0 ? 'pos' : 'neg'}">${signed(r.score)}</td></tr>`).join('')}
      </table></div>
    </div>`;
}

// ---------- 운영 ----------
const adminToken = () => { try { return sessionStorage.getItem('adminToken') || ''; } catch { return ''; } };
const adminApi = (m, p, b) => api(m, p, b, { 'x-admin-token': adminToken() });

async function pageAdmin() {
  if (!adminToken()) {
    view.innerHTML = `<div class="panel"><h2>운영 도구</h2><div class="field"><label for="tok">관리자 토큰</label><input class="in" id="tok" type="password"></div><button class="btn primary" id="tokGo">들어가기</button></div>`;
    $('#tokGo').onclick = () => { try { sessionStorage.setItem('adminToken', $('#tok').value); } catch {} pageAdmin(); };
    return;
  }
  let supply, flags, events;
  try {
    [supply, { flags }, { events }] = await Promise.all([adminApi('GET', '/api/admin/supply'), adminApi('GET', '/api/admin/flags'), api('GET', '/api/events')]);
  } catch (err) {
    try { sessionStorage.removeItem('adminToken'); } catch {}
    toast(err.message, true);
    return pageAdmin();
  }
  const defClose = new Date(Date.now() + 86400000);
  defClose.setMinutes(0, 0, 0);
  const local = new Date(defClose.getTime() - defClose.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  view.innerHTML = `
    <div class="panel"><h2>알 공급</h2><div class="stats num">
      <div>총 공급<b>${fmt(supply.total)}</b></div><div>누적 발행<b>${fmt(supply.minted)}</b></div><div>손실 보전 발행<b>${fmt(supply.refundsMinted)}</b></div>
      <div>수수료 소멸<b>${fmt(supply.feesBurned)}</b></div><div>사용자<b>${fmt(supply.users)}</b></div></div>
      <p><button class="btn sm" id="season">새 시즌 시작 (랭킹 점수만 초기화)</button></p></div>
    <div class="panel"><h2>새 이벤트</h2><form id="evForm" class="form-grid">
      <div class="field"><label for="f-id">이벤트 id (영문)</label><input class="in" id="f-id" required placeholder="kbo-2026-final"></div>
      <div class="field"><label for="f-cat">분류</label><input class="in" id="f-cat" placeholder="스포츠"></div>
      <div class="field wide"><label for="f-title">질문</label><input class="in" id="f-title" required placeholder="2026 한국시리즈 우승팀은?"></div>
      <div class="field wide"><label for="f-mk">선택지 (한 줄에 하나, 하나면 예/아니오 질문)</label><textarea class="in" id="f-mk" rows="3" required></textarea></div>
      <div class="field"><label for="f-close">거래 마감</label><input class="in" id="f-close" type="datetime-local" value="${local}" required></div>
      <div class="field"><label for="f-ex">결과 범위</label><select class="in" id="f-ex"><option value="1">선택지 중 정확히 하나가 정답</option><option value="0">"해당 없음"도 가능</option></select></div>
      <div class="field wide"><label for="f-rules">정산 규칙 (출처·기준)</label><textarea class="in" id="f-rules" rows="3" required></textarea></div>
      <div class="wide"><button class="btn primary">만들기</button></div></form></div>
    <div class="panel"><h2>이벤트 관리</h2>${events.map((e) => `
      <div class="admin-ev"><span class="t">${esc(e.title)} <span class="status ${e.status}">${STATUS[e.status]}</span></span>
      ${e.status === 'open' || e.status === 'closed' ? `
        ${e.status === 'open' ? `<button class="btn sm" data-close="${esc(e.id)}">거래 마감</button>` : ''}
        <select class="in sm" data-win="${esc(e.id)}">${e.markets.map((m) => `<option value="${esc(m.id)}">${esc(m.title)}${e.markets.length === 1 ? ' → 예' : ''}</option>`).join('')}${!e.exhaustive ? '<option value="__none">해당 없음 (아니오)</option>' : ''}</select>
        <button class="btn sm" data-settle="${esc(e.id)}">정산</button><button class="btn sm" data-void="${esc(e.id)}">무효</button>` : ''}</div>`).join('') || '<p class="empty">이벤트가 없습니다.</p>'}</div>
    <div class="panel"><h2>담합 의심 (거래상대 집중)</h2>${flags.length ? `<table class="list"><tr><th>사용자</th><th>상대</th><th class="r">비중</th><th class="r">거래량</th></tr>
      ${flags.map((f) => `<tr><td>${esc(f.nickname)}</td><td>${esc(f.counterpartyNickname)}</td><td class="r num">${Math.round(f.share * 100)}%</td><td class="r num">${fmt(f.volume)}</td></tr>`).join('')}</table>` : '<p class="empty">없음</p>'}</div>`;
  const act = async (fn, ok, ask) => {
    if (ask && !confirm(ask)) return;
    try { await fn(); toast(ok); pageAdmin(); } catch (err) { toast(err.message, true); }
  };
  $('#season').onclick = () => act(() => adminApi('POST', '/api/admin/season'), '새 시즌을 시작했습니다', '랭킹 점수를 모두 0으로 초기화합니다. 계속할까요?');
  $('#evForm').onsubmit = (ev) => {
    ev.preventDefault();
    const lines = $('#f-mk').value.split('\n').map((s) => s.trim()).filter(Boolean);
    act(() => adminApi('POST', '/api/admin/events', {
      id: $('#f-id').value.trim(), title: $('#f-title').value, category: $('#f-cat').value, rules: $('#f-rules').value,
      closesAt: new Date($('#f-close').value).toISOString(), exhaustive: $('#f-ex').value === '1',
      markets: lines.map((t) => ({ title: t })),
    }), '이벤트를 만들었습니다');
  };
  $$('[data-close]').forEach((b) => (b.onclick = () => act(() => adminApi('POST', `/api/admin/events/${encodeURIComponent(b.dataset.close)}/close`), '거래를 마감했습니다')));
  $$('[data-void]').forEach((b) => (b.onclick = () => act(() => adminApi('POST', `/api/admin/events/${encodeURIComponent(b.dataset.void)}/void`), '무효 처리했습니다', '이 이벤트를 무효로 하고 모두에게 원금을 돌려줍니다. 되돌릴 수 없습니다.')));
  $$('[data-settle]').forEach((b) => (b.onclick = () => {
    const v = $(`[data-win="${CSS.escape(b.dataset.settle)}"]`).value;
    act(() => adminApi('POST', `/api/admin/events/${encodeURIComponent(b.dataset.settle)}/settle`, { winner: v === '__none' ? null : v }), '정산했습니다', `결과를 "${$(`[data-win="${CSS.escape(b.dataset.settle)}"]`).selectedOptions[0].textContent}"(으)로 정산합니다. 되돌릴 수 없습니다.`);
  }));
}

// ---------- 라우터 ----------
async function route() {
  clearInterval(state.timer);
  const h = location.hash.slice(1) || '/';
  const nav = h.startsWith('/portfolio') ? 'portfolio' : h.startsWith('/leaderboard') ? 'leaderboard' : h.startsWith('/admin') ? '' : 'markets';
  $$('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === nav));
  try {
    let m;
    if ((m = h.match(/^\/event\/(.+)$/))) {
      const id = decodeURIComponent(m[1]);
      await pageEvent(id);
      state.timer = setInterval(() => {
        if (document.activeElement && ['price', 'qty'].includes(document.activeElement.id)) return;
        pageEvent(id, true).catch(() => {});
        if (state.me) refreshMe().catch(() => {});
      }, 4000);
    } else if (h.startsWith('/portfolio')) await pagePortfolio();
    else if (h.startsWith('/leaderboard')) await pageLeaderboard();
    else if (h.startsWith('/admin')) await pageAdmin();
    else await pageMarkets();
  } catch (err) {
    view.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
  }
}

window.addEventListener('hashchange', () => { scrollTo(0, 0); route(); });
refreshMe().catch(() => renderAccount()).finally(route);
