/* Teacher / Admin dashboard, role-aware sign-in and class membership.
   Depends on globals from index.html: firebase*, currentUserProfile, store, ALL, esc, scoreFrac, ... */
const FV = () => firebase.firestore.FieldValue;
function userRole(){ return (currentUserProfile && currentUserProfile.role) || 'student'; }
function isStaffRole(){ return ['teacher','admin'].includes(userRole()); }
function isAdminRole(){ return userRole()==='admin'; }

function updateNavAdminRole(){
  const nav=document.getElementById('nav-admin');
  if(nav){
    nav.style.display = (firebaseUser && isStaffRole()) ? '' : 'none';
    nav.textContent = isAdminRole() ? 'Admin Dashboard' : 'Teacher Portal';
  }
  const a=document.getElementById('nav-auth');
  if(a){ a.disabled=!firebaseReady; a.textContent = firebaseUser ? 'Account' : 'Sign in / Register'; }
}

/* ---------------- Modal helpers ---------------- */
function openModal(html){
  document.getElementById('global-modal-root').innerHTML =
    `<div class="modal-overlay" onclick="if(event.target===this)closeModal()"><div class="modal-card"><button class="modal-close no-print" onclick="closeModal()" aria-label="Close">&times;</button>${html}</div></div>`;
}
function closeModal(){ document.getElementById('global-modal-root').innerHTML=''; }

/* ---------------- Auth / registration ---------------- */
let authTab='student';
function openAuthModal(tab){ authTab=tab||'student'; renderAuthModal(''); }
function setAuthTab(t){ authTab=t; renderAuthModal(''); }
function renderAuthModal(msg){
  const teacher = authTab==='teacher';
  openModal(`<h2 style="font-family:Fraunces,serif;margin:0 0 12px">Sign in / Register</h2>
  <div class="auth-tab-bar"><button class="auth-tab-btn ${!teacher?'active':''}" onclick="setAuthTab('student')">Student</button><button class="auth-tab-btn ${teacher?'active':''}" onclick="setAuthTab('teacher')">Teacher</button></div>
  ${teacher
    ? `<p class="mini-note">Teachers register with a school access key. Enter it below, then continue with Google. Existing teachers can enter the key again or sign in directly.</p>
       <input id="teacher-key" class="admin-input" type="password" placeholder="Teacher access key" autocomplete="off">`
    : `<p class="mini-note">Students sign in with Google to sync progress and join a class with a class code.</p>`}
  <p id="auth-msg" style="color:var(--red);font-size:14px;min-height:20px">${esc(msg||'')}</p>
  <div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn btn-primary" onclick="submitAuth()">Continue with Google</button><button class="btn btn-ghost" onclick="closeModal()">Cancel</button></div>`);
}
async function submitAuth(){
  if(!firebaseReady){ renderAuthModal('Cloud sync is not configured.'); return; }
  if(authTab==='teacher'){
    const key=(document.getElementById('teacher-key')||{}).value||'';
    if(!key.trim()){ renderAuthModal('Please enter the teacher access key.'); return; }
    try{
      const r=await fetch('/api/verify-teacher',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accessKey:key})});
      const d=await r.json();
      if(!d.valid){ renderAuthModal(d.error||'Invalid access key.'); return; }
      if(d.role==='admin'){ renderAuthModal('Admin accounts are granted in the Firebase console (set role to "admin" on the user document). Use the teacher key to register as a teacher.'); return; }
      pendingRegistrationRole='teacher';
    }catch(e){ renderAuthModal('Could not verify the key. Check your connection.'); return; }
  } else pendingRegistrationRole=null;
  closeModal();
  if(firebaseUser && pendingRegistrationRole){ await loadUserProfile(); updateNavAdminRole(); renderAuthStatus(); return; }
  await googleLogin();
}
function openAccountModal(){
  const p=currentUserProfile||{};
  openModal(`<h2 style="font-family:Fraunces,serif;margin:0 0 10px">Account</h2>
  <p><b>${esc(p.displayName||firebaseUser.displayName||'')}</b><br><span class="mini-note">${esc(p.email||firebaseUser.email||'')}</span></p>
  <p><span class="admin-badge ${esc(userRole())}">${esc(userRole().toUpperCase())}</span> ${p.className?`&nbsp;Class: <b>${esc(p.className)}</b>`:''}</p>
  ${userRole()==='student'?`<p class="mini-note">Are you a teacher? Sign out and register from the Teacher tab, or <a href="#" onclick="closeModal();openAuthModal('teacher');return false">enter your teacher key</a>.</p>`:''}
  <div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn btn-navy" onclick="closeModal();googleLogout()">Sign out</button><button class="btn btn-ghost" onclick="closeModal()">Close</button></div>`);
}

