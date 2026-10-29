/* Teacher / Admin dashboard, role-aware sign-in and class membership.
   Depends on globals from index.html: firebase*, currentUserProfile, store, ALL, esc, scoreFrac, ... */
const FV = () => firebase.firestore.FieldValue;
function userRole(){ return (currentUserProfile && currentUserProfile.role) || 'student'; }
function isStaffRole(){ return ['teacher','admin'].includes(userRole()); }
function isAdminRole(){ return userRole()==='admin'; }

function updateNavAdminRole(){
  const nav=document.getElementById('nav-admin');
  if(nav){
    nav.style.display = '';
    nav.innerHTML = `<span>👨‍🏫 ${isAdminRole() ? 'Admin Dashboard' : 'Teacher Portal'}</span>`;
  }
  const a=document.getElementById('nav-auth');
  if(a){
    a.disabled = false;
    const name = firebaseUser ? (currentUserProfile?.displayName ? currentUserProfile.displayName.split(' ')[0] : 'Account') : 'Sign in / Register';
    a.innerHTML = `<span>👤 ${esc(name)}</span>`;
  }
  if(firebaseUser){ loadStudentAssignments(); }
  else {
    const badge = document.getElementById('nav-assign-count');
    if(badge) badge.textContent = '';
  }
  if(typeof updateMobileNavCurrentLabel==='function') updateMobileNavCurrentLabel();
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
  if(!force && adminState.users.length && adminState.classes.length && adminState.assignments.length){
    renderAdmin();
    return;
  }
  adminState.loading=true; renderAdmin();
  try{
    let cq=firebaseDb.collection('classes');
    let aq=firebaseDb.collection('assignments');
    if(!isAdminRole()){
      cq=cq.where('teacherId','==',firebaseUser.uid);
      aq=aq.where('teacherId','==',firebaseUser.uid);
    }
    const [cs,us,as]=await Promise.all([cq.get(), firebaseDb.collection('users').get(), aq.get()]);
    adminState.classes=cs.docs.map(d=>({...d.data(), id:d.id}));
    adminState.users=us.docs.map(d=>({...d.data(), uid:d.id}));
    adminState.assignments=as.docs.map(d=>({...d.data(), id:d.id}));
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
  const tabs=[['overview','Overview'],['classes','Classes'],['students','Students'],['assignments','Assignments'],['reports','Reports']];
  if(isAdminRole()) tabs.push(['staff','Teachers']);
  root.innerHTML=`<div class="drill-card"><div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px"><h2 style="font-family:Fraunces,serif;margin:0">${isAdminRole()?'Admin Dashboard':'Teacher Portal'}</h2><span><span class="admin-badge ${esc(userRole())}">${esc(userRole().toUpperCase())}</span> <button class="btn btn-ghost btn-sm" onclick="adminState.userProgressMap={};loadAdminData(true)">Refresh</button></span></div>
  <div class="admin-nav" id="admin-tabs-bar">${tabs.map(([k,l])=>`<button class="admin-tab ${adminTab===k?'active':''}" onclick="setAdminTab('${k}')">${l}</button>`).join('')}</div>
  ${adminState.error?`<div class="note" style="color:var(--red)">${esc(adminState.error)}</div>`:''}
  ${adminState.loading?'<p class="loading">Loading…</p>':'<div id="admin-body"></div>'}</div>`;
  if(adminState.loading) return;
  const body=document.getElementById('admin-body');
  body.innerHTML = ({overview:adminOverviewHtml,classes:adminClassesHtml,students:adminStudentsHtml,assignments:adminAssignmentsHtml,reports:adminReportsHtml,staff:adminStaffHtml}[adminTab]||adminOverviewHtml)();
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

/* ---------------- Assignments tab (Teacher / Admin) ---------------- */
function adminAssignmentsHtml(){
  const asList = adminState.assignments || [];
  return `
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:14px">
      <p class="mini-note" style="margin:0">Create assignments for classes or specific students. Student attempts and grades are recorded separately from casual practice.</p>
      <button class="btn btn-primary" onclick="openCreateAssignmentModal()">+ Create Assignment</button>
    </div>
    <div class="kpi-grid">
      <div class="kpi-card"><b>${asList.length}</b><span>Total Assignments</span></div>
      <div class="kpi-card"><b>${asList.reduce((s,a)=>(s+(a.questionIds||[]).length),0)}</b><span>Questions Assigned</span></div>
      <div class="kpi-card"><b>${adminState.classes.length}</b><span>Classes</span></div>
    </div>
    <div class="tablewrap">
      <table class="admin-table">
        <thead>
          <tr>
            <th>Assignment Title</th>
            <th>Target</th>
            <th>Questions</th>
            <th>Total Marks</th>
            <th>Due Date</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${asList.map(a => {
            const cNames = (a.classIds||[]).map(cid => (classById(cid)||{}).name || cid).filter(Boolean);
            const targetText = cNames.length ? cNames.join(', ') : ((a.studentUids||[]).length + ' students');
            const qCount = (a.questionIds||[]).length;
            const marksTotal = (a.questionIds||[]).map(qid => (ALL.find(x=>x.id===qid)||{}).marks || 0).reduce((x,y)=>x+y, 0);
            return `
              <tr>
                <td><b>${esc(a.title)}</b>${a.description ? `<br><span class="mini-note">${esc(a.description)}</span>` : ''}</td>
                <td><span class="pill none">${esc(targetText||'All')}</span></td>
                <td>${qCount}</td>
                <td>${marksTotal}</td>
                <td>${a.dueDate ? esc(a.dueDate) : '<span style="color:var(--muted)">No due date</span>'}</td>
                <td>
                  <div style="display:flex;gap:6px;flex-wrap:wrap">
                    <button class="btn btn-ghost btn-sm" onclick="openAssignmentQuestionsPreviewModal('${esc(a.id)}')">View Questions</button>
                    <button class="btn btn-navy btn-sm" onclick="openAssignmentSubmissionsModal('${esc(a.id)}')">Submissions &amp; Gradebook</button>
                    <button class="btn btn-danger btn-sm" onclick="deleteAssignment('${esc(a.id)}')">Delete</button>
                  </div>
                </td>
              </tr>
            `;
          }).join('') || '<tr><td colspan="6" style="color:var(--muted)">No assignments created yet. Click "+ Create Assignment" to get started.</td></tr>'}
        </tbody>
      </table>
    </div>
  `;
}

window._assignSelectedQIds = [];
window._assignSearchTerm = '';
window._assignModuleFilter = 'All';
window._assignPreviewOpenIds = new Set();
let _assignSearchTimer = null;

function openCreateAssignmentModal(){
  window._assignSelectedQIds = [];
  window._assignSearchTerm = '';
  window._assignModuleFilter = 'All';
  window._assignPreviewOpenIds = new Set();

  openModal(`
    <div style="max-width:840px;width:100%">
      <div style="border-bottom:2px solid var(--line);padding-bottom:10px;margin-bottom:14px">
        <h2 style="font-family:Fraunces,serif;margin:0 0 4px;font-size:24px">Create New Assignment</h2>
        <span class="mini-note">Assign questions to an entire class or selected students. Preview full questions and official marking schemes before distributing.</span>
      </div>

      <div class="form-grid-2col" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
        <div>
          <label style="font-weight:700;font-size:13.5px">Assignment Title *</label>
          <input id="new-assign-title" class="admin-input" placeholder="e.g. Paper 1A Practice Quiz 1" maxlength="120" style="margin-top:4px">
        </div>
        <div>
          <label style="font-weight:700;font-size:13.5px">Due Date (Optional)</label>
          <input id="new-assign-duedate" class="admin-input" type="date" style="margin-top:4px">
        </div>
      </div>

      <div style="margin-bottom:14px">
        <label style="font-weight:700;font-size:13.5px">Instructions / Description (Optional)</label>
        <textarea id="new-assign-desc" class="admin-input" placeholder="e.g. Complete before next Tuesday's lesson. No calculators allowed." rows="2" maxlength="1000" style="margin-top:4px;resize:vertical"></textarea>
      </div>

      <div style="margin-bottom:14px">
        <label style="font-weight:700;font-size:13.5px">Assign To Classes</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px" id="new-assign-classes">
          ${adminState.classes.map(c => `
            <label style="display:inline-flex;align-items:center;gap:6px;background:var(--surface2);padding:6px 12px;border-radius:999px;font-weight:700;font-size:13.5px;cursor:pointer">
              <input type="checkbox" class="target-class-chk" value="${esc(c.id)}" checked style="accent-color:var(--teal)">
              <span>${esc(c.name)}</span>
            </label>
          `).join('') || '<span class="mini-note">No classes available. Create a class first or assign by student.</span>'}
        </div>
      </div>

      <div style="border-top:1px solid var(--line);padding-top:14px;margin-top:14px">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px">
          <label style="font-weight:800;font-size:13.5px;text-transform:uppercase;letter-spacing:0.05em;color:var(--teal)">Select Questions &amp; Preview</label>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <span id="assign-selected-summary" class="mini-note">Selected: <b>0</b> question(s) • <b>0</b> total marks</span>
            <button type="button" class="btn btn-ghost btn-sm" onclick="previewAllSelectedAssignQuestions()" style="font-size:12px;padding:3px 9px">👁️ Preview All Selected</button>
          </div>
        </div>

        <div style="background:var(--teal-light);border:1px solid var(--teal);padding:8px 12px;border-radius:8px;margin-bottom:10px;font-size:12.5px;color:var(--navy);display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <span>💡 <b>Teacher Guide:</b> Click <b>"👁️ Preview Question"</b> on any question below to inspect full text, diagrams, and marking schemes before assigning.</span>
        </div>

        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
          <input id="assign-q-search" class="admin-input" style="flex:1 1 200px" placeholder="Search questions by keyword, year, or topic…" autocomplete="off" oninput="onAssignSearchInput(this.value)">
          <select id="assign-q-module" class="admin-select" style="flex:1 1 160px;max-width:100%" onchange="onAssignModuleChange(this.value)">
            <option value="All">All modules</option>
            ${MODULE_ORDER.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('')}
          </select>
        </div>

        <div id="assign-question-list-inner" style="max-height:min(440px,50vh);overflow-y:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--line);border-radius:12px;padding:8px;background:var(--surface)"></div>
      </div>

      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:18px;gap:10px">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveNewAssignment()">Create &amp; Assign</button>
      </div>
    </div>
  `);

  updateAssignmentQuestionList();
  updateAssignmentSummaryLabel();
}

function getFilteredAssignmentPool(){
  const term = (window._assignSearchTerm || '').toLowerCase().trim();
  const modF = window._assignModuleFilter || 'All';
  return ALL.filter(q => {
    if(modF !== 'All' && !questionInModule(q, modF)) return false;
    if(term){
      if(!q._searchText) q._searchText = (blocksToText(q.stem)+' '+q.topics.join(' ')+' '+yearOf(q)+' '+paperOf(q)+' q.'+q.number).toLowerCase();
      if(!q._searchText.includes(term)) return false;
    }
    return true;
  });
}

function onAssignSearchInput(val){
  window._assignSearchTerm = val;
  clearTimeout(_assignSearchTimer);
  _assignSearchTimer = setTimeout(updateAssignmentQuestionList, 60);
}

function onAssignModuleChange(val){
  window._assignModuleFilter = val;
  updateAssignmentQuestionList();
}

function updateAssignmentQuestionList(){
  const container = document.getElementById('assign-question-list-inner');
  if(!container) return;
  const pool = getFilteredAssignmentPool();
  if(!pool.length){
    container.innerHTML = '<div style="padding:18px;text-align:center;color:var(--muted);font-size:14px">No questions match your filter. Try another keyword or module.</div>';
    return;
  }
  window._assignPreviewOpenIds = window._assignPreviewOpenIds || new Set();

  container.innerHTML = pool.slice(0, 80).map(q => {
    const isSel = window._assignSelectedQIds.includes(q.id);
    const isPrev = window._assignPreviewOpenIds.has(q.id);
    const textSnippet = (q.stem.find(b=>b.type==='text')||q.stem[0]||{}).text || ('Question '+q.number);
    return `
      <div id="assign-q-row-${esc(q.id)}" style="border:1.5px solid ${isSel?'var(--teal)':'var(--line)'};padding:12px;background:${isSel?'var(--teal-light)':'var(--surface)'};border-radius:10px;margin-bottom:8px;transition:all .15s">
        <div style="display:flex;align-items:flex-start;gap:12px">
          <input type="checkbox" id="assign-chk-${esc(q.id)}" ${isSel?'checked':''} onchange="toggleAssignQ('${esc(q.id)}')" style="margin-top:3px;accent-color:var(--teal);cursor:pointer;width:19px;height:19px;flex-shrink:0">
          <div style="flex:1;min-width:0">
            <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center">
              <label for="assign-chk-${esc(q.id)}" style="cursor:pointer;margin:0;display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap">
                <span style="font-weight:800;font-size:14px;color:var(--navy)">${yearOf(q)} ${paperOf(q)} Q.${esc(q.number)}</span>
                <span class="pill none" style="font-size:11px">${q.marks} mark${q.marks!==1?'s':''}</span>
                <span class="pill" style="font-size:10px;text-transform:uppercase;background:var(--surface2)">${q.type==='structured'?'Structured':'MCQ'}</span>
              </label>
              <span class="mini-note" style="color:var(--muted)">${esc(q.topics[0]||'')}</span>
            </div>
            <div style="color:var(--muted);font-size:13px;margin:5px 0 10px;line-height:1.45">${esc(textSnippet)}</div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <button type="button" class="btn btn-sm" id="btn-prev-${esc(q.id)}" style="background:${isPrev?'var(--navy)':'var(--teal)'};color:#fff;border-radius:6px;font-weight:700;padding:6px 14px;font-size:12.5px;display:inline-flex;align-items:center;gap:6px;cursor:pointer;border:none;box-shadow:0 1px 3px rgba(0,0,0,0.15)" onclick="toggleAssignPreview('${esc(q.id)}')">
                <span>${isPrev ? '✕ Close Preview' : '👁️ Preview Question'}</span>
              </button>
              <button type="button" class="btn btn-ghost btn-sm" style="font-size:12px;padding:5px 12px" onclick="toggleAssignQ('${esc(q.id)}')">
                ${isSel ? '✓ Selected in Assignment' : '＋ Select for Assignment'}
              </button>
            </div>
          </div>
        </div>
        <div id="assign-q-prev-box-${esc(q.id)}" style="display:${isPrev?'block':'none'};margin-top:14px;border-top:1.5px dashed var(--line);padding-top:14px">
          ${isPrev ? renderAssignQuestionPreview(q) : ''}
        </div>
      </div>
    `;
  }).join('') + (pool.length > 80 ? `<div style="padding:8px;text-align:center;color:var(--muted);font-size:12px">Showing first 80 of ${pool.length} matching questions. Type to filter more specifically.</div>` : '');

  if(window._assignPreviewOpenIds.size > 0 && typeof initMermaid === 'function'){
    initMermaid();
  }
}

function previewAllSelectedAssignQuestions(){
  if(!window._assignSelectedQIds || !window._assignSelectedQIds.length){
    alert('Please select at least one question first by ticking its checkbox.');
    return;
  }
  const questions = window._assignSelectedQIds.map(id => ALL.find(x => x.id === id)).filter(Boolean);
  const totalMarks = questions.reduce((s, q) => s + (q.marks || 0), 0);
  openModal(`
    <div style="max-width:860px;width:100%">
      <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid var(--line);padding-bottom:10px;margin-bottom:14px">
        <div>
          <span class="eyebrow">Assignment Preview</span>
          <h2 style="font-family:Fraunces,serif;margin:2px 0 0;font-size:22px">Selected Questions (${questions.length})</h2>
          <span class="mini-note">Total: <b>${totalMarks}</b> marks</span>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="closeModal()">✕ Back to Assignment Creator</button>
      </div>
      <div style="max-height:65vh;overflow-y:auto;-webkit-overflow-scrolling:touch;padding-right:6px">
        ${questions.map((q, idx) => `
          <div style="border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:14px;background:var(--surface)">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
              <b>Question ${idx + 1} (${yearOf(q)} ${paperOf(q)} Q.${esc(q.number)})</b>
              <span class="pill none">${q.marks} mark${q.marks!==1?'s':''}</span>
            </div>
            ${renderAssignQuestionPreview(q)}
          </div>
        `).join('')}
      </div>
      <div style="display:flex;justify-content:flex-end;margin-top:14px">
        <button class="btn btn-primary" onclick="closeModal()">Back to Assignment</button>
      </div>
    </div>
  `);
  if(typeof initMermaid === 'function') initMermaid();
}

function quickAssignQuestion(qid){
  if(!firebaseUser){
    openAuthModal('teacher');
    return;
  }
  openCreateAssignmentModal();
  window._assignSelectedQIds = [qid];
  window._assignPreviewOpenIds = new Set([qid]);
  const q = ALL.find(x => x.id === qid);
  const titleInp = document.getElementById('new-assign-title');
  if(titleInp && q){
    titleInp.value = `${yearOf(q)} ${paperOf(q)} Q.${q.number} Practice`;
  }
  updateAssignmentQuestionList();
  updateAssignmentSummaryLabel();
}

function renderAssignQuestionPreview(q){
  const isSel = window._assignSelectedQIds.includes(q.id);
  const isS = q.type === 'structured';

  let bodyHtml = `
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px">
      <span style="font-weight:800;font-size:11.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--teal)">Preview &amp; Official Marking Guide</span>
      <button type="button" class="btn ${isSel?'btn-navy':'btn-primary'} btn-sm" id="btn-assign-toggle-${esc(q.id)}" onclick="toggleAssignQ('${esc(q.id)}')">
        ${isSel ? '✓ Selected (Click to remove)' : '＋ Add to Assignment'}
      </button>
    </div>
    <div style="background:var(--surface2);border-radius:10px;padding:12px;margin-bottom:12px;font-size:13.5px;line-height:1.6">
      <div style="font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);margin-bottom:4px">Stem:</div>
      <div class="blocks">${renderBlocks(q.stem)}</div>
    </div>
  `;

  if(!isS && q.options){
    const correctAns = (q.markingScheme && q.markingScheme.answer) || '';
    bodyHtml += `
      <div style="margin-bottom:12px">
        <div style="font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);margin-bottom:6px">Options:</div>
        <div style="display:grid;gap:6px">
          ${q.options.map(o => {
            const isRight = (o.key === correctAns);
            return `
              <div style="display:flex;gap:10px;align-items:flex-start;padding:8px 12px;border-radius:8px;border:1.5px solid ${isRight?'var(--teal)':'var(--line)'};background:${isRight?'rgba(14,124,107,0.08)':'var(--surface)'}">
                <span style="font-weight:700;font-size:12.5px;width:24px;height:24px;border-radius:50%;display:inline-grid;place-items:center;background:${isRight?'var(--teal)':'var(--surface2)'};color:${isRight?'#fff':'var(--ink)'};flex-shrink:0">${esc(o.key)}</span>
                <div style="flex:1;font-size:13px">${renderBlocks(o.content)}</div>
                ${isRight ? `<span class="pill" style="background:var(--teal);color:#fff;font-size:11px;font-weight:700">✓ Official Key</span>` : ''}
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  } else if(isS && q.parts){
    bodyHtml += `
      <div style="margin-bottom:12px">
        <div style="font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);margin-bottom:6px">Structured Parts &amp; Marking Scheme:</div>
        <div style="display:grid;gap:10px">
          ${q.parts.map(p => {
            const ms = p.markingScheme || {};
            return `
              <div style="border:1px solid var(--line);background:var(--surface);border-radius:8px;padding:10px 12px">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
                  <b>Part (${esc(p.label)})</b>
                  <span class="pill none" style="font-size:11px">${p.marks} mark${p.marks!==1?'s':''}</span>
                </div>
                <div class="blocks" style="font-size:13px;margin:4px 0 8px">${renderBlocks(p.stem)}</div>
                <div style="background:rgba(14,124,107,0.06);border:1px solid rgba(14,124,107,0.25);border-radius:6px;padding:8px 10px;font-size:12.5px">
                  <div style="font-weight:700;color:var(--teal);margin-bottom:2px">Official Marking Scheme:</div>
                  ${ms.modelAnswer ? `<div style="font-family:monospace;white-space:pre-wrap;margin:4px 0 6px;padding:6px;background:#fff;border-radius:4px;border:1px solid rgba(14,124,107,0.2)"><b>Model Answer:</b> ${esc(ms.modelAnswer)}</div>` : ''}
                  ${(ms.points||[]).length ? `<ul style="margin:4px 0 4px 18px;padding:0">${ms.points.map(pt => `<li>${esc(pt.point)} <b>[${pt.marks}m]</b></li>`).join('')}</ul>` : ''}
                  ${(ms.unacceptable||[]).length ? `<div style="color:var(--red);margin-top:4px">✕ Not accepted: ${esc(ms.unacceptable.join('; '))}</div>` : ''}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  if(q.performance){
    const perf = q.performance;
    bodyHtml += `
      <div style="background:rgba(217,119,6,0.08);border:1px solid rgba(217,119,6,0.25);border-radius:8px;padding:10px 12px;font-size:12.5px;margin-bottom:10px">
        <div style="font-weight:700;color:#92400e;margin-bottom:4px">Historical HKDSE Performance:</div>
        ${perf.correctPct != null ? `<div style="margin:2px 0"><b>Candidates correct:</b> ${perf.correctPct}%</div>` : ''}
        ${perf.optionStatsPct ? `<div style="margin:2px 0"><b>Option selection breakdown:</b> ${Object.entries(perf.optionStatsPct).map(([k,v])=>`${k}: ${v}%`).join(' • ')}</div>` : ''}
        ${perf.commentary ? `<div style="margin-top:4px;color:var(--ink)"><b>Commentary:</b> ${esc(perf.commentary)}</div>` : ''}
      </div>
    `;
  }

  bodyHtml += `
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-top:8px">
      <button type="button" class="btn btn-ghost btn-sm" onclick="openQuestionExportModal('${esc(q.id)}')">⎙ Export / Print this Question</button>
      <button type="button" class="btn btn-ghost btn-sm" onclick="toggleAssignPreview('${esc(q.id)}')">✕ Close Preview</button>
    </div>
  `;

  return bodyHtml;
}

function toggleAssignPreview(qid){
  window._assignPreviewOpenIds = window._assignPreviewOpenIds || new Set();
  const box = document.getElementById('assign-q-prev-box-' + qid);
  const btn = document.getElementById('btn-prev-' + qid);
  if(!box) return;

  if(window._assignPreviewOpenIds.has(qid)){
    window._assignPreviewOpenIds.delete(qid);
    box.style.display = 'none';
    box.innerHTML = '';
    if(btn) btn.innerHTML = '👁️ Preview';
  } else {
    window._assignPreviewOpenIds.add(qid);
    const q = ALL.find(x => x.id === qid);
    if(!q) return;
    box.style.display = 'block';
    box.innerHTML = renderAssignQuestionPreview(q);
    if(btn) btn.innerHTML = '✕ Hide';
    if(typeof initMermaid === 'function') initMermaid();
  }
}

function toggleAssignQ(qid){
  const idx = window._assignSelectedQIds.indexOf(qid);
  if(idx >= 0) window._assignSelectedQIds.splice(idx, 1);
  else window._assignSelectedQIds.push(qid);

  const isSel = window._assignSelectedQIds.includes(qid);
  const row = document.getElementById('assign-q-row-' + qid);
  if(row){
    row.style.background = isSel ? 'var(--teal-light)' : 'transparent';
    const chk = document.getElementById('assign-chk-' + qid);
    if(chk) chk.checked = isSel;
  }
  const qBtn = document.getElementById('btn-assign-toggle-' + qid);
  if(qBtn){
    qBtn.className = isSel ? 'btn btn-navy btn-sm' : 'btn btn-primary btn-sm';
    qBtn.textContent = isSel ? '✓ Selected (Click to remove)' : '＋ Add to Assignment';
  }
  updateAssignmentSummaryLabel();
}

function updateAssignmentSummaryLabel(){
  const label = document.getElementById('assign-selected-summary');
  if(!label) return;
  const selectedQuestions = window._assignSelectedQIds.map(id => ALL.find(x => x.id === id)).filter(Boolean);
  const totalMarks = selectedQuestions.reduce((s, q) => s + (q.marks || 0), 0);
  label.innerHTML = `Selected: <b>${selectedQuestions.length}</b> question(s) • <b>${totalMarks}</b> total marks`;
}

function openAssignmentQuestionsPreviewModal(assignId){
  const a = (adminState.assignments || []).find(x => x.id === assignId);
  if(!a) return;
  const questions = (a.questionIds || []).map(id => ALL.find(x => x.id === id)).filter(Boolean);
  const totalMarks = questions.reduce((s, q) => s + (q.marks || 0), 0);

  openModal(`
    <div style="max-width:860px;width:100%">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;border-bottom:2px solid var(--line);padding-bottom:12px;margin-bottom:14px;flex-wrap:wrap">
        <div>
          <span class="eyebrow">Assignment Preview</span>
          <h2 style="font-family:Fraunces,serif;margin:4px 0 2px;font-size:24px">${esc(a.title)}</h2>
          <div class="mini-note">${questions.length} questions • ${totalMarks} total marks • Due: ${a.dueDate ? esc(a.dueDate) : 'No due date'}</div>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="closeModal()">✕ Close</button>
      </div>
      ${a.description ? `<p style="background:var(--surface2);padding:10px 14px;border-radius:8px;font-size:13.5px;margin-bottom:14px">${esc(a.description)}</p>` : ''}
      <div style="max-height:65vh;overflow-y:auto;-webkit-overflow-scrolling:touch;padding-right:6px">
        ${questions.map((q, idx) => `
          <div style="border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:14px;background:var(--surface)">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px">
              <b>Question ${idx + 1} (${yearOf(q)} ${paperOf(q)} Q.${esc(q.number)})</b>
              <span class="pill none">${q.marks} mark${q.marks!==1?'s':''}</span>
            </div>
            ${renderAssignQuestionPreview(q)}
          </div>
        `).join('') || '<div style="color:var(--muted)">No questions found in this assignment.</div>'}
      </div>
      <div style="display:flex;justify-content:flex-end;margin-top:14px">
        <button class="btn btn-primary" onclick="closeModal()">Done</button>
      </div>
    </div>
  `);
  if(typeof initMermaid === 'function') initMermaid();
}

async function saveNewAssignment(){
  const title = ((document.getElementById('new-assign-title')||{}).value||'').trim();
  const desc = ((document.getElementById('new-assign-desc')||{}).value||'').trim();
  const dueDate = ((document.getElementById('new-assign-duedate')||{}).value||'').trim();
  const classCheckboxes = document.querySelectorAll('.target-class-chk:checked');
  const classIds = Array.from(classCheckboxes).map(c => c.value);
  const qIds = window._assignSelectedQIds || [];

  if(!title){ alert('Please enter an assignment title.'); return; }
  if(!qIds.length){ alert('Please select at least one question for the assignment.'); return; }
  if(!classIds.length){ alert('Please select at least one class to assign.'); return; }

  const ref = firebaseDb.collection('assignments').doc();
  const data = {
    id: ref.id,
    title: title.slice(0, 120),
    description: desc.slice(0, 1000) || '',
    questionIds: qIds.slice(0, 150),
    classIds: classIds.slice(0, 30),
    studentUids: [],
    teacherId: firebaseUser.uid,
    teacherName: currentUserProfile.displayName || firebaseUser.displayName || 'Teacher',
    dueDate: dueDate || '',
    createdAt: FV().serverTimestamp(),
    updatedAt: FV().serverTimestamp()
  };

  try{
    await ref.set(data);
    closeModal();
    await Promise.all([loadAdminData(true), loadStudentAssignments(true)]);
  }catch(e){
    alert('Could not create assignment: ' + (e.message || e));
  }
}

async function deleteAssignment(id){
  if(!confirm('Are you sure you want to delete this assignment?')) return;
  try{
    await firebaseDb.collection('assignments').doc(id).delete();
    await Promise.all([loadAdminData(true), loadStudentAssignments(true)]);
  }catch(e){
    alert('Could not delete assignment: ' + (e.message || e));
  }
}

async function openAssignmentSubmissionsModal(assignId, force){
  const a = (adminState.assignments||[]).find(x => x.id === assignId);
  if(!a) return;
  openModal('<p class="loading">Loading student submissions…</p>');

  const targetStudentSet = new Set(a.studentUids || []);
  (a.classIds || []).forEach(cid => {
    const c = classById(cid);
    if(c && c.studentUids) c.studentUids.forEach(uid => targetStudentSet.add(uid));
  });
  const targetStudents = adminState.users.filter(u => targetStudentSet.has(u.uid) && u.role === 'student');

  let subs = (!force && adminState.assignmentAttemptsMap[assignId]) ? adminState.assignmentAttemptsMap[assignId] : null;
  if(!subs){
    subs = await Promise.all(targetStudents.map(async u => {
      try{
        const snap = await firebaseDb.collection('users').doc(u.uid).collection('assignmentAttempts').doc(assignId).get();
        return { u, attempt: snap.exists ? snap.data() : null };
      }catch(e){
        return { u, attempt: null };
      }
    }));
    adminState.assignmentAttemptsMap[assignId] = subs;
  }

  const maxPossibleMarks = (a.questionIds||[]).map(qid => (ALL.find(x=>x.id===qid)||{}).marks || 0).reduce((x,y)=>x+y, 0);
  const completedSubs = subs.filter(s => s.attempt && s.attempt.status === 'completed');
  const avgScore = completedSubs.length ? Math.round(completedSubs.reduce((acc,s)=>acc+(s.attempt.score||0),0)/completedSubs.length) : null;

  window._currentGradebookRows = subs.map(s => [
    s.u.displayName || '',
    s.u.email || '',
    s.u.className || '—',
    s.attempt ? s.attempt.status : 'not_started',
    s.attempt ? s.attempt.score : '',
    maxPossibleMarks,
    s.attempt && maxPossibleMarks ? Math.round(s.attempt.score / maxPossibleMarks * 100) : '',
    s.attempt && s.attempt.submittedAt ? fmtDate(s.attempt.submittedAt) : ''
  ]);
  window._currentGradebookTitle = a.title;

  openModal(`
    <div style="max-width:880px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;border-bottom:2px solid var(--line);padding-bottom:12px;margin-bottom:14px">
        <div>
          <h2 style="font-family:Fraunces,serif;margin:0 0 4px;font-size:24px">${esc(a.title)} — Gradebook</h2>
          <div class="mini-note">Due: ${a.dueDate ? esc(a.dueDate) : 'None'} • Questions: ${(a.questionIds||[]).length} • Max marks: ${maxPossibleMarks}</div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ghost no-print" onclick="openAssignmentSubmissionsModal('${esc(assignId)}', true)" title="Reload live submissions from database">↻ Refresh</button>
          <button class="btn btn-navy no-print" onclick="window.print()">Print / PDF</button>
          <button class="btn btn-ghost no-print" onclick="downloadGradebookCsv()">Export CSV</button>
        </div>
      </div>

      <div class="kpi-grid">
        <div class="kpi-card"><b>${targetStudents.length}</b><span>Target Students</span></div>
        <div class="kpi-card"><b>${completedSubs.length}</b><span>Submitted</span></div>
        <div class="kpi-card"><b>${targetStudents.length - completedSubs.length}</b><span>Pending</span></div>
        <div class="kpi-card"><b>${avgScore != null ? avgScore + ' / ' + maxPossibleMarks : '—'}</b><span>Average Score</span></div>
      </div>

      <div class="tablewrap" style="margin-top:14px">
        <table class="admin-table">
          <thead>
            <tr>
              <th>Student</th>
              <th>Class</th>
              <th>Status</th>
              <th>Score / Max</th>
              <th>Accuracy</th>
              <th>Submitted Date</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            ${subs.map(({u, attempt}) => {
              const isDone = attempt && attempt.status === 'completed';
              const hasTeacherScore = isDone && attempt.teacherScore != null;
              const displayScore = hasTeacherScore ? attempt.teacherScore : (attempt ? attempt.score : 0);
              const pct = isDone && maxPossibleMarks ? Math.round(displayScore / maxPossibleMarks * 100) + '%' : '—';
              return `
                <tr>
                  <td><b>${esc(u.displayName||'')}</b><br><span class="mini-note">${esc(u.email||'')}</span></td>
                  <td>${esc(u.className||'—')}</td>
                  <td>${isDone ? (hasTeacherScore ? '<span class="pill know">Graded</span>' : '<span class="pill know">Submitted</span>') : '<span class="pill none">Not Started</span>'}</td>
                  <td>
                    <b>${isDone ? displayScore + ' / ' + maxPossibleMarks : '—'}</b>
                    ${hasTeacherScore ? `<br><span class="mini-note">AI: ${attempt.score}</span>` : ''}
                  </td>
                  <td>${pct}</td>
                  <td>${isDone && attempt.submittedAt ? fmtDate(attempt.submittedAt) : '—'}</td>
                  <td>
                    ${isDone ? `<button class="btn btn-primary btn-sm" onclick="openStudentAssignmentAttemptModal('${esc(assignId)}','${esc(u.uid)}')">${hasTeacherScore ? 'Edit Grade &amp; Notes' : 'Grade &amp; Feedback'}</button>` : '<span class="mini-note">—</span>'}
                  </td>
                </tr>
              `;
            }).join('') || '<tr><td colspan="7" style="color:var(--muted)">No students assigned.</td></tr>'}
          </tbody>
        </table>
      </div>

      <div style="margin-top:16px;display:flex;justify-content:flex-end">
        <button class="btn btn-ghost" onclick="closeModal()">Close</button>
      </div>
    </div>
  `);
}

function downloadGradebookCsv(){
  const rows = [['Student Name','Email','Class','Status','Score','Max Marks','Percentage','Submitted Date'], ...(window._currentGradebookRows || [])];
  const csv = rows.map(r => r.map(v => '"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  a.download = ((window._currentGradebookTitle||'assignment')+'-gradebook.csv').replace(/[\s\/\\]+/g,'_');
  a.click();
}

async function openStudentAssignmentAttemptModal(assignId, uid){
  const a = (adminState.assignments||[]).find(x => x.id === assignId);
  const u = adminState.users.find(x => x.uid === uid);
  if(!a || !u) return;

  openModal('<p class="loading">Loading student attempt details…</p>');
  try{
    const snap = await firebaseDb.collection('users').doc(uid).collection('assignmentAttempts').doc(assignId).get();
    if(!snap.exists){
      openModal('<p>No submission found for this student.</p>');
      return;
    }
    const attempt = snap.data();
    const results = attempt.results || {};
    const questions = (a.questionIds||[]).map(qid => ALL.find(x => x.id === qid)).filter(Boolean);

    const effectiveScore = attempt.teacherScore != null ? attempt.teacherScore : attempt.score;
    const maxPossibleMarks = attempt.maxScore || (questions.map(q => q.marks).reduce((x, y) => x + y, 0));

    openModal(`
      <div style="max-width:880px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;border-bottom:2px solid var(--line);padding-bottom:12px;margin-bottom:14px">
          <div>
            <div class="eyebrow" style="color:var(--teal)">Teacher Marking &amp; Feedback</div>
            <h2 style="font-family:Fraunces,serif;margin:2px 0 4px;font-size:24px">Submission: ${esc(u.displayName||'')}</h2>
            <div class="mini-note">Assignment: <b>${esc(a.title)}</b> • Submitted: ${fmtDate(attempt.submittedAt)}</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:22px;font-weight:bold;color:var(--teal)">
              Score: <span id="teacher-modal-total-score">${effectiveScore}</span> / ${maxPossibleMarks} marks
            </div>
            <div class="mini-note" id="teacher-modal-score-note">
              ${attempt.teacherScore != null ? `(Teacher Adjusted • Original AI: ${attempt.score}/${maxPossibleMarks})` : `(AI Marked: ${attempt.score}/${maxPossibleMarks})`}
            </div>
          </div>
        </div>

        <!-- Overall Teacher Feedback card -->
        <div style="background:var(--surface2);border:2px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:18px">
          <label style="font-weight:700;font-size:14px;color:var(--navy);display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <span>📝 Overall Teacher Feedback for Student:</span>
            ${attempt.gradedBy ? `<span class="mini-note">Graded by ${esc(attempt.gradedBy)}${attempt.gradedAt ? ' • ' + fmtDate(attempt.gradedAt) : ''}</span>` : ''}
          </label>
          <textarea id="teacher-overall-feedback" class="answerbox" rows="3" style="width:100%;margin-top:0" placeholder="Write overall comments, praise, or guidance for the student on this assignment...">${esc(attempt.teacherFeedback||'')}</textarea>
        </div>

        <div style="display:flex;flex-direction:column;gap:16px">
          ${questions.map((q, idx) => {
            const res = results[q.id] || {};
            const isS = q.type === 'structured';
            const curQScore = res.teacherScore != null ? res.teacherScore : (res.score != null ? res.score : 0);

            return `
              <div class="drill-card" style="margin-top:0;border:1px solid var(--line);background:var(--surface)">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px">
                  <div>
                    <span class="qnum">Q${idx+1}. ${yearOf(q)} ${paperOf(q)} Q.${esc(q.number)}</span>
                    <span style="font-size:13px;color:var(--muted);margin-left:8px">[${q.marks} mark${q.marks!==1?'s':''}]</span>
                  </div>
                  <div style="display:flex;align-items:center;gap:8px">
                    <span style="font-size:13.5px;font-weight:700">Question Mark:</span>
                    <input type="number" step="0.5" min="0" max="${q.marks}"
                      class="teacher-q-score-input"
                      id="teacher-q-score-${q.id}"
                      data-qid="${q.id}"
                      data-max="${q.marks}"
                      value="${curQScore}"
                      ${isS ? 'readonly style="background:var(--surface2);width:68px;padding:4px 8px;border-radius:6px;border:1px solid var(--line);font-weight:bold;text-align:center"' : 'style="width:68px;padding:4px 8px;border-radius:6px;border:1px solid var(--line);font-weight:bold;text-align:center" oninput="onTeacherScoreChanged()"'}
                    />
                    <span style="font-size:13px;color:var(--muted)">/ ${q.marks}</span>
                  </div>
                </div>

                <div class="blocks" style="font-size:14px;margin-bottom:12px">${renderBlocks(q.stem)}</div>

                ${!isS ? `
                  <div style="padding:10px 12px;border-radius:10px;background:var(--surface2);margin-bottom:10px">
                    <div><b>Student Answer:</b> <span style="font-weight:bold;color:${res.correct?'var(--green)':'var(--red)'}">${esc(res.answer||'(blank)')}</span> • <b>Official Answer:</b> ${esc(q.markingScheme.answer)}</div>
                  </div>
                ` : `
                  <div style="display:flex;flex-direction:column;gap:12px;margin-bottom:12px">
                    ${q.parts.map((p) => {
                      const userPartAns = (res.answers && res.answers[p.label]) || '';
                      const partInfo = (res.parts && res.parts[p.label]) || {};
                      const ms = p.markingScheme || {};
                      const teacherPartScore = (res.teacherParts && res.teacherParts[p.label] != null)
                        ? res.teacherParts[p.label]
                        : (partInfo.score != null ? partInfo.score : (res.score != null ? res.score : 0));

                      return `
                        <div class="part" style="background:var(--surface2);padding:12px;border-radius:10px">
                          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
                            <strong>Part (${esc(p.label)}) [${p.marks} mark${p.marks!==1?'s':''}]</strong>
                            <div style="display:flex;align-items:center;gap:6px">
                              <span style="font-size:13px;font-weight:700">Teacher Part Mark:</span>
                              <input type="number" step="0.5" min="0" max="${p.marks}"
                                class="teacher-part-score-input"
                                data-qid="${q.id}"
                                data-part="${p.label}"
                                data-max="${p.marks}"
                                value="${teacherPartScore}"
                                style="width:64px;padding:4px 8px;border-radius:6px;border:1px solid var(--line);font-weight:bold;text-align:center"
                                oninput="onTeacherPartScoreChanged('${q.id}')"
                              />
                              <span style="font-size:12.5px;color:var(--muted)">/ ${p.marks}</span>
                            </div>
                          </div>
                          <div class="blocks" style="margin-top:6px;font-size:13.5px">${renderBlocks(p.stem)}</div>

                          <div style="margin-top:8px;padding:8px 10px;background:var(--surface);border-radius:6px;border:1px solid var(--line)">
                            <div style="font-size:12.5px;font-weight:700;color:var(--muted)">Student's Written Answer:</div>
                            <pre style="margin:4px 0;white-space:pre-wrap;font-family:inherit;font-size:13.5px">${esc(userPartAns||'(blank)')}</pre>
                          </div>

                          <div style="margin-top:8px;padding:8px 10px;background:var(--teal-light);border-radius:6px;font-size:13px">
                            <b>Official Model Answer:</b> ${esc(ms.modelAnswer||'(None)')}
                            ${ms.points && ms.points.length ? `
                              <div style="margin-top:4px">
                                <b>Marking Points:</b>
                                <ul style="margin:2px 0 0 16px;padding:0">
                                  ${ms.points.map((pt,pi)=>`<li>[${pt.marks}m] ${esc(pt.point)}</li>`).join('')}
                                </ul>
                              </div>
                            ` : ''}
                          </div>

                          <!-- AI Examiner assessment info -->
                          ${partInfo.score != null || partInfo.feedback ? `
                            <div style="margin-top:8px;padding:8px 10px;background:#eef7ff;border-left:3px solid var(--teal);border-radius:6px;font-size:12.5px">
                              <b>🤖 AI Examiner:</b> ${partInfo.score != null ? partInfo.score + ' / ' + p.marks + ' marks' : ''}
                              ${partInfo.feedback ? ` — <em>${esc(partInfo.feedback)}</em>` : ''}
                              ${partInfo.hits && Array.isArray(partInfo.hits) && ms.points ? `
                                <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:4px">
                                  ${partInfo.hits.map((h,hi)=>`<span style="color:${h?'var(--green)':'var(--red)'};font-weight:600">${h?'✓':'✗'} Point ${hi+1}</span>`).join('')}
                                </div>
                              ` : ''}
                            </div>
                          ` : ''}
                        </div>
                      `;
                    }).join('')}
                  </div>
                `}

                <!-- Per-Question Teacher Feedback -->
                <div style="margin-top:8px">
                  <label style="font-size:12.5px;font-weight:700;color:var(--muted);display:block;margin-bottom:4px">Question Feedback / Teacher Notes (optional):</label>
                  <input type="text"
                    class="teacher-q-feedback-input"
                    id="teacher-q-feedback-${q.id}"
                    data-qid="${q.id}"
                    placeholder="E.g. Clear explanation in part (a), review memory hierarchy definitions for part (b)..."
                    value="${esc(res.teacherFeedback||'')}"
                    style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--line);font-size:13px"
                  />
                </div>
              </div>
            `;
          }).join('')}
        </div>

        <div style="margin-top:20px;padding-top:14px;border-top:2px solid var(--line);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
          <button class="btn btn-ghost" onclick="openAssignmentSubmissionsModal('${esc(assignId)}')">← Back to Gradebook</button>
          <button class="btn btn-primary" onclick="saveTeacherGrading('${esc(assignId)}', '${esc(uid)}')">💾 Save Marks &amp; Feedback</button>
        </div>
      </div>
    `);
  }catch(e){
    alert('Error loading attempt: ' + (e.message || e));
  }
}

function onTeacherPartScoreChanged(qid){
  const partInputs = document.querySelectorAll(`.teacher-part-score-input[data-qid="${qid}"]`);
  let qSum = 0;
  partInputs.forEach(inp => {
    qSum += parseFloat(inp.value) || 0;
  });
  const qScoreInput = document.getElementById(`teacher-q-score-${qid}`);
  if(qScoreInput){
    const max = parseFloat(qScoreInput.dataset.max) || 0;
    qSum = Math.min(max, Math.round(qSum * 2) / 2);
    qScoreInput.value = qSum;
  }
  onTeacherScoreChanged();
}

function onTeacherScoreChanged(){
  const qInputs = document.querySelectorAll('.teacher-q-score-input');
  let total = 0;
  qInputs.forEach(inp => {
    total += parseFloat(inp.value) || 0;
  });
  const totalEl = document.getElementById('teacher-modal-total-score');
  if(totalEl) totalEl.textContent = Math.round(total * 2) / 2;
}

async function saveTeacherGrading(assignId, uid){
  const a = (adminState.assignments||[]).find(x => x.id === assignId);
  if(!a) return;
  const snap = await firebaseDb.collection('users').doc(uid).collection('assignmentAttempts').doc(assignId).get();
  if(!snap.exists){
    alert('Submission document not found.');
    return;
  }
  const attempt = snap.data();
  const results = attempt.results || {};
  const questions = (a.questionIds||[]).map(qid => ALL.find(x => x.id === qid)).filter(Boolean);

  let newTotal = 0;
  questions.forEach(q => {
    results[q.id] = results[q.id] || {};
    const qFeedInput = document.getElementById(`teacher-q-feedback-${q.id}`);
    if(qFeedInput) results[q.id].teacherFeedback = qFeedInput.value.trim().slice(0, 500);

    if(q.type === 'structured'){
      const partInputs = document.querySelectorAll(`.teacher-part-score-input[data-qid="${q.id}"]`);
      results[q.id].teacherParts = results[q.id].teacherParts || {};
      let qSum = 0;
      partInputs.forEach(inp => {
        const pLabel = inp.dataset.part;
        const pMax = parseFloat(inp.dataset.max) || 0;
        const pVal = Math.max(0, Math.min(pMax, parseFloat(inp.value) || 0));
        results[q.id].teacherParts[pLabel] = pVal;
        qSum += pVal;
      });
      qSum = Math.min(q.marks, Math.round(qSum * 2) / 2);
      results[q.id].teacherScore = qSum;
      newTotal += qSum;
    } else {
      const qScoreInput = document.getElementById(`teacher-q-score-${q.id}`);
      const val = qScoreInput ? Math.max(0, Math.min(q.marks, parseFloat(qScoreInput.value) || 0)) : (results[q.id].score || 0);
      results[q.id].teacherScore = val;
      newTotal += val;
    }
  });

  newTotal = Math.round(newTotal * 2) / 2;
  const overallFeedback = (document.getElementById('teacher-overall-feedback')?.value || '').trim().slice(0, 2000);
  const teacherName = (currentUserProfile?.displayName || firebaseUser.displayName || firebaseUser.email || 'Teacher').slice(0, 100);

  const updateData = {
    assignmentId: assignId,
    results: results,
    score: attempt.score,
    maxScore: attempt.maxScore,
    answered: attempt.answered,
    teacherScore: newTotal,
    teacherFeedback: overallFeedback,
    gradedBy: teacherName,
    gradedAt: FV().serverTimestamp(),
    updatedAt: FV().serverTimestamp()
  };

  try{
    await firebaseDb.collection('users').doc(uid).collection('assignmentAttempts').doc(assignId).set(updateData, { merge: true });
    delete adminState.assignmentAttemptsMap[assignId];
    if(studentAssignmentsState.attempts[assignId]){
      studentAssignmentsState.attempts[assignId] = { ...studentAssignmentsState.attempts[assignId], ...updateData };
    }
    alert('✅ Marks and feedback saved successfully!');
    openStudentAssignmentAttemptModal(assignId, uid);
  }catch(e){
    alert('Could not save teacher grading: ' + (e.message || e));
  }
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
  const [st, attSnap]=await Promise.all([
    loadStudentProgress(uid),
    firebaseDb.collection('users').doc(uid).collection('assignmentAttempts').get().catch(()=>({docs:[]}))
  ]);
  const r=computeStoreStats(st);
  const queue=ALL.filter(q=>st[q.id]&&['Shaky','Gap'].includes(st[q.id].rating)).length;
  const studentAssignments = attSnap.docs.map(d=>d.data());

  openModal(`<div class="report-sheet" style="margin:0;border:none;padding:0"><div class="report-header"><div><h2 class="report-title">Student practice report</h2><div class="report-meta">${esc(u.displayName||'')} · ${esc(u.email||'')}<br>Class: ${esc(u.className||'Unassigned')} · Generated ${new Date().toLocaleDateString()} by ${esc(currentUserProfile.displayName||'')}</div></div><button class="btn btn-navy no-print" onclick="window.print()">Print / PDF</button></div>
  <div class="kpi-grid"><div class="kpi-card"><b>${r.att}</b><span>Attempted</span></div><div class="kpi-card"><b>${accCell(r.acc)}</b><span>Practice accuracy</span></div><div class="kpi-card"><b>${studentAssignments.length}</b><span>Assignments submitted</span></div><div class="kpi-card"><b>${fmtDate(u.lastActive)}</b><span>Last active</span></div></div>
  <div class="report-section"><div class="report-section-title">Assigned Tests &amp; Homework (${studentAssignments.length})</div><p class="mini-note">Scores from official assignments assigned by teachers — kept separate from casual practice records.</p>
  ${studentAssignments.length ? `
    <table class="admin-table">
      <thead>
        <tr><th>Assignment Title</th><th>Score</th><th>Accuracy</th><th>Submitted Date</th></tr>
      </thead>
      <tbody>
        ${studentAssignments.map(as => `
          <tr>
            <td><b>${esc(as.title || as.assignmentId)}</b></td>
            <td><b>${as.score} / ${as.maxScore} marks</b></td>
            <td>${as.maxScore ? Math.round(as.score/as.maxScore*100)+'%' : '—'}</td>
            <td>${fmtDate(as.submittedAt)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  ` : '<p class="mini-note">No assignment attempts on record.</p>'}
  </div>
  <div class="report-section"><div class="report-section-title">Mastery by module (Practice)</div>${modBars(r.mods)}</div>
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

/* ---------------- Student: Assignments View & Runner ---------------- */
async function loadStudentAssignments(force){
  if(!firebaseUser || !firebaseDb){
    if(adminDemoMode){
      studentAssignmentsState.list = adminState.assignments || [];
      studentAssignmentsState.loaded = true;
      studentAssignmentsState.loading = false;
      if(document.getElementById('view-assignments') && !document.getElementById('view-assignments').hidden) renderAssignments();
    }
    return;
  }
  if(!force && studentAssignmentsState.loaded && !studentAssignmentsState.error) return;
  if(studentAssignmentsState.loading) return;
  studentAssignmentsState.loading = true;
  try{
    const [asSnap, attSnap] = await Promise.all([
      firebaseDb.collection('assignments').get(),
      firebaseDb.collection('users').doc(firebaseUser.uid).collection('assignmentAttempts').get()
    ]);
    const cid = (currentUserProfile && currentUserProfile.classId) || '';
    const allA = asSnap.docs.map(d => ({ ...d.data(), id: d.id }));
    const isTeacher = isStaffRole();
    studentAssignmentsState.list = allA.filter(a => {
      if(isTeacher){
        return isAdminRole() || a.teacherId === firebaseUser.uid || (cid && (a.classIds||[]).includes(cid)) || (a.studentUids||[]).includes(firebaseUser.uid);
      }
      const inClass = cid && (a.classIds || []).includes(cid);
      const inStudents = (a.studentUids || []).includes(firebaseUser.uid);
      return inClass || inStudents;
    });
    studentAssignmentsState.attempts = {};
    attSnap.docs.forEach(d => {
      studentAssignmentsState.attempts[d.id] = d.data();
    });
    studentAssignmentsState.error = '';
    studentAssignmentsState.loaded = true;

    // Update nav badge count
    const pending = studentAssignmentsState.list.filter(a => !(studentAssignmentsState.attempts[a.id] && studentAssignmentsState.attempts[a.id].status === 'completed')).length;
    const badge = document.getElementById('nav-assign-count');
    if(badge) badge.textContent = pending ? `• ${pending} due` : '';
  }catch(e){
    studentAssignmentsState.error = e.message || e;
    studentAssignmentsState.loaded = true;
  }
  studentAssignmentsState.loading = false;
  if(document.getElementById('view-assignments') && !document.getElementById('view-assignments').hidden) renderAssignments();
}

function renderAssignments(){
  const root = document.getElementById('assignments-root');
  if(!root) return;

  if(!firebaseUser && !adminDemoMode){
    root.innerHTML = `<div class="empty">Please <a href="#" onclick="openAuthModal('student');return false">sign in with Google</a> to view and attempt your assigned homework and assessments.</div>`;
    return;
  }
  if(activeAssignmentRunner){
    renderAssignmentRunner();
    return;
  }
  if(adminDemoMode && !firebaseUser){
    studentAssignmentsState.list = adminState.assignments || [];
    studentAssignmentsState.loaded = true;
  } else if(!studentAssignmentsState.loaded && !studentAssignmentsState.loading && !studentAssignmentsState.error){
    studentAssignmentsState.loading = true;
    root.innerHTML = '<p class="loading">Loading assignments…</p>';
    loadStudentAssignments();
    return;
  }

  const list = studentAssignmentsState.list || [];
  const attempts = studentAssignmentsState.attempts || {};
  const isTeacher = isStaffRole();
  const teacherHeader = isTeacher ? `
    <div style="background:var(--teal-light);border:2px solid var(--teal);border-radius:14px;padding:16px 18px;margin-bottom:18px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
      <div>
        <div class="eyebrow" style="color:var(--teal)">Teacher Management</div>
        <h3 style="font-family:Fraunces,serif;margin:4px 0 2px;font-size:20px;color:var(--navy)">Teacher Assignment Hub</h3>
        <p class="mini-note" style="margin:0">Create and distribute assignments with full question previews, marking schemes, and student gradebooks.</p>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary" onclick="openCreateAssignmentModal()">+ Create New Assignment</button>
        <button class="btn btn-navy" onclick="showView('admin');setAdminTab('assignments')">Open Teacher Portal →</button>
      </div>
    </div>
  ` : '';

  const emptyMsg = isTeacher
    ? '<div class="empty">No assignments created yet. Click <strong>+ Create New Assignment</strong> above to distribute tasks to your classes.</div>'
    : '<div class="empty">No assignments assigned to you yet. If you have a class code from your teacher, join your class in the Practice Zone or Settings.</div>';

  root.innerHTML = `
    ${teacherHeader}
    ${studentAssignmentsState.error ? `<div class="note" style="color:var(--red)">${esc(studentAssignmentsState.error)}</div>` : ''}
    ${studentAssignmentsState.loading ? '<p class="loading">Loading assignments…</p>' : `
      <div style="display:flex;flex-direction:column;gap:14px;margin-top:10px">
        ${list.map(a => {
          const att = attempts[a.id];
          const isDone = att && att.status === 'completed';
          const hasTeacherGraded = isDone && att.teacherScore != null;
          const displayScore = hasTeacherGraded ? att.teacherScore : (att ? att.score : 0);
          const qCount = (a.questionIds || []).length;
          const maxMarks = (a.questionIds || []).map(qid => (ALL.find(x => x.id === qid) || {}).marks || 0).reduce((x, y) => x + y, 0);

          return `
            <div class="qcard" style="padding:20px">
              <div class="qcard-top">
                <div>
                  <span class="qnum" style="background:var(--navy);color:#fff">Assignment</span>
                  <span style="font-weight:700;font-size:17px;margin-left:8px">${esc(a.title)}</span>
                </div>
                ${isDone ? `
                  <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
                    <span class="pill know">Score: ${displayScore} / ${att.maxScore || maxMarks}</span>
                    ${hasTeacherGraded ? '<span class="pill" style="background:#e6f4ea;color:#137333;font-size:11.5px">Teacher Graded</span>' : '<span class="pill" style="background:var(--teal-light);color:var(--teal);font-size:11.5px">AI Marked</span>'}
                    ${att.teacherFeedback ? '<span class="pill" style="background:#fff3cd;color:#856404;font-size:11.5px">📝 Feedback</span>' : ''}
                  </div>
                ` : `<span class="pill ${a.dueDate?'shaky':'none'}">${a.dueDate?'Due '+esc(a.dueDate):'No due date'}</span>`}
              </div>
              ${a.description ? `<p style="margin:4px 0;font-size:14.5px;color:var(--muted)">${esc(a.description)}</p>` : ''}
              <div class="topic">Teacher: <b>${esc(a.teacherName||'Teacher')}</b> • ${qCount} questions • ${maxMarks} marks total</div>
              <div class="qfoot">
                <span style="font-size:13px;color:var(--muted)">${isDone ? (hasTeacherGraded ? 'Teacher reviewed & feedback provided' : 'AI evaluation completed on ' + fmtDate(att.submittedAt)) : 'Unsubmitted assignment'}</span>
                <div style="display:flex;gap:8px">
                  ${isDone ? `
                    <button class="btn btn-ghost" onclick="startAssignmentRunner('${esc(a.id)}', true)">Review Submission &amp; Feedback →</button>
                  ` : `
                    <button class="btn btn-primary" onclick="startAssignmentRunner('${esc(a.id)}', false)">${att?'Resume Assignment':'Start Assignment'} →</button>
                  `}
                </div>
              </div>
            </div>
          `;
        }).join('') || emptyMsg}
      </div>
    `}
  `;
}

async function startAssignmentRunner(assignId, isReview){
  const a = studentAssignmentsState.list.find(x => x.id === assignId) || (adminState.assignments||[]).find(x => x.id === assignId);
  if(!a) return;
  const questions = (a.questionIds || []).map(qid => ALL.find(x => x.id === qid)).filter(Boolean);

  let prevAttempt = studentAssignmentsState.attempts[assignId] || null;
  if(isReview && !prevAttempt && firebaseUser){
    try{
      const snap = await firebaseDb.collection('users').doc(firebaseUser.uid).collection('assignmentAttempts').doc(assignId).get();
      if(snap.exists){
        prevAttempt = snap.data();
        studentAssignmentsState.attempts[assignId] = prevAttempt;
      }
    }catch(e){}
  }

  activeAssignmentRunner = {
    assign: a,
    questions,
    curIndex: 0,
    isReview: !!isReview,
    answers: (prevAttempt && prevAttempt.results) ? Object.fromEntries(Object.entries(prevAttempt.results).map(([k,v])=>[k, v.answer != null ? v.answer : v.answers])) : {}
  };
  showView('assignments');
  renderAssignmentRunner();
}

function exitAssignmentRunner(){
  activeAssignmentRunner = null;
  renderAssignments();
}

let assignChatHistory = {};
let assignChatOpen = {};
let assignChatBusy = false;

function toggleAssignChat(qid){
  if(!activeAssignmentRunner) return;
  const key = `${activeAssignmentRunner.assign.id}_${qid}`;
  assignChatOpen[key] = !assignChatOpen[key];
  const el = document.getElementById(`assign-chat-${qid}`);
  if(el){
    el.hidden = !assignChatOpen[key];
    if(!el.hidden){
      renderAssignChatMsgs(qid);
      const inp = document.getElementById(`assign-chat-input-${qid}`);
      if(inp) inp.focus();
    }
  }
}

function sendAssignQuickPrompt(qid, promptText){
  const inp = document.getElementById(`assign-chat-input-${qid}`);
  if(inp) inp.value = promptText;
  sendAssignChat(qid);
}

function renderAssignChatMsgs(qid){
  if(!activeAssignmentRunner) return;
  const key = `${activeAssignmentRunner.assign.id}_${qid}`;
  const el = document.getElementById(`assign-chat-msgs-${qid}`);
  if(!el) return;
  const msgs = assignChatHistory[key] || [];
  el.innerHTML = msgs.map(m => `
    <div class="chatmsg ${m.role==='user'?'user':'ai'}">
      <strong>${m.role==='user'?'You':'AI Tutor'}</strong>
      <div style="white-space:pre-wrap;margin-top:2px;font-size:13.5px">${esc(m.content)}</div>
    </div>
  `).join('') || '<div class="mini-note" style="padding:8px">No chat messages yet. Ask a question or click a prompt above.</div>';
  el.scrollTop = el.scrollHeight;
}

async function sendAssignChat(qid){
  if(assignChatBusy || !activeAssignmentRunner) return;
  const q = activeAssignmentRunner.questions.find(x => x.id === qid);
  if(!q) return;
  const inp = document.getElementById(`assign-chat-input-${qid}`);
  const text = ((inp && inp.value) || '').trim();
  if(!text) return;
  inp.value = '';

  const key = `${activeAssignmentRunner.assign.id}_${qid}`;
  assignChatHistory[key] = assignChatHistory[key] || [];
  assignChatHistory[key].push({ role: 'user', content: text });
  renderAssignChatMsgs(qid);

  assignChatBusy = true;
  const sendBtn = document.getElementById(`assign-chat-send-${qid}`);
  const noteEl = document.getElementById(`assign-chat-note-${qid}`);
  if(sendBtn){ sendBtn.disabled = true; sendBtn.textContent = 'Thinking…'; }
  if(inp) inp.disabled = true;
  if(noteEl) noteEl.innerHTML = '<span class="loading">AI tutor is thinking…</span>';

  const isReview = activeAssignmentRunner.isReview;
  const curAns = activeAssignmentRunner.answers[q.id];
  let answerSummary = '';
  if(q.type === 'mc'){
    answerSummary = `The student selected option: ${curAns || '(none)'}.`;
  } else {
    answerSummary = `Student's written answers:\n` + Object.entries(curAns || {}).map(([lbl, val]) => `Part (${lbl}): ${val || '(blank)'}`).join('\n');
  }

  const sys = isReview
    ? `You are an expert tutor for HKDSE ICT students. The student has submitted this assignment question, and the official HKDSE marking scheme and model answers are now revealed.
Explain the official answers, marking scheme points, and marking criteria clearly.
Point out where the student earned or missed marks based on their answers, and provide actionable advice on how to structure HKDSE answers for full marks.
OFFICIAL MARKING INFORMATION:
${schemeContext(q)}

STUDENT'S ANSWERS:
${answerSummary}`
    : `You are an expert tutor for HKDSE ICT students. The student is currently attempting this assignment question and has NOT yet submitted.
Explain what the question is asking, clarify syllabus concepts, give helpful hints, and guide the student with leading questions.
CRITICAL EXAMINATION INTEGRITY RULE: You must NOT reveal, quote, or state the correct answer, the official marking scheme, model answers, or which option is right, even if the student asks directly. If asked for answers, politely decline and provide another hint or conceptual explanation.

STUDENT'S CURRENT ANSWERS:
${answerSummary}`;

  try{
    const reply = await aiComplete([
      { role: 'system', content: sys + '\n\nQUESTION CONTEXT:\n' + questionContext(q) },
      ...assignChatHistory[key]
    ]);
    assignChatHistory[key].push({ role: 'assistant', content: reply });
    if(noteEl) noteEl.innerHTML = '';
  }catch(e){
    if(noteEl) noteEl.innerHTML = `<div class="note" style="color:var(--red)">AI tutor temporarily unavailable (${esc(e.message || 'network')}). The official marking scheme is available upon submission.</div>`;
  }
  assignChatBusy = false;
  if(sendBtn){ sendBtn.disabled = false; sendBtn.textContent = 'Send'; }
  if(inp) inp.disabled = false;
  renderAssignChatMsgs(qid);
}

function renderAssignmentRunner(){
  const root = document.getElementById('assignments-root');
  if(!root || !activeAssignmentRunner) return;

  const { assign, questions, curIndex, isReview, answers } = activeAssignmentRunner;
  const q = questions[curIndex];
  if(!q){ exitAssignmentRunner(); return; }

  const isS = q.type === 'structured';
  const prevAttempt = studentAssignmentsState.attempts[assign.id];
  const qResult = prevAttempt && prevAttempt.results && prevAttempt.results[q.id];

  const pillsHtml = questions.map((item, idx) => {
    const hasAns = answers[item.id] != null && answers[item.id] !== '';
    const isCur = idx === curIndex;
    return `
      <button class="fbtn ${isCur?'active':''}" style="flex-shrink:0;min-width:38px;height:38px;padding:0 12px;display:inline-flex;align-items:center;justify-content:center;gap:4px;border-radius:10px;font-size:13.5px;font-weight:700;transition:all .15s;${isCur?'background:var(--navy);color:#fff;border-color:var(--navy);box-shadow:0 2px 8px rgba(0,0,0,0.18)':(hasAns?'background:var(--teal-light);border-color:var(--teal);color:var(--teal)':'background:var(--surface2)')}" onclick="jumpAssignmentQ(${idx})">
        <span>${idx + 1}</span>${hasAns ? '<span style="font-weight:900">✓</span>' : ''}
      </button>
    `;
  }).join('');

  const chatKey = `${assign.id}_${q.id}`;
  const isChatOpen = !!assignChatOpen[chatKey];
  const chatMsgs = assignChatHistory[chatKey] || [];

  root.innerHTML = `
    <div style="border-bottom:2px solid var(--line);padding-bottom:12px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
      <div>
        <span class="eyebrow">${isReview ? 'Reviewing Submission' : 'Assignment in progress'}</span>
        <h2 style="font-family:Fraunces,serif;margin:2px 0 4px;font-size:24px">${esc(assign.title)}</h2>
        <span class="mini-note">Question ${curIndex + 1} of ${questions.length} • Total ${q.marks} mark${q.marks!==1?'s':''}</span>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="exitAssignmentRunner()">← Exit Assignment</button>
    </div>

    ${isReview && prevAttempt ? `
      <div style="border-radius:12px;padding:14px 18px;margin-bottom:16px;${prevAttempt.teacherScore != null ? 'background:var(--teal-light);border:2px solid var(--teal)' : 'background:var(--surface2);border:1px solid var(--line)'}">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
          <div>
            <div class="eyebrow" style="color:var(--navy)">${prevAttempt.teacherScore != null ? 'Teacher Evaluation &amp; Feedback' : 'AI Evaluation Result'}</div>
            <div style="font-size:20px;font-weight:800;color:var(--teal);margin-top:2px">
              Final Score: ${prevAttempt.teacherScore != null ? prevAttempt.teacherScore : prevAttempt.score} / ${prevAttempt.maxScore} marks (${Math.round(((prevAttempt.teacherScore != null ? prevAttempt.teacherScore : prevAttempt.score)/(prevAttempt.maxScore||1))*100)}%)
            </div>
            ${prevAttempt.teacherScore != null ? `<div class="mini-note">Initial AI Examiner Score: ${prevAttempt.score} / ${prevAttempt.maxScore} marks</div>` : '<div class="mini-note">Graded by AI examiner against official HKDSE marking criteria.</div>'}
          </div>
          <div style="font-size:12.5px;color:var(--muted);text-align:right">
            ${prevAttempt.gradedBy ? `Graded by <b>${esc(prevAttempt.gradedBy)}</b><br>` : ''}
            Submitted: ${fmtDate(prevAttempt.submittedAt)}
          </div>
        </div>
        ${prevAttempt.teacherFeedback ? `
          <div style="margin-top:10px;padding:10px 14px;background:#fff;border-radius:8px;border:1px solid var(--teal)">
            <b style="color:var(--navy);font-size:13.5px">👨‍🏫 Teacher's Overall Feedback:</b>
            <div style="margin-top:4px;white-space:pre-wrap;font-size:14px">${esc(prevAttempt.teacherFeedback)}</div>
          </div>
        ` : ''}
      </div>
    ` : ''}

    <div style="display:flex;gap:8px;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:thin;padding:4px 2px 10px;margin-bottom:18px">
      ${pillsHtml}
    </div>

    <div class="drill-card" style="border:1px solid var(--line);background:var(--surface)">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <span class="qnum">${yearOf(q)} ${paperOf(q)} • Question ${esc(q.number)}</span>
        <div style="display:flex;gap:8px;align-items:center">
          ${isReview && qResult ? `
            <span class="pill ${qResult.correct ? 'know' : 'gap'}">
              ${(qResult.teacherScore != null ? qResult.teacherScore : qResult.score) || 0} / ${q.marks} marks
            </span>
          ` : ''}
          <span style="font-size:13px;color:var(--muted)">${esc(q.topics.join(' • '))} • ${q.marks} mark${q.marks!==1?'s':''}</span>
        </div>
      </div>

      <div class="blocks" style="margin-top:16px">${renderBlocks(q.stem)}</div>

      ${!isS ? `
        <div class="section-title" style="margin-top:12px">${isReview?'Your answer & official answer':'Select your answer'}</div>
        <div class="options">
          ${q.options.map(o => {
            const isUserChoice = answers[q.id] === o.key;
            const isCorrect = isReview && q.markingScheme.answer === o.key;
            const isWrong = isReview && isUserChoice && !isCorrect;
            let cls = '';
            if(isReview){
              if(isCorrect) cls = 'correct';
              else if(isWrong) cls = 'wrong';
            } else if(isUserChoice){
              cls = 'selected';
            }
            return `
              <button class="opt ${cls}" onclick="${isReview?'':'setAssignmentAnswer(\''+o.key+'\')'}">
                <span class="opt-key">${esc(o.key)}</span>
                <span class="blocks">${renderBlocks(o.content)}</span>
              </button>
            `;
          }).join('')}
        </div>
      ` : `
        <div class="section-title" style="margin-top:12px">${isReview?'Your written answers & marking scheme':'Type your answers for each part'}</div>
        ${q.parts.map((p, pi) => {
          const userAns = (answers[q.id] && answers[q.id][p.label]) || '';
          const ms = p.markingScheme || {};
          const partRes = qResult && qResult.parts && qResult.parts[p.label];
          const teacherPartScore = qResult && qResult.teacherParts && qResult.teacherParts[p.label] != null ? qResult.teacherParts[p.label] : null;

          return `
            <div class="part">
              <div class="part-head">
                <strong>Part (${esc(p.label)})</strong>
                <span style="font-size:13px;color:var(--muted)">${p.marks} mark${p.marks!==1?'s':''}</span>
              </div>
              <div class="blocks" style="margin-top:8px">${renderBlocks(p.stem)}</div>
              <textarea class="answerbox" ${isReview?'disabled':''} placeholder="Type your answer for part ${esc(p.label)} here…" oninput="setAssignmentStructAnswer('${esc(p.label)}', this.value)">${esc(userAns)}</textarea>

              ${isReview ? `
                <div style="margin-top:10px;padding:12px 14px;background:var(--teal-light);border-radius:10px;font-size:13.5px">
                  <b>Official Model Answer:</b>
                  <pre style="margin:4px 0 8px;font-family:inherit;white-space:pre-wrap">${esc(ms.modelAnswer||'(No model answer published)')}</pre>
                  ${ms.points && ms.points.length ? `
                    <b>Official Marking Points:</b>
                    <ul style="margin:4px 0 0 18px;padding:0">
                      ${ms.points.map((pt, i) => `<li>[${pt.marks} mark${pt.marks!==1?'s':''}] ${esc(pt.point)}</li>`).join('')}
                    </ul>
                  ` : ''}
                </div>

                <!-- AI Examiner assessment box -->
                ${partRes ? `
                  <div class="aimarkbox" style="margin-top:10px;padding:12px 14px;background:var(--surface2);border-radius:10px;border-left:4px solid var(--teal)">
                    <div style="font-weight:bold;color:var(--navy);font-size:14px">🤖 AI Examiner Mark: ${partRes.score} / ${p.marks} marks</div>
                    ${partRes.feedback ? `<div style="margin-top:4px;font-size:13.5px;color:var(--ink)"><b>Feedback:</b> ${esc(partRes.feedback)}</div>` : ''}
                    ${partRes.hits && Array.isArray(partRes.hits) && ms.points ? `
                      <div style="margin-top:8px;font-size:13px">
                        <b>Marking Points Checklist:</b>
                        <div style="display:grid;gap:4px;margin-top:4px">
                          ${partRes.hits.map((hit, hi) => {
                            const ptObj = ms.points[hi] || { marks: 1, point: 'Point ' + (hi + 1) };
                            return `
                              <div style="display:flex;gap:6px;align-items:baseline;color:${hit ? 'var(--green)' : 'var(--red)'}">
                                <span style="font-weight:bold">${hit ? '✓' : '✗'}</span>
                                <span>[${ptObj.marks}m] ${esc(ptObj.point)}</span>
                              </div>
                            `;
                          }).join('')}
                        </div>
                      </div>
                    ` : ''}
                  </div>
                ` : ''}

                <!-- Teacher adjusted mark if present -->
                ${teacherPartScore != null ? `
                  <div style="margin-top:8px;padding:8px 12px;background:#fff8e6;border-left:4px solid var(--orange);border-radius:8px;font-size:13.5px">
                    <b>👨‍🏫 Teacher's Adjusted Mark:</b> <span style="font-weight:bold;color:var(--orange)">${teacherPartScore} / ${p.marks} marks</span>
                  </div>
                ` : ''}
              ` : ''}
            </div>
          `;
        }).join('')}
      `}

      <!-- Per-question Teacher Feedback in Review Mode -->
      ${isReview && qResult && qResult.teacherFeedback ? `
        <div style="margin-top:14px;padding:10px 14px;background:#f0f8ff;border-left:4px solid var(--navy);border-radius:8px">
          <b style="color:var(--navy);font-size:13.5px">👨‍🏫 Teacher Feedback for Q.${esc(q.number)}:</b>
          <div style="margin-top:4px;white-space:pre-wrap;font-size:13.5px">${esc(qResult.teacherFeedback)}</div>
        </div>
      ` : ''}

      <!-- Interactive AI Tutor Zone in Assignment Runner -->
      <div style="margin-top:20px;border-top:2px solid var(--line);padding-top:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
          <div>
            <strong style="font-size:14.5px;color:var(--navy)">🤖 Ask AI Tutor</strong>
            <span class="mini-note" style="margin-left:6px">${isReview ? 'Clarify marking schemes & learn how to improve' : 'Ask for hints & concept explanations without spoilers'}</span>
          </div>
          <button class="btn btn-navy btn-sm" onclick="toggleAssignChat('${esc(q.id)}')">${isChatOpen ? 'Hide AI Chat' : 'Ask AI Tutor'}</button>
        </div>

        <div id="assign-chat-${esc(q.id)}" ${isChatOpen ? '' : 'hidden'} style="margin-top:14px">
          <div id="assign-chat-msgs-${esc(q.id)}" style="display:grid;gap:8px;max-height:280px;overflow-y:auto;padding-right:4px">
            ${chatMsgs.map(m => `
              <div class="chatmsg ${m.role==='user'?'user':'ai'}">
                <strong>${m.role==='user'?'You':'AI Tutor'}</strong>
                <div style="white-space:pre-wrap;margin-top:2px;font-size:13.5px">${esc(m.content)}</div>
              </div>
            `).join('') || `
              <div class="mini-note" style="padding:10px;background:var(--surface2);border-radius:8px">
                ${isReview
                  ? '💡 Ask anything about the marking scheme, model answer, or how marks are awarded.'
                  : '💡 Ask for hints, syllabus definitions, or clarifying questions without giving away answers.'}
              </div>
            `}
          </div>

          <div id="assign-chat-note-${esc(q.id)}" style="margin-top:6px"></div>

          <!-- Quick prompt chips -->
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
            ${isReview ? `
              <button class="btn btn-ghost btn-sm" style="font-size:12px;padding:3px 9px" onclick="sendAssignQuickPrompt('${esc(q.id)}', 'Can you explain the official model answer and key requirements clearly?')">Explain model answer</button>
              <button class="btn btn-ghost btn-sm" style="font-size:12px;padding:3px 9px" onclick="sendAssignQuickPrompt('${esc(q.id)}', 'What specific keywords or points are needed to get full marks for this question?')">Key points for full marks</button>
              <button class="btn btn-ghost btn-sm" style="font-size:12px;padding:3px 9px" onclick="sendAssignQuickPrompt('${esc(q.id)}', 'How can I improve my written answer next time?')">How to improve answer</button>
            ` : `
              <button class="btn btn-ghost btn-sm" style="font-size:12px;padding:3px 9px" onclick="sendAssignQuickPrompt('${esc(q.id)}', 'Can you give me a hint on how to think about this question without giving away the answer?')">Give me a hint</button>
              <button class="btn btn-ghost btn-sm" style="font-size:12px;padding:3px 9px" onclick="sendAssignQuickPrompt('${esc(q.id)}', 'What syllabus concepts and topics are being tested here?')">Explain core concepts</button>
              <button class="btn btn-ghost btn-sm" style="font-size:12px;padding:3px 9px" onclick="sendAssignQuickPrompt('${esc(q.id)}', 'What should I pay attention to in the question stem?')">Guide me through stem</button>
            `}
          </div>

          <div style="display:flex;gap:8px;margin-top:10px;align-items:flex-start">
            <textarea id="assign-chat-input-${esc(q.id)}" class="answerbox" style="min-height:50px;flex:1;margin-top:0" placeholder="${isReview ? 'Ask anything about the marking scheme, model answer, or your mistakes…' : 'Ask about concepts or for a hint (AI will not spoil the answer)…'}"></textarea>
            <button class="btn btn-primary" id="assign-chat-send-${esc(q.id)}" onclick="sendAssignChat('${esc(q.id)}')">Send</button>
          </div>
        </div>
      </div>

      <div class="assign-runner-foot" style="display:flex;justify-content:space-between;align-items:center;margin-top:22px;flex-wrap:wrap;gap:10px">
        <button class="btn btn-ghost" ${curIndex===0?'disabled':''} onclick="prevAssignmentQ()">← Previous</button>
        <div style="display:flex;gap:10px">
          ${!isReview ? `<button class="btn btn-navy" onclick="submitActiveAssignment()">Finish &amp; Submit Assignment</button>` : ''}
          <button class="btn btn-primary" ${curIndex===questions.length-1?'disabled':''} onclick="nextAssignmentQ()">Next →</button>
        </div>
      </div>
    </div>
  `;
}

function jumpAssignmentQ(idx){
  if(!activeAssignmentRunner) return;
  activeAssignmentRunner.curIndex = idx;
  renderAssignmentRunner();
}
function prevAssignmentQ(){
  if(!activeAssignmentRunner || activeAssignmentRunner.curIndex <= 0) return;
  activeAssignmentRunner.curIndex--;
  renderAssignmentRunner();
}
function nextAssignmentQ(){
  if(!activeAssignmentRunner || activeAssignmentRunner.curIndex >= activeAssignmentRunner.questions.length - 1) return;
  activeAssignmentRunner.curIndex++;
  renderAssignmentRunner();
}
function setAssignmentAnswer(k){
  if(!activeAssignmentRunner || activeAssignmentRunner.isReview) return;
  const q = activeAssignmentRunner.questions[activeAssignmentRunner.curIndex];
  activeAssignmentRunner.answers[q.id] = k;
  renderAssignmentRunner();
}
function setAssignmentStructAnswer(partLabel, val){
  if(!activeAssignmentRunner || activeAssignmentRunner.isReview) return;
  const q = activeAssignmentRunner.questions[activeAssignmentRunner.curIndex];
  activeAssignmentRunner.answers[q.id] = activeAssignmentRunner.answers[q.id] || {};
  activeAssignmentRunner.answers[q.id][partLabel] = val;
}

async function submitActiveAssignment(){
  if(!activeAssignmentRunner) return;
  const { assign, questions, answers } = activeAssignmentRunner;

  let answeredCount = 0;
  questions.forEach(q => {
    if(q.type === 'mc'){
      if(answers[q.id]) answeredCount++;
    } else {
      if(answers[q.id] && Object.values(answers[q.id]).some(v => String(v).trim())) answeredCount++;
    }
  });

  if(!confirm(`Submit this assignment now? You have answered ${answeredCount} of ${questions.length} questions.\n\nUpon submission, written answers are evaluated by the AI examiner against official HKDSE marking points.`)) return;

  // Show AI grading progress modal
  openModal(`
    <div style="text-align:center;padding:26px 16px;max-width:500px">
      <div style="font-size:32px;margin-bottom:8px">🤖</div>
      <h3 style="font-family:Fraunces,serif;margin:0 0 6px;font-size:22px">Marking Assignment with AI</h3>
      <p class="mini-note" id="assign-marking-status" style="margin:0 0 16px">Initializing AI examiner…</p>
      <div style="width:100%;height:10px;background:var(--line);border-radius:6px;overflow:hidden;margin-bottom:8px">
        <div id="assign-marking-bar" style="width:5%;height:100%;background:var(--teal);transition:width .25s ease"></div>
      </div>
      <div class="mini-note" style="font-size:12px;color:var(--muted)">Assessing against HKDSE marking schemes &amp; awarding points…</div>
    </div>
  `);

  const statusEl = document.getElementById('assign-marking-status');
  const barEl = document.getElementById('assign-marking-bar');

  let totalScore = 0;
  let maxScore = 0;
  const results = {};

  for(let i = 0; i < questions.length; i++){
    const q = questions[i];
    maxScore += q.marks;
    const progressPct = Math.round(((i + 0.3) / questions.length) * 90);
    if(barEl) barEl.style.width = progressPct + '%';
    if(statusEl) statusEl.textContent = `Assessing Question ${i + 1} of ${questions.length} (${yearOf(q)} Q.${q.number})…`;

    if(q.type === 'mc'){
      const userAns = answers[q.id] || '';
      const corr = userAns === q.markingScheme.answer;
      const sc = corr ? q.marks : 0;
      totalScore += sc;
      results[q.id] = { answer: userAns, correct: corr, score: sc, maxScore: q.marks };
    } else {
      const partAns = answers[q.id] || {};
      const partResults = {};
      let qSc = 0;

      for(let pi = 0; pi < (q.parts || []).length; pi++){
        const p = q.parts[pi];
        const userText = String(partAns[p.label] || '').trim();
        if(statusEl) statusEl.textContent = `AI marking Question ${i + 1} Part (${p.label}) / ${q.parts.length}…`;

        if(!userText){
          partResults[p.label] = {
            score: 0,
            maxScore: p.marks,
            hits: (p.markingScheme?.points || []).map(() => false),
            feedback: 'No answer submitted for this part.'
          };
        } else {
          try{
            const res = await aiMarkPart(q, p, userText);
            partResults[p.label] = {
              score: res.score != null ? res.score : 0,
              maxScore: p.marks,
              hits: res.hits,
              feedback: res.feedback || ''
            };
            qSc += partResults[p.label].score;
          }catch(err){
            // Fallback heuristic scoring if AI offline/busy
            const pts = p.markingScheme?.points || [];
            let hits = pts.map(pt => {
              const kw = (pt.point || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
              return kw.some(k => userText.toLowerCase().includes(k));
            });
            let hitMarks = pts.reduce((sum, pt, idx) => sum + (hits[idx] ? pt.marks : 0), 0);
            const fbScore = Math.min(p.marks, hitMarks);
            partResults[p.label] = {
              score: fbScore,
              maxScore: p.marks,
              hits: hits,
              feedback: 'Marked by heuristic (' + (err.message || 'AI busy') + '). Full official model answer available below.'
            };
            qSc += fbScore;
          }
        }
      }
      qSc = Math.min(q.marks, qSc);
      totalScore += qSc;
      results[q.id] = {
        answers: partAns,
        correct: qSc * 2 >= q.marks,
        score: qSc,
        maxScore: q.marks,
        parts: partResults
      };
    }
  }

  if(barEl) barEl.style.width = '100%';
  if(statusEl) statusEl.textContent = 'Saving submission to your student profile…';

  const attemptData = {
    assignmentId: assign.id,
    title: assign.title.slice(0, 120),
    results: results,
    score: totalScore,
    maxScore: maxScore,
    answered: answeredCount,
    status: 'completed',
    submittedAt: FV().serverTimestamp(),
    updatedAt: FV().serverTimestamp()
  };

  try{
    await firebaseDb.collection('users').doc(firebaseUser.uid).collection('assignmentAttempts').doc(assign.id).set(attemptData);
    studentAssignmentsState.attempts[assign.id] = attemptData;
    activeAssignmentRunner.isReview = true;
    closeModal();
    renderAssignmentRunner();
    alert(`🎉 Assignment submitted and AI marked successfully!\nYour score: ${totalScore} / ${maxScore} marks (${Math.round((totalScore/(maxScore||1))*100)}%).\n\nYou can now review each question, see model answers, and check AI feedback.`);
  }catch(e){
    closeModal();
    alert('Could not submit assignment: ' + (e.message || e));
  }
}

document.addEventListener('DOMContentLoaded',updateNavAdminRole);
