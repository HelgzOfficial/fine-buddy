/* =========================================================
   FINE BUDDY — real app logic (Supabase-backed)
   No demo data here — everything comes from your Supabase
   project. See schema.sql for the database this expects.
   ========================================================= */

const cfg = window.FINE_BUDDY_CONFIG;
// flowType: 'implicit' is the important bit here. Supabase's default (PKCE)
// ties a sign-in link to a secret stored only in the browser that requested
// it, so opening the email on a different device (or a different browser on
// the same device) always fails and bounces back to the sign-in screen.
// Implicit flow puts the actual session tokens in the link itself, so it
// works on whatever device the player opens their email on.
const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
  auth: { flowType: 'implicit', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

const state = {
  session: null,
  me: null,
  view: 'dashboard',
  viewAsPlayer: false,
  team: { name: 'My Team', crest_url: null, paypal_link: '', monzo_link: '', bank_account_name:'', bank_sort_code:'', bank_account_number:'', bank_reference:'', double_bubble:false },
  players: [],
  fines: [],
  fineLog: [],
  announcements: [],
  events: [],
  courtCases: [],
  courtVotes: [],
  eventSuggestions: [],
  eventPolls: [],
  eventPollVotes: [],
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
  return logsFor(playerId).filter(l=>new Date(l.date) >= sow && !l.waived).reduce((s,l)=>s+Number(l.amount),0);
}
function playerPaidTotal(playerId){
  const p = getPlayer(playerId);
  const loggedPaid = logsFor(playerId).filter(l=>l.paid && !l.waived).reduce((s,l)=>s+Number(l.amount),0);
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
// A bank of jokey "wanted for" captions. Real, live AI text-generation per
// player would need a server-side function holding an API key (something
// this no-backend setup deliberately avoids) — so instead each player gets a
// deterministically-picked line from this bank, based on their own id, which
// rotates weekly so it doesn't feel entirely static.
const WANTED_REASONS = [
  "for arriving fashionably late to training — again",
  "last seen avoiding eye contact with the treasurer",
  "wanted for crimes against punctuality",
  "suspected of hiding boots in the depths of a kit bag",
  "for a phone that rang mid team-talk",
  "for a first touch heavier than the fine itself",
  "last spotted sprinting from the changing room, not the pitch",
  "wanted for an own goal nobody has forgiven",
  "for celebrating like it was the World Cup final",
  "suspected of forging a doctor's note for training",
  "for a WhatsApp message left on read for a week",
  "last seen blaming the ref for something that was clearly their fault",
  "wanted for wearing the wrong colour socks. Again.",
  "for a nutmeg that still haunts the group chat",
  "suspected of eating the last of the half-time oranges",
  "for parking in the manager's spot",
  "wanted for an ambitious rabona that ended in a throw-in",
  "last seen ghosting the car-share rota",
  "for claiming '5 minutes away' from 45 minutes away",
  "wanted for a tactical foul with zero tactical value",
  "for turning up to five-a-side in full kit, shin pads and all",
  "suspected of taking the captain's armband without asking",
  "for a goal celebration bigger than the goal itself",
  "last seen dodging the fines pot like a seasoned defender",
];
function reasonFor(playerId){
  let hash = 0;
  const salted = playerId + '-' + Math.floor((new Date().getTime())/(1000*60*60*24*7)); // rotates weekly
  for(let i=0;i<salted.length;i++){ hash = (hash*31 + salted.charCodeAt(i)) >>> 0; }
  return WANTED_REASONS[hash % WANTED_REASONS.length];
}
function isAdmin(){ return !!(state.me && state.me.is_admin); }
function effectiveRole(){ return isAdmin() && !state.viewAsPlayer ? 'admin' : 'player'; }
function isCommittee(){ return !!(state.me && (state.me.is_admin || state.me.is_committee)); }
function committeeCount(){ return state.players.filter(p=>p.is_admin || p.is_committee).length; }
function openCourtCases(){ return state.courtCases.filter(c=>c.status==='open'); }
function resolvedCourtCases(){ return state.courtCases.filter(c=>c.status!=='open').slice().sort((a,b)=>new Date(b.resolved_at)-new Date(a.resolved_at)); }
function votesForCase(caseId){ return state.courtVotes.filter(v=>v.case_id===caseId); }
function myOpenCourtCase(){ return state.me ? state.courtCases.find(c=>c.defendant_id===state.me.id && c.status==='open') : null; }
function openCasesNeedingMyVote(){
  if(!isCommittee() || !state.me) return [];
  return openCourtCases().filter(c=> c.defendant_id!==state.me.id && !votesForCase(c.id).some(v=>v.voter_id===state.me.id));
}
function mostLoggedFine(){
  if(!state.fineLog.length) return null;
  const counts = {};
  state.fineLog.forEach(l=>{ counts[l.label] = (counts[l.label]||0) + 1; });
  const [label, count] = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0];
  return { label, count };
}
function fineCountFor(playerId){ return logsFor(playerId).length; }
function serialOffender(){
  if(!state.players.length) return null;
  const ranked = state.players.slice().sort((a,b)=>fineCountFor(b.id)-fineCountFor(a.id));
  const top = ranked[0];
  if(!top || fineCountFor(top.id)<=0) return null;
  return top;
}

/* ---------------- events: suggestions + polls helpers ---------------- */
function votesForPoll(pollId){ return state.eventPollVotes.filter(v=>v.poll_id===pollId); }
function myPollVoteFor(pollId){
  if(!state.me) return null;
  return votesForPoll(pollId).find(v=>v.voter_id===state.me.id) || null;
}
function tallyPoll(options, votes){
  const total = votes.length;
  return options.map((label, i)=>{
    const count = votes.filter(v=>v.option_index===i).length;
    const pct = total ? Math.round((count/total)*100) : 0;
    return { label, count, pct };
  });
}

/* ---------------- icon set (inline SVG, currentColor so they follow theme) ---------------- */
const ICONS = {
  dashboard: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="12" width="4" height="8" rx="1"/><rect x="10" y="7" width="4" height="13" rx="1"/><rect x="17" y="3" width="4" height="17" rx="1"/></svg>`,
  fines: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="3" x2="12" y2="21"/><line x1="5" y1="7" x2="19" y2="7"/><path d="M5 7l-3 7a3 3 0 0 0 6 0z"/><path d="M19 7l-3 7a3 3 0 0 0 6 0z"/><line x1="8" y1="21" x2="16" y2="21"/></svg>`,
  players: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M2.5 20c0-3.5 3-6 6.5-6s6.5 2.5 6.5 6"/><circle cx="17.5" cy="8.5" r="2.6"/><path d="M15.2 14.3c2.9.3 5.3 2.6 5.3 5.7"/></svg>`,
  events: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2.5"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="2.5" x2="8" y2="6.5"/><line x1="16" y1="2.5" x2="16" y2="6.5"/></svg>`,
  team: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 13.5a7.7 7.7 0 000-3l2-1.5-2-3.4-2.3.9a7.6 7.6 0 00-2.6-1.5L14 2h-4l-.5 2.4a7.6 7.6 0 00-2.6 1.5l-2.3-.9-2 3.4 2 1.5a7.7 7.7 0 000 3l-2 1.6 2 3.4 2.3-.9c.8.7 1.7 1.2 2.6 1.5L10 22h4l.5-2.4c.9-.3 1.8-.8 2.6-1.5l2.3.9 2-3.4-2-1.6z"/></svg>`,
  profile: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><circle cx="12" cy="9.5" r="3.2"/><path d="M5.5 19a7 7 0 0113 0"/></svg>`,
  pay: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="2.5"/><line x1="2.5" y1="9.5" x2="21.5" y2="9.5"/><line x1="6" y1="15" x2="10" y2="15"/></svg>`,
  court: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10l9-6 9 6"/><line x1="4" y1="10" x2="20" y2="10"/><line x1="5" y1="10" x2="5" y2="19"/><line x1="9" y1="10" x2="9" y2="19"/><line x1="15" y1="10" x2="15" y2="19"/><line x1="19" y1="10" x2="19" y2="19"/><line x1="3" y1="21" x2="21" y2="21"/></svg>`,
  gavelSm: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="3" x2="12" y2="21"/><line x1="5" y1="7" x2="19" y2="7"/><path d="M5 7l-3 7a3 3 0 0 0 6 0z"/><path d="M19 7l-3 7a3 3 0 0 0 6 0z"/><line x1="8" y1="21" x2="16" y2="21"/></svg>`,
  calendarSm: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2.5"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="2.5" x2="8" y2="6.5"/><line x1="16" y1="2.5" x2="16" y2="6.5"/></svg>`,
  install: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="2.5"/><line x1="11" y1="18" x2="13" y2="18"/><path d="M12 6.5v6"/><path d="M9 10l3 3 3-3"/></svg>`,
  share: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><rect x="4" y="11" width="16" height="10" rx="2"/></svg>`,
};

/* ---------------- data loading ---------------- */
async function loadAll(){
  const [teamRes, playersRes, finesRes, logRes, annRes, evRes, courtCasesRes, courtVotesRes, suggRes, pollsRes, pollVotesRes] = await Promise.all([
    sb.from('team_info').select('*').eq('id',1).maybeSingle(),
    sb.from('players').select('*').order('created_at'),
    sb.from('fines').select('*').order('created_at'),
    sb.from('fine_log').select('*').order('date',{ascending:false}),
    sb.from('announcements').select('*').order('created_at'),
    sb.from('events').select('*').order('date'),
    sb.from('court_cases').select('*').order('created_at',{ascending:false}),
    sb.from('court_votes').select('*'),
    sb.from('event_suggestions').select('*').order('created_at',{ascending:false}),
    sb.from('event_polls').select('*').order('created_at',{ascending:false}),
    sb.from('event_poll_votes').select('*'),
  ]);
  if(teamRes.data) state.team = teamRes.data;
  state.players = playersRes.data || [];
  state.fines = finesRes.data || [];
  state.fineLog = logRes.data || [];
  state.announcements = annRes.data || [];
  state.events = evRes.data || [];
  state.courtCases = courtCasesRes.data || [];
  state.courtVotes = courtVotesRes.data || [];
  state.eventSuggestions = suggRes.data || [];
  state.eventPolls = pollsRes.data || [];
  state.eventPollVotes = pollVotesRes.data || [];
  state.me = state.players.find(p=>p.id === state.session.user.id) || null;
}

async function refresh(){ await loadAll(); render(); }

/* ---------------- "Add to Home Screen" install experience ---------------- */
// Chrome/Edge (desktop or Android) fire beforeinstallprompt and let us
// trigger the native install dialog ourselves. Every other browser/OS combo
// has no programmatic install API at all, so we detect which one the visitor
// is actually using and show ONE short, correct set of manual steps for it —
// see getInstallVariant() below. Either way, once it's running standalone
// (already added to the home screen) none of this should show up again.
let deferredInstallPrompt = null;
function isStandalone(){
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
}
function uaString(){ return navigator.userAgent.toLowerCase(); }
function isIOS(){
  return /iphone|ipad|ipod/.test(uaString()) && !window.MSStream;
}
// True Safari — NOT one of the iOS/Android "wrapper" browsers that all
// report "Safari" in their UA string too (Chrome/Firefox/Edge on iOS are all
// just skins over WebKit, and Android WebViews often say "Safari" as well).
function isRealSafari(){
  const u = uaString();
  return /safari/.test(u) && !/crios|fxios|edgios|opios|chrome|android/.test(u);
}
function isAndroid(){ return /android/.test(uaString()); }
function isSamsungBrowser(){ return /samsungbrowser/.test(uaString()); }
// "firefox" also matches iOS Firefox's "fxios" token, which needs the iOS
// (Safari-only) treatment instead — exclude it here.
function isFirefox(){ return /firefox/.test(uaString()) && !/fxios/.test(uaString()); }
function isMac(){ return /macintosh|mac os x/.test(uaString()) && !isIOS(); }
function isChromeOrEdge(){
  const u = uaString();
  return (/chrome/.test(u) || /edg\//.test(u)) && !isSamsungBrowser() && !isAndroid() && !isIOS();
}
// One tidy variant name per real-world browser/OS combo we support, so the
// banner + modal only ever show the ONE set of instructions that actually
// applies to whoever is looking at the screen right now.
function getInstallVariant(){
  if(isStandalone()) return 'standalone';
  if(!!deferredInstallPrompt) return 'native'; // Chrome/Edge, desktop or Android — real install dialog
  if(isIOS()) return isRealSafari() ? 'ios-safari' : 'ios-other-browser';
  if(isAndroid()){
    if(isSamsungBrowser()) return 'android-samsung';
    if(isFirefox()) return 'android-firefox';
    return 'android-other'; // e.g. an in-app browser without beforeinstallprompt
  }
  if(isFirefox()) return 'desktop-firefox';
  if(isMac() && isRealSafari()) return 'desktop-safari';
  if(isChromeOrEdge()) return 'desktop-chrome-edge'; // prompt hasn't fired (yet) but browser supports it
  return 'desktop-other';
}
function installDismissed(){
  try{
    const ts = localStorage.getItem('fb_install_dismissed_at');
    if(!ts) return false;
    return (Date.now() - parseInt(ts,10)) < 1000*60*60*24*21; // re-offer after 3 weeks
  }catch(e){ return false; }
}
function dismissInstallBanner(){
  try{ localStorage.setItem('fb_install_dismissed_at', String(Date.now())); }catch(e){}
  render();
}
function canOfferInstall(){
  return !isStandalone() && !installDismissed();
}
window.addEventListener('beforeinstallprompt', (e)=>{
  e.preventDefault();
  deferredInstallPrompt = e;
  render();
});
window.addEventListener('appinstalled', ()=>{
  deferredInstallPrompt = null;
  try{ localStorage.setItem('fb_install_dismissed_at', String(Date.now())); }catch(e){}
  toast('🎉 Fine Buddy installed!');
  render();
});

// Copy shared with signup.html's compact version of the same instructions —
// keep both in sync if you change the wording here.
const INSTALL_COPY = {
  'ios-safari': {
    banner: 'Install Fine Buddy', sub: 'One tap from your home screen, just like a real app.', btn: 'How?',
    title: '📲 Add to Home Screen',
    steps: [
      `Tap the <b>Share</b> icon ${ICONS.share} in Safari's toolbar.`,
      'Scroll down and tap <b>Add to Home Screen</b>.',
      'Tap <b>Add</b> in the top right — Fine Buddy now has its own icon.',
    ],
  },
  'ios-other-browser': {
    banner: 'Install Fine Buddy', sub: "iOS needs Safari for this — tap “How?” for the 1-step fix.", btn: 'How?',
    title: '📲 Add to Home Screen',
    steps: [
      "iOS only allows adding to the Home Screen from <b>Safari</b> itself — not from this browser.",
      'Open this same page in Safari (copy the link, or tap ⋯ / ⋮ in your current browser and choose "Open in Safari" if offered).',
      `Then in Safari: tap <b>Share</b> ${ICONS.share} → <b>Add to Home Screen</b> → <b>Add</b>.`,
    ],
  },
  'android-samsung': {
    banner: 'Install Fine Buddy', sub: 'Add it to your home screen for the full app feel.', btn: 'How?',
    title: '📲 Add to Home Screen',
    steps: [
      'Tap the <b>menu</b> (☰ or ⋮) in Samsung Internet.',
      'Tap <b>Add page to</b> → <b>Home screen</b>.',
      'Confirm the name and tap <b>Add</b> — Fine Buddy now has its own icon.',
    ],
  },
  'android-firefox': {
    banner: 'Install Fine Buddy', sub: 'Add it to your home screen for the full app feel.', btn: 'How?',
    title: '📲 Add to Home Screen',
    steps: [
      'Tap the <b>⋮</b> menu in Firefox.',
      'Tap <b>Install</b> (or <b>Add to Home screen</b>, depending on your Firefox version).',
      'Confirm — Fine Buddy now has its own icon.',
    ],
  },
  'android-other': {
    banner: 'Install Fine Buddy', sub: 'Add it to your home screen for the full app feel.', btn: 'How?',
    title: '📲 Add to Home Screen',
    steps: [
      'Tap your browser\'s <b>menu</b> button (usually ⋮ or ☰).',
      'Look for <b>Install app</b> or <b>Add to Home screen</b> and tap it.',
      'Confirm — Fine Buddy now has its own icon.',
    ],
  },
  'desktop-chrome-edge': {
    banner: 'Install Fine Buddy', sub: 'Add it as an app on your computer.', btn: 'How?',
    title: '💻 Install Fine Buddy',
    steps: [
      'Look for the <b>install icon</b> (a little ⊕ or monitor-with-arrow) at the right edge of the address bar and click it — or open the <b>⋮</b> menu → <b>Install Fine Buddy…</b>',
      'Click <b>Install</b> in the popup — Fine Buddy now opens in its own window from your desktop/taskbar/dock.',
    ],
  },
  'desktop-safari': {
    banner: 'Add Fine Buddy to your Dock', sub: 'Keep it one click away.', btn: 'How?',
    title: '💻 Add to Dock',
    steps: [
      'In Safari\'s menu bar, open <b>File</b> → <b>Add to Dock</b> (or tap the <b>Share</b> icon and choose <b>Add to Dock</b> — the exact wording can vary a little by macOS/Safari version).',
      'Fine Buddy now has its own icon in the Dock, separate from Safari.',
    ],
  },
  'desktop-firefox': {
    banner: 'Bookmark Fine Buddy', sub: "Firefox on desktop can't install apps — bookmark it instead.", btn: 'How?',
    title: '🔖 Bookmark this page',
    steps: [
      'Firefox on desktop doesn\'t support installing web apps like this one.',
      'Press <b>Ctrl+D</b> (Windows/Linux) or <b>Cmd+D</b> (Mac) to bookmark this page instead, so it\'s always one click away.',
    ],
  },
  'desktop-other': {
    banner: 'Install Fine Buddy', sub: 'Add it as an app, or bookmark it for quick access.', btn: 'How?',
    title: '💻 Add Fine Buddy',
    steps: [
      'Check your browser\'s menu for an <b>Install</b> or <b>Add to Home screen</b> option.',
      "Don't see one? Bookmark this page instead (usually Ctrl+D / Cmd+D) so it's always one click away.",
    ],
  },
};

/* ---------------- boot / auth ---------------- */
function consumeUrlAuthArtifacts(){
  // With flowType:'implicit', a successful sign-in link lands back here as
  // "#access_token=...&refresh_token=...&type=magiclink" — supabase-js
  // detects and consumes that itself (detectSessionInUrl:true), so there's
  // nothing for us to do there except tidy the URL afterwards. What we DO
  // need to handle ourselves is the failure case: an expired or already-used
  // link comes back as "#error=...&error_description=...", which supabase-js
  // doesn't turn into anything — so we surface that as a friendly message.
  // The old "?code=..." PKCE-style link is also still handled below as a
  // harmless fallback, in case anyone clicks an old link sent before this fix.
  const search = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));

  const code = search.get('code');
  const hashError = hash.get('error_description') || hash.get('error');
  const hasAuthTokens = hash.get('access_token');

  if(hashError){
    state.authError = decodeURIComponent(hashError.replace(/\+/g, ' '));
    window.history.replaceState({}, document.title, window.location.pathname);
    return Promise.resolve();
  }
  if(code){
    return sb.auth.exchangeCodeForSession(window.location.href)
      .then(({ error }) => {
        if(error) state.authError = error.message;
        window.history.replaceState({}, document.title, window.location.pathname);
      })
      .catch(()=>{ window.history.replaceState({}, document.title, window.location.pathname); });
  }
  // hasAuthTokens ("#access_token=...") is deliberately left untouched here —
  // supabase-js's own detectSessionInUrl is already reading and consuming
  // that hash in the background (it starts the moment the client is
  // created), and it cleans the address bar itself once done. Stripping the
  // hash ourselves first could win the race and wipe it out before the
  // library gets to read it, which would break sign-in.
  void hasAuthTokens;
  return Promise.resolve();
}