/* ---------------- Student: join / leave class ---------------- */
async function studentJoinClass(){
  if(!firebaseUser||!firebaseDb){ openAuthModal('student'); return; }
  const code=((document.getElementById('join-class-code')||{}).value||'').trim().toUpperCase();
  if(!code){ return; }
  try{
    const qs=await firebaseDb.collection('classes').where('code','==',code).limit(1).get();
    if(qs.empty){ alert('Class code not found.'); return; }
    const doc=qs.docs[0], c=doc.data();
    await doc.ref.update({studentUids:FV().arrayUnion(firebaseUser.uid), updatedAt:FV().serverTimestamp()});
    await firebaseDb.collection('users').doc(firebaseUser.uid).update({classId:doc.id, className:c.name, updatedAt:FV().serverTimestamp()});
    currentUserProfile={...currentUserProfile, classId:doc.id, className:c.name};
    syncProgressToCloud();
    renderPractice();
  }catch(e){ alert('Could not join class: '+(e.message||e)); }
}
async function studentLeaveClass(){
  if(!firebaseUser||!currentUserProfile||!currentUserProfile.classId) return;
  if(!confirm('Leave this class?')) return;
  try{
    await firebaseDb.collection('classes').doc(currentUserProfile.classId).update({studentUids:FV().arrayRemove(firebaseUser.uid), updatedAt:FV().serverTimestamp()});
    await firebaseDb.collection('users').doc(firebaseUser.uid).update({classId:FV().delete(), className:FV().delete(), updatedAt:FV().serverTimestamp()});
    const p={...currentUserProfile}; delete p.classId; delete p.className; currentUserProfile=p;
    renderPractice();
  }catch(e){ alert('Could not leave class: '+(e.message||e)); }
}

/* ---------------- Dashboard data ---------------- */
async function loadAdminData(force){
  if(!firebaseDb||!firebaseUser||!isStaffRole()) return;
  if(adminState.loading) return;
  adminState.loading=true; renderAdmin();
  try{
    let cq=firebaseDb.collection('classes');
    if(!isAdminRole()) cq=cq.where('teacherId','==',firebaseUser.uid);
    const [cs,us]=await Promise.all([cq.get(), firebaseDb.collection('users').get()]);
    adminState.classes=cs.docs.map(d=>({...d.data(), id:d.id}));
    adminState.users=us.docs.map(d=>({...d.data(), uid:d.id}));
    adminState.error='';
  }catch(e){ adminState.error='Could not load data: '+(e.message||e); }
  adminState.loading=false; renderAdmin();
}
async function loadStudentProgress(uid){
  if(adminState.userProgressMap[uid]) return adminState.userProgressMap[uid];
  try{
    const s=await firebaseDb.collection('users').doc(uid).collection('appData').doc('progress').get();
    adminState.userProgressMap[uid]= s.exists ? (s.data().store||{}) : {};
  }catch(e){ adminState.userProgressMap[uid]={}; }
  return adminState.userProgressMap[uid];
}
function students(){ return adminState.users.filter(u=>u.role==='student'); }
function teachers(){ return adminState.users.filter(u=>u.role==='teacher'||u.role==='admin'); }
function classById(id){ return adminState.classes.find(c=>c.id===id); }
function fmtDate(t){ try{ const d=t&&t.toDate?t.toDate():new Date(t); return isNaN(d)?'—':d.toLocaleDateString(); }catch(e){ return '—'; } }

