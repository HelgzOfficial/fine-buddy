/* =========================================================
   FINE BUDDY — real app logic (Supabase-backed)
   No demo data here — everything comes from your Supabase
   project. See schema.sql for the database this expects.
   ========================================================= */

const cfg = window.FINE_BUDDY_CONFIG;
const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

const state = {
  session: null,
  me: null,
  view: 'dashboard',
  viewAsPlayer: false,
  team: { name: 'My Team', crest_url: null, stripe_link: '', bank_account_name:'', bank_sort_code:'', bank_account_number:'', bank_reference:'', double_bubble:false },
  players: [],
  fines: [],
  fineLog: [],
  announcements: [],
  events: [],
  ready: false,
  authBusy: false,
  authSentTo: null,
};

/* ---------------- helpers ---------------- */
function fmt(n){ return '£' + (Math.round((n||0)*100)/100).toFixed(2); }
function initials(name){ return (name||'?').split(' ').filter(Boolean).slice(0,2).map(w=>w[0].toUpperCase()).join(''); }
function todayISO(){ return new Date().toISOString().slice(0,10); }
function startOfWeek(d){ d=new Date(d); const day=(d.getDay()+6)%7; d.setDate(d.getDate()-day); d.setHours(0,0,0,0); return d; }
function escapeHtml(s){ return (s==null?'':String(s)).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fineAmountNow(price){ return state.team.double_bubble ? price*2 : price; }
function getPlayer(id){ return state.players.find(p=>p.id===id); }
function logsFor(playerId){ return state.fineLog.filter(l=>l.player_id===playerId); }
function playerOwed(playerId){ return logsFor(playerId).filter(l=>!l.paid).reduce((s,l)=>s+Number(l.amount),0); }
function playerWeekTotal(playerId){
  const sow = startOfWeek(new Date());
  return logsFor(playerId).filter(l=>new Date(l.date) >= sow).reduce((s,l)=>s+Number(l.amount),0);
}
function playerPaidTotal(playerId){
  const p = getPlayer(playerId);
  const loggedPaid = logsFor(playerId).filter(l=>l.paid).reduce((s,l)=>s+Number(l.amount),0);
  return (p ? Number(p.season_paid||0) : 0) + loggedPaid;
}
function totalCollected(){ return state.players.reduce((s,p)=>s+playerPaidTotal(p.id),0); }
function totalOutstanding(){ return state.fineLog.filter(l=>!l.paid).reduce((s,l)=>s+Number(l.amount),0); }
function playersWithOutstanding(){ return state.players.filter(p=>playerOwed(p.id)>0).sort((a,b)=>playerOwed(b.id)-playerOwed(a.id)); }
function pctSquadOutstanding(){ if(!state.players.length) return 0; return Math.round((playersWithOutstanding().length/state.players.length)*100); }
function mostWantedPlayer(){
  const list = playersWithOutstanding();
  if(!list.length) return null;
  return list.slice().sort((a,b)=>{
    const diff = playerOwed(b.id) - playerOwed(a.id);
    if(diff!==0) return diff;
    const aOldest = Math.min(...logsFor(a.id).filter(l=>!l.paid).map(l=>new Date(l.date).getTime()));
    const bOldest = Math.min(...logsFor(b.id).filter(l=>!l.paid).map(l=>new Date(l.date).getTime()));
    return aOldest-bOldest;
  })[0];
}
function isAdmin(){ return !!(state.me && state.me.is_admin); }
function effectiveRole(){ return isAdmin() && !state.viewAsPlayer ? 'admin' : 'player'; }

/* ---------------- data loading ---------------- */
async function loadAll(){
  const [teamRes, playersRes, finesRes, logRes, annRes, evRes] = await Promise.all([
    sb.from('team_info').select('*').eq('id',1).maybeSingle(),
    sb.from('players').select('*').order('created_at'),
    sb.from('fines').select('*').order('created_at'),
    sb.from('fine_log').select('*').order('date',{ascending:false}),
    sb.from('announcements').select('*').order('created_at'),
    sb.from('events').select('*').order('date'),
  ]);
  if(teamRes.data) state.team = teamRes.data;
  state.players = playersRes.data || [];
  state.fines = finesRes.data || [];
  state.fineLog = logRes.data || [];
  state.announcements = annRes.data || [];
  state.events = evRes.data || [];
  state.me = state.players.find(p=>p.id === state.session.user.id) || null;
}

async function refresh(){ await loadAll(); render(); }

/* ---------------- boot / auth ---------------- */
async function boot(){
  const { data: { session } } = await sb.auth.getSession();
  state.session = session;
  if(session){
    await loadAll();
  }
  state.ready = true;
  render();

  sb.auth.onAuthStateChange(async (event, session) => {
    state.session = session;
    if(session){
      await loadAll();
    } else {
      state.me = null;
    }
    render();
  });
}

async function sendMagicLink(email){
  state.authBusy = true; render();
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.href }
  });
  state.authBusy = false;
  if(error){ state.authError = error.message; }
  else { state.authError = null; state.authSentTo = email; }
  render();
}