async function boot(){
  await consumeUrlAuthArtifacts();
  const { data: { session } } = await sb.auth.getSession();
  state.session = session;
  if(session){
    await loadAll();
    subscribeGlobalCourtNotifications();
  }
  state.ready = true;
  render();

  sb.auth.onAuthStateChange(async (event, session) => {
    state.session = session;
    if(session){
      await loadAll();
      subscribeGlobalCourtNotifications();
    } else {
      state.me = null;
    }
    render();
  });
}

// There's no push-notification infrastructure here (that would need a
// server holding device tokens) — so "notify the Committee" means a live
// in-app alert via Supabase Realtime: while the app is open, a new case or
// a fresh verdict pops a toast and refreshes the screen automatically.
let globalCourtSubscribed = false;
function subscribeGlobalCourtNotifications(){
  if(globalCourtSubscribed || !sb.channel) return;
  globalCourtSubscribed = true;
  sb.channel('court-cases-global')
    .on('postgres_changes', { event:'INSERT', schema:'public', table:'court_cases' }, async (payload)=>{
      await refresh();
      if(isCommittee() && payload.new.defendant_id !== state.me.id){
        const defendant = getPlayer(payload.new.defendant_id);
        toast(`⚖️ ${defendant?defendant.name:'A player'} has been called to Court — tap Court to review.`);
      }
    })
    .on('postgres_changes', { event:'UPDATE', schema:'public', table:'court_cases' }, async (payload)=>{
      const wasOpen = payload.old && payload.old.status === 'open';
      await refresh();
      if(wasOpen && payload.new.status !== 'open'){
        const defendant = getPlayer(payload.new.defendant_id);
        toast(`⚖️ Verdict in: ${defendant?defendant.name:'A player'} — ${payload.new.status==='guilty'?'GUILTY':'NOT GUILTY'}`);
      }
    })
    .subscribe();
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
let courtChannel = null; // realtime subscription for whichever court case modal is open

function render(){
  // Admin gets a distinct white/light theme so it's never mistaken for the
  // player-facing green/gold experience, even mid-session when switching
  // between "view as player" and the real admin tools.
  root.className = effectiveRole()==='admin' ? 'role-admin' : 'role-player';
  if(!state.ready){
    root.innerHTML = `<div class="loading-screen"><div class="spinner" style="width:28px;height:28px;border-width:3px;"></div><div>Loading Fine Buddy…</div></div>`;
    return;
  }
  if(!state.session){
    root.innerHTML = renderInstallBanner() + renderAuthScreen();
    bindAuthEvents();
    bindInstallBannerEvents();
    return;
  }
  if(!state.me){
    root.innerHTML = `<div class="loading-screen"><div class="spinner" style="width:28px;height:28px;border-width:3px;"></div><div>Setting up your profile…</div></div>`;
    return;
  }
  root.innerHTML = `
    ${renderTopbar()}
    ${renderInstallBanner()}
    <main id="main">${renderView()}</main>
    ${renderFab()}
    ${renderBottomNav()}
  `;
  bindGlobalEvents();
  bindInstallBannerEvents();
}

function renderInstallBanner(){
  if(!canOfferInstall()) return '';
  const variant = getInstallVariant();
  const copy = INSTALL_COPY[variant] || INSTALL_COPY['desktop-other'];
  const label = variant==='native' ? 'Install' : copy.btn;
  const title = variant==='native' ? 'Install Fine Buddy' : copy.banner;
  const sub = variant==='native' ? 'One tap from your home screen, just like a real app.' : copy.sub;
  return `
  <div class="install-banner" id="installBanner">
    <div class="install-banner-icon">${ICONS.install}</div>
    <div class="install-banner-text">
      <div class="install-banner-title">${title}</div>
      <div class="install-banner-sub">${sub}</div>
    </div>
    <button class="install-banner-btn" id="installBannerBtn">${label}</button>
    <button class="install-banner-close" id="installBannerClose" aria-label="Dismiss">✕</button>
  </div>`;
}
function bindInstallBannerEvents(){
  const btn = document.getElementById('installBannerBtn');
  if(btn) btn.addEventListener('click', triggerInstall);
  const closeBtn = document.getElementById('installBannerClose');
  if(closeBtn) closeBtn.addEventListener('click', dismissInstallBanner);
}
async function triggerInstall(){
  if(deferredInstallPrompt){
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    render();
  } else {
    openInstallInstructionsModal();
  }
}
function openInstallInstructionsModal(){
  const variant = getInstallVariant();
  const copy = INSTALL_COPY[variant] || INSTALL_COPY['desktop-other'];
  openModal(`
    <div class="install-steps">
      ${copy.steps.map((s,i)=>`<div class="install-step"><div class="install-step-num">${i+1}</div><div>${s}</div></div>`).join('')}
    </div>
    <button class="btn btn-primary" id="closeInstallStepsBtn" style="margin-top:16px;">Got it</button>
  `, { title: copy.title, center:true });
  document.getElementById('closeInstallStepsBtn').addEventListener('click', ()=>{ closeModal(); dismissInstallBanner(); });
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
    ['dashboard','Dashboard'],['fines','Fines'],['players','Players'],
    ['court','Court'],['events','Events'],['team','Team'],
  ];
  const playerTabs = [
    ['dashboard','Overview'],['profile','My Profile'],['fines','Fines'],
    ['court','Court'],['events','Events'],['pay','Pay'],
  ];
  const tabs = effectiveRole()==='admin' ? adminTabs : playerTabs;
  const needsVote = openCasesNeedingMyVote().length;
  return `<nav class="bottom-nav">
    ${tabs.map(([id,label])=>`
      <button data-view="${id}" class="${state.view===id?'active':''}">
        <span class="ic">${ICONS[id]}${id==='court' && needsVote ? '<span class="nav-badge"></span>' : ''}</span><span>${label}</span>
      </button>`).join('')}
  </nav>`;
}