/* Compute detailed stats from a progress store */
function computeStoreStats(st){
  let att=0,corr=0,sum=0; const mod={}, topic={};
  ALL.forEach(q=>{
    const a=st[q.id]; if(!a||a.faq) return;
    const f=scoreFrac(q,a); if(f==null) return;
    att++; sum+=f; if(f>=0.5) corr++;
    topicModuleKeys(q.topics.join(';')).forEach(k=>{ const o=mod[k]=mod[k]||{n:0,s:0}; o.n++; o.s+=f; });
    q.topics.forEach(t=>{ const o=topic[t]=topic[t]||{n:0,s:0}; o.n++; o.s+=f; });
  });
  const mods=MODULE_ORDER.filter(k=>mod[k]).map(k=>({key:k,name:MODULE_NAMES[k]||k,n:mod[k].n,pct:Math.round(mod[k].s/mod[k].n*100)}));
  const weakTopics=Object.entries(topic).filter(([,o])=>o.n>=1).map(([t,o])=>({t,n:o.n,pct:Math.round(o.s/o.n*100)})).sort((a,b)=>a.pct-b.pct).slice(0,5);
  const rec=ALL.filter(q=>st[q.id]&&!st[q.id].faq).map(q=>({q,a:st[q.id]})).sort((x,y)=>String(y.a.date||'').localeCompare(String(x.a.date||''))).slice(0,10);
  return {att,corr,acc:att?Math.round(sum/att*100):null,mods,weakTopics,rec};
}
function userSummary(u){
  const s=u.stats||{};
  return {att:s.att||0, acc:(s.acc==null?null:s.acc), gap:s.gap||0, shaky:s.shaky||0};
}
function accCell(v){ return v==null?'—':v+'%'; }

/* ---------------- Dashboard shell ---------------- */
function setAdminTab(t){ adminTab=t; renderAdmin(); }
function renderAdmin(){
  const root=document.getElementById('admin-root'); if(!root) return;
  if(!firebaseUser){ root.innerHTML=`<div class="empty">Please <a href="#" onclick="openAuthModal('teacher');return false">sign in as a teacher</a> to open the dashboard.</div>`; return; }
  if(!isStaffRole()){ root.innerHTML=`<div class="empty">This area is for teachers and admins. <a href="#" onclick="openAuthModal('teacher');return false">Register as a teacher</a> with your school access key.</div>`; return; }
  if(!adminState.classes.length && !adminState.users.length && !adminState.loading && !adminState.error){ loadAdminData(); }
  const tabs=[['overview','Overview'],['classes','Classes'],['students','Students'],['reports','Reports']];
  if(isAdminRole()) tabs.push(['staff','Teachers']);
  root.innerHTML=`<div class="drill-card"><div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px"><h2 style="font-family:Fraunces,serif;margin:0">${isAdminRole()?'Admin Dashboard':'Teacher Portal'}</h2><span><span class="admin-badge ${esc(userRole())}">${esc(userRole().toUpperCase())}</span> <button class="btn btn-ghost btn-sm" onclick="adminState.userProgressMap={};loadAdminData(true)">Refresh</button></span></div>
  <div class="admin-nav" id="admin-tabs-bar">${tabs.map(([k,l])=>`<button class="admin-tab ${adminTab===k?'active':''}" onclick="setAdminTab('${k}')">${l}</button>`).join('')}</div>
  ${adminState.error?`<div class="note" style="color:var(--red)">${esc(adminState.error)}</div>`:''}
  ${adminState.loading?'<p class="loading">Loading…</p>':'<div id="admin-body"></div>'}</div>`;
  if(adminState.loading) return;
  const body=document.getElementById('admin-body');
  body.innerHTML = ({overview:adminOverviewHtml,classes:adminClassesHtml,students:adminStudentsHtml,reports:adminReportsHtml,staff:adminStaffHtml}[adminTab]||adminOverviewHtml)();
}

function adminOverviewHtml(){
  const st=students(); const act=st.filter(u=>userSummary(u).att>0);
  const accs=act.map(u=>userSummary(u).acc).filter(v=>v!=null);
  const avg=accs.length?Math.round(accs.reduce((a,b)=>a+b,0)/accs.length):null;
  const unassigned=st.filter(u=>!u.classId).length;
  return `<div class="kpi-grid"><div class="kpi-card"><b>${st.length}</b><span>Students</span></div><div class="kpi-card"><b>${adminState.classes.length}</b><span>Classes</span></div><div class="kpi-card"><b>${act.length}</b><span>Active (≥1 attempt)</span></div><div class="kpi-card"><b>${accCell(avg)}</b><span>Average accuracy</span></div><div class="kpi-card"><b>${unassigned}</b><span>Unassigned students</span></div></div>
  <div class="section-title">Class performance</div>${classTableHtml()}`;
}
function classTableHtml(){
  if(!adminState.classes.length) return '<p style="color:var(--muted)">No classes yet. Create one in the Classes tab.</p>';
  return `<div class="tablewrap"><table class="admin-table"><thead><tr><th>Class</th><th>Students</th><th>Active</th><th>Avg accuracy</th></tr></thead><tbody>${adminState.classes.map(c=>{ const m=classMembers(c); const a=m.map(u=>userSummary(u)).filter(s=>s.att>0); const avg=a.length?Math.round(a.reduce((x,s)=>x+s.acc,0)/a.length):null; return `<tr><td>${esc(c.name)}</td><td>${m.length}</td><td>${a.length}</td><td>${accCell(avg)}</td></tr>`; }).join('')}</tbody></table></div>`;
}
function classMembers(c){ const ids=new Set(c.studentUids||[]); return adminState.users.filter(u=>ids.has(u.uid)); }