async function signOut(){ await sb.auth.signOut(); }

/* ---------------- render engine ---------------- */
const root = document.getElementById('root');
let modalNode = null;

function render(){
  if(!state.ready){
    root.innerHTML = `<div class="loading-screen"><div class="spinner" style="width:28px;height:28px;border-width:3px;"></div><div>Loading Fine Buddy…</div></div>`;
    return;
  }
  if(!state.session){
    root.innerHTML = renderAuthScreen();
    bindAuthEvents();
    return;
  }
  if(!state.me){
    root.innerHTML = `<div class="loading-screen"><div class="spinner" style="width:28px;height:28px;border-width:3px;"></div><div>Setting up your profile…</div></div>`;
    return;
  }
  root.innerHTML = `
    ${renderTopbar()}
    <main id="main">${renderView()}</main>
    ${renderFab()}
    ${renderBottomNav()}
  `;
  bindGlobalEvents();
}

function renderAuthScreen(){
  if(state.authSentTo){
    return `
    <div class="auth-wrap">
      <div class="auth-crest">${state.team.crest_url?`<img src="${state.team.crest_url}">`:'⚽'}</div>
      <div class="auth-title">Check your email</div>
      <div class="auth-sub">We sent a sign-in link to <b>${escapeHtml(state.authSentTo)}</b>. Open it on this phone to finish signing in.</div>
      <div class="auth-card">
        <button class="btn btn-outline" id="authResendBtn">Use a different email</button>
      </div>
    </div>`;
  }
  return `
  <div class="auth-wrap">
    <div class="auth-crest">${state.team.crest_url?`<img src="${state.team.crest_url}">`:'⚽'}</div>
    <div class="auth-title">Fine Buddy</div>
    <div class="auth-sub">${escapeHtml(state.team.name||'Your team')} — enter your email and we'll send you a magic link to sign in. No password needed.</div>
    <div class="auth-card">
      <label class="field-label" style="text-align:left;">Email address</label>
      <input type="email" id="authEmailInput" placeholder="you@example.com" autocomplete="email">
      ${state.authError?`<div style="color:var(--red-500);font-size:12.5px;margin-top:8px;">${escapeHtml(state.authError)}</div>`:''}
      <button class="btn btn-primary" id="authSendBtn" style="margin-top:14px;" ${state.authBusy?'disabled':''}>
        ${state.authBusy?'<span class="spinner"></span> Sending…':'Send me a sign-in link'}
      </button>
      <small class="disclaimer">First time signing in? An account is created automatically — no separate sign-up step needed.</small>
    </div>
  </div>`;
}
function bindAuthEvents(){
  const sendBtn = document.getElementById('authSendBtn');
  if(sendBtn) sendBtn.addEventListener('click', ()=>{
    const email = document.getElementById('authEmailInput').value.trim();
    if(!email) return;
    sendMagicLink(email);
  });
  const resendBtn = document.getElementById('authResendBtn');
  if(resendBtn) resendBtn.addEventListener('click', ()=>{ state.authSentTo=null; render(); });
}

function renderTopbar(){
  const t = state.team;
  const role = effectiveRole();
  return `
  <header class="topbar">
    <div class="crest">${t.crest_url ? `<img src="${t.crest_url}">` : initials(t.name)}</div>
    <div class="team-name-wrap">
      <div class="team-name">${escapeHtml(t.name)}</div>
      <div class="team-sub">Fine Buddy ${t.double_bubble ? '· 🔴 Double Bubble ON' : ''}</div>
    </div>
    ${ isAdmin() ? `
    <div class="role-switch">
      <button data-preview="admin" class="${role==='admin'?'active':''}">Admin</button>
      <button data-preview="player" class="${role==='player'?'active':''}">Player</button>
    </div>` : `<button class="link-btn" id="signOutBtn" style="color:#fff;">Sign out</button>` }
  </header>`;
}

function renderFab(){
  if(effectiveRole()!=='admin') return '';
  if(state.view==='fines') return `<button class="fab" id="fabAddFine">+</button>`;
  if(state.view==='players') return `<button class="fab" id="fabInvite">+</button>`;
  if(state.view==='events') return `<button class="fab" id="fabAddEvent">+</button>`;
  if(state.view==='dashboard') return `<button class="fab" id="fabAnnounce">+</button>`;
  return '';
}

function renderBottomNav(){
  const adminTabs = [
    ['dashboard','📊','Dashboard'],['fines','⚖️','Fines'],['players','👥','Players'],
    ['events','📅','Events'],['team','⚙️','Team'],
  ];
  const playerTabs = [
    ['dashboard','📊','Overview'],['profile','🙋','My Profile'],['fines','⚖️','Fines'],
    ['events','📅','Events'],['pay','💳','Pay'],
  ];
  const tabs = effectiveRole()==='admin' ? adminTabs : playerTabs;
  return `<nav class="bottom-nav">
    ${tabs.map(([id,ic,label])=>`
      <button data-view="${id}" class="${state.view===id?'active':''}">
        <span class="ic">${ic}</span><span>${label}</span>
      </button>`).join('')}
  </nav>`;
}