function renderView(){
  const role = effectiveRole();
  if(role==='admin'){
    switch(state.view){
      case 'fines': return viewFinesAdmin();
      case 'players': return viewPlayersAdmin();
      case 'court': return viewCourt();
      case 'events': return viewEvents();
      case 'team': return viewTeamSettings();
      default: return viewDashboard();
    }
  }
  switch(state.view){
    case 'profile': return viewPlayerProfile();
    case 'fines': return viewFinesPlayer();
    case 'court': return viewCourt();
    case 'events': return viewEvents();
    case 'pay': return viewPay();
    default: return viewDashboard();
  }
}

/* ---------------- DASHBOARD ---------------- */
function viewDashboard(){
  const outstanding = playersWithOutstanding();
  const clear = state.players.filter(p=>playerOwed(p.id)<=0);
  const pct = pctSquadOutstanding();
  const myCase = state.me ? myOpenCourtCase() : null;
  const latestVerdict = resolvedCourtCases()[0];
  const pendingForMe = openCasesNeedingMyVote();
  const offender = serialOffender();
  return `
    <h1 class="page-title">Dashboard</h1>
    ${ clear.length ? `
    <div class="clear-strip">
      <span class="clear-strip-label">✅ Paid up</span>
      ${clear.map(p=>`<div class="avatar sm" data-player-click="${p.id}" title="${escapeHtml(p.name)}">${p.photo_url?`<img src="${p.photo_url}">`:initials(p.name)}</div>`).join('')}
    </div>
    ` : '' }
    ${ pendingForMe.length ? `
    <div class="banner court-banner" data-goto="court">
      ⚖️ Court is in session — ${pendingForMe.length} case${pendingForMe.length>1?'s':''} awaiting your vote.
    </div>
    ` : '' }
    ${ latestVerdict ? renderVerdictCard(latestVerdict) : '' }
    ${ offender ? `
    <div class="card serial-offender-card" data-player-click="${offender.id}">
      <div class="badge">🎯</div>
      <div>
        <div class="so-label">Serial Offender</div>
        <div class="so-name">${escapeHtml(offender.name)}</div>
        <div class="so-count">${fineCountFor(offender.id)} fine${fineCountFor(offender.id)===1?'':'s'} logged this season</div>
      </div>
    </div>
    ` : '' }
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
    ${ effectiveRole()==='player' ? (
      myCase ? `<button class="btn btn-outline" data-open-case="${myCase.id}" style="margin-bottom:14px;">⚖️ View my court case — awaiting verdict</button>`
      : playerOwed(state.me.id) > 0 ? `<button class="btn btn-court" id="takeToCourtBtn" style="margin-bottom:14px;">⚖️ Take it to Court</button>`
      : ''
    ) : '' }
    <div class="section-title">🚨 Wall of Shame</div>
    ${ outstanding.length ? `
    <div class="wanted-row">
      ${outstanding.map(pl=>`
        <div class="wanted-poster compact" data-player-click="${pl.id}">
          <div class="wanted-title">Wanted</div>
          <div class="wanted-photo">${pl.photo_url?`<img src="${pl.photo_url}">`:initials(pl.name)}</div>
          <div class="wanted-name">${escapeHtml(pl.name)}</div>
          <div class="wanted-for">${escapeHtml(reasonFor(pl.id))}</div>
          <div class="wanted-bounty">Owes <span class="amt">${fmt(playerOwed(pl.id))}</span></div>
        </div>
      `).join('')}
    </div>
    <small class="disclaimer">Tap a poster ${isAdmin() ? "to open that player's details" : "— if it's you, it'll take you straight to Pay"}.</small>
    ` : `<div class="card empty">🎉 Nobody's wanted — the whole squad is paid up!</div>` }

    <div class="section-title">Players with outstanding balances</div>
    <div class="card">
      ${ outstanding.length ? outstanding.map(p=>`
        <div class="row between" style="margin-bottom:10px;cursor:pointer;" data-player-click="${p.id}">
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
      <div class="announcement-card">
        <div class="row between"><div class="muted">${a.date}</div>${isAdmin()?`<button class="link-btn" style="color:#fff;" data-del-announce="${a.id}">Delete</button>`:''}</div>
        <div style="margin-top:6px;font-size:14.5px;">${escapeHtml(a.text)}</div>
      </div>
    `).join('') || `<div class="empty">No announcements yet.</div>`}
  `;
}

/* ---------------- FINES ---------------- */
function viewFinesAdmin(){
  const top = mostLoggedFine();
  return `
    <h1 class="page-title">Fines Catalog</h1>
    <div class="stat-grid" style="margin-bottom:14px;">
      <div class="stat-tile">
        <div class="label">Offenses on the books</div>
        <div class="value">${state.fines.length}</div>
      </div>
      <div class="stat-tile">
        <div class="label">Most logged</div>
        <div class="value" style="font-size:16px;line-height:1.25;margin-top:7px;">${top ? escapeHtml(top.label) : '—'}</div>
        ${top ? `<div class="muted" style="margin-top:2px;">${top.count}× this season</div>` : ''}
      </div>
    </div>

    <div class="card double-bubble-card ${state.team.double_bubble?'is-on':''}">
      <div class="toggle-row">
        <div class="row" style="gap:12px;">
          <div class="list-icon gold" style="width:44px;height:44px;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="9" r="5.5"/><circle cx="15" cy="15" r="5.5"/></svg>
          </div>
          <div><div class="name">Double Bubble</div><div class="muted">Instantly doubles every fine below</div></div>
        </div>
        <label class="switch"><input type="checkbox" id="doubleBubbleToggle" ${state.team.double_bubble?'checked':''}><span class="slider"></span></label>
      </div>
    </div>

    <div class="section-title">Tap an offense to log it against a player</div>
    <div class="list-card">
      ${state.fines.map((f,i)=>`
        <div class="list-row" data-log-fine="${f.id}">
          <div class="list-icon ${i%2?'gold':''}">${ICONS.gavelSm}</div>
          <div class="lbl">
            <div class="title">${escapeHtml(f.label)}</div>
            <div class="sub">${fmt(f.price)} standard${state.team.double_bubble?` · doubled to ${fmt(fineAmountNow(f.price))}`:''}</div>
          </div>
          <div class="row" style="gap:6px;">
            <span class="price-tag ${state.team.double_bubble?'doubled':''}">${fmt(fineAmountNow(f.price))}</span>
            <button class="icon-btn" data-edit-fine="${f.id}" onclick="event.stopPropagation()" aria-label="Edit">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4.5l5 5L8 21H3v-5z"/></svg>
            </button>
          </div>
        </div>
      `).join('') || `<div class="empty">No fines yet — tap + to add one.</div>`}
    </div>
    <button class="btn btn-outline" id="bulkImportBtn" style="margin-top:6px;">📋 Bulk import fines list</button>
    <small class="disclaimer">Paste "Offense, Price" pairs, one per line, to add lots of fines at once.</small>
  `;
}
function viewFinesPlayer(){
  const top = mostLoggedFine();
  return `
    <h1 class="page-title">Fines Catalog</h1>
    <div class="banner ${state.team.double_bubble?'banner-alert':''}">${state.team.double_bubble ? '🔴 Double Bubble is currently ON — all fines are doubled!' : 'ℹ️ These are the standard team fines set by your admin.'}</div>
    <div class="stat-grid" style="margin-bottom:14px;">
      <div class="stat-tile">
        <div class="label">Offenses</div>
        <div class="value">${state.fines.length}</div>
      </div>
      <div class="stat-tile">
        <div class="label">Squad's favourite</div>
        <div class="value" style="font-size:16px;line-height:1.25;margin-top:7px;">${top ? escapeHtml(top.label) : '—'}</div>
      </div>
    </div>
    <div class="list-card">
      ${state.fines.map((f,i)=>`
        <div class="list-row" style="cursor:default;">
          <div class="list-icon ${i%2?'gold':''}">${ICONS.gavelSm}</div>
          <div class="lbl">
            <div class="title">${escapeHtml(f.label)}</div>
            <div class="sub">Standard price ${fmt(f.price)}</div>
          </div>
          <span class="price-tag ${state.team.double_bubble?'doubled':''}">${fmt(fineAmountNow(f.price))}</span>
        </div>
      `).join('') || `<div class="empty">No fines set yet.</div>`}
    </div>
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
            <div class="name">${escapeHtml(p.name)} ${p.is_admin?'<span class="pill gold">Admin</span>':''} ${p.is_committee?'<span class="pill committee">Committee</span>':''}</div>
            <div class="muted">This week: ${fmt(playerWeekTotal(p.id))} · Paid: ${fmt(playerPaidTotal(p.id))}</div>
          </div>
        </div>
        ${ playerOwed(p.id)>0 ? `<span class="pill owed">${fmt(playerOwed(p.id))}</span>` : `<span class="pill clear">Clear</span>` }
      </div>
    `).join('') || `<div class="empty">No players yet — invite your squad below.</div>`}
    <button class="btn btn-outline" id="inviteBtn" style="margin-top:6px;">✉️ Invite a player</button>
  `;
}