/* ---------------- Classes tab ---------------- */
function genClassCode(){ const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s=''; for(let i=0;i<6;i++) s+=c[Math.floor(Math.random()*c.length)]; return s; }
function adminClassesHtml(){
  const tOpts = isAdminRole()? `<select id="new-class-teacher" class="admin-select" style="max-width:220px">${teachers().map(t=>`<option value="${esc(t.uid)}" ${t.uid===firebaseUser.uid?'selected':''}>${esc(t.displayName||t.email)}</option>`).join('')}</select>`:'';
  return `<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center"><input id="new-class-name" class="admin-input" style="max-width:240px" placeholder="New class name (e.g. 6A ICT)" maxlength="100">${tOpts}<button class="btn btn-primary" onclick="createClass()">Create class</button></div>
  <div class="class-grid">${adminState.classes.map(c=>{ const m=classMembers(c); return `<div class="class-card"><div><div style="font-weight:800;font-size:17px">${esc(c.name)}</div><div class="mini-note">Teacher: ${esc(c.teacherName||'')}</div><div style="margin-top:8px">Join code <span class="class-code-pill">${esc(c.code)}</span></div><div class="mini-note" style="margin-top:6px">${m.length} student(s)</div></div>
  <div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn btn-navy btn-sm" onclick="openAssignModal('${esc(c.id)}')">Manage students</button><button class="btn btn-ghost btn-sm" onclick="openClassReport('${esc(c.id)}')">Report</button><button class="btn btn-danger btn-sm" onclick="deleteClass('${esc(c.id)}')">Delete</button></div></div>`; }).join('')||'<p style="color:var(--muted)">No classes yet.</p>'}</div>`;
}
async function createClass(){
  const name=((document.getElementById('new-class-name')||{}).value||'').trim();
  if(!name){ alert('Enter a class name.'); return; }
  let t={uid:firebaseUser.uid, email:firebaseUser.email, displayName:currentUserProfile.displayName};
  const sel=document.getElementById('new-class-teacher');
  if(sel){ const f=teachers().find(x=>x.uid===sel.value); if(f) t=f; }
  const ref=firebaseDb.collection('classes').doc();
  try{
    await ref.set({id:ref.id,name,code:genClassCode(),teacherId:t.uid,teacherEmail:t.email||firebaseUser.email,teacherName:t.displayName||'Teacher',studentUids:[],createdAt:FV().serverTimestamp(),updatedAt:FV().serverTimestamp()});
    await loadAdminData(true);
  }catch(e){ alert('Could not create class: '+(e.message||e)); }
}
async function deleteClass(id){
  const c=classById(id); if(!c||!confirm('Delete class "'+c.name+'"? Students are kept but unassigned.')) return;
  try{
    const b=firebaseDb.batch();
    (c.studentUids||[]).forEach(uid=>b.update(firebaseDb.collection('users').doc(uid),{classId:FV().delete(),className:FV().delete(),updatedAt:FV().serverTimestamp()}));
    b.delete(firebaseDb.collection('classes').doc(id));
    await b.commit(); await loadAdminData(true);
  }catch(e){ alert('Could not delete class: '+(e.message||e)); }
}
function openAssignModal(id){
  const c=classById(id); if(!c) return;
  const inSet=new Set(c.studentUids||[]);
  openModal(`<h3 style="margin:0 0 6px">Manage students — ${esc(c.name)}</h3><p class="mini-note">Tick the students who belong to this class. Students already in another class will be moved.</p>
  <input class="admin-input" placeholder="Filter by name or email" oninput="filterAssignList(this.value)" style="margin-bottom:10px">
  <div id="assign-list" style="max-height:46vh;overflow:auto;border:1px solid var(--line);border-radius:12px;padding:8px">${students().map(u=>`<label class="assign-row" data-s="${esc((u.displayName+' '+u.email).toLowerCase())}" style="display:flex;gap:10px;align-items:center;padding:6px 4px"><input type="checkbox" value="${esc(u.uid)}" ${inSet.has(u.uid)?'checked':''}><span>${esc(u.displayName||'')} <span class="mini-note">${esc(u.email||'')}${u.className&&u.classId!==id?' · in '+esc(u.className):''}</span></span></label>`).join('')||'<p class="mini-note">No students have registered yet.</p>'}</div>
  <div style="display:flex;gap:10px;margin-top:14px"><button class="btn btn-primary" onclick="saveAssign('${esc(id)}')">Save</button><button class="btn btn-ghost" onclick="closeModal()">Cancel</button></div>`);
}
function filterAssignList(v){ v=v.toLowerCase(); document.querySelectorAll('.assign-row').forEach(r=>r.style.display=r.dataset.s.includes(v)?'flex':'none'); }
async function saveAssign(id){
  const c=classById(id); if(!c) return;
  const want=new Set([...document.querySelectorAll('#assign-list input:checked')].map(i=>i.value));
  if(want.size>300){ alert('A class can hold at most 300 students.'); return; }
  const old=new Set(c.studentUids||[]);
  try{
    const b=firebaseDb.batch();
    b.update(firebaseDb.collection('classes').doc(id),{studentUids:[...want],updatedAt:FV().serverTimestamp()});
    old.forEach(uid=>{ if(!want.has(uid)) b.update(firebaseDb.collection('users').doc(uid),{classId:FV().delete(),className:FV().delete(),updatedAt:FV().serverTimestamp()}); });
    want.forEach(uid=>{
      if(old.has(uid)) return;
      const u=adminState.users.find(x=>x.uid===uid);
      if(u&&u.classId&&u.classId!==id&&classById(u.classId)) b.update(firebaseDb.collection('classes').doc(u.classId),{studentUids:FV().arrayRemove(uid),updatedAt:FV().serverTimestamp()});
      b.update(firebaseDb.collection('users').doc(uid),{classId:id,className:c.name,updatedAt:FV().serverTimestamp()});
    });
    await b.commit(); closeModal(); await loadAdminData(true);
  }catch(e){ alert('Could not save: '+(e.message||e)); }
}