function renderView(){
  const role = effectiveRole();
  if(role==='admin'){
    switch(state.view){
      case 'fines': return viewFinesAdmin();
      case 'players': return viewPlayersAdmin();
      case 'events': return viewEvents();
      case 'team': return viewTeamSettings();
      default: return viewDashboard();
    }
  }
  switch(state.view){
    case 'profile': return viewPlayerProfile();
    case 'fines': return viewFinesPlayer();
    case 'events': return viewEvents();
    case 'pay': return viewPay();
    default: return viewDashboard();
  }
}

/* ---------------- DASHBOARD ---------------- */
function viewDashboard(){
  const outstanding = playersWithOutstanding();
  const pct = pctSquadOutstanding();
  const wanted = mostWantedPlayer();
  return `
    <h1 class="page-title">Dashboard</h1>
    <div class="hero-collected">
      <div class="label">🏆 Total Collected This Season</div>
      <div class="value">${fmt(totalCollected())}</div>
      <div class="sub">Keep the fines flowing, keep the socials funded</div>
    </div>
    <div class="pct-tile">
      <div class="pct-ring" style="--pct:${pct};"><div class="pct-ring-inner">${pct}%</div></div>
      <div>
        <div class="pct-label">Squad still owing</div>
        <div class="pct-detail">${outstanding.length} of ${state.players.length} players · ${fmt(totalOutstanding())} outstanding</div>
      </div>
    </div>
    ${ wanted ? `
    <div class="section-title">🚨 Wall of Shame</div>
    <div class="wanted-wrap">
      <div class="wanted-poster">
        <div class="wanted-title">Wanted</div>
        <div class="wanted-photo">${wanted.photo_url?`<img src="${wanted.photo_url}">`:initials(wanted.name)}</div>
        <div class="wanted-name">${escapeHtml(wanted.name)}</div>
        <div class="wanted-for">for dodging the fines pot</div>
        <div class="wanted-bounty">Owes <span class="amt">${fmt(playerOwed(wanted.id))}</span></div>
      </div>
    </div>` : `
    <div class="section-title">🚨 Wall of Shame</div>
    <div class="card empty">🎉 Nobody's wanted — the whole squad is paid up!</div>` }

    <div class="section-title">Players with outstanding balances</div>
    <div class="card">
      ${ outstanding.length ? outstanding.map(p=>`
        <div class="row between" style="margin-bottom:10px;">
          <div class="row" style="gap:10px;">
            <div class="avatar">${p.photo_url?`<img src="${p.photo_url}">`:initials(p.name)}</div>
            <div><div class="name">${escapeHtml(p.name)}</div><div class="muted">owes ${fmt(playerOwed(p.id))}</div></div>
          </div>
          <span class="pill owed">${fmt(playerOwed(p.id))}</span>
        </div>
      `).join('') : `<div class="empty">🎉 Everyone is paid up!</div>` }
    </div>

    <div class="section-title">Announcements</div>
    ${state.announcements.slice().reverse().map(a=>`
      <div class="card">
        <div class="row between"><div class="muted">${a.date}</div>${isAdmin()?`<button class="link-btn" data-del-announce="${a.id}">Delete</button>`:''}</div>
        <div style="margin-top:6px;font-size:14.5px;">${escapeHtml(a.text)}</div>
      </div>
    `).join('') || `<div class="empty">No announcements yet.</div>`}
  `;
}

/* ---------------- FINES ---------------- */
function viewFinesAdmin(){
  return `
    <h1 class="page-title">Fines Catalog</h1>
    <div class="card">
      <div class="toggle-row">
        <div><div class="name">Double Bubble</div><div class="muted">Instantly doubles every fine price below</div></div>
        <label class="switch"><input type="checkbox" id="doubleBubbleToggle" ${state.team.double_bubble?'checked':''}><span class="slider"></span></label>
      </div>
    </div>
    <div class="section-title">Tap an offense to log it against a player</div>
    ${state.fines.map(f=>`
      <div class="fine-chip" data-log-fine="${f.id}">
        <div>${escapeHtml(f.label)}</div>
        <div class="row" style="gap:8px;">
          <span class="price ${state.team.double_bubble?'doubled':''}">${fmt(fineAmountNow(f.price))}</span>
          <button class="link-btn" data-edit-fine="${f.id}" onclick="event.stopPropagation()">Edit</button>
        </div>
      </div>
    `).join('') || `<div class="empty">No fines yet — tap + to add one.</div>`}
    <button class="btn btn-outline" id="bulkImportBtn" style="margin-top:6px;">📋 Bulk import fines list</button>
    <small class="disclaimer">Paste "Offense, Price" pairs, one per line, to add lots of fines at once.</small>
  `;
}
function viewFinesPlayer(){
  return `
    <h1 class="page-title">Fines Catalog</h1>
    <div class="banner">${state.team.double_bubble ? '🔴 Double Bubble is currently ON — all fines are doubled!' : 'ℹ️ These are the standard team fines set by your admin.'}</div>
    ${state.fines.map(f=>`
      <div class="fine-chip" style="cursor:default;">
        <div>${escapeHtml(f.label)}</div>
        <span class="price ${state.team.double_bubble?'doubled':''}">${fmt(fineAmountNow(f.price))}</span>
      </div>
    `).join('') || `<div class="empty">No fines set yet.</div>`}
  `;
}

/* ---------------- PLAYERS ---------------- */
function viewPlayersAdmin(){
  return `
    <h1 class="page-title">Players</h1>
    ${state.players.map(p=>`
      <div class="card row between">
        <div class="row" style="gap:12px;" data-open-player="${p.id}">
          <div class="avatar">${p.photo_url?`<img src="${p.photo_url}">`:initials(p.name)}</div>
          <div>
            <div class="name">${escapeHtml(p.name)} ${p.is_admin?'<span class="pill gold">Admin</span>':''}</div>
            <div class="muted">This week: ${fmt(playerWeekTotal(p.id))} · Paid: ${fmt(playerPaidTotal(p.id))}</div>
          </div>
        </div>
        ${ playerOwed(p.id)>0 ? `<span class="pill owed">${fmt(playerOwed(p.id))}</span>` : `<span class="pill clear">Clear</span>` }
      </div>
    `).join('') || `<div class="empty">No players yet — invite your squad below.</div>`}
    <button class="btn btn-outline" id="inviteBtn" style="margin-top:6px;">✉️ Invite a player</button>
  `;
}

/* ---------------- PLAYER PROFILE ---------------- */
function viewPlayerProfile(){
  const p = state.me;
  const logs = logsFor(p.id).slice().reverse();
  return `
    <h1 class="page-title">My Profile</h1>
    <div class="card center-text">
      <div class="avatar lg" style="margin:0 auto 10px;">${p.photo_url?`<img src="${p.photo_url}">`:initials(p.name)}</div>
      <label class="field-label" style="text-align:left;">Your name</label>
      <input type="text" id="myNameInput" value="${escapeHtml(p.name)}">
      <label class="upload-tile" style="margin-top:12px;">
        📷 Change profile picture
        <input type="file" accept="image/*" class="file-hidden" id="playerPhotoInput">
      </label>
      <button class="btn btn-primary" id="saveNameBtn" style="margin-top:10px;">Save name</button>
    </div>
    <div class="stat-grid">
      <div class="stat-tile"><div class="label">This week's fines</div><div class="value">${fmt(playerWeekTotal(p.id))}</div></div>
      <div class="stat-tile bad"><div class="label">Outstanding</div><div class="value">${fmt(playerOwed(p.id))}</div></div>
      <div class="stat-tile good"><div class="label">Paid this season</div><div class="value">${fmt(playerPaidTotal(p.id))}</div></div>
      <div class="stat-tile"><div class="label">Fines logged</div><div class="value">${logs.length}</div></div>
    </div>
    <div class="section-title">Fine history</div>
    <div class="card">
      ${logs.length ? logs.map(l=>`
        <div class="row between" style="margin-bottom:8px;">
          <div><div class="name" style="font-size:13.5px;">${escapeHtml(l.label)}</div><div class="muted">${l.date}</div></div>
          <span class="pill ${l.paid?'clear':'owed'}">${fmt(l.amount)} ${l.paid?'· paid':''}</span>
        </div>`).join('') : `<div class="empty">No fines logged yet — nice one.</div>`}
    </div>
    ${ playerOwed(p.id)>0 ? `<button class="btn btn-primary" data-goto="pay">💳 Pay outstanding balance</button>` : '' }
    <button class="btn btn-ghost" id="signOutBtn2" style="margin-top:10px;">Sign out</button>
  `;
}

/* ---------------- PAY ---------------- */
function viewPay(){
  const p = state.me;
  const owed = playerOwed(p.id);
  const t = state.team;
  const stripeUrl = t.stripe_link ? (t.stripe_link + (t.stripe_link.includes('?')?'&':'?') + 'prefilled_amount=' + encodeURIComponent(owed.toFixed(2)) + '&client_reference_id=' + encodeURIComponent(p.id)) : null;
  return `
    <h1 class="page-title">Pay Fines</h1>
    <div class="card">
      <div class="muted">Amount due</div>
      <div style="font-size:30px;font-weight:800;color:${owed>0?'var(--red-500)':'var(--green-600)'};margin-top:2px;">${fmt(owed)}</div>
    </div>
    ${ stripeUrl ? `
    <div class="section-title">Pay instantly</div>
    <div class="card">
      <a class="btn btn-primary" href="${stripeUrl}" target="_blank" rel="noopener">💳 Pay ${fmt(owed)} now</a>
      <small class="disclaimer">Opens a secure Stripe checkout page. Apple Pay and Google Pay appear automatically there on supported devices — nothing extra to set up.</small>
    </div>` : isAdmin() ? `<div class="banner">Add your Stripe payment link in Team Settings to enable instant payments here.</div>` : ''}
    <div class="section-title">Bank transfer</div>
    <div class="card">
      <div class="row between"><div class="muted">Account name</div><div class="name">${escapeHtml(t.bank_account_name||'—')}</div></div>
      <div class="row between"><div class="muted">Sort code</div><div class="name">${escapeHtml(t.bank_sort_code||'—')}</div></div>
      <div class="row between"><div class="muted">Account number</div><div class="name">${escapeHtml(t.bank_account_number||'—')}</div></div>
      <div class="row between"><div class="muted">Reference</div><div class="name">${escapeHtml(t.bank_reference||'FINE')}-${p.name.split(' ')[0].toUpperCase()}</div></div>
    </div>
    ${ owed>0 ? `<button class="btn btn-outline" id="markPaidBtn" data-player="${p.id}">I've paid — mark my balance as paid</button>` : '' }
    <small class="disclaimer">Marking your balance as paid here notifies your admin — it's an honesty-system confirmation for bank transfers, separate from the automatic Stripe payment above.</small>
  `;
}

/* ---------------- EVENTS ---------------- */
function viewEvents(){
  const sorted = state.events.slice().sort((a,b)=>new Date(a.date)-new Date(b.date));
  return `
    <h1 class="page-title">Social Calendar</h1>
    <div class="banner">🎉 Funds raised from fines go straight towards these events.</div>
    ${ sorted.length ? sorted.map(e=>`
      <div class="card">
        <div class="row between">
          <div class="name">${escapeHtml(e.title)}</div>
          ${isAdmin()?`<button class="link-btn" data-del-event="${e.id}">Delete</button>`:''}
        </div>
        <div class="muted" style="margin:4px 0 8px;">📅 ${e.date}</div>
        <div style="font-size:14px;">${escapeHtml(e.description||'')}</div>
        ${e.funds_note?`<div class="pill gold" style="margin-top:8px;">${escapeHtml(e.funds_note)}</div>`:''}
        ${e.link?`<a class="btn btn-gold" style="margin-top:12px;" href="${e.link}" target="_blank" rel="noopener">🎟️ View tickets / booking link</a>`:''}
      </div>
    `).join('') : `<div class="empty">No events scheduled yet.</div>` }
  `;
}

/* ---------------- TEAM SETTINGS ---------------- */
function viewTeamSettings(){
  const t = state.team;
  return `
    <h1 class="page-title">Team Settings</h1>
    <div class="section-title">Branding</div>
    <div class="card center-text">
      <div class="crest" style="width:72px;height:72px;font-size:22px;margin:0 auto 12px;">${t.crest_url?`<img src="${t.crest_url}">`:initials(t.name)}</div>
      <label class="upload-tile">
        🖼️ Upload / change crest
        <input type="file" accept="image/*" class="file-hidden" id="crestInput">
      </label>
      <label class="field-label" style="text-align:left;">Team name</label>
      <input type="text" id="teamNameInput" value="${escapeHtml(t.name)}">
    </div>
    <div class="section-title">Payment details players will see</div>
    <div class="card">
      <label class="field-label">Stripe Payment Link</label>
      <input type="url" id="stripeLinkInput" value="${escapeHtml(t.stripe_link||'')}" placeholder="https://buy.stripe.com/...">
      <small class="disclaimer">Create a "customer chooses amount" Payment Link in your Stripe Dashboard → Payment Links. Apple Pay / Google Pay show up automatically for players on supported devices.</small>
      <label class="field-label">Bank account name</label>
      <input type="text" id="bankNameInput" value="${escapeHtml(t.bank_account_name||'')}">
      <div class="row" style="gap:10px;">
        <div style="flex:1;"><label class="field-label">Sort code</label><input type="text" id="bankSortInput" value="${escapeHtml(t.bank_sort_code||'')}"></div>
        <div style="flex:1;"><label class="field-label">Account no.</label><input type="text" id="bankAccInput" value="${escapeHtml(t.bank_account_number||'')}"></div>
      </div>
      <label class="field-label">Payment reference prefix</label>
      <input type="text" id="bankRefInput" value="${escapeHtml(t.bank_reference||'')}">
      <button class="btn btn-primary" id="saveTeamSettingsBtn" style="margin-top:14px;">Save settings</button>
    </div>
  `;
}

/* ---------------- Modal helpers ---------------- */
function openModal(html, opts={}){
  closeModal();
  modalNode = document.createElement('div');
  modalNode.className = 'modal-backdrop' + (opts.center?' center':'');
  modalNode.innerHTML = `<div class="modal">
    <div class="modal-head"><h2>${opts.title||''}</h2><button class="modal-close" id="modalCloseBtn">✕</button></div>
    ${html}
  </div>`;
  document.body.appendChild(modalNode);
  modalNode.addEventListener('click',(e)=>{ if(e.target===modalNode) closeModal(); });
  document.getElementById('modalCloseBtn').addEventListener('click', closeModal);
}
function closeModal(){ if(modalNode){ modalNode.remove(); modalNode=null; } }

function fileToPath(prefix, file){
  const ext = (file.name.split('.').pop()||'jpg').toLowerCase().replace(/[^a-z0-9]/g,'') || 'jpg';
  return `${prefix}/${Date.now()}_${Math.random().toString(36).slice(2,8)}.${ext}`;
}
async function uploadImage(prefix, file){
  const path = fileToPath(prefix, file);
  const { error } = await sb.storage.from('media').upload(path, file, { cacheControl:'3600', upsert:false });
  if(error){ toast('Upload failed: ' + error.message); return null; }
  const { data } = sb.storage.from('media').getPublicUrl(path);
  return data.publicUrl;
}

/* ---------------- Event bindings ---------------- */
function bindGlobalEvents(){
  root.querySelectorAll('[data-preview]').forEach(b=>b.addEventListener('click', ()=>{
    state.viewAsPlayer = b.dataset.preview === 'player'; state.view='dashboard'; render();
  }));
  root.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click', ()=>{ state.view=b.dataset.view; render(); }));
  root.querySelectorAll('[data-goto]').forEach(b=>b.addEventListener('click', ()=>{ state.view=b.dataset.goto; render(); }));
  root.querySelectorAll('[data-open-player]').forEach(b=>b.addEventListener('click', ()=>openPlayerDetailModal(b.dataset.openPlayer)));
  ['signOutBtn','signOutBtn2'].forEach(id=>{ const el=document.getElementById(id); if(el) el.addEventListener('click', signOut); });

  root.querySelectorAll('[data-del-announce]').forEach(b=>b.addEventListener('click', async ()=>{
    await sb.from('announcements').delete().eq('id', b.dataset.delAnnounce); await refresh();
  }));
  root.querySelectorAll('[data-del-event]').forEach(b=>b.addEventListener('click', async ()=>{
    await sb.from('events').delete().eq('id', b.dataset.delEvent); await refresh();
  }));

  const dbToggle = document.getElementById('doubleBubbleToggle');
  if(dbToggle) dbToggle.addEventListener('change', async ()=>{
    await sb.from('team_info').update({ double_bubble: dbToggle.checked }).eq('id',1); await refresh();
  });

  root.querySelectorAll('[data-log-fine]').forEach(el=>el.addEventListener('click', ()=>openLogFineModal(el.dataset.logFine)));
  root.querySelectorAll('[data-edit-fine]').forEach(el=>el.addEventListener('click',(e)=>{ e.stopPropagation(); openEditFineModal(el.dataset.editFine); }));

  const fabAddFine=document.getElementById('fabAddFine'); if(fabAddFine) fabAddFine.addEventListener('click',()=>openEditFineModal(null));
  const fabInvite=document.getElementById('fabInvite'); if(fabInvite) fabInvite.addEventListener('click', openInviteModal);
  const inviteBtn=document.getElementById('inviteBtn'); if(inviteBtn) inviteBtn.addEventListener('click', openInviteModal);
  const fabAddEvent=document.getElementById('fabAddEvent'); if(fabAddEvent) fabAddEvent.addEventListener('click', openEventModal);
  const fabAnnounce=document.getElementById('fabAnnounce'); if(fabAnnounce) fabAnnounce.addEventListener('click', openAnnounceModal);
  const bulkImportBtn=document.getElementById('bulkImportBtn'); if(bulkImportBtn) bulkImportBtn.addEventListener('click', openBulkImportModal);

  const crestInput = document.getElementById('crestInput');
  if(crestInput) crestInput.addEventListener('change', async (e)=>{
    if(!e.target.files[0]) return;
    const url = await uploadImage('crests', e.target.files[0]);
    if(url){ await sb.from('team_info').update({ crest_url:url }).eq('id',1); await refresh(); }
  });
  const playerPhotoInput = document.getElementById('playerPhotoInput');
  if(playerPhotoInput) playerPhotoInput.addEventListener('change', async (e)=>{
    if(!e.target.files[0]) return;
    const url = await uploadImage('players', e.target.files[0]);
    if(url){ await sb.from('players').update({ photo_url:url }).eq('id', state.me.id); await refresh(); }
  });
  const saveNameBtn = document.getElementById('saveNameBtn');
  if(saveNameBtn) saveNameBtn.addEventListener('click', async ()=>{
    const name = document.getElementById('myNameInput').value.trim();
    if(!name) return;
    await sb.from('players').update({ name }).eq('id', state.me.id); await refresh();
    toast('Profile saved');
  });

  const saveTeamBtn = document.getElementById('saveTeamSettingsBtn');
  if(saveTeamBtn) saveTeamBtn.addEventListener('click', async ()=>{
    await sb.from('team_info').update({
      name: document.getElementById('teamNameInput').value.trim() || state.team.name,
      stripe_link: document.getElementById('stripeLinkInput').value.trim(),
      bank_account_name: document.getElementById('bankNameInput').value.trim(),
      bank_sort_code: document.getElementById('bankSortInput').value.trim(),
      bank_account_number: document.getElementById('bankAccInput').value.trim(),
      bank_reference: document.getElementById('bankRefInput').value.trim(),
    }).eq('id',1);
    await refresh();
    toast('Team settings saved');
  });

  const markPaidBtn = document.getElementById('markPaidBtn');
  if(markPaidBtn) markPaidBtn.addEventListener('click', async ()=>{
    const pid = markPaidBtn.dataset.player;
    const unpaid = state.fineLog.filter(l=>l.player_id===pid && !l.paid).map(l=>l.id);
    if(unpaid.length) await sb.from('fine_log').update({ paid:true }).in('id', unpaid);
    await refresh();
    toast('Balance marked as paid ✅');
  });
}

/* ---------------- Modals ---------------- */
function openLogFineModal(fineId){
  const fine = state.fines.find(f=>f.id===fineId);
  openModal(`
    <div class="muted" style="margin-bottom:10px;">${escapeHtml(fine.label)} — <b>${fmt(fineAmountNow(fine.price))}</b></div>
    <label class="field-label">Who's getting fined?</label>
    <select id="logFinePlayerSelect">${state.players.map(p=>`<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}</select>
    <button class="btn btn-primary" id="confirmLogFineBtn" style="margin-top:16px;">Add fine</button>
  `, { title:'Log a fine' });
  document.getElementById('confirmLogFineBtn').addEventListener('click', async ()=>{
    const pid = document.getElementById('logFinePlayerSelect').value;
    const amount = fineAmountNow(fine.price);
    await sb.from('fine_log').insert({ player_id: pid, fine_id: fine.id, label: fine.label, amount, date: todayISO(), paid:false });
    closeModal(); await refresh();
    toast(`${fmt(amount)} added to ${getPlayer(pid).name}`);
  });
}

function openEditFineModal(fineId){
  const fine = fineId ? state.fines.find(f=>f.id===fineId) : null;
  openModal(`
    <label class="field-label">Offense</label>
    <input type="text" id="fineLabelInput" value="${fine?escapeHtml(fine.label):''}" placeholder="e.g. Late to training">
    <label class="field-label">Price (£)</label>
    <input type="number" id="finePriceInput" min="0" step="0.5" value="${fine?fine.price:''}">
    <div class="btn-block-row" style="margin-top:16px;">
      ${fine?`<button class="btn btn-danger" id="deleteFineBtn">Delete</button>`:''}
      <button class="btn btn-primary" id="saveFineBtn">${fine?'Save':'Add fine'}</button>
    </div>
  `, { title: fine?'Edit fine':'New fine', center:true });
  if(fine) document.getElementById('deleteFineBtn').addEventListener('click', async ()=>{
    await sb.from('fines').delete().eq('id', fine.id); closeModal(); await refresh();
  });
  document.getElementById('saveFineBtn').addEventListener('click', async ()=>{
    const label = document.getElementById('fineLabelInput').value.trim();
    const price = parseFloat(document.getElementById('finePriceInput').value)||0;
    if(!label) return;
    if(fine) await sb.from('fines').update({ label, price }).eq('id', fine.id);
    else await sb.from('fines').insert({ label, price });
    closeModal(); await refresh();
  });
}

function openBulkImportModal(){
  openModal(`
    <label class="field-label">Paste your fines list — one per line, "Offense, Price"</label>
    <textarea id="bulkImportText" rows="7" placeholder="Late to training, 5
Missed session, 15
Forgot boots, 5"></textarea>
    <button class="btn btn-primary" id="bulkImportConfirm" style="margin-top:14px;">Import fines</button>
  `, { title:'Bulk import fines list' });
  document.getElementById('bulkImportConfirm').addEventListener('click', async ()=>{
    const lines = document.getElementById('bulkImportText').value.split('\n').map(l=>l.trim()).filter(Boolean);
    const rows = [];
    lines.forEach(line=>{
      const parts = line.split(',');
      if(parts.length>=2){
        const label = parts[0].trim();
        const price = parseFloat(parts[1])||0;
        if(label) rows.push({ label, price });
      }
    });
    if(rows.length) await sb.from('fines').insert(rows);
    closeModal(); await refresh();
    toast(`${rows.length} fine(s) imported`);
  });
}

function openInviteModal(){
  const link = window.location.origin + window.location.pathname;
  openModal(`
    <div class="muted">Share this link with a player. They just enter their email and we'll send them a sign-in link — their account and profile are created automatically the first time they sign in.</div>
    <div class="card" style="margin-top:10px;word-break:break-all;font-weight:700;">${link}</div>
    <button class="btn btn-outline" id="copyInviteBtn" style="margin-top:14px;">📋 Copy link</button>
  `, { title:'Invite a player' });
  document.getElementById('copyInviteBtn').addEventListener('click', ()=>{
    navigator.clipboard?.writeText(link).catch(()=>{});
    toast('Invite link copied');
  });
}

function openPlayerDetailModal(playerId){
  const p = getPlayer(playerId);
  const logs = logsFor(p.id).slice().reverse();
  openModal(`
    <div class="row" style="gap:12px;margin-bottom:14px;">
      <div class="avatar lg">${p.photo_url?`<img src="${p.photo_url}">`:initials(p.name)}</div>
      <div><div class="name" style="font-size:16px;">${escapeHtml(p.name)}</div><div class="muted">Owes ${fmt(playerOwed(p.id))} · Paid ${fmt(playerPaidTotal(p.id))}</div></div>
    </div>
    ${logs.length? logs.map(l=>`
      <div class="row between" style="margin-bottom:8px;">
        <div><div style="font-size:13.5px;font-weight:700;">${escapeHtml(l.label)}</div><div class="muted">${l.date}</div></div>
        <span class="pill ${l.paid?'clear':'owed'}">${fmt(l.amount)}</span>
      </div>`).join('') : `<div class="empty">No fines yet</div>`}
    <div class="divider"></div>
    <button class="btn btn-primary" id="markPlayerPaidBtn">Mark all as paid</button>
    ${!p.is_admin ? `<button class="btn btn-outline" id="makeAdminBtn" style="margin-top:8px;">Make team admin</button>` : ''}
  `, { title:'Player details' });
  document.getElementById('markPlayerPaidBtn').addEventListener('click', async ()=>{
    const unpaid = logsFor(p.id).filter(l=>!l.paid).map(l=>l.id);
    if(unpaid.length) await sb.from('fine_log').update({ paid:true }).in('id', unpaid);
    closeModal(); await refresh();
    toast(`${p.name}'s balance cleared`);
  });
  const makeAdminBtn = document.getElementById('makeAdminBtn');
  if(makeAdminBtn) makeAdminBtn.addEventListener('click', async ()=>{
    await sb.from('players').update({ is_admin:true }).eq('id', p.id);
    closeModal(); await refresh();
    toast(`${p.name} is now a team admin`);
  });
}

function openEventModal(){
  openModal(`
    <label class="field-label">Event title</label>
    <input type="text" id="evTitle" placeholder="e.g. Summer BBQ">
    <label class="field-label">Date</label>
    <input type="date" id="evDate" value="${todayISO()}">
    <label class="field-label">Description</label>
    <textarea id="evDesc" rows="3" placeholder="Details about the event..."></textarea>
    <label class="field-label">Booking / ticket link</label>
    <input type="url" id="evLink" placeholder="https://...">
    <label class="field-label">Funds note (optional)</label>
    <input type="text" id="evFunds" placeholder="e.g. Fines pot contribution: £200">
    <button class="btn btn-primary" id="saveEventBtn" style="margin-top:14px;">Add event</button>
  `, { title:'New social event' });
  document.getElementById('saveEventBtn').addEventListener('click', async ()=>{
    const title = document.getElementById('evTitle').value.trim();
    if(!title) return;
    await sb.from('events').insert({
      title, date: document.getElementById('evDate').value || todayISO(),
      description: document.getElementById('evDesc').value.trim(),
      link: document.getElementById('evLink').value.trim(),
      funds_note: document.getElementById('evFunds').value.trim(),
    });
    closeModal(); await refresh();
  });
}

function openAnnounceModal(){
  openModal(`
    <label class="field-label">Announcement</label>
    <textarea id="annText" rows="4" placeholder="Write an announcement for the squad..."></textarea>
    <button class="btn btn-primary" id="saveAnnounceBtn" style="margin-top:14px;">Post</button>
  `, { title:'New announcement', center:true });
  document.getElementById('saveAnnounceBtn').addEventListener('click', async ()=>{
    const text = document.getElementById('annText').value.trim();
    if(!text) return;
    await sb.from('announcements').insert({ text, date: todayISO() });
    closeModal(); await refresh();
  });
}

/* ---------------- toast ---------------- */
let toastTimer=null;
function toast(msg){
  let t = document.getElementById('fbToast');
  if(!t){
    t = document.createElement('div'); t.id='fbToast';
    t.style.cssText='position:fixed;bottom:96px;left:50%;transform:translateX(-50%);background:var(--ink-900);color:#fff;padding:10px 18px;border-radius:999px;font-size:13px;font-weight:700;z-index:200;box-shadow:0 4px 14px rgba(0,0,0,0.25);max-width:88%;text-align:center;';
    document.body.appendChild(t);
  }
  t.textContent = msg; t.style.opacity='1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>{ t.style.transition='opacity .3s'; t.style.opacity='0'; }, 2200);
}

boot();