/* ---------------- COURT ---------------- */
function renderVerdictCard(c){
  const defendant = getPlayer(c.defendant_id);
  const guilty = c.status === 'guilty';
  return `
  <div class="verdict-card ${guilty?'guilty':'not-guilty'}">
    <div class="verdict-gavel">${ICONS.gavelSm}</div>
    <div>
      <div class="verdict-headline"><b>${escapeHtml(defendant?defendant.name:'A player')}</b> has been found <span class="verdict-tag">${guilty?'GUILTY':'NOT GUILTY'}</span> of ${escapeHtml(c.fine_label || 'the disputed charge')}${guilty ? '' : ' — the fine has been waived'}.</div>
      <div class="verdict-sub">"${escapeHtml(c.reason)}"</div>
    </div>
  </div>`;
}
function renderCaseRow(c){
  const defendant = getPlayer(c.defendant_id);
  const votes = votesForCase(c.id);
  return `
    <div class="list-row" data-open-case="${c.id}">
      <div class="list-icon gold">${ICONS.gavelSm}</div>
      <div class="lbl">
        <div class="title">${escapeHtml(defendant?defendant.name:'Unknown player')}</div>
        <div class="sub">${escapeHtml(c.fine_label || 'General dispute')} · ${votes.length} vote${votes.length===1?'':'s'} in</div>
      </div>
      <span class="price-tag">›</span>
    </div>`;
}
function renderVerdictRow(c){
  const defendant = getPlayer(c.defendant_id);
  const guilty = c.status === 'guilty';
  return `
    <div class="list-row" data-open-case="${c.id}">
      <div class="list-icon ${guilty?'':'gold'}">${ICONS.gavelSm}</div>
      <div class="lbl">
        <div class="title">${escapeHtml(defendant?defendant.name:'Unknown player')}</div>
        <div class="sub">${escapeHtml(c.fine_label || 'General dispute')}</div>
      </div>
      <span class="pill ${guilty?'owed':'clear'}">${guilty?'Guilty':'Not guilty'}</span>
    </div>`;
}
function viewCourt(){
  if(isCommittee()) return viewCourtCommittee();
  return viewCourtPlayer();
}
function viewCourtCommittee(){
  const open = openCourtCases();
  const resolved = resolvedCourtCases();
  return `
    <h1 class="page-title">Court</h1>
    <div class="stat-grid" style="margin-bottom:14px;">
      <div class="stat-tile"><div class="label">On the docket</div><div class="value">${open.length}</div></div>
      <div class="stat-tile"><div class="label">Cases closed</div><div class="value">${resolved.length}</div></div>
    </div>
    <div class="section-title">Open cases</div>
    ${ open.length ? `<div class="list-card">${open.map(renderCaseRow).join('')}</div>` : `<div class="card empty">No one's currently on trial. ⚖️</div>` }
    ${ resolved.length ? `
    <div class="section-title">Past verdicts</div>
    <div class="list-card">${resolved.slice(0,12).map(renderVerdictRow).join('')}</div>
    ` : '' }
    <small class="disclaimer">As a Committee member, you can see every case, join the discussion, and cast one vote per case. Once everyone eligible has voted, the verdict is applied automatically.</small>
  `;
}
function viewCourtPlayer(){
  const mine = state.courtCases.filter(c=>c.defendant_id===state.me.id).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
  const active = mine.find(c=>c.status==='open');
  const history = mine.filter(c=>c.status!=='open');
  return `
    <h1 class="page-title">Court</h1>
    ${ active ? `
    <div class="banner">⚖️ Your case is open — the Committee is discussing it now. Add your side of the story below.</div>
    <div class="list-card">${renderCaseRow(active)}</div>
    ` : `
    <div class="card empty">You don't have an open case. Got a fine you think is unfair? Head to your Dashboard and tap <b>Take it to Court</b> on your outstanding balance.</div>
    ` }
    ${ history.length ? `
    <div class="section-title">Your case history</div>
    <div class="list-card">${history.map(renderVerdictRow).join('')}</div>
    ` : '' }
    <small class="disclaimer">Every player can be called to Court, no matter their role — the Committee reviews the chat, then votes guilty or not guilty. A not-guilty verdict automatically waives the fine.</small>
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
    ${ !isStandalone() ? `
    <div class="card" style="margin-top:14px;">
      <div class="row" style="gap:12px;">
        <div class="list-icon">${ICONS.install}</div>
        <div class="lbl"><div class="title">Not installed yet?</div><div class="sub">Add Fine Buddy to your home screen for the full app feel.</div></div>
      </div>
      <button class="btn btn-outline" id="profileInstallBtn" style="margin-top:12px;">📲 Install Fine Buddy</button>
    </div>
    ` : '' }
    <button class="btn btn-ghost" id="signOutBtn2" style="margin-top:10px;">Sign out</button>
  `;
}

/* ---------------- PAY ---------------- */
function viewPay(){
  const p = state.me;
  const owed = playerOwed(p.id);
  const t = state.team;
  const paypalUrl = t.paypal_link ? (t.paypal_link.replace(/\/+$/,'') + '/' + owed.toFixed(2) + 'GBP') : null;
  const monzoUrl = t.monzo_link ? (t.monzo_link.replace(/\/+$/,'') + '/' + owed.toFixed(2)) : null;
  return `
    <h1 class="page-title">Pay Fines</h1>
    <div class="card">
      <div class="muted">Amount due</div>
      <div style="font-size:30px;font-weight:800;color:${owed>0?'#ff9d9a':'var(--gold-400)'};margin-top:2px;">${fmt(owed)}</div>
    </div>
    ${ (paypalUrl || monzoUrl) ? `
    <div class="section-title">Pay instantly</div>
    <div class="card">
      ${paypalUrl ? `<a class="btn paypal-btn" href="${paypalUrl}" target="_blank" rel="noopener">Pay ${fmt(owed)} with PayPal</a>` : ''}
      ${paypalUrl && monzoUrl ? `<div style="height:10px;"></div>` : ''}
      ${monzoUrl ? `<a class="btn monzo-btn" href="${monzoUrl}" target="_blank" rel="noopener">Pay ${fmt(owed)} with Monzo</a>` : ''}
      <small class="disclaimer">Opens the app with the amount already filled in. Once you've paid, your admin will confirm it and your balance will clear.</small>
    </div>` : isAdmin() ? `<div class="banner">Add a PayPal.me or Monzo.me link in Team Settings to enable instant payments here.</div>` : `<div class="banner">Ask your admin to add a PayPal or Monzo link in Team Settings for instant one-tap payments.</div>`}
    <div class="section-title">No Monzo? Bank transfer instead</div>
    <div class="card">
      <div class="muted">Amount to transfer</div>
      <div style="font-size:26px;font-weight:800;color:var(--gold-400);margin:2px 0 12px;">${fmt(owed)}</div>
      <div class="divider"></div>
      <div class="row between"><div class="muted">Account name</div><div class="name">${escapeHtml(t.bank_account_name||'—')}</div></div>
      <div class="row between"><div class="muted">Sort code</div><div class="name">${escapeHtml(t.bank_sort_code||'—')}</div></div>
      <div class="row between"><div class="muted">Account number</div><div class="name">${escapeHtml(t.bank_account_number||'—')}</div></div>
      <div class="row between"><div class="muted">Reference</div><div class="name">${escapeHtml(t.bank_reference||'FINE')}-${p.name.split(' ')[0].toUpperCase()}</div></div>
      <button class="btn btn-outline" id="copyBankDetailsBtn" style="margin-top:14px;">📋 Copy bank details</button>
      <small class="disclaimer">Same amount as above — no Monzo needed, just transfer straight to the nominated account and your admin will confirm it.</small>
    </div>
    ${ owed>0 ? `<div class="banner">Once you've paid, your admin confirms it on their end — balances can only be marked as paid by a team admin, to keep the totals trustworthy.</div>` : '' }
  `;
}

/* ---------------- EVENTS ---------------- */
function renderPollCard(poll){
  const votes = votesForPoll(poll.id);
  const myVote = myPollVoteFor(poll.id);
  const options = Array.isArray(poll.options) ? poll.options : [];
  const tally = tallyPoll(options, votes);
  const canVote = !poll.closed;
  return `
    <div class="poll-card ${poll.closed?'closed':''}">
      <div class="poll-question">${escapeHtml(poll.question)}${poll.closed?' <span class="muted" style="font-size:12px;">(closed)</span>':''}</div>
      ${tally.map((opt,i)=>`
        <button class="poll-option ${myVote && myVote.option_index===i?'voted':''}" ${canVote?`data-poll-vote="${poll.id}:${i}"`:'disabled'}>
          <div class="poll-option-row">
            <span class="poll-option-label">${myVote && myVote.option_index===i?'✅ ':''}${escapeHtml(opt.label)}</span>
            <span class="poll-option-pct">${opt.pct}%</span>
          </div>
          <div class="poll-bar"><div class="poll-bar-fill" style="width:${opt.pct}%;"></div></div>
          <div class="poll-votes-count">${opt.count} vote${opt.count===1?'':'s'}</div>
        </button>
      `).join('')}
      <div class="poll-meta">
        <div class="muted" style="font-size:12px;">${votes.length} total vote${votes.length===1?'':'s'}</div>
        ${isAdmin() && !poll.closed ? `<button class="link-btn" data-close-poll="${poll.id}">Close poll</button>` : ''}
      </div>
    </div>
  `;
}
function viewEvents(){
  const sorted = state.events.slice().sort((a,b)=>new Date(a.date)-new Date(b.date));
  const polls = state.eventPolls.slice().sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
  return `
    <h1 class="page-title">Social Calendar</h1>
    <div class="banner">🎉 Funds raised from fines go straight towards these events.</div>
    ${ sorted.length ? sorted.map(e=>`
      <div class="card">
        <div class="row between">
          <div class="name">${escapeHtml(e.title)}</div>
          ${isAdmin()?`<button class="link-btn" style="color:#fff;" data-del-event="${e.id}">Delete</button>`:''}
        </div>
        <div class="muted" style="margin:4px 0 8px;">📅 ${e.date}</div>
        <div style="font-size:14px;">${escapeHtml(e.description||'')}</div>
        ${e.funds_note?`<div class="pill gold" style="margin-top:8px;">${escapeHtml(e.funds_note)}</div>`:''}
        ${e.link?`<a class="btn btn-gold" style="margin-top:12px;" href="${e.link}" target="_blank" rel="noopener">🎟️ View tickets / booking link</a>`:''}
      </div>
    `).join('') : `<div class="empty">No events scheduled yet.</div>` }

    <div class="section-title">Suggest an event</div>
    <div class="card">
      <div class="row" style="gap:8px;">
        <input type="text" id="suggestionInput" placeholder="Got an idea for a social? Type it here…" style="flex:1;">
        <button class="btn btn-primary btn-sm" id="submitSuggestionBtn">Submit</button>
      </div>
      ${ state.eventSuggestions.length ? `
      <div class="divider"></div>
      ${state.eventSuggestions.map(s=>{
        const suggester = getPlayer(s.suggested_by);
        return `
        <div class="suggestion-row">
          <div>
            <div class="who">${escapeHtml(suggester?suggester.name:'A player')}</div>
            <div class="txt">${escapeHtml(s.text)}</div>
          </div>
          ${isAdmin()?`<button class="link-btn" style="color:#fff;flex-shrink:0;" data-del-suggestion="${s.id}">Delete</button>`:''}
        </div>`;
      }).join('')}
      ` : '' }
    </div>

    <div class="section-title">Polls</div>
    ${ polls.length ? polls.map(renderPollCard).join('') : (isAdmin() ? '' : `<div class="empty">No polls yet.</div>`) }
    ${ isAdmin() ? `<button class="btn btn-outline" id="createPollBtn" style="margin-top:6px;">+ Create a poll</button>` : '' }
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
      <label class="field-label">PayPal.me Link</label>
      <input type="url" id="paypalLinkInput" value="${escapeHtml(t.paypal_link||'')}" placeholder="https://paypal.me/YourClubName">
      <small class="disclaimer">Create a free PayPal.me link at paypal.me — just your club's PayPal account name, no business setup required.</small>
      <label class="field-label">Monzo.me Link</label>
      <input type="url" id="monzoLinkInput" value="${escapeHtml(t.monzo_link||'')}" placeholder="https://monzo.me/yourusername">
      <small class="disclaimer">Create a free Monzo.me link in your Monzo app (Payments → Monzo.me), or at monzo.me. Both links, if filled in, fill in each player's exact amount owed automatically when they tap Pay — add either, both, or neither.</small>
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

    <div class="section-title">Danger zone</div>
    <div class="card">
      <div class="muted" style="margin-bottom:10px;">Permanently deletes every logged fine and resets everyone's "paid this season" total back to £0.00. Your fines catalog, players, events, and announcements are untouched — just the money data gets wiped. Use this once, right before you actually launch, to clear out test entries.</div>
      <button class="btn btn-danger" id="resetFinesBtn">Reset all fines &amp; payments</button>
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
function closeModal(){
  if(courtChannel){ sb.removeChannel(courtChannel); courtChannel=null; }
  if(modalNode){ modalNode.remove(); modalNode=null; }
}

function fileToPath(prefix, file){
  const ext = (file.name.split('.').pop()||'jpg').toLowerCase().replace(/[^a-z0-9]/g,'') || 'jpg';
  return `${prefix}/${Date.now()}_${Math.random().toString(36).slice(2,8)}.${ext}`;
}
async function uploadImage(prefix, file){
  if(!file.type || !file.type.startsWith('image/')){ toast('Please choose an image file.'); return null; }
  if(file.size > 8*1024*1024){ toast('That image is too large — please use one under 8MB.'); return null; }
  const path = fileToPath(prefix, file);
  const { error } = await sb.storage.from('media').upload(path, file, { cacheControl:'3600', upsert:false });
  if(error){ toast('Upload failed: ' + error.message + ' — check the "media" storage bucket exists and is public.'); return null; }
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
  root.querySelectorAll('[data-player-click]').forEach(el=>el.addEventListener('click', ()=>{
    const pid = el.dataset.playerClick;
    if(pid === state.me.id){ state.view = 'pay'; render(); }
    else if(isAdmin()){ openPlayerDetailModal(pid); }
  }));
  ['signOutBtn','signOutBtn2'].forEach(id=>{ const el=document.getElementById(id); if(el) el.addEventListener('click', signOut); });

  root.querySelectorAll('[data-open-case]').forEach(el=>el.addEventListener('click', ()=>openCaseModal(el.dataset.openCase)));
  const takeToCourtBtn = document.getElementById('takeToCourtBtn');
  if(takeToCourtBtn) takeToCourtBtn.addEventListener('click', openTakeToCourtModal);
  const profileInstallBtn = document.getElementById('profileInstallBtn');
  if(profileInstallBtn) profileInstallBtn.addEventListener('click', triggerInstall);

  root.querySelectorAll('[data-del-announce]').forEach(b=>b.addEventListener('click', async ()=>{
    await sb.from('announcements').delete().eq('id', b.dataset.delAnnounce); await refresh();
  }));
  root.querySelectorAll('[data-del-event]').forEach(b=>b.addEventListener('click', async ()=>{
    await sb.from('events').delete().eq('id', b.dataset.delEvent); await refresh();
  }));

  const submitSuggestionBtn = document.getElementById('submitSuggestionBtn');
  if(submitSuggestionBtn) submitSuggestionBtn.addEventListener('click', async ()=>{
    const input = document.getElementById('suggestionInput');
    const text = input.value.trim();
    if(!text) return;
    await sb.from('event_suggestions').insert({ text, suggested_by: state.me.id });
    await refresh();
    toast('Suggestion added — thanks!');
  });
  root.querySelectorAll('[data-del-suggestion]').forEach(b=>b.addEventListener('click', async ()=>{
    await sb.from('event_suggestions').delete().eq('id', b.dataset.delSuggestion); await refresh();
  }));
  root.querySelectorAll('[data-poll-vote]').forEach(b=>b.addEventListener('click', async ()=>{
    const [pollId, optionIndex] = b.dataset.pollVote.split(':');
    await sb.from('event_poll_votes').upsert(
      { poll_id: pollId, voter_id: state.me.id, option_index: parseInt(optionIndex,10) },
      { onConflict:'poll_id,voter_id' }
    );
    await refresh();
  }));
  root.querySelectorAll('[data-close-poll]').forEach(b=>b.addEventListener('click', async ()=>{
    await sb.from('event_polls').update({ closed:true }).eq('id', b.dataset.closePoll); await refresh();
  }));
  const createPollBtn = document.getElementById('createPollBtn');
  if(createPollBtn) createPollBtn.addEventListener('click', openCreatePollModal);

  const copyBankDetailsBtn = document.getElementById('copyBankDetailsBtn');
  if(copyBankDetailsBtn) copyBankDetailsBtn.addEventListener('click', ()=>{
    const t = state.team;
    const p = state.me;
    const owed = playerOwed(p.id);
    const ref = `${t.bank_reference||'FINE'}-${p.name.split(' ')[0].toUpperCase()}`;
    const text = `Amount: ${fmt(owed)}\nAccount name: ${t.bank_account_name||'—'}\nSort code: ${t.bank_sort_code||'—'}\nAccount number: ${t.bank_account_number||'—'}\nReference: ${ref}`;
    navigator.clipboard?.writeText(text).catch(()=>{});
    const original = copyBankDetailsBtn.textContent;
    copyBankDetailsBtn.textContent = 'Copied!';
    setTimeout(()=>{ copyBankDetailsBtn.textContent = original; }, 1500);
  });

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
    toast('Uploading crest…');
    const url = await uploadImage('crests', e.target.files[0]);
    if(url){ await sb.from('team_info').update({ crest_url:url }).eq('id',1); await refresh(); toast('Crest updated'); }
  });
  const playerPhotoInput = document.getElementById('playerPhotoInput');
  if(playerPhotoInput) playerPhotoInput.addEventListener('change', async (e)=>{
    if(!e.target.files[0]) return;
    toast('Uploading photo…');
    const url = await uploadImage('players', e.target.files[0]);
    if(url){ await sb.from('players').update({ photo_url:url }).eq('id', state.me.id); await refresh(); toast('Profile picture updated'); }
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
      paypal_link: document.getElementById('paypalLinkInput').value.trim(),
      monzo_link: document.getElementById('monzoLinkInput').value.trim(),
      bank_account_name: document.getElementById('bankNameInput').value.trim(),
      bank_sort_code: document.getElementById('bankSortInput').value.trim(),
      bank_account_number: document.getElementById('bankAccInput').value.trim(),
      bank_reference: document.getElementById('bankRefInput').value.trim(),
    }).eq('id',1);
    await refresh();
    toast('Team settings saved');
  });

  const resetFinesBtn = document.getElementById('resetFinesBtn');
  if(resetFinesBtn) resetFinesBtn.addEventListener('click', async ()=>{
    if(!confirm('This permanently deletes every logged fine and resets all "paid this season" totals to £0.00. This cannot be undone. Continue?')) return;
    if(!confirm('Last check — are you absolutely sure? Everyone\'s fine history and payment totals will be wiped completely.')) return;
    const NEVER_A_REAL_ID = '00000000-0000-0000-0000-000000000000';
    await sb.from('fine_log').delete().neq('id', NEVER_A_REAL_ID);
    await sb.from('players').update({ season_paid: 0 }).neq('id', NEVER_A_REAL_ID);
    await refresh();
    toast('All fines and payments have been reset');
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
    <div class="divider"></div>
    <label class="field-label">Or add them directly by email</label>
    <input type="text" id="inviteNameInput" placeholder="Player's full name">
    <input type="email" id="inviteEmailInput" placeholder="their@email.com" style="margin-top:8px;">
    <button class="btn btn-primary" id="sendEmailInviteBtn" style="margin-top:10px;">Add player &amp; send sign-in email</button>
    <small class="disclaimer">This adds them to your squad immediately with the name you enter, and emails them a link to activate their account whenever they're ready.</small>
  `, { title:'Invite a player' });
  document.getElementById('copyInviteBtn').addEventListener('click', ()=>{
    navigator.clipboard?.writeText(link).catch(()=>{});
    toast('Invite link copied');
  });
  document.getElementById('sendEmailInviteBtn').addEventListener('click', async ()=>{
    const name = document.getElementById('inviteNameInput').value.trim();
    const email = document.getElementById('inviteEmailInput').value.trim();
    if(!name || !email) return;
    const btn = document.getElementById('sendEmailInviteBtn');
    btn.disabled = true; btn.textContent = 'Sending…';
    const { error: pendingError } = await sb.from('pending_invites').upsert({ email, name, invited_by: state.me.id });
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.href } });
    closeModal();
    await refresh();
    if(error){
      toast('Could not send invite: ' + error.message);
    } else if(pendingError){
      toast(`Sign-in email sent, but the name may not have pre-filled — check the Players tab and rename ${name} if needed.`);
    } else {
      toast(`${name} added — sign-in email sent`);
    }
  });
}

function openPlayerDetailModal(playerId){
  const p = getPlayer(playerId);
  const logs = logsFor(p.id).slice().reverse();
  openModal(`
    <div class="row" style="gap:12px;margin-bottom:14px;">
      <div class="avatar lg">${p.photo_url?`<img src="${p.photo_url}">`:initials(p.name)}</div>
      <div style="flex:1;"><div class="muted">Owes ${fmt(playerOwed(p.id))} · Paid ${fmt(playerPaidTotal(p.id))}</div></div>
    </div>
    <label class="field-label">Name</label>
    <div class="row" style="gap:8px;">
      <input type="text" id="editPlayerNameInput" value="${escapeHtml(p.name)}" style="flex:1;">
      <button class="btn btn-outline btn-sm" id="savePlayerNameBtn">Save</button>
    </div>
    <div class="divider"></div>
    ${logs.length? logs.map(l=>`
      <div class="row between" style="margin-bottom:8px;">
        <div><div style="font-size:13.5px;font-weight:700;">${escapeHtml(l.label)}</div><div class="muted">${l.date}</div></div>
        <div class="row" style="gap:8px;">
          <span class="pill ${l.waived?'gold':l.paid?'clear':'owed'}">${l.waived?'Waived by Court':fmt(l.amount)}</span>
          <button class="link-btn" data-del-log="${l.id}" title="Delete this fine entry">✕</button>
        </div>
      </div>`).join('') : `<div class="empty">No fines yet</div>`}
    <div class="divider"></div>
    <button class="btn btn-primary" id="markPlayerPaidBtn">Mark all as paid</button>
    ${!p.is_admin ? `<button class="btn btn-outline" id="makeAdminBtn" style="margin-top:8px;">Make team admin</button>` : ''}
    <button class="btn btn-outline" id="toggleCommitteeBtn" style="margin-top:8px;">${p.is_committee ? 'Remove from Committee' : '⚖️ Make Committee member'}</button>
  `, { title:'Player details' });
  modalNode.querySelectorAll('[data-del-log]').forEach(btn=>btn.addEventListener('click', async ()=>{
    if(!confirm('Delete this fine entry? This cannot be undone.')) return;
    await sb.from('fine_log').delete().eq('id', btn.dataset.delLog);
    closeModal(); await refresh();
    toast('Fine entry deleted');
  }));
  document.getElementById('savePlayerNameBtn').addEventListener('click', async ()=>{
    const name = document.getElementById('editPlayerNameInput').value.trim();
    if(!name) return;
    await sb.from('players').update({ name }).eq('id', p.id);
    closeModal(); await refresh();
    toast('Name updated');
  });
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
  const toggleCommitteeBtn = document.getElementById('toggleCommitteeBtn');
  if(toggleCommitteeBtn) toggleCommitteeBtn.addEventListener('click', async ()=>{
    await sb.from('players').update({ is_committee: !p.is_committee }).eq('id', p.id);
    closeModal(); await refresh();
    toast(`${p.name} ${p.is_committee ? 'removed from' : 'added to'} the Committee`);
  });
}

/* ---------------- Court modal — dispute a fine, chat, vote ---------------- */
function openTakeToCourtModal(){
  const myUnpaid = logsFor(state.me.id).filter(l=>!l.paid);
  if(!myUnpaid.length){ toast("You don't have any outstanding fines to dispute."); return; }
  openModal(`
    <div class="muted" style="margin-bottom:10px;">Pick the fine you want to dispute, then make your case to the Committee.</div>
    <label class="field-label">Which fine?</label>
    <select id="courtFineSelect">${myUnpaid.map(l=>`<option value="${l.id}">${escapeHtml(l.label)} — ${fmt(l.amount)} (${l.date})</option>`).join('')}</select>
    <label class="field-label">Why do you think this fine is unfair?</label>
    <textarea id="courtReasonInput" rows="4" placeholder="Make your case…"></textarea>
    <button class="btn btn-court" id="submitCourtBtn" style="margin-top:14px;">⚖️ Submit to the Committee</button>
    <small class="disclaimer">This opens a private thread between you and the Committee, who'll discuss it and vote guilty or not guilty. A not-guilty verdict automatically waives the fine.</small>
  `, { title:'Take it to Court' });
  document.getElementById('submitCourtBtn').addEventListener('click', async ()=>{
    const logId = document.getElementById('courtFineSelect').value;
    const reason = document.getElementById('courtReasonInput').value.trim();
    if(!reason) return;
    const log = state.fineLog.find(l=>l.id===logId);
    const btn = document.getElementById('submitCourtBtn');
    btn.disabled = true; btn.textContent = 'Submitting…';
    const { data, error } = await sb.from('court_cases').insert({
      defendant_id: state.me.id, fine_log_id: log ? log.id : null, fine_label: log ? log.label : null, reason
    }).select().maybeSingle();
    if(error || !data){
      toast('Could not open your case: ' + (error ? error.message : 'unknown error'));
      btn.disabled = false; btn.textContent = '⚖️ Submit to the Committee';
      return;
    }
    await sb.from('court_messages').insert({ case_id: data.id, sender_id: state.me.id, body: reason });
    closeModal();
    await refresh();
    const size = committeeCount() - 1; // excluding the defendant, if they're on the committee too
    toast(`Your case is open — ${Math.max(size,0)} committee member${size===1?'':'s'} notified`);
    state.view = 'court'; render();
    openCaseModal(data.id);
  });
}

function openCaseModal(caseId){
  let c = state.courtCases.find(x=>x.id===caseId);
  if(!c) return;
  let messages = [];

  const load = async ()=>{
    const { data } = await sb.from('court_messages').select('*').eq('case_id', caseId).order('created_at');
    messages = data || [];
    renderCaseModal(c, messages);
  };
  load();

  if(sb.channel){
    courtChannel = sb.channel('court-'+caseId)
      .on('postgres_changes', { event:'INSERT', schema:'public', table:'court_messages', filter:`case_id=eq.${caseId}` }, payload=>{
        if(!messages.some(m=>m.id===payload.new.id)){
          messages = [...messages, payload.new];
          renderCaseModal(c, messages);
        }
      })
      .on('postgres_changes', { event:'*', schema:'public', table:'court_votes', filter:`case_id=eq.${caseId}` }, async ()=>{
        await refresh();
        c = state.courtCases.find(x=>x.id===caseId) || c;
        renderCaseModal(c, messages);
      })
      .subscribe();
  }
}

function renderCaseModal(c, messages){
  const defendant = getPlayer(c.defendant_id);
  const committee = isCommittee();
  const isMine = c.defendant_id === state.me.id;
  const votes = votesForCase(c.id);
  const myVote = votes.find(v=>v.voter_id===state.me.id);
  const stillToVote = Math.max(committeeCount() - (state.players.some(p=>p.id===c.defendant_id && (p.is_admin||p.is_committee)) ? 1 : 0) - votes.length, 0);
  const guiltyCount = votes.filter(v=>v.verdict==='guilty').length;
  const notGuiltyCount = votes.filter(v=>v.verdict==='not_guilty').length;

  const body = `
    <div class="case-summary">
      <div class="row" style="gap:10px;">
        <div class="avatar">${defendant && defendant.photo_url?`<img src="${defendant.photo_url}">`:initials(defendant?defendant.name:'?')}</div>
        <div>
          <div class="name">${escapeHtml(defendant?defendant.name:'Unknown player')}</div>
          <div class="muted">${escapeHtml(c.fine_label || 'General dispute')}</div>
        </div>
      </div>
      <div class="case-status-pill ${c.status}">${c.status==='open'?'Open':c.status==='guilty'?'Guilty':'Not Guilty'}</div>
    </div>
    <div class="case-reason">"${escapeHtml(c.reason)}"</div>

    ${ committee && !isMine ? `
      <div class="vote-panel">
        <div class="vote-tally">${guiltyCount} guilty · ${notGuiltyCount} not guilty · ${stillToVote} yet to vote</div>
        ${ c.status==='open' ? `
        <div class="btn-block-row">
          <button class="btn btn-guilty" data-vote="guilty" ${myVote && myVote.verdict==='guilty' ? 'disabled':''}>🔨 Guilty</button>
          <button class="btn btn-not-guilty" data-vote="not_guilty" ${myVote && myVote.verdict==='not_guilty' ? 'disabled':''}>🕊️ Not Guilty</button>
        </div>
        ${myVote ? `<div class="muted center-text" style="margin-top:8px;">You voted ${myVote.verdict==='guilty'?'Guilty':'Not Guilty'} — tap the other button to change your vote.</div>` : ''}
        ` : `<div class="muted center-text" style="margin-top:8px;">${escapeHtml(c.verdict_note||'')}</div>` }
      </div>
    ` : '' }
    ${ !committee && c.status!=='open' ? `<div class="vote-panel"><div class="muted center-text">${escapeHtml(c.verdict_note||'')}</div></div>` : '' }

    <div class="section-title" style="margin-top:20px;">Discussion</div>
    <div class="court-chat" id="courtChatLog">
      ${ messages.length ? messages.map(m=>{
        const sender = getPlayer(m.sender_id);
        const mine = m.sender_id === state.me.id;
        return `<div class="chat-bubble ${mine?'mine':''}">
          <div class="chat-sender">${escapeHtml(sender?sender.name:'Unknown')}</div>
          <div class="chat-body">${escapeHtml(m.body)}</div>
        </div>`;
      }).join('') : `<div class="empty">No messages yet — start the discussion below.</div>` }
    </div>
    ${ c.status==='open' ? `
    <div class="row" style="gap:8px;margin-top:10px;">
      <input type="text" id="courtMsgInput" placeholder="Type a message…" style="flex:1;">
      <button class="btn btn-primary btn-sm" id="courtSendBtn">Send</button>
    </div>
    ` : `<div class="muted center-text" style="margin-top:10px;">This case is closed — no further messages.</div>` }
  `;

  if(modalNode){
    modalNode.querySelector('.modal').innerHTML = `
      <div class="modal-head"><h2>Case file</h2><button class="modal-close" id="modalCloseBtn">✕</button></div>
      ${body}
    `;
    document.getElementById('modalCloseBtn').addEventListener('click', closeModal);
  } else {
    openModal(body, { title:'Case file' });
  }
  bindCaseModalEvents(c, messages);
  const log = document.getElementById('courtChatLog');
  if(log) log.scrollTop = log.scrollHeight;
}

function bindCaseModalEvents(c, messages){
  const sendBtn = document.getElementById('courtSendBtn');
  if(sendBtn) sendBtn.addEventListener('click', async ()=>{
    const input = document.getElementById('courtMsgInput');
    const body = input.value.trim();
    if(!body) return;
    input.value = '';
    await sb.from('court_messages').insert({ case_id: c.id, sender_id: state.me.id, body });
    const { data } = await sb.from('court_messages').select('*').eq('case_id', c.id).order('created_at');
    renderCaseModal(c, data || messages);
  });
  const msgInput = document.getElementById('courtMsgInput');
  if(msgInput) msgInput.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); document.getElementById('courtSendBtn').click(); } });
  if(modalNode) modalNode.querySelectorAll('[data-vote]').forEach(btn=>btn.addEventListener('click', async ()=>{
    const verdict = btn.dataset.vote;
    await sb.from('court_votes').upsert({ case_id: c.id, voter_id: state.me.id, verdict }, { onConflict:'case_id,voter_id' });
    await refresh();
    const updated = state.courtCases.find(x=>x.id===c.id) || c;
    renderCaseModal(updated, messages);
    toast(verdict==='guilty' ? 'You voted Guilty' : 'You voted Not Guilty');
  }));
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

function openCreatePollModal(){
  openModal(`
    <label class="field-label">Question</label>
    <input type="text" id="pollQuestionInput" placeholder="e.g. Where should we do the end-of-season do?">
    <label class="field-label">Options (leave blank to skip)</label>
    <input type="text" id="pollOptionInput0" placeholder="Option 1">
    <input type="text" id="pollOptionInput1" placeholder="Option 2" style="margin-top:8px;">
    <input type="text" id="pollOptionInput2" placeholder="Option 3 (optional)" style="margin-top:8px;">
    <input type="text" id="pollOptionInput3" placeholder="Option 4 (optional)" style="margin-top:8px;">
    <button class="btn btn-primary" id="savePollBtn" style="margin-top:14px;">Create poll</button>
    <small class="disclaimer">Every player will be able to vote for one option. You can close the poll to lock in the final result whenever you like.</small>
  `, { title:'New poll' });
  document.getElementById('savePollBtn').addEventListener('click', async ()=>{
    const question = document.getElementById('pollQuestionInput').value.trim();
    const options = [0,1,2,3]
      .map(i=>document.getElementById('pollOptionInput'+i).value.trim())
      .filter(Boolean);
    if(!question || options.length<2){ toast('Add a question and at least 2 options.'); return; }
    await sb.from('event_polls').insert({ question, options, created_by: state.me.id, closed:false });
    closeModal(); await refresh();
    toast('Poll created');
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