/* ---------------- Students tab ---------------- */
function adminStudentsHtml(){
  const term=adminStudentSearch.toLowerCase();
  const list=students().filter(u=>(adminFilterClass==='all'||(adminFilterClass==='none'?!u.classId:u.classId===adminFilterClass))&&(!term||((u.displayName||'')+' '+(u.email||'')).toLowerCase().includes(term)));
  return `<div style="display:flex;gap:10px;flex-wrap:wrap"><input class="admin-input" style="max-width:260px" placeholder="Search students" value="${esc(adminStudentSearch)}" onchange="adminStudentSearch=this.value;renderAdmin()"><select class="admin-select" style="max-width:220px" onchange="adminFilterClass=this.value;renderAdmin()"><option value="all">All classes</option><option value="none" ${adminFilterClass==='none'?'selected':''}>Unassigned</option>${adminState.classes.map(c=>`<option value="${esc(c.id)}" ${adminFilterClass===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select></div>
  <div class="tablewrap"><table class="admin-table"><thead><tr><th>Student</th><th>Class</th><th>Attempted</th><th>Accuracy</th><th>Gap / Shaky</th><th>Last active</th><th></th></tr></thead><tbody>${list.map(u=>{ const s=userSummary(u); return `<tr><td>${esc(u.displayName||'')}<br><span class="mini-note">${esc(u.email||'')}</span></td><td><select class="admin-select" style="min-width:130px" onchange="assignStudent('${esc(u.uid)}',this.value)"><option value="">— none —</option>${adminState.classes.map(c=>`<option value="${esc(c.id)}" ${u.classId===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select></td><td>${s.att}</td><td>${accCell(s.acc)}</td><td>${s.gap} / ${s.shaky}</td><td>${fmtDate(u.lastActive)}</td><td><button class="btn btn-primary btn-sm" onclick="openStudentReport('${esc(u.uid)}')">Report</button></td></tr>`; }).join('')||'<tr><td colspan="7" style="color:var(--muted)">No students found.</td></tr>'}</tbody></table></div>`;
}
async function assignStudent(uid, classId){
  const u=adminState.users.find(x=>x.uid===uid); if(!u) return;
  try{
    const b=firebaseDb.batch();
    if(u.classId&&classById(u.classId)) b.update(firebaseDb.collection('classes').doc(u.classId),{studentUids:FV().arrayRemove(uid),updatedAt:FV().serverTimestamp()});
    if(classId){ const c=classById(classId); b.update(firebaseDb.collection('classes').doc(classId),{studentUids:FV().arrayUnion(uid),updatedAt:FV().serverTimestamp()}); b.update(firebaseDb.collection('users').doc(uid),{classId,className:c.name,updatedAt:FV().serverTimestamp()}); }
    else b.update(firebaseDb.collection('users').doc(uid),{classId:FV().delete(),className:FV().delete(),updatedAt:FV().serverTimestamp()});
    await b.commit(); await loadAdminData(true);
  }catch(e){ alert('Could not assign: '+(e.message||e)); renderAdmin(); }
}

/* ---------------- Teachers tab (admin only) ---------------- */
function adminStaffHtml(){
  return `<p class="mini-note">Promote or demote accounts. Admin rights can only be granted by an existing admin.</p><div class="tablewrap"><table class="admin-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead><tbody>${adminState.users.map(u=>`<tr><td>${esc(u.displayName||'')}</td><td>${esc(u.email||'')}</td><td><select class="admin-select" style="max-width:150px" ${u.uid===firebaseUser.uid?'disabled':''} onchange="setUserRole('${esc(u.uid)}',this.value)">${['student','teacher','admin'].map(r=>`<option ${u.role===r?'selected':''}>${r}</option>`).join('')}</select></td></tr>`).join('')}</tbody></table></div>`;
}
async function setUserRole(uid, role){
  try{ await firebaseDb.collection('users').doc(uid).update({role,updatedAt:FV().serverTimestamp()}); await loadAdminData(true); }
  catch(e){ alert('Could not change role: '+(e.message||e)); }
}


/* ---------------- Per-question attempt history ---------------- */
function attemptList(q,a){
  let h=Array.isArray(a.history)?a.history.map(x=>({...x})):[];
  if(!h.length) h=[{date:a.date,answer:a.answer,answers:a.answers,correct:a.correct,score:a.score,maxScore:q.marks,confidence:a.confidence}];
  const last=h[h.length-1];
  if(last.answer==null&&last.answers==null){ if(a.answer!=null) last.answer=a.answer; if(a.answers) last.answers=a.answers; }
  if(last.score==null&&q.type==='structured'&&a.score!=null) last.score=a.score;
  return h;
}
function attemptAnswerText(q,x){
  if(q.type==='structured'){
    if(!x.answers) return '—';
    return Object.entries(x.answers).map(([k,v])=>'('+k+') '+(String(v).trim()||'(blank)')).join('\n');
  }
  return x.answer!=null?x.answer:'—';
}
function attemptScoreText(q,x){
  const max=x.maxScore!=null?x.maxScore:q.marks;
  if(q.type==='structured'){ let t=(x.score!=null?x.score:0)+' / '+max; if(x.aiScore!=null) t+=' (AI '+x.aiScore+')'; return t; }
  const sc=x.score!=null?x.score:(x.correct?max:0);
  return sc+' / '+max+(x.correct?' ✓':' ✕');
}
function questionAttempts(st){
  return ALL.filter(q=>st[q.id]&&!st[q.id].faq).map(q=>{
    const a=st[q.id], h=attemptList(q,a);
    return {q,a,h,total:Math.max(typeof a.attempts==='number'?a.attempts:0,h.length)};
  }).sort((x,y)=>String(y.a.date||'').localeCompare(String(x.a.date||'')));
}
function attemptHistoryHtml(st){
  const rows=questionAttempts(st);
  if(!rows.length) return '<p class="mini-note">No attempts yet.</p>';
  const answerCell=t=>`<div style="white-space:pre-wrap;max-width:360px">${esc(t)}</div>`;
  return rows.map(({q,a,h,total})=>`<details style="border:1px solid var(--line);border-radius:12px;padding:8px 12px;margin-bottom:8px"><summary style="cursor:pointer;font-weight:700">${qLabel(q)} <span class="mini-note">· attempted ${total} time${total!==1?'s':''}${total>h.length?' (latest '+h.length+' shown)':''} · latest ${attemptScoreText(q,h[h.length-1])}</span></summary>
  <table class="admin-table"><thead><tr><th>#</th><th>Date</th><th>Answer given</th><th>Score</th><th>Confidence</th></tr></thead><tbody>${h.map((x,i)=>`<tr><td>${total-h.length+i+1}</td><td>${x.date?new Date(x.date).toLocaleString():'—'}</td><td>${answerCell(attemptAnswerText(q,x))}</td><td>${esc(attemptScoreText(q,x))}</td><td>${esc(x.confidence||'—')}</td></tr>`).join('')}</tbody></table></details>`).join('');
}
function downloadAttemptsCsv(uid){
  const u=adminState.users.find(x=>x.uid===uid); const st=adminState.userProgressMap[uid]||{};
  const rows=[['Question','Attempt #','Date','Answer','Score','Max','Confidence']];
  questionAttempts(st).forEach(({q,h,total})=>h.forEach((x,i)=>rows.push([q.id,total-h.length+i+1,x.date||'',attemptAnswerText(q,x),x.score!=null?x.score:(x.correct?q.marks:0),x.maxScore!=null?x.maxScore:q.marks,x.confidence||''])));
  const csv=rows.map(r=>r.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\n');
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download=((u&&u.displayName)||'student')+'-attempts.csv'; a.click();
}

/* ---------------- Reports ---------------- */
function adminReportsHtml(){
  return `<p class="mini-note">Pick a class for a class-wide report, or a student for an individual practice report. Reports can be printed or saved as PDF/CSV.</p>
  <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center"><select id="rep-class" class="admin-select" style="max-width:240px"><option value="">Select class…</option>${adminState.classes.map(c=>`<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select><button class="btn btn-primary" onclick="openClassReport(document.getElementById('rep-class').value)">Class report</button></div>
  <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:10px"><select id="rep-student" class="admin-select" style="max-width:240px"><option value="">Select student…</option>${students().map(u=>`<option value="${esc(u.uid)}">${esc(u.displayName||u.email)}</option>`).join('')}</select><button class="btn btn-primary" onclick="openStudentReport(document.getElementById('rep-student').value)">Student report</button></div>`;
}
function modBars(mods){
  if(!mods.length) return '<p class="mini-note">No attempts yet.</p>';
  return mods.map(d=>`<div><div class="topic-row"><span>${esc(d.key)} — ${esc(d.name)}</span><strong>${d.pct}% (${d.n})</strong></div><div class="progress"><i style="width:${d.pct}%"></i></div></div>`).join('');
}
async function openStudentReport(uid){
  if(!uid) return;
  const u=adminState.users.find(x=>x.uid===uid); if(!u) return;
  openModal('<p class="loading">Building report…</p>');
  const st=await loadStudentProgress(uid); const r=computeStoreStats(st);
  const queue=ALL.filter(q=>st[q.id]&&['Shaky','Gap'].includes(st[q.id].rating)).length;
  openModal(`<div class="report-sheet" style="margin:0;border:none;padding:0"><div class="report-header"><div><h2 class="report-title">Student practice report</h2><div class="report-meta">${esc(u.displayName||'')} · ${esc(u.email||'')}<br>Class: ${esc(u.className||'Unassigned')} · Generated ${new Date().toLocaleDateString()} by ${esc(currentUserProfile.displayName||'')}</div></div><button class="btn btn-navy no-print" onclick="window.print()">Print / PDF</button></div>
  <div class="kpi-grid"><div class="kpi-card"><b>${r.att}</b><span>Attempted</span></div><div class="kpi-card"><b>${accCell(r.acc)}</b><span>Average score</span></div><div class="kpi-card"><b>${queue}</b><span>Re-drill queue</span></div><div class="kpi-card"><b>${fmtDate(u.lastActive)}</b><span>Last active</span></div></div>
  <div class="report-section"><div class="report-section-title">Mastery by module</div>${modBars(r.mods)}</div>
  <div class="report-section"><div class="report-section-title">Weakest topics</div>${r.weakTopics.length?`<table class="admin-table"><tbody>${r.weakTopics.map(w=>`<tr><td>${esc(shortTopic(w.t))}</td><td>${w.pct}%</td><td>${w.n} attempt(s)</td></tr>`).join('')}</tbody></table>`:'<p class="mini-note">No data.</p>'}</div>
  <div class="report-section"><div class="report-section-title">Attempt history by question <button class="btn btn-ghost btn-sm no-print" style="margin-left:8px" onclick="downloadAttemptsCsv('${esc(uid)}')">CSV</button></div><p class="mini-note no-print">Click a question to see every attempt: answer, score and confidence.</p>${attemptHistoryHtml(st)}</div>
  <div class="report-section"><div class="report-section-title">Recent attempts</div>${r.rec.length?`<table class="admin-table"><thead><tr><th>Question</th><th>Result</th><th>Confidence</th><th>Date</th></tr></thead><tbody>${r.rec.map(({q,a})=>`<tr><td>${qLabel(q)}</td><td>${q.type==='structured'?(a.score||0)+' / '+q.marks:(a.correct?'Correct':'Incorrect')}${a.rating?' · '+esc(a.rating):''}</td><td>${esc(a.confidence||'—')}</td><td>${fmtDate(a.date)}</td></tr>`).join('')}</tbody></table>`:'<p class="mini-note">No attempts yet.</p>'}</div></div>`);
}
async function openClassReport(id){
  const c=classById(id); if(!c){ alert('Select a class first.'); return; }
  openModal('<p class="loading">Building report…</p>');
  const m=classMembers(c);
  const data=await Promise.all(m.map(async u=>({u, r:computeStoreStats(await loadStudentProgress(u.uid))})));
  const act=data.filter(d=>d.r.att>0);
  const avg=act.length?Math.round(act.reduce((a,d)=>a+d.r.acc,0)/act.length):null;
  const agg={}; act.forEach(d=>d.r.mods.forEach(x=>{ const o=agg[x.key]=agg[x.key]||{key:x.key,name:x.name,n:0,s:0}; o.n+=x.n; o.s+=x.pct*x.n; }));
  const mods=MODULE_ORDER.filter(k=>agg[k]).map(k=>({key:k,name:agg[k].name,n:agg[k].n,pct:Math.round(agg[k].s/agg[k].n)}));
  window._classReportRows=data.map(d=>[d.u.displayName||'',d.u.email||'',d.r.att,d.r.acc==null?'':d.r.acc]);
  window._classReportName=c.name;
  openModal(`<div class="report-sheet" style="margin:0;border:none;padding:0"><div class="report-header"><div><h2 class="report-title">Class report — ${esc(c.name)}</h2><div class="report-meta">Teacher: ${esc(c.teacherName||'')} · ${m.length} student(s) · Generated ${new Date().toLocaleDateString()}</div></div><div class="no-print" style="display:flex;gap:8px"><button class="btn btn-navy" onclick="window.print()">Print / PDF</button><button class="btn btn-ghost" onclick="downloadClassCsv()">CSV</button></div></div>
  <div class="kpi-grid"><div class="kpi-card"><b>${m.length}</b><span>Students</span></div><div class="kpi-card"><b>${act.length}</b><span>Active</span></div><div class="kpi-card"><b>${accCell(avg)}</b><span>Class average</span></div></div>
  <div class="report-section"><div class="report-section-title">Class mastery by module</div>${modBars(mods)}</div>
  <div class="report-section"><div class="report-section-title">Students</div><table class="admin-table"><thead><tr><th>Student</th><th>Attempted</th><th>Average</th><th>Weakest module</th></tr></thead><tbody>${data.map(d=>{ const w=[...d.r.mods].sort((a,b)=>a.pct-b.pct)[0]; return `<tr><td>${esc(d.u.displayName||'')}</td><td>${d.r.att}</td><td>${accCell(d.r.acc)}</td><td>${w?esc(w.key)+' ('+w.pct+'%)':'—'}</td></tr>`; }).join('')||'<tr><td colspan="4">No students in this class.</td></tr>'}</tbody></table></div></div>`);
}
function downloadClassCsv(){
  const rows=[['Name','Email','Attempted','Average %'],...(window._classReportRows||[])];
  const csv=rows.map(r=>r.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\n');
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download=(window._classReportName||'class')+'-report.csv'; a.click();
}
document.addEventListener('DOMContentLoaded',updateNavAdminRole);
