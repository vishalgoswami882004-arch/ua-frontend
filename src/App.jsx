import { useState, useRef, useEffect, useMemo } from "react";
import {
  readFile,
  now,
  fmtD,
  fmtT,
  scoreColor,
  statusColor,
  sevColor,
  verifyAdmin,
  DB,
  DOMAINS,
  JURISDICTIONS,
  getJLaws,
  AUDIT_SYS,
  COMPARE_SYS,
  emailReport,
  callClaude,
  dlTxt,
  dlJson
} from "./ua-backend.js";

export default function App() {
  const [page,    setPage]    = useState("landing");
  const [auth,    setAuth]    = useState(null);
  const [tok,     setTok]     = useState(null);
  const [adminIn, setAdminIn] = useState(false);
  const [aLock,   setALock]   = useState({count:0,until:0});
  const [juris,   setJuris]   = useState({country:"United States",state:"California"});
  const [auditS,  setAuditS]  = useState({text:"",fileName:"",extraNotes:"",result:null,loading:false,msg:"",err:null});
  const [rTab,    setRTab]    = useState("findings");
  const [votes,   setVotes]   = useState({});
  const [notif,   setNotif]   = useState(null);
  const [modal,   setModal]   = useState(null);
  const [feedbackCtx, setFeedbackCtx] = useState(null); // {source, auditScore, auditDomain}
  const [hist,    setHist]    = useState([]);
  const [upgV,    setUpgV]    = useState(0); // increments on each upgrade to force dashboard remount
  const [cfg,     setCfgState] = useState(() => DB.getCfg());
  const [dbReady, setDbReady] = useState(false);
  const [theme,   setTheme]   = useState("dark");
  const [emailVerif, setEmailVerif] = useState(null); // {email,name} waiting for verify
  const [fileMsg, setFileMsg] = useState(null); // PDF extraction status
  const fileRef = useRef();

  useEffect(() => {
    DB.init().then(() => { setCfgState(DB.getCfg()); setDbReady(true); });
  }, []);

  // Sync auth plan from DB — memoized, only recomputes when auth or upgV changes
  const syncedAuth = useMemo(()=>{
    if(!auth) return null;
    const u=DB.getUser(auth.id);
    return u ? {...auth, plan:u.plan, trialEnd:u.trialEnd} : auth;
  }, [auth, upgV]); // upgV changes on upgrade

  const _toastTimer = useRef(null);
  const toast = (msg,type="ok") => { if(_toastTimer.current) clearTimeout(_toastTimer.current); setNotif({msg,type}); _toastTimer.current=setTimeout(()=>setNotif(null),3500); };

  // All non-hook logic — safe after hooks, before early return or after it
  // scrollTo effect must stay as a hook above early return
  useEffect(()=>{ if(dbReady) window.scrollTo({top:0,behavior:"smooth"}); },[page,dbReady]);

  if(!dbReady) return (
    <div className={"ua-root"+(theme==="light"?" ua-light":"")} style={{minHeight:"100vh",background:"var(--ua-bg)",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:16}}>
      <style>{CSS}</style>
      <div style={{fontFamily:"'Playfair Display',serif",fontSize:22,color:"#D4A853",letterSpacing:"0.05em"}}>Universal Auditor</div>
      <div style={{fontSize:13,color:"var(--ua-sub)",letterSpacing:"0.12em"}}>Loading…</div>
    </div>
  );

  // ── Plain derived values (not hooks) — defined after early return ──────
  const doLogout   = () => { if(tok)DB.logout(tok); setAuth(null);setTok(null); setAuditS({text:"",fileName:"",extraNotes:"",result:null,loading:false,msg:"",err:null}); setHist([]); setPage("landing"); toast("Logged out securely.","info"); };
  const doAdminOut = () => { setAdminIn(false); setPage("landing"); toast("Admin session ended.","info"); };

  const isPaid = !!(syncedAuth||auth) && (syncedAuth||auth).plan !== "trial";

  const goAudit = () => {
    if(!auth){ setPage("login"); return; }
    if(!isPaid && DB.trialExpired(auth.id)){ setModal("expired"); return; }
    if(!isPaid && DB.trialAuditsExhausted(auth.id)){ setModal("exhausted"); return; }
    setAuditS({text:"",fileName:"",extraNotes:"",result:null,loading:false,msg:"",err:null});
    setRTab("findings"); setVotes({});
    setPage("audit");
  };

  // Plain async function — no useCallback needed (called only on user action)
  const runAudit = async (j) => {
    if(!auth||!tok){ setPage("login"); toast("Session expired. Please log in again.","err"); return; }
    if(!isPaid && DB.trialExpired(auth.id)){ setModal("expired"); setPage("dashboard"); return; }
    if(!isPaid && DB.trialAuditsExhausted(auth.id)){ setModal("exhausted"); setPage("dashboard"); return; }
    if(!auditS.text.trim()||!auditS.fileName) return;
    setJuris(j);
    const jLaws = getJLaws(j.country,j.state);
    setAuditS(s=>({...s,loading:true,err:null,result:null,msg:"Auditing under "+j.country+(j.state?" · "+j.state:"")+" law…"}));
    try {
      const res = await callClaude(
        AUDIT_SYS(j.country,j.state,jLaws),
        "Audit this document titled \""+auditS.fileName+"\" ("+j.country+(j.state?", "+j.state:"")+" jurisdiction):\n\n"+auditS.text.slice(0,30000)+(auditS.extraNotes.trim()?"\n\nAdditional context from submitter:\n"+auditS.extraNotes.slice(0,800):""),
        msg2=>setAuditS(s=>({...s,msg:msg2}))
      );
      const dm = DOMAINS[res.domain]||DOMAINS.legal;
      const full = {...res,dm,jurisdiction:{country:j.country,state:j.state,laws:jLaws}};
      if(auth) DB.saveAudit(auth.id,{subdomain:res.subdomain,score:res.compliance_score,riskLevel:res.risk_level,findings:(res.findings||[]).length,doc:auditS.text.slice(0,200),country:j.country,state:j.state,domain:res.domain},full);
      setAuditS(s=>({...s,loading:false,result:full}));
      setRTab("findings"); setVotes({}); setPage("result");
    } catch(e) {
      setAuditS(s=>({...s,loading:false,err:"Audit failed: "+e.message+". Please try again."}));
    }
  };

  const trialHrs      = (syncedAuth||auth) ? Math.max(0,Math.floor(((DB.getUser((syncedAuth||auth).id)?.trialEnd||0)-now())/3600000)) : 0;
  const inGrace       = (syncedAuth||auth) ? DB.inGrace((syncedAuth||auth).id) : false;
  const graceMin      = (syncedAuth||auth) ? Math.max(0,Math.ceil((DB.graceRemaining((syncedAuth||auth).id)||0)/60000)) : 0;
  const isExpired     = (syncedAuth||auth) && !isPaid && DB.trialExpired((syncedAuth||auth).id);
  const auditsLeft    = (syncedAuth||auth) && !isPaid ? DB.trialAuditsLeft((syncedAuth||auth).id) : Infinity;
  const auditExhausted = (syncedAuth||auth) && !isPaid && DB.trialAuditsExhausted((syncedAuth||auth).id);

  return (
    <div className={"ua-root"+(theme==="light"?" ua-light":"")} style={{minHeight:"100vh",background:"var(--ua-bg)",color:"var(--ua-text)",fontFamily:"'DM Sans',sans-serif"}}>
      <style>{CSS}</style>
      {notif&&<div className="toast" style={{background:notif.type==="ok"?"#4ECBA8":notif.type==="info"?"#5BB8D4":"#E8645A",color:"#0A0B10"}}>{notif.msg}</div>}
      {cfg.announcementOn&&cfg.announcementText&&<div style={{background:"rgba(212,168,83,0.1)",borderBottom:"1px solid rgba(212,168,83,0.22)",padding:"9px 24px",textAlign:"center",fontSize:13,color:"#D4A853",fontWeight:500}}>📢 {cfg.announcementText}</div>}
      {cfg.maintenanceMode&&<div style={{background:"rgba(232,100,90,0.1)",borderBottom:"1px solid rgba(232,100,90,0.22)",padding:"9px 24px",textAlign:"center",fontSize:13,color:"#E8645A",fontWeight:500}}>🔴 Platform is under maintenance — logins temporarily disabled.</div>}

      <nav className="nav">
        <div onClick={()=>setPage(adminIn?"admindash":auth?"dashboard":"landing")} style={{display:"flex",alignItems:"center",gap:11,cursor:"pointer",userSelect:"none"}}>
          <div className="nav-logo">U</div>
          <div>
            <div style={{fontFamily:"'Playfair Display',serif",fontSize:15,fontWeight:700,color:"var(--ua-text)",lineHeight:1}}>Universal Auditor</div>
            <div style={{fontSize:9,color:"var(--ua-sub)",letterSpacing:"0.18em",textTransform:"uppercase",marginTop:2,opacity:0.7}}>AI Compliance Engine</div>
          </div>
        </div>
        <div className="nav-actions" style={{marginLeft:"auto",display:"flex",gap:6,alignItems:"center",flexWrap:"wrap",minWidth:0}}>
          {adminIn?(<>
            <span className="nav-badge" style={{color:"#E8645A",borderColor:"rgba(232,100,90,0.3)",background:"rgba(232,100,90,0.06)"}}>🛡 ADMIN</span>
            <button className="btn-ghost" onClick={()=>setPage("admindash")} style={{fontSize:12}}>Dashboard</button>
            <button className="btn-ghost" onClick={doAdminOut} style={{fontSize:12,color:"#E8645A",borderColor:"rgba(232,100,90,0.25)"}}>Exit Admin</button>
          </>):auth?(<>
            {auth.plan==="trial"
            ? <span className="nav-badge" style={{color:trialHrs===0?"#E8645A":auditExhausted?"#D4A853":"#E8A83A",borderColor:trialHrs===0?"rgba(232,100,90,0.3)":auditExhausted?"rgba(212,168,83,0.3)":"rgba(232,168,58,0.3)",background:trialHrs===0?"rgba(232,100,90,0.06)":auditExhausted?"rgba(212,168,83,0.06)":"rgba(232,168,58,0.06)"}}>{trialHrs===0?"⚠ Expired":auditExhausted?"🎟 Limit reached":auditsLeft===Infinity?"⏱ "+trialHrs+"h left":"🎟 "+auditsLeft+" left"}</span>
            : <span className="nav-badge" style={{color:"#4ECBA8",borderColor:"rgba(78,203,168,0.3)",background:"rgba(78,203,168,0.06)"}}>✓ {auth.plan.charAt(0).toUpperCase()+auth.plan.slice(1)}</span>
          }
            <button className="btn-ghost nav-secondary" onClick={()=>{setHist(DB.getHistory(auth.id));setPage("history");}} style={{fontSize:12}}>📂 History</button>
            <button className="btn-ghost nav-secondary" onClick={()=>setPage("compare")} style={{fontSize:12}}>⚖ Compare</button>
            <button className="btn-ghost nav-secondary" onClick={()=>setModal("help")} style={{fontSize:12}}>Help</button>
            <button className="btn-ghost" onClick={()=>{setFeedbackCtx({source:"nav"});setModal("feedback");}} style={{fontSize:12,padding:"7px 12px"}} aria-label="Open feedback">💬</button>
            <button className="btn-ghost" onClick={()=>setPage("settings")} style={{fontSize:12}} aria-label="Settings">⚙️</button>
            <button className="btn-ghost" onClick={()=>setTheme(t=>t==="dark"?"light":"dark")} style={{fontSize:14,padding:"7px 10px"}} title="Toggle theme" aria-label={theme==="dark"?"Switch to light mode":"Switch to dark mode"}>{theme==="dark"?"☀️":"🌙"}</button>
            <button className="btn-primary" onClick={goAudit} style={{padding:"8px 18px",fontSize:13}}>+ New Audit</button>
            <button className="btn-ghost" onClick={doLogout} style={{fontSize:12}}>Logout</button>
          </>):(<>
            <button className="btn-ghost" onClick={()=>setModal("help")} style={{fontSize:12}}>Help</button>
            <button className="btn-ghost" onClick={()=>setTheme(t=>t==="dark"?"light":"dark")} style={{fontSize:14,padding:"7px 10px"}} title="Toggle theme">{theme==="dark"?"☀️":"🌙"}</button>
            <button className="btn-ghost" onClick={()=>setPage("login")} style={{fontSize:12}}>Log In</button>
            <button className="btn-primary" onClick={()=>setPage("signup")} style={{padding:"8px 20px",fontSize:13}}>Free Trial →</button>
          </>)}
        </div>
      </nav>

      {/* Floating Feedback Button — shown when logged in, not in modals */}
      {auth&&!modal&&(
        <button className="fab-feedback" onClick={()=>{setFeedbackCtx({source:"floating"});setModal("feedback");}}>
          <span style={{fontSize:16}}>💬</span>
          <span>Feedback</span>
        </button>
      )}

      {page==="landing"   && <LandingPage pricing={cfg.pricing} onSignup={()=>setPage("signup")} onLogin={()=>setPage("login")} onHelp={()=>setModal("help")} onAdmin={()=>setPage("adminlogin")}/>}
      {page==="login"     && <AuthPage mode="login" onSwitch={()=>setPage("signup")} onForgot={()=>setPage("forgot")} onSubmit={async(_,email,pw)=>{
  try {
    const res = await fetch(process.env.NEXT_PUBLIC_API_URL + "/api/auth/login", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ email, password: pw })
    });

    let r = {};
    try {
      r = await res.json();
    } catch {
      return "Invalid server response";
    }

    if(!res.ok) return r.error || "Login failed";
    if(!r.token) return "Login failed: No token received";

    localStorage.setItem("ua_token", r.token);

    setAuth(r.user);
    setTok(r.token);

    setPage("dashboard");

    toast("Welcome back, " + r.user.name + "!");
    return null;

  } catch(e) {
    return "Network error";
  }
}}={async(_,email,pw)=>{ const res = await fetch(process.env.NEXT_PUBLIC_API_URL + "/api/auth/login", {
  method: "POST",
  headers: {"Content-Type":"application/json"},
  body: JSON.stringify({ email, password: pw })
});

const r = await res.json();

 setAuth(r.user);setTok(r.token);setPage("dashboard");toast("Welcome back, "+r.user.name+"!");return null; }}/>}
      {page==="forgot"    && <ForgotPage onBack={()=>setPage("login")} toast={toast}/>}
      {page==="signup"    && <AuthPage mode="signup" onSwitch={()=>setPage("login")} onSubmit={async(name,email,pw)=>{ const e=await DB.register(name,email,pw); if(e)return e; const info=DB.sendVerifyCode(email); setEmailVerif({email,name:info?.name||name,code:info?.code});setPage("emailverify");return null; }}/>}
      {page==="dashboard" && auth && <DashboardPage key={auth.plan+"-"+upgV} user={auth} trialHrs={trialHrs} isPaid={isPaid} inGrace={inGrace} graceMin={graceMin} isExpired={isExpired} auditsLeft={auditsLeft} auditExhausted={auditExhausted} onAudit={goAudit} onHistory={()=>{setHist(DB.getHistory(auth.id));setPage("history");}} onUpgrade={()=>setModal("payment")} onHelp={()=>setModal("help")} onPay={()=>setPage("paysetup")}/>}
      {page==="audit"     && <AuditPage auditS={auditS} fileRef={fileRef} initJuris={juris} isExpired={isExpired} fileMsg={fileMsg} onBack={()=>setPage(auth?"dashboard":"landing")} onChange={v=>{ if(typeof v==="object") setAuditS(s=>({...s,text:v.text,fileName:v.fileName})); else setAuditS(s=>({...s,text:v})); }} onNotes={v=>setAuditS(s=>({...s,extraNotes:v.slice(0,2000)}))} onFile={async e=>{const f=e.target.files[0];if(!f)return;try{const res=await readFile(f,setFileMsg);setAuditS(s=>({...s,text:res.text,fileName:res.fileName,err:null}));}catch(err){toast(err.message,"err");}finally{setFileMsg(null);}}} onError={msg=>toast(msg,"err")} onRun={runAudit}/>}
      {page==="result"    && auditS.result && <ResultPage result={auditS.result} tab={rTab} setTab={setRTab} votes={votes} setVotes={setVotes} onDownload={()=>setModal("download")} onNew={goAudit} onBack={()=>setPage("audit")} onFeedback={()=>{setFeedbackCtx({source:"result",auditScore:auditS.result?.compliance_score,auditDomain:auditS.result?.domain,subdomain:auditS.result?.subdomain});setModal("feedback");}}/>}
      {page==="history"   && <HistoryPage history={hist} onBack={()=>setPage("dashboard")}
          onDelete={id=>{if(auth){DB.deleteAudit(auth.id,id);setHist(DB.getHistory(auth.id));toast("Audit deleted.");}}}
          onClear={()=>{if(auth){DB.clearHistory(auth.id);setHist([]);toast("History cleared.");}}}
          onView={id=>{
            const detail=DB.getAuditDetail(id);
            if(!detail){toast("Full result not available for older audits.","err");return;}
            const dm=DOMAINS[detail.domain]||DOMAINS.legal;
            const full={...detail,dm,jurisdiction:{country:detail.jurisdiction?.country||"",state:detail.jurisdiction?.state||"",laws:detail.jurisdiction?.laws||""}};
            setAuditS(s=>({...s,result:full}));
            setRTab("findings"); setVotes({});
            setPage("result");
          }}
        />}
      {page==="emailverify" && emailVerif && <EmailVerifyPage email={emailVerif.email} name={emailVerif.name} initCode={emailVerif.code} onVerify={async(code)=>{ const ok=DB.verifyEmail(emailVerif.email,code); if(!ok)return "Invalid or expired code."; const r=await DB.login(emailVerif.email,null,true); if(r.err)return "Verification failed."; setAuth(r.user);setTok(r.token);setEmailVerif(null);setPage("dashboard");toast("Account verified! Trial started. 🎉");return null; }} onResend={()=>{ DB.sendVerifyCode(emailVerif.email); toast("New code generated.","info"); }} onBack={()=>{setEmailVerif(null);setPage("signup");}}/>}
      {page==="compare"  && auth && <ComparePage onBack={()=>setPage("dashboard")} isExpired={isExpired} isPaid={isPaid} auditExhausted={auditExhausted} onUpgrade={()=>setModal("payment")} onTrackUsage={()=>DB.incrementAuditCount(auth.id)} toast={toast}/>}
      {page==="settings"  && auth && <SettingsPage user={auth} isPaid={isPaid} onBack={()=>setPage("dashboard")} onUpgrade={()=>setModal("payment")} onLogout={doLogout}/>}
      {page==="paysetup"  && auth && <PaySetupPage onBack={()=>setPage("dashboard")} toast={toast}/>}
      {page==="adminlogin"&& <AdminLoginPage lock={aLock} onBack={()=>setPage("landing")} onLogin={async(u,p)=>{ if(aLock.until>now())return "Too many failed attempts. Try again later."; const ok=await verifyAdmin(u,p); if(ok){setAdminIn(true);setALock({count:0,until:0});setPage("admindash");toast("Admin access granted.","info");return null;} const c=aLock.count+1; setALock({count:c,until:c>=5?now()+300000:0}); return c>=5?"Locked for 5 min.":`Wrong credentials. ${5-c} left.`; }}/>}
      {page==="admindash" && adminIn  && <AdminDashPage onLogout={doAdminOut} toast={toast} onCfgChange={()=>setCfgState(DB.getCfg())}/>}
      {page==="admindash" && !adminIn && (()=>{setTimeout(()=>setPage("adminlogin"),0);return null;})()}

      {modal==="payment"  && <PaymentModal pricing={cfg.pricing} onClose={()=>setModal(null)} onSuccess={plan=>{
        if(auth){
          DB.upgrade(auth.id, plan);
          // Refresh auth from DB to pick up any other changes
          const fresh = DB.getUser(auth.id);
          setAuth({id:fresh.id, email:fresh.email, name:fresh.name, plan:fresh.plan, trialEnd:fresh.trialEnd});
        }
        setUpgV(v => v + 1);
        setModal(null);
        setPage("dashboard");
        toast("🎉 Upgraded to "+plan.charAt(0).toUpperCase()+plan.slice(1)+"! Full access active.");
      }}/>}
      {modal==="help"     && <HelpModal onClose={()=>setModal(null)}/>}
      {modal==="feedback"  && <FeedbackModal
        onClose={()=>setModal(null)}
        ctx={feedbackCtx}
        user={auth}
        onSubmit={fb=>{
          DB.saveFeedback({...fb, userName:auth?.name||"Guest", userEmail:auth?.email||"", userId:auth?.id||""});
          // NOTE: do NOT close modal here — let FeedbackModal advance to step 3 (thank you screen)
          // Modal closes when user clicks "Done" on step 3
          toast("Thank you for your feedback! 🙏","ok");
        }}
      />}
      {modal==="download" && auditS.result && <DownloadModal onClose={()=>setModal(null)} onTxt={()=>{dlTxt(auditS.result);setModal(null);toast("Report downloaded!");}} onJson={()=>{dlJson(auditS.result);setModal(null);toast("JSON downloaded!");}}/>}
      {modal==="exhausted" && <Modal onClose={()=>setModal(null)} title="Audit Limit Reached"><div style={{textAlign:"center",padding:"20px 0 10px"}}><div style={{fontSize:48,marginBottom:14}}>🎟</div><div style={{fontFamily:"'Playfair Display',serif",fontSize:18,fontWeight:700,color:"#D4A853",marginBottom:10}}>Free audit limit reached</div><p style={{color:"var(--ua-sub)",lineHeight:1.75,marginBottom:6,fontSize:13}}>You've used your free trial audits. Your trial time is still running.</p><p style={{color:"var(--ua-sub)",lineHeight:1.75,marginBottom:22,fontSize:13}}>Upgrade to unlock unlimited audits and use the rest of your trial.</p><button className="btn-primary" onClick={()=>setModal("payment")} style={{padding:"13px 40px",fontSize:14}}>Upgrade Now →</button></div></Modal>}
      {modal==="expired"  && <Modal onClose={()=>setModal(null)} title="Trial Expired"><div style={{textAlign:"center",padding:"20px 0 10px"}}><div style={{fontSize:48,marginBottom:14}}>🚫</div><div style={{fontFamily:"'Playfair Display',serif",fontSize:18,fontWeight:700,color:"var(--ua-text)",marginBottom:10}}>Trial & grace period ended</div><p style={{color:"var(--ua-sub)",lineHeight:1.75,marginBottom:6,fontSize:13}}>Your 24-hour trial and 2-hour grace period have both expired.</p><p style={{color:"var(--ua-sub)",lineHeight:1.75,marginBottom:22,fontSize:13}}>Upgrade now to restore full audit access immediately.</p><button className="btn-primary" onClick={()=>setModal("payment")} style={{padding:"13px 40px",fontSize:14,background:"linear-gradient(135deg,#E8645A,#C9184A)"}}>View Plans →</button></div></Modal>}
    </div>
  );
}

/* ══════════════ LANDING ══════════════ */
function useCounter(target, duration=1800, start=false) {
  const [count, setCount] = useState(0);
  useEffect(()=>{
    if(!start) return;
    let raf=0, startTime=null;
    const step=(ts)=>{
      if(!startTime) startTime=ts;
      const progress=Math.min((ts-startTime)/duration,1);
      setCount(Math.floor(progress*target));
      if(progress<1) raf=requestAnimationFrame(step);
    };
    raf=requestAnimationFrame(step);
    return ()=>cancelAnimationFrame(raf); // cleanup on unmount
  },[target,duration,start]);
  return count;
}

function LandingPage({pricing,onSignup,onLogin,onHelp,onAdmin}) {
  const [statsVis, setStatsVis] = useState(false);
  const statsRef = useRef(null);
  useEffect(()=>{
    const obs = new IntersectionObserver(([e])=>{ if(e.isIntersecting) setStatsVis(true); },{threshold:0.3});
    if(statsRef.current) obs.observe(statsRef.current);
    return ()=>obs.disconnect();
  },[]);
  const c1=useCounter(10000,1800,statsVis), c2=useCounter(38,1200,statsVis), c3=useCounter(700,1600,statsVis);
  return (
    <div className="page-fade">
      <section className="hero">
        <div className="hero-grid-bg"/>
        <div className="orb o1"/><div className="orb o2"/><div className="orb o3"/>
        <div style={{position:"relative",zIndex:2,maxWidth:720,margin:"0 auto",textAlign:"center"}}>
          <div className="eyebrow">✦ 1-Day Free Trial · No Credit Card Required ✦</div>
          <h1 className="hero-h1">One document.<br/><em className="gradient-text">Eight specialists.</em><br/><span style={{color:"var(--ua-text)"}}>Zero guessing.</span></h1>
          <p className="hero-sub">Drop any document — contract, medical record, financial ledger, floor plan. AI routes it to the right specialist and returns a citation-backed compliance audit in seconds.</p>
          <div style={{display:"flex",gap:14,justifyContent:"center",flexWrap:"wrap",marginBottom:16}}>
            <button className="btn-primary" style={{padding:"15px 42px",fontSize:15}} onClick={onSignup}>Start Free Trial →</button>
            <button className="btn-outline" style={{padding:"15px 30px",fontSize:15}} onClick={onLogin}>Log In</button>
          </div>
          <p style={{fontSize:11,color:"var(--ua-sub)",letterSpacing:"0.08em"}}>24 hours full access · cancel anytime</p>
        </div>

        {/* Hero illustration — hidden on phones via CSS */}
        <div className="hero-illustration" style={{position:"relative",zIndex:2,maxWidth:680,margin:"40px auto 0",padding:"0 16px"}}>
          <svg viewBox="0 0 680 280" fill="none" xmlns="http://www.w3.org/2000/svg" style={{width:"100%",height:"auto"}}>
            {/* Background glow */}
            <defs>
              <radialGradient id="g1" cx="50%" cy="50%" r="50%"><stop offset="0%" stopColor="#D4A853" stopOpacity="0.12"/><stop offset="100%" stopColor="#D4A853" stopOpacity="0"/></radialGradient>
              <radialGradient id="g2" cx="50%" cy="50%" r="50%"><stop offset="0%" stopColor="#9B7FE8" stopOpacity="0.1"/><stop offset="100%" stopColor="#9B7FE8" stopOpacity="0"/></radialGradient>
              <radialGradient id="g3" cx="50%" cy="50%" r="50%"><stop offset="0%" stopColor="#4ECBA8" stopOpacity="0.1"/><stop offset="100%" stopColor="#4ECBA8" stopOpacity="0"/></radialGradient>
            </defs>
            <ellipse cx="340" cy="140" rx="200" ry="100" fill="url(#g1)"/>
            {/* Document A */}
            <rect x="30" y="40" width="140" height="180" rx="8" fill="#12131B" stroke="rgba(212,168,83,0.35)" strokeWidth="1.5"/>
            <rect x="44" y="58" width="112" height="8" rx="3" fill="#D4A853" opacity="0.7"/>
            <rect x="44" y="72" width="90" height="5" rx="2" fill="rgba(255,255,255,0.12)"/>
            <rect x="44" y="82" width="100" height="5" rx="2" fill="rgba(255,255,255,0.08)"/>
            <rect x="44" y="92" width="75" height="5" rx="2" fill="rgba(255,255,255,0.08)"/>
            <rect x="44" y="110" width="112" height="1" fill="rgba(255,255,255,0.06)"/>
            <rect x="44" y="118" width="95" height="5" rx="2" fill="rgba(255,255,255,0.1)"/>
            <rect x="44" y="128" width="85" height="5" rx="2" fill="rgba(255,255,255,0.08)"/>
            <rect x="44" y="138" width="105" height="5" rx="2" fill="rgba(255,255,255,0.08)"/>
            <rect x="44" y="148" width="70" height="5" rx="2" fill="rgba(255,255,255,0.08)"/>
            <rect x="44" y="166" width="112" height="1" fill="rgba(255,255,255,0.06)"/>
            <rect x="44" y="174" width="80" height="5" rx="2" fill="rgba(232,100,90,0.5)"/>
            <rect x="44" y="184" width="100" height="5" rx="2" fill="rgba(232,168,58,0.4)"/>
            <rect x="44" y="194" width="60" height="5" rx="2" fill="rgba(78,203,168,0.5)"/>
            <text x="100" y="226" textAnchor="middle" fill="rgba(212,168,83,0.6)" fontSize="9" fontFamily="monospace">CONTRACT.PDF</text>
            {/* Flow arrows */}
            <path d="M175 140 Q220 120 255 140" stroke="rgba(212,168,83,0.4)" strokeWidth="1.5" strokeDasharray="4 3" fill="none"/>
            <polygon points="253,134 261,140 253,146" fill="rgba(212,168,83,0.4)"/>
            {/* AI Brain - centre */}
            <circle cx="340" cy="140" r="48" fill="#12131B" stroke="rgba(155,127,232,0.4)" strokeWidth="1.5"/>
            <circle cx="340" cy="140" r="38" fill="rgba(155,127,232,0.05)" stroke="rgba(155,127,232,0.2)" strokeWidth="1" strokeDasharray="3 3"/>
            <text x="340" y="132" textAnchor="middle" fill="#9B7FE8" fontSize="22">🧠</text>
            <text x="340" y="150" textAnchor="middle" fill="rgba(155,127,232,0.8)" fontSize="7" fontFamily="monospace">CLAUDE AI</text>
            <text x="340" y="161" textAnchor="middle" fill="rgba(155,127,232,0.6)" fontSize="7" fontFamily="monospace">COMPLIANCE</text>
            {/* Orbiting domain dots */}
            <circle cx="340" cy="88" r="6" fill="#D4A853" opacity="0.9"/><text x="340" y="91" textAnchor="middle" fill="#0A0B10" fontSize="7">⚖</text>
            <circle cx="385" cy="104" r="6" fill="#E8645A" opacity="0.9"/><text x="385" y="107" textAnchor="middle" fill="#0A0B10" fontSize="7">🏥</text>
            <circle cx="392" cy="155" r="6" fill="#4ECBA8" opacity="0.9"/><text x="392" y="158" textAnchor="middle" fill="#0A0B10" fontSize="7">📊</text>
            <circle cx="360" cy="188" r="6" fill="#E8A83A" opacity="0.9"/><text x="360" y="191" textAnchor="middle" fill="#0A0B10" fontSize="7">🏗</text>
            <circle cx="318" cy="188" r="6" fill="#9B7FE8" opacity="0.9"/><text x="318" y="191" textAnchor="middle" fill="#0A0B10" fontSize="7">🔐</text>
            <circle cx="288" cy="155" r="6" fill="#5BB8D4" opacity="0.9"/><text x="288" y="158" textAnchor="middle" fill="#0A0B10" fontSize="7">👥</text>
            <circle cx="295" cy="104" r="6" fill="#6BCF7F" opacity="0.9"/><text x="295" y="107" textAnchor="middle" fill="#0A0B10" fontSize="7">🍽</text>
            {/* Flow to report */}
            <path d="M390 140 Q430 120 460 140" stroke="rgba(78,203,168,0.4)" strokeWidth="1.5" strokeDasharray="4 3" fill="none"/>
            <polygon points="458,134 466,140 458,146" fill="rgba(78,203,168,0.4)"/>
            {/* Report card */}
            <rect x="470" y="40" width="180" height="200" rx="8" fill="#12131B" stroke="rgba(78,203,168,0.35)" strokeWidth="1.5"/>
            <rect x="484" y="58" width="100" height="8" rx="3" fill="rgba(78,203,168,0.6)"/>
            <rect x="484" y="72" width="60" height="6" rx="2" fill="rgba(255,255,255,0.06)"/>
            {/* Score ring */}
            <circle cx="616" cy="75" r="18" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="3"/>
            <circle cx="616" cy="75" r="18" fill="none" stroke="#4ECBA8" strokeWidth="3" strokeDasharray="85 28" strokeLinecap="round" transform="rotate(-90 616 75)"/>
            <text x="616" y="79" textAnchor="middle" fill="#4ECBA8" fontSize="9" fontWeight="bold">87</text>
            {/* Findings */}
            <rect x="484" y="100" width="152" height="1" fill="rgba(255,255,255,0.06)"/>
            <rect x="484" y="110" width="8" height="8" rx="1" fill="rgba(78,203,168,0.5)"/>
            <rect x="496" y="112" width="100" height="4" rx="2" fill="rgba(78,203,168,0.3)"/>
            <rect x="484" y="125" width="8" height="8" rx="1" fill="rgba(232,168,58,0.6)"/>
            <rect x="496" y="127" width="85" height="4" rx="2" fill="rgba(232,168,58,0.25)"/>
            <rect x="484" y="140" width="8" height="8" rx="1" fill="rgba(232,100,90,0.7)"/>
            <rect x="496" y="142" width="110" height="4" rx="2" fill="rgba(232,100,90,0.25)"/>
            <rect x="484" y="157" width="8" height="8" rx="1" fill="rgba(78,203,168,0.5)"/>
            <rect x="496" y="159" width="90" height="4" rx="2" fill="rgba(78,203,168,0.25)"/>
            <rect x="484" y="172" width="152" height="1" fill="rgba(255,255,255,0.06)"/>
            {/* Citation */}
            <rect x="484" y="180" width="12" height="12" rx="2" fill="rgba(212,168,83,0.15)"/>
            <text x="490" y="189" textAnchor="middle" fill="#D4A853" fontSize="8" fontWeight="bold">§</text>
            <rect x="500" y="182" width="90" height="4" rx="2" fill="rgba(212,168,83,0.2)"/>
            <rect x="500" y="190" width="70" height="4" rx="2" fill="rgba(212,168,83,0.15)"/>
            {/* PASS badge */}
            <rect x="484" y="206" width="35" height="16" rx="4" fill="rgba(78,203,168,0.15)" stroke="rgba(78,203,168,0.35)" strokeWidth="1"/>
            <text x="501" y="217" textAnchor="middle" fill="#4ECBA8" fontSize="7" fontWeight="bold">PASS</text>
            <rect x="525" y="206" width="35" height="16" rx="4" fill="rgba(232,100,90,0.12)" stroke="rgba(232,100,90,0.3)" strokeWidth="1"/>
            <text x="542" y="217" textAnchor="middle" fill="#E8645A" fontSize="7" fontWeight="bold">FAIL</text>
            <rect x="566" y="206" width="50" height="16" rx="4" fill="rgba(232,168,58,0.12)" stroke="rgba(232,168,58,0.3)" strokeWidth="1"/>
            <text x="591" y="217" textAnchor="middle" fill="#E8A83A" fontSize="7" fontWeight="bold">REVIEW</text>
            <text x="560" y="245" textAnchor="middle" fill="rgba(78,203,168,0.5)" fontSize="8" fontFamily="monospace">AUDIT REPORT</text>
            {/* Connecting lines from AI */}
            <path d="M320 96 L340 88" stroke="rgba(155,127,232,0.3)" strokeWidth="1"/>
            <path d="M360 96 L385 104" stroke="rgba(155,127,232,0.3)" strokeWidth="1"/>
            <path d="M388 140 L392 155" stroke="rgba(155,127,232,0.3)" strokeWidth="1"/>
            <path d="M380 172 L360 188" stroke="rgba(155,127,232,0.3)" strokeWidth="1"/>
            <path d="M340 188 L318 188" stroke="rgba(155,127,232,0.3)" strokeWidth="1"/>
            <path d="M300 172 L288 155" stroke="rgba(155,127,232,0.3)" strokeWidth="1"/>
            <path d="M300 106 L295 104" stroke="rgba(155,127,232,0.3)" strokeWidth="1"/>
          </svg>
        </div>
      </section>
      <section className="section" ref={statsRef} style={{paddingBottom:30,paddingTop:10}}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:16,maxWidth:640,margin:"0 auto",textAlign:"center"}}>
          {[
            {count:statsVis?c1.toLocaleString():"—",suffix:"+",label:"Documents Audited",color:"#D4A853"},
            {count:statsVis?c2:"—",suffix:"",label:"Jurisdictions",color:"#4ECBA8"},
            {count:statsVis?c3+"+":"—",suffix:"",label:"Laws Auto-Applied",color:"#9B7FE8"},
          ].map((s,i)=>(
            <div key={i} style={{padding:"18px 12px",background:"var(--ua-card)",border:"1px solid var(--ua-border)",borderRadius:14}}>
              <div style={{fontFamily:"'Playfair Display',serif",fontSize:"clamp(24px,5vw,36px)",fontWeight:900,color:s.color,lineHeight:1}}>{s.count}{s.suffix}</div>
              <div style={{fontSize:11,color:"var(--ua-sub)",marginTop:5,letterSpacing:"0.06em"}}>{s.label}</div>
            </div>
          ))}
        </div>
      </section>
      <section className="section">
        <div className="section-label">How It Works</div>
        <div className="pipeline-row">
          {[["📄","Your Document","#D4A853"],["🌍","Jurisdiction","#5BB8D4"],["🧠","Specialist Audit","#E8645A"],["👤","HITL Review","#4ECBA8"],["📋","Cited Report","#9B7FE8"]].map(([ic,lb,col],i,arr)=>(
            <div key={i} style={{display:"flex",alignItems:"center",gap:8}}>
              <div className="pipeline-step" style={{"--pc":col}}><span style={{fontSize:24,display:"block",marginBottom:8}}>{ic}</span><span style={{fontSize:11,color:col,fontWeight:600,letterSpacing:"0.04em"}}>{lb}</span></div>
              {i<arr.length-1&&<span style={{color:"var(--ua-sub)",fontSize:20,flexShrink:0}}>›</span>}
            </div>
          ))}
        </div>
      </section>
      <section className="section" style={{paddingBottom:40}}>
        <div className="section-label">How the AI Engine Works</div>
        <div style={{background:"var(--ua-card)",border:"1px solid rgba(255,255,255,0.06)",borderRadius:20,padding:"32px 28px",maxWidth:860,margin:"0 auto"}}>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:24}}>
            {[
              {icon:<svg width="48" height="48" viewBox="0 0 48 48" fill="none"><rect x="6" y="8" width="36" height="32" rx="4" stroke="#D4A853" strokeWidth="2"/><line x1="13" y1="17" x2="35" y2="17" stroke="#D4A853" strokeWidth="1.5" strokeLinecap="round"/><line x1="13" y1="22" x2="35" y2="22" stroke="#D4A853" strokeWidth="1.5" strokeLinecap="round"/><line x1="13" y1="27" x2="26" y2="27" stroke="#D4A853" strokeWidth="1.5" strokeLinecap="round"/><circle cx="38" cy="36" r="7" fill="#D4A85322" stroke="#D4A853" strokeWidth="1.5"/><path d="M35.5 36l1.5 1.5 3-3" stroke="#D4A853" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>,title:"1. Upload Document",desc:"Drop any PDF, TXT, or document. Text is extracted securely in your browser — never uploaded to our servers."},
              {icon:<svg width="48" height="48" viewBox="0 0 48 48" fill="none"><circle cx="24" cy="24" r="16" stroke="#9B7FE8" strokeWidth="2"/><path d="M17 24c0-3.866 3.134-7 7-7s7 3.134 7 7-3.134 7-7 7-7-3.134-7-7z" stroke="#9B7FE8" strokeWidth="1.5"/><circle cx="24" cy="24" r="3" fill="#9B7FE8"/><line x1="24" y1="8" x2="24" y2="12" stroke="#9B7FE8" strokeWidth="1.5" strokeLinecap="round"/><line x1="24" y1="36" x2="24" y2="40" stroke="#9B7FE8" strokeWidth="1.5" strokeLinecap="round"/><line x1="8" y1="24" x2="12" y2="24" stroke="#9B7FE8" strokeWidth="1.5" strokeLinecap="round"/><line x1="36" y1="24" x2="40" y2="24" stroke="#9B7FE8" strokeWidth="1.5" strokeLinecap="round"/></svg>,title:"2. Domain Detection",desc:"Claude AI reads the document and automatically identifies the domain — legal, medical, financial, privacy, and more."},
              {icon:<svg width="48" height="48" viewBox="0 0 48 48" fill="none"><rect x="8" y="6" width="32" height="36" rx="4" stroke="#4ECBA8" strokeWidth="2"/><path d="M16 16h16M16 22h16M16 28h10" stroke="#4ECBA8" strokeWidth="1.5" strokeLinecap="round"/><circle cx="36" cy="36" r="8" fill="#0A0B10" stroke="#4ECBA8" strokeWidth="1.5"/><path d="M33 36l2 2 4-4" stroke="#4ECBA8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>,title:"3. Law Auto-Applied",desc:"38 jurisdictions and 700+ laws are matched instantly. The right regulatory framework is applied — no manual selection needed."},
              {icon:<svg width="48" height="48" viewBox="0 0 48 48" fill="none"><circle cx="24" cy="16" r="8" stroke="#E8645A" strokeWidth="2"/><path d="M10 40c0-7.732 6.268-14 14-14s14 6.268 14 14" stroke="#E8645A" strokeWidth="2" strokeLinecap="round"/><path d="M20 36l3 3 6-6" stroke="#E8645A" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>,title:"4. HITL Review",desc:"Low-confidence findings are flagged for Human-in-the-Loop review. You confirm or reject each finding manually."},
              {icon:<svg width="48" height="48" viewBox="0 0 48 48" fill="none"><rect x="6" y="8" width="36" height="32" rx="4" stroke="#E8A83A" strokeWidth="2"/><path d="M13 17h8M13 22h22M13 27h18M13 32h12" stroke="#E8A83A" strokeWidth="1.5" strokeLinecap="round"/><circle cx="35" cy="15" r="5" fill="#E8A83A22" stroke="#E8A83A" strokeWidth="1.5"/><text x="33" y="18" fill="#E8A83A" fontSize="6" fontWeight="bold">§</text></svg>,title:"5. Cited Report",desc:"Every finding includes a precise legal citation. Download as TXT or JSON, or email the report directly from the app."},
            ].map((item,i)=>(
              <div key={i} style={{textAlign:"center",padding:"8px 12px"}}>
                <div style={{display:"flex",justifyContent:"center",marginBottom:14}}>{item.icon}</div>
                <div style={{fontFamily:"'Playfair Display',serif",fontSize:14,fontWeight:700,color:"var(--ua-text)",marginBottom:8,lineHeight:1.3}}>{item.title}</div>
                <div style={{fontSize:12,color:"var(--ua-sub)",lineHeight:1.7}}>{item.desc}</div>
              </div>
            ))}
          </div>
          <div style={{marginTop:28,padding:"14px 18px",background:"rgba(212,168,83,0.06)",border:"1px solid rgba(212,168,83,0.15)",borderRadius:12,display:"flex",gap:12,alignItems:"center"}}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke="#D4A853" strokeWidth="2" fill="rgba(212,168,83,0.1)"/><path d="M9 12l2 2 4-4" stroke="#D4A853" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            <div style={{fontSize:12,color:"#D4A853",lineHeight:1.65}}><strong>Privacy first:</strong> Document text is processed in your browser. Only the text you submit is sent to the AI — no file uploads, no server storage, no tracking.</div>
          </div>
        </div>
      </section>
      <section className="section">
        <div className="section-label">8 Specialist Modules</div>
        <div className="domain-grid">
          {[
            {key:"legal",icon:"⚖️",label:"Legal / Contract",specialist:"The Lawyer",color:"#D4A853",svg:<svg width="36" height="36" viewBox="0 0 36 36" fill="none"><path d="M18 4l2 8h8l-6.5 4.7 2.5 8L18 20.2l-6 4.5 2.5-8L8 12h8z" stroke="#D4A853" strokeWidth="1.2" fill="rgba(212,168,83,0.08)"/><line x1="18" y1="24" x2="18" y2="32" stroke="#D4A853" strokeWidth="1.2"/><line x1="10" y1="32" x2="26" y2="32" stroke="#D4A853" strokeWidth="1.2" strokeLinecap="round"/></svg>},
            {key:"medical",icon:"🏥",label:"Medical / Clinical",specialist:"The Clinician",color:"#E8645A",svg:<svg width="36" height="36" viewBox="0 0 36 36" fill="none"><rect x="13" y="6" width="10" height="24" rx="2" fill="rgba(232,100,90,0.08)" stroke="#E8645A" strokeWidth="1.2"/><rect x="6" y="13" width="24" height="10" rx="2" fill="rgba(232,100,90,0.08)" stroke="#E8645A" strokeWidth="1.2"/></svg>},
            {key:"financial",icon:"📊",label:"Financial",specialist:"The Accountant",color:"#4ECBA8",svg:<svg width="36" height="36" viewBox="0 0 36 36" fill="none"><rect x="6" y="22" width="5" height="10" rx="1" fill="rgba(78,203,168,0.5)"/><rect x="14" y="16" width="5" height="16" rx="1" fill="rgba(78,203,168,0.7)"/><rect x="22" y="10" width="5" height="22" rx="1" fill="#4ECBA8"/><path d="M6 20 Q13 8 22 8 L28 4" stroke="#4ECBA8" strokeWidth="1.2" strokeLinecap="round" fill="none"/></svg>},
            {key:"construction",icon:"🏗️",label:"Construction",specialist:"The Inspector",color:"#E8A83A",svg:<svg width="36" height="36" viewBox="0 0 36 36" fill="none"><path d="M8 28 L8 14 L18 8 L28 14 L28 28" stroke="#E8A83A" strokeWidth="1.2" strokeLinejoin="round" fill="rgba(232,168,58,0.06)"/><rect x="14" y="20" width="8" height="8" rx="1" stroke="#E8A83A" strokeWidth="1.2" fill="rgba(232,168,58,0.1)"/><path d="M8 28 L28 28" stroke="#E8A83A" strokeWidth="1.2"/></svg>},
            {key:"privacy",icon:"🔐",label:"Privacy / Data",specialist:"Privacy Counsel",color:"#9B7FE8",svg:<svg width="36" height="36" viewBox="0 0 36 36" fill="none"><path d="M18 4 L28 8 L28 18 C28 24 23 28.5 18 31 C13 28.5 8 24 8 18 L8 8 Z" stroke="#9B7FE8" strokeWidth="1.2" fill="rgba(155,127,232,0.08)"/><circle cx="18" cy="17" r="3" stroke="#9B7FE8" strokeWidth="1.2"/><path d="M18 20 L18 24" stroke="#9B7FE8" strokeWidth="1.2" strokeLinecap="round"/></svg>},
            {key:"hr",icon:"👥",label:"HR / Employment",specialist:"The HR Auditor",color:"#5BB8D4",svg:<svg width="36" height="36" viewBox="0 0 36 36" fill="none"><circle cx="13" cy="12" r="5" stroke="#5BB8D4" strokeWidth="1.2" fill="rgba(91,184,212,0.08)"/><circle cx="24" cy="12" r="5" stroke="#5BB8D4" strokeWidth="1.2" fill="rgba(91,184,212,0.08)"/><path d="M4 28 C4 22 8 18 13 18" stroke="#5BB8D4" strokeWidth="1.2" strokeLinecap="round" fill="none"/><path d="M32 28 C32 22 28 18 23 18" stroke="#5BB8D4" strokeWidth="1.2" strokeLinecap="round" fill="none"/><path d="M13 18 C15 17 21 17 23 18 C25 20 26 23 26 28" stroke="#5BB8D4" strokeWidth="1.2" strokeLinecap="round" fill="none"/></svg>},
            {key:"food",icon:"🍽️",label:"Food Safety",specialist:"The Food Inspector",color:"#6BCF7F",svg:<svg width="36" height="36" viewBox="0 0 36 36" fill="none"><circle cx="18" cy="18" r="11" stroke="#6BCF7F" strokeWidth="1.2" fill="rgba(107,207,127,0.06)"/><path d="M12 16 C12 12 16 10 18 10 C20 10 24 12 24 16 C24 20 20 22 18 22 C16 22 12 20 12 16" stroke="#6BCF7F" strokeWidth="1.1" fill="none"/><path d="M18 22 L18 28" stroke="#6BCF7F" strokeWidth="1.2" strokeLinecap="round"/><path d="M14 28 L22 28" stroke="#6BCF7F" strokeWidth="1.2" strokeLinecap="round"/></svg>},
            {key:"software",icon:"💻",label:"Software / Security",specialist:"Security Auditor",color:"#F07B4A",svg:<svg width="36" height="36" viewBox="0 0 36 36" fill="none"><rect x="5" y="8" width="26" height="18" rx="3" stroke="#F07B4A" strokeWidth="1.2" fill="rgba(240,123,74,0.06)"/><path d="M12 30 L24 30 M18 26 L18 30" stroke="#F07B4A" strokeWidth="1.2" strokeLinecap="round"/><text x="11" y="21" fill="#F07B4A" fontSize="8" fontFamily="monospace" opacity="0.9">&lt;/&gt;</text></svg>},
          ].map((d,i)=>(
            <div key={i} className="domain-card" style={{"--dc":d.color}}>
              <div style={{marginBottom:10,opacity:0.9}}>{d.svg}</div>
              <div style={{fontFamily:"'Playfair Display',serif",fontSize:13,fontWeight:700,color:d.color,marginBottom:3}}>{d.label}</div>
              <div style={{fontSize:11,color:"var(--ua-sub)"}}>{d.specialist}</div>
            </div>
          ))}
        </div>
      </section>
      <section className="section" style={{paddingBottom:40}}>
        <div className="section-label">Sample Audit Result</div>
        <div style={{maxWidth:700,margin:"0 auto",background:"var(--ua-card)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:18,overflow:"hidden"}}>
          {/* Mock result header */}
          <div style={{background:"rgba(78,203,168,0.05)",borderBottom:"1px solid rgba(78,203,168,0.15)",padding:"16px 18px",display:"flex",gap:14,alignItems:"flex-start",flexWrap:"wrap"}}>
            <div style={{width:72,height:72,borderRadius:"50%",border:"4px solid rgba(78,203,168,0.2)",flexShrink:0,position:"relative",display:"flex",alignItems:"center",justifyContent:"center"}}>
              <svg viewBox="0 0 72 72" style={{position:"absolute",inset:0}} fill="none"><circle cx="36" cy="36" r="28" stroke="rgba(78,203,168,0.1)" strokeWidth="5"/><circle cx="36" cy="36" r="28" stroke="#4ECBA8" strokeWidth="5" strokeDasharray="132 44" strokeLinecap="round" transform="rotate(-90 36 36)" style={{filter:"drop-shadow(0 0 6px rgba(78,203,168,0.4))"}}/></svg>
              <span style={{fontFamily:"'Playfair Display',serif",fontSize:20,fontWeight:900,color:"#4ECBA8",position:"relative",zIndex:1}}>87</span>
            </div>
            <div style={{flex:1,minWidth:0,overflow:"hidden"}}>
              <div style={{fontSize:10,letterSpacing:"0.14em",textTransform:"uppercase",color:"#4ECBA8",marginBottom:4}}>⚖️ Legal / Contract — Non-Disclosure Agreement</div>
              <div style={{fontSize:11,color:"var(--ua-sub)",marginBottom:8}}>🌍 United States · California</div>
              <p style={{fontSize:13,color:"var(--ua-sub)",lineHeight:1.7,margin:0}}>The NDA contains CCPA-compliant disclosure provisions but lacks explicit data deletion timelines required under CCPA §1798.105. Liability caps appear inadequate under California law precedent.</p>
            </div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              {[["3","PASS","#4ECBA8"],["2","FAIL","#E8645A"],["1","REVIEW","#E8A83A"]].map(([n,l,c])=>(
                <div key={l} style={{textAlign:"center",padding:"6px 12px",background:"var(--ua-card2)",border:"1px solid var(--ua-border)",borderRadius:8}}>
                  <div style={{fontFamily:"'Playfair Display',serif",fontSize:18,fontWeight:900,color:c,lineHeight:1}}>{n}</div>
                  <div style={{fontSize:9,color:"var(--ua-sub)",textTransform:"uppercase",letterSpacing:"0.1em",marginTop:2}}>{l}</div>
                </div>
              ))}
            </div>
          </div>
          {/* Mock findings */}
          <div style={{padding:"16px 22px 20px"}}>
            {[
              {id:"F001",status:"FAIL",sev:"High",rule:"CCPA §1798.105",color:"#E8645A",issue:"No data deletion timeline specified",fix:"Add explicit deletion deadline within 45 days of user request per CCPA §1798.105(d)"},
              {id:"F002",status:"PASS",sev:"Low",rule:"Cal. Civ. Code §1798.83",color:"#4ECBA8",issue:"Disclosure to third parties properly addressed",fix:"Compliant — no action required"},
              {id:"F003",status:"REVIEW",sev:"Medium",rule:"UCC §2-316",color:"#E8A83A",issue:"Liability cap language ambiguous",fix:"Clarify whether cap applies per-occurrence or in aggregate"},
            ].map((f,i)=>(
              <div key={i} style={{display:"flex",gap:12,alignItems:"flex-start",padding:"10px 12px",marginBottom:8,background:"var(--ua-card)",borderLeft:"3px solid "+f.color,borderRadius:"0 10px 10px 0"}}>
                <div style={{flexShrink:0,display:"flex",flexDirection:"column",gap:4,minWidth:56}}>
                  <span style={{fontSize:9,fontWeight:700,color:f.color,letterSpacing:"0.1em",background:"rgba(255,255,255,0.05)",padding:"2px 7px",borderRadius:4}}>{f.status}</span>
                  <span style={{fontSize:9,color:"var(--ua-sub)"}}>{f.id}</span>
                </div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:12,fontWeight:600,color:"var(--ua-text)",marginBottom:3}}>{f.rule}</div>
                  <div style={{fontSize:11,color:"#E8645A",marginBottom:3}}>⚠ {f.issue}</div>
                  <div style={{fontSize:11,color:"#4ECBA8"}}>✓ {f.fix}</div>
                </div>
              </div>
            ))}
            <div style={{marginTop:12,padding:"8px 12px",background:"rgba(212,168,83,0.04)",border:"1px solid rgba(212,168,83,0.12)",borderRadius:8,fontSize:11,color:"#D4A853",display:"flex",gap:8,alignItems:"center"}}>
              <span>§</span><span><strong>Citation:</strong> California Civil Code §1798.105(d); California Consumer Privacy Act 2018 as amended by CPRA 2020</span>
            </div>
          </div>
        </div>
        <p style={{textAlign:"center",fontSize:12,color:"var(--ua-sub)",marginTop:14}}>Real audit of your documents — in ~5–10 seconds</p>
      </section>

      {/* Testimonials */}
      <section className="section" style={{paddingBottom:48}}>
        <div className="section-label">What Users Say</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(240px,1fr))",gap:16,maxWidth:860,margin:"0 auto"}}>
          {[
            {quote:"Flagged a missing GDPR clause in our vendor contract in seconds. Saved us from a compliance fine.",name:"Sarah K.",role:"Legal Counsel, SaaS Startup",score:94,domain:"Legal"},
            {quote:"The HIPAA analysis caught consent language issues our team had missed for months. Incredible accuracy.",name:"Dr. M. Patel",role:"Healthcare Administrator",score:88,domain:"Medical"},
            {quote:"We run every financial disclosure through this before filing. The GAAP citations are precise.",name:"James W.",role:"CFO, Mid-market Firm",score:91,domain:"Financial"},
          ].map((t,i)=>(
            <div key={i} style={{background:"var(--ua-card)",border:"1px solid var(--ua-border)",borderRadius:16,padding:"20px 20px 16px",position:"relative",overflow:"hidden"}}>
              <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:"linear-gradient(90deg,#D4A853,#9B7FE8,#4ECBA8)"}}/>
              <div style={{display:"flex",gap:4,marginBottom:12}}>{[1,2,3,4,5].map(s=><span key={s} style={{color:"#D4A853",fontSize:13}}>★</span>)}</div>
              <p style={{fontSize:13,color:"var(--ua-text)",lineHeight:1.75,marginBottom:14,fontStyle:"italic"}}>"{t.quote}"</p>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",paddingTop:12,borderTop:"1px solid var(--ua-border)"}}>
                <div>
                  <div style={{fontSize:12,fontWeight:700,color:"var(--ua-text)"}}>{t.name}</div>
                  <div style={{fontSize:11,color:"var(--ua-sub)"}}>{t.role}</div>
                </div>
                <div style={{textAlign:"center",padding:"4px 10px",background:"rgba(78,203,168,0.1)",borderRadius:8}}>
                  <div style={{fontFamily:"'Playfair Display',serif",fontSize:16,fontWeight:900,color:"#4ECBA8",lineHeight:1}}>{t.score}</div>
                  <div style={{fontSize:8,color:"var(--ua-sub)",textTransform:"uppercase",letterSpacing:"0.06em"}}>score</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="section" style={{paddingBottom:80}}>
        <div className="section-label">Transparent Pricing</div>
        <div className="pricing-grid">
          {[
            {k:"individual",title:"Individual",price:"$"+(pricing?.individual??10),unit:"per doc",desc:"Contracts, personal docs, one-offs.",col:"#D4A853",perks:["Single document audit","TXT & JSON export","Full citations"]},
            {k:"sme",title:"SME",price:"$"+(pricing?.sme??500).toLocaleString(),unit:"/month",desc:"Teams, compliance officers, legal depts.",col:"#9B7FE8",perks:["Batch processing","HITL dashboard","Priority support"],hot:true},
            {k:"enterprise",title:"Enterprise",price:"$"+(pricing?.enterprise??5000).toLocaleString()+"+",unit:"/month",desc:"Law firms, healthcare, 10K docs/hr.",col:"#E8645A",perks:["Full API access","SLA guarantee","Custom modules"]},
          ].map(t=>(
            <div key={t.k} className="pricing-card" style={{"--pc":t.col}}>
              {t.hot&&<div className="pricing-badge" style={{background:t.col}}>MOST POPULAR</div>}
              <div style={{fontSize:10,letterSpacing:"0.18em",textTransform:"uppercase",color:t.col,marginBottom:10,fontWeight:600}}>{t.title}</div>
              <div style={{fontFamily:"'Playfair Display',serif",fontSize:36,fontWeight:900,color:"var(--ua-text)",lineHeight:1,marginBottom:4}}>{t.price}</div>
              <div style={{fontSize:12,color:"var(--ua-sub)",marginBottom:14}}>{t.unit}</div>
              <div style={{fontSize:13,color:"var(--ua-sub)",lineHeight:1.7,marginBottom:16,paddingBottom:16,borderBottom:"1px solid var(--ua-border)"}}>{t.desc}</div>
              {t.perks.map((p,j)=><div key={j} style={{display:"flex",gap:9,alignItems:"flex-start",marginBottom:8}}><span style={{color:t.col,fontSize:12,flexShrink:0}}>✓</span><span style={{fontSize:13,color:"var(--ua-sub)",lineHeight:1.5}}>{p}</span></div>)}
              <button className="btn-primary" onClick={onSignup} style={{width:"100%",padding:"11px",fontSize:13,marginTop:16,background:"linear-gradient(135deg,"+t.col+"CC,"+t.col+"88)"}}>Get Started →</button>
            </div>
          ))}
        </div>
      </section>
      {/* Trust strip */}
      <div style={{borderTop:"1px solid var(--ua-border)",borderBottom:"1px solid var(--ua-border)",padding:"20px 24px",maxWidth:920,margin:"0 auto"}}>
        <div style={{textAlign:"center",marginBottom:12}}>
          <span style={{fontSize:10,letterSpacing:"0.2em",textTransform:"uppercase",color:"var(--ua-sub)"}}>Frameworks & Standards Covered</span>
        </div>
        <div style={{display:"flex",gap:12,flexWrap:"wrap",justifyContent:"center",alignItems:"center"}}>
          {["GDPR","HIPAA","CCPA","SOC 2","ISO 27001","OSHA","GAAP","NIST"].map(badge=>(
            <div key={badge} style={{padding:"5px 14px",background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:100,fontSize:11,color:"var(--ua-sub)",fontWeight:600,letterSpacing:"0.04em",fontFamily:"'DM Sans',sans-serif"}}>{badge}</div>
          ))}
        </div>
      </div>

      <footer style={{borderTop:"1px solid rgba(255,255,255,0.04)",padding:"26px 24px",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12,maxWidth:920,margin:"0 auto"}}>
        <div style={{fontSize:12,color:"var(--ua-sub)"}}>© {new Date().getFullYear()} Universal Auditor · AI Compliance Engine</div>
        <div style={{display:"flex",gap:14,alignItems:"center"}}>
          <button className="btn-ghost" onClick={onHelp} style={{fontSize:12,padding:"7px 14px"}}>Help & Support</button>
          <a href="mailto:support@universalauditor.app?subject=Feedback" style={{fontSize:10,color:"var(--ua-sub)",textDecoration:"none",fontFamily:"inherit",letterSpacing:"0.04em"}}>💬 Send Feedback</a>
          <button onClick={onAdmin} style={{background:"none",border:"none",fontSize:10,color:"var(--ua-sub)",cursor:"pointer",fontFamily:"inherit",letterSpacing:"0.06em"}}>Administrator Portal</button>
        </div>
      </footer>
    </div>
  );
}

/* ══════════════ AUTH ══════════════ */
function AuthPage({mode,onSubmit,onSwitch,onForgot}) {
  const [name,setName]=useState(""); const [email,setEmail]=useState(""); const [pw,setPw]=useState(""); const [pw2,setPw2]=useState("");
  const [err,setErr]=useState(""); const [busy,setBusy]=useState(false); const [showPw,setShowPw]=useState(false);
  const go = async () => {
    setErr(""); setBusy(true);
    if(mode==="signup"){
      if(!name||!email||!pw){setErr("Please fill in all fields.");setBusy(false);return;}
      if(pw.length<8){setErr("Password must be at least 8 characters.");setBusy(false);return;}
      if(!/[A-Za-z]/.test(pw)||!/[0-9]/.test(pw)){setErr("Password must contain at least one letter and one number.");setBusy(false);return;}
      if(pw!==pw2){setErr("Passwords do not match.");setBusy(false);return;}
      if(!email.includes("@")){setErr("Enter a valid email address.");setBusy(false);return;}
    } else { if(!email||!pw){setErr("Please fill in all fields.");setBusy(false);return;} }
    const e = await onSubmit(name,email,pw);
    if(e){setErr(e);setBusy(false);}
  };
  return (
    <div className="auth-wrap">
      <div className="auth-card page-fade">
        <div style={{textAlign:"center",marginBottom:26}}>
          <div style={{fontSize:36,marginBottom:10}}>{mode==="login"?"🔐":"✨"}</div>
          <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:24,fontWeight:700,margin:"0 0 5px",color:"var(--ua-text)"}}>{mode==="login"?"Welcome back":"Start free trial"}</h2>
          <p style={{fontSize:13,color:"var(--ua-sub)",lineHeight:1.6}}>{mode==="login"?"Sign in to your account":"24 hours full access · no card required"}</p>
        </div>
        {mode==="signup"&&<Fld label="Full Name" value={name} set={setName} ph="Jane Smith"/>}
        <Fld label="Email Address" type="email" value={email} set={setEmail} ph="you@example.com"/>
        <div style={{marginBottom:mode==="login"?6:14}}>
          <label className="field-label">Password{mode==="signup"?" (min 8 chars)":""}</label>
          <div style={{position:"relative"}}>
            <input type={showPw?"text":"password"} value={pw} onChange={e=>setPw(e.target.value)} placeholder="••••••••" className="field-input" style={{paddingRight:40}} onKeyDown={e=>e.key==="Enter"&&go()}/>
            <button onClick={()=>setShowPw(s=>!s)} style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:"var(--ua-sub)",cursor:"pointer",fontSize:14,padding:0}}>{showPw?"🙈":"👁"}</button>
          </div>
        </div>
        {mode==="login"&&<div style={{textAlign:"right",marginBottom:14}}><span onClick={onForgot} style={{fontSize:12,color:"#D4A853",cursor:"pointer",fontWeight:500}}>Forgot password?</span></div>}
        {mode==="signup"&&(()=>{
          const strength = pw.length===0?0:pw.length<8?1:pw.length<12&&!/[^a-zA-Z0-9]/.test(pw)?2:pw.length>=12&&/[^a-zA-Z0-9]/.test(pw)&&/[A-Z]/.test(pw)?4:3;
          const labels=["","Weak","Fair","Good","Strong"];
          const cols=["","#E8645A","#E8A83A","#D4A853","#4ECBA8"];
          return pw.length>0?<div style={{marginBottom:14}}>
            <div style={{display:"flex",gap:4,marginBottom:4}}>
              {[1,2,3,4].map(i=><div key={i} style={{height:3,flex:1,borderRadius:2,background:i<=strength?cols[strength]:"var(--ua-border)",transition:"all 0.3s"}}/>)}
            </div>
            <div style={{fontSize:11,color:cols[strength],fontWeight:600}}>{labels[strength]} password{strength<3?" — add symbols & uppercase for stronger":""}</div>
          </div>:null;
        })()}
        {mode==="signup"&&<Fld label="Confirm Password" type="password" value={pw2} set={setPw2} ph="••••••••" onEnter={go}/>}
        {err&&<div className="form-err">{err}</div>}
        <button className="btn-primary" onClick={go} disabled={busy} style={{width:"100%",padding:"14px",fontSize:14,marginTop:4}}>{busy?(mode==="login"?"Signing in...":"Creating account..."):(mode==="login"?"Sign In →":"Create Account →")}</button>
        <p style={{textAlign:"center",marginTop:16,fontSize:13,color:"var(--ua-sub)"}}>{mode==="login"?"No account? ":"Already have one? "}<span style={{color:"#D4A853",cursor:"pointer",fontWeight:600}} onClick={onSwitch}>{mode==="login"?"Start free trial →":"Sign in →"}</span></p>
        <div style={{marginTop:18,display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          {[["🔒","Bcrypt passwords"],["📱","Secure session"],["⚡","Rate-limit protected"],["🛡","Session secured"]].map(([ic,lb])=>(
            <div key={lb} style={{padding:"8px 11px",background:"rgba(78,203,168,0.06)",border:"1px solid rgba(78,203,168,0.15)",borderRadius:9,fontSize:11,color:"#4ECBA8",display:"flex",gap:7,alignItems:"center"}}>
              <span>{ic}</span><span>{lb}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
const Fld = ({label,type="text",value,set,ph,onEnter}) => (
  <div style={{marginBottom:14}}>
    <label className="field-label">{label}</label>
    <input type={type} value={value} onChange={e=>set(e.target.value)} placeholder={ph} className="field-input" onKeyDown={e=>e.key==="Enter"&&onEnter&&onEnter()}/>
  </div>
);

/* ══════════════ DASHBOARD ══════════════ */
function DashboardPage({user,trialHrs,isPaid,inGrace,graceMin,isExpired,auditsLeft,auditExhausted,onAudit,onHistory,onUpgrade,onHelp,onPay}) {
  const planLabel = user.plan.charAt(0).toUpperCase()+user.plan.slice(1);
  const cards = isPaid
    ? [{ic:"🔍",label:"New Audit",desc:"Analyze any document",col:"#D4A853",fn:onAudit},{ic:"📂",label:"Audit History",desc:"View past reports",col:"#4ECBA8",fn:onHistory},{ic:"❓",label:"Help & Support",desc:"FAQs and contact info",col:"#5BB8D4",fn:onHelp},{ic:"⚙️",label:"Payment Setup",desc:"Configure receiving details",col:"#E8A83A",fn:onPay},{ic:"📊",label:"My Plan",desc:planLabel+" · Full Access",col:"#9B7FE8",fn:onUpgrade}]
    : [{ic:"🔍",label:"New Audit",desc:"Analyze any document",col:"#D4A853",fn:onAudit},{ic:"📂",label:"Audit History",desc:"View past reports",col:"#4ECBA8",fn:onHistory},{ic:"💳",label:"Upgrade Plan",desc:"Unlock unlimited access",col:"#9B7FE8",fn:onUpgrade},{ic:"❓",label:"Help & Support",desc:"FAQs and contact info",col:"#5BB8D4",fn:onHelp},{ic:"⚙️",label:"Payment Setup",desc:"Configure receiving details",col:"#E8A83A",fn:onPay}];
  return (
    <div className="content-pad page-fade">
      <div style={{marginBottom:22}} className="dash-welcome">
        <div style={{fontSize:10,letterSpacing:"0.18em",textTransform:"uppercase",color:"#D4A853",marginBottom:8}}>Dashboard</div>
        <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
          <div>
            <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:"clamp(22px,5vw,34px)",fontWeight:700,margin:"0 0 4px",color:"var(--ua-text)"}}>Hello, {user.name} 👋</h2>
            <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
              <p style={{color:"var(--ua-sub)",fontSize:14,margin:0}}>{isPaid ? planLabel+" Plan · Full Access" : "Free trial · "+trialHrs+"h remaining"}</p>
              {isPaid && <span style={{fontSize:11,fontWeight:700,color:"#4ECBA8",background:"rgba(78,203,168,0.1)",border:"1px solid rgba(78,203,168,0.25)",padding:"3px 10px",borderRadius:100}}>✓ Active</span>}
            </div>
          </div>
          {(()=>{const u=DB.getUser(user.id);return u?(
            <div style={{display:"flex",gap:10,flexShrink:0}}>
              <div style={{textAlign:"center",padding:"8px 14px",background:"var(--ua-card)",border:"1px solid var(--ua-border)",borderRadius:12}}>
                <div style={{fontFamily:"'Playfair Display',serif",fontSize:20,fontWeight:900,color:"#9B7FE8",lineHeight:1}}>{u.auditCount||0}</div>
                <div style={{fontSize:9,color:"var(--ua-sub)",textTransform:"uppercase",letterSpacing:"0.08em",marginTop:3}}>Audits Run</div>
              </div>
            </div>
          ):null;})()}
        </div>
      </div>
      {isPaid && (
        <div style={{background:"linear-gradient(135deg,rgba(78,203,168,0.07),rgba(212,168,83,0.07))",border:"1px solid rgba(78,203,168,0.2)",borderRadius:16,padding:"18px 20px",marginBottom:20,display:"flex",gap:14,alignItems:"center",flexWrap:"wrap"}}>
          <span style={{fontSize:32}}>🎉</span>
          <div style={{flex:1}}>
            <div style={{fontSize:15,fontWeight:700,color:"var(--ua-text)",marginBottom:3}}>{planLabel} Plan — Full Access Unlocked</div>
            <div style={{fontSize:13,color:"var(--ua-sub)"}}>All features active. Run unlimited audits across all 38 jurisdictions.</div>
          </div>
          <button className="btn-primary" onClick={onAudit} style={{padding:"10px 20px",fontSize:13,whiteSpace:"nowrap"}}>Start Auditing →</button>
        </div>
      )}
      {/* Upgrade banner — always visible for unpaid users */}
      {!isPaid && (
        <div style={{marginBottom:20}}>
          {(isExpired || auditExhausted) ? (
            /* Block — show different tone for exhausted (amber) vs expired (red) */
            auditExhausted&&!isExpired ? (
              /* Audit quota reached — time still remaining, amber/informational tone */
              <div style={{background:"rgba(212,168,83,0.07)",border:"1.5px solid rgba(212,168,83,0.35)",borderRadius:16,padding:"18px 20px",display:"flex",gap:14,alignItems:"center",flexWrap:"wrap"}}>
                <div style={{width:44,height:44,borderRadius:12,background:"rgba(212,168,83,0.12)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,flexShrink:0}}>🎟</div>
                <div style={{flex:1}}>
                  <div style={{fontSize:15,fontWeight:700,color:"#D4A853",marginBottom:4}}>
                    Free audit limit reached · {trialHrs}h trial time left
                  </div>
                  <div style={{fontSize:13,color:"var(--ua-sub)"}}>
                    You've used all your free trial audits. Upgrade to unlock unlimited audits and keep full access for the rest of your trial.
                  </div>
                </div>
                <button className="btn-primary" onClick={onUpgrade} style={{padding:"11px 22px",fontSize:13,whiteSpace:"nowrap"}}>Upgrade Now →</button>
              </div>
            ) : (
              /* Trial fully expired — red/urgent */
              <div style={{background:"rgba(232,100,90,0.08)",border:"1.5px solid rgba(232,100,90,0.35)",borderRadius:16,padding:"18px 20px",display:"flex",gap:14,alignItems:"center",flexWrap:"wrap"}}>
                <span style={{fontSize:28}}>🚫</span>
                <div style={{flex:1}}>
                  <div style={{fontSize:15,fontWeight:700,color:"#E8645A",marginBottom:4}}>Trial &amp; grace period ended</div>
                  <div style={{fontSize:13,color:"var(--ua-sub)"}}>Your 24h trial and 2h grace period have expired. Upgrade to run more audits.</div>
                </div>
                <button className="btn-primary" onClick={onUpgrade} style={{padding:"11px 22px",fontSize:13,whiteSpace:"nowrap",background:"linear-gradient(135deg,#E8645A,#C9184A)"}}>Upgrade Now →</button>
              </div>
            )
          ) : inGrace ? (
            /* In grace period — urgent warning */
            <div style={{background:"rgba(232,100,90,0.06)",border:"1.5px solid rgba(232,100,90,0.3)",borderRadius:16,padding:"18px 20px",display:"flex",gap:14,alignItems:"center",flexWrap:"wrap"}}>
              <span style={{fontSize:28}}>⚠️</span>
              <div style={{flex:1}}>
                <div style={{fontSize:15,fontWeight:700,color:"#E8645A",marginBottom:4}}>Grace period — {graceMin} min left</div>
                <div style={{fontSize:13,color:"var(--ua-sub)"}}>Trial ended. You have a 2-hour grace window. Upgrade before it closes to keep uninterrupted access.</div>
              </div>
              <button className="btn-primary" onClick={onUpgrade} style={{padding:"11px 22px",fontSize:13,whiteSpace:"nowrap",background:"linear-gradient(135deg,#E8645A,#C9184A)"}}>Upgrade Now →</button>
            </div>
          ) : (
            /* Active trial — show audit credits remaining */
            <div style={{background:auditsLeft<=1?"rgba(232,168,58,0.07)":"rgba(212,168,83,0.04)",border:"1px solid "+(auditsLeft<=1?"rgba(232,168,58,0.3)":"rgba(212,168,83,0.15)"),borderRadius:14,padding:"14px 18px",display:"flex",gap:12,alignItems:"center",flexWrap:"wrap"}}>
              <div style={{width:38,height:38,borderRadius:10,background:auditsLeft<=1?"rgba(232,168,58,0.12)":"rgba(212,168,83,0.08)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>
                {auditsLeft<=1?"⚠️":"🎟"}
              </div>
              <div style={{flex:1}}>
                <div style={{fontSize:13,fontWeight:700,color:auditsLeft<=1?"#E8A83A":"#D4A853",marginBottom:3}}>
                  {auditsLeft===Infinity ? "Free trial active" : auditsLeft===1 ? "1 free audit remaining" : auditsLeft+" free audits remaining"}
                </div>
                <div style={{fontSize:12,color:"var(--ua-sub)"}}>
                  {auditsLeft<=1 ? "Last free audit — upgrade for unlimited access." : "Upgrade anytime for unlimited audits and full access."}
                </div>
              </div>
              <button onClick={onUpgrade} style={{fontSize:12,color:"#D4A853",background:"rgba(212,168,83,0.08)",border:"1px solid rgba(212,168,83,0.25)",borderRadius:8,padding:"7px 16px",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontWeight:600,whiteSpace:"nowrap"}}>Upgrade →</button>
            </div>
          )}
        </div>
      )}
      <div className="dash-grid">
        {cards.map((item,i)=>(
          <button key={i} onClick={item.fn} className="dash-card" style={{"--dc":item.col}}>
            <div style={{fontSize:28,marginBottom:10}}>{item.ic}</div>
            <div style={{fontFamily:"'Playfair Display',serif",fontSize:14,fontWeight:700,color:item.col,marginBottom:4}}>{item.label}</div>
            <div style={{fontSize:12,color:"var(--ua-sub)",lineHeight:1.5,overflow:"hidden",display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical"}}>{item.desc}</div>
          </button>
        ))}
      </div>
      <div className="info-note" style={{marginTop:14}}>💾 Audit history is stored in your browser · up to 50 audits saved per device</div>
    </div>
  );
}

/* ══════════════ AUDIT PAGE ══════════════ */
function AuditPage({auditS,fileRef,onChange,onNotes,onFile,onRun,onBack,initJuris,isExpired,fileMsg,onError}) {
  const [country, setCountry] = useState(initJuris?.country||"United States");
  const [state,   setState]   = useState(initJuris?.state||"");
  const countries = Object.keys(JURISDICTIONS);
  const states    = JURISDICTIONS[country]?.states||[];

  const AUDIT_STEPS = ["Reading document","Detecting domain & laws","Analysing compliance","Generating findings","Building report"];
  const [stepTick,setStepTick] = useState(0);
  useEffect(()=>{ if(!auditS.loading){setStepTick(0);return;} const t=setInterval(()=>setStepTick(x=>x+1),2200); return ()=>clearInterval(t); },[auditS.loading]);
  useEffect(()=>{ const h=e=>{if((e.ctrlKey||e.metaKey)&&e.key==="Enter"&&auditS.text&&!auditS.loading&&!isExpired)onRun({country,state});}; window.addEventListener("keydown",h); return ()=>window.removeEventListener("keydown",h); },[country,state,auditS.text,auditS.loading,isExpired,onRun]);
  const stepIdx = AUDIT_STEPS.findIndex(s=>auditS.msg&&auditS.msg.toLowerCase().includes(s.toLowerCase().split(" ")[0]));
  const activeStep = stepIdx>=0?stepIdx:Math.min(4,stepTick);

  if(auditS.loading) return (
    <div className="loader-wrap page-fade">
      <div style={{position:"relative",width:96,height:96,marginBottom:26,flexShrink:0}}>
        <div className="spin-ring"/>
        <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <svg width="44" height="44" viewBox="0 0 44 44" fill="none">
            <circle cx="22" cy="22" r="14" fill="rgba(212,168,83,0.08)" stroke="rgba(212,168,83,0.2)" strokeWidth="1"/>
            <path d="M22 10v6M22 28v6M10 22h6M28 22h6" stroke="#D4A853" strokeWidth="1.5" strokeLinecap="round"/>
            <circle cx="22" cy="22" r="5" fill="rgba(212,168,83,0.2)" stroke="#D4A853" strokeWidth="1.5"/>
            <circle cx="22" cy="22" r="2" fill="#D4A853"/>
          </svg>
        </div>
      </div>
      <div style={{fontSize:10,letterSpacing:"0.2em",textTransform:"uppercase",color:"#D4A853",marginBottom:10,fontWeight:600}}>Compliance Audit Engine</div>
      <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:"clamp(14px,3.5vw,20px)",fontWeight:700,margin:"0 0 7px",color:"var(--ua-text)",textAlign:"center",maxWidth:400}}>{auditS.msg}</h2>
      <p style={{color:"var(--ua-sub)",fontSize:13,textAlign:"center",marginBottom:26}}>{country}{state?" · "+state:""}</p>
      <div style={{width:"min(380px,90vw)",marginBottom:22}}>
        {AUDIT_STEPS.map((step,i)=>(
          <div key={i} style={{display:"flex",alignItems:"center",gap:10,marginBottom:8,opacity:i>activeStep?0.3:1,transition:"opacity 0.4s"}}>
            <div style={{width:22,height:22,borderRadius:"50%",border:"2px solid",borderColor:i<activeStep?"#4ECBA8":i===activeStep?"#D4A853":"rgba(255,255,255,0.15)",background:i<activeStep?"rgba(78,203,168,0.15)":i===activeStep?"rgba(212,168,83,0.12)":"transparent",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,flexShrink:0,transition:"all 0.4s",boxShadow:i===activeStep?"0 0 10px rgba(212,168,83,0.3)":"none"}}>
              {i<activeStep?"✓":i+1}
            </div>
            <div style={{fontSize:13,color:i===activeStep?"var(--ua-text)":i<activeStep?"#4ECBA8":"var(--ua-sub)",fontWeight:i===activeStep?600:400,transition:"all 0.4s"}}>{step}</div>
            {i===activeStep&&<div style={{marginLeft:"auto",flexShrink:0}}><div style={{width:16,height:16,border:"2px solid rgba(212,168,83,0.3)",borderTopColor:"#D4A853",borderRadius:"50%",animation:"spin 0.9s linear infinite"}}/></div>}
          </div>
        ))}
      </div>
      <div style={{width:"min(380px,90vw)",height:3,background:"var(--ua-border)",borderRadius:3,overflow:"hidden"}}><div className="progress-bar" style={{"--pc":"#D4A853"}}/></div>
      <div style={{marginTop:14,fontSize:11,color:"var(--ua-sub)"}}>⚡ Claude Haiku · citation-backed · ~5–10 sec</div>
    </div>
  );

  const hasFile  = auditS.fileName && auditS.text;
  const fileSize = auditS.text ? (new Blob([auditS.text]).size/1024).toFixed(1) : 0;

  return (
    <div className="content-pad page-fade">
      <div style={{marginBottom:20}}>
        <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:10}}>
          <button className="btn-ghost" onClick={onBack} style={{fontSize:13}}>← Back</button>
          <div style={{fontSize:10,letterSpacing:"0.18em",textTransform:"uppercase",color:"#D4A853"}}>Universal Audit Pipeline</div>
        </div>
        <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:"clamp(18px,4vw,30px)",fontWeight:700,margin:"0 0 6px",color:"var(--ua-text)"}}>Audit your document</h2>
        <p style={{color:"var(--ua-sub)",fontSize:14,lineHeight:1.75}}>Upload a file to begin. Jurisdiction laws are applied automatically.</p>
      </div>

      <div className="juris-box">
        <div style={{marginBottom:14}}>
          <div style={{fontSize:11,fontWeight:700,letterSpacing:"0.14em",textTransform:"uppercase",color:"#D4A853",marginBottom:3}}>🌍 Jurisdiction</div>
          <div style={{fontSize:10,color:"var(--ua-sub)",fontWeight:400}}>Laws & regulations applied automatically based on selection</div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:12}}>
          <div>
            <label className="field-label">Country</label>
            <select value={country} onChange={e=>{setCountry(e.target.value);setState("");}} className="juris-select">
              {countries.map(co=><option key={co} value={co}>{co}</option>)}
            </select>
          </div>
          <div>
            <label className="field-label">State / Region {!states.length&&<span style={{color:"var(--ua-sub)",fontWeight:400,textTransform:"none",letterSpacing:"normal"}}>(N/A)</span>}</label>
            <select value={state} onChange={e=>setState(e.target.value)} className="juris-select" disabled={!states.length}>
              <option value="">All / National</option>
              {states.map(s=><option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>
        {country&&(
          <div style={{marginTop:10,fontSize:11,color:"var(--ua-sub)",lineHeight:1.6,padding:"7px 11px",background:"var(--ua-card)",borderRadius:8,border:"1px solid var(--ua-border)"}}>
            <span style={{color:"var(--ua-sub)",fontWeight:600}}>Applied: </span>{getJLaws(country,state).slice(0,140)}...
          </div>
        )}
      </div>

      <div className="domain-pills">{Object.values(DOMAINS).map((d,i)=><span key={i} className="domain-pill" style={{"--pc":d.color}}>{d.icon} {d.label}</span>)}</div>

      {/* File drop zone */}
      <div
        onClick={()=>!fileMsg&&fileRef.current?.click()}
        onDragOver={e=>{e.preventDefault();e.currentTarget.style.borderColor="#D4A853";e.currentTarget.style.background="rgba(212,168,83,0.06)";}}
        onDragLeave={e=>{e.currentTarget.style.borderColor=hasFile?"rgba(78,203,168,0.3)":"rgba(128,128,128,0.15)";e.currentTarget.style.background=hasFile?"rgba(78,203,168,0.04)":"transparent";}}
        onDrop={async e=>{e.preventDefault();e.currentTarget.style.borderColor=hasFile?"rgba(78,203,168,0.3)":"rgba(128,128,128,0.15)";e.currentTarget.style.background=hasFile?"rgba(78,203,168,0.04)":"transparent";const f=e.dataTransfer.files[0];if(f){try{const res=await readFile(f,msg=>onChange({...auditS,_status:msg}));onChange(res);}catch(err){if(onError)onError(err.message);else console.error(err);}}}}
        style={{
          border:"2px dashed "+(hasFile?"rgba(78,203,168,0.35)":"rgba(255,255,255,0.1)"),
          background:hasFile?"rgba(78,203,168,0.03)":"rgba(255,255,255,0.01)",
          borderRadius:16,padding:"40px 24px",textAlign:"center",cursor:"pointer",
          transition:"all 0.22s",marginBottom:14,
        }}
      >
        {hasFile ? (
          <div>
            <div style={{fontSize:40,marginBottom:12}}>📄</div>
            <div style={{fontFamily:"'Playfair Display',serif",fontSize:16,fontWeight:700,color:"var(--ua-text)",marginBottom:5}}>{auditS.fileName}</div>
            <div style={{fontSize:12,color:"#4ECBA8",marginBottom:12}}>{fileSize} KB · {auditS.text.length.toLocaleString()} characters · ready to audit</div>
            <button onClick={e=>{e.stopPropagation();onChange({text:"",fileName:""});}} style={{fontSize:12,color:"#E8645A",background:"rgba(232,100,90,0.08)",border:"1px solid rgba(232,100,90,0.2)",borderRadius:8,padding:"5px 14px",cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>✕ Remove file</button>
          </div>
        ) : (
          <div>
            {fileMsg?<div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:12,padding:"10px 0"}}><div style={{width:36,height:36,border:"3px solid rgba(212,168,83,0.25)",borderTopColor:"#D4A853",borderRadius:"50%",animation:"spin 1s linear infinite"}}/><div style={{fontSize:14,color:"#D4A853",fontWeight:600}}>{fileMsg}</div></div>:<><div style={{fontSize:44,marginBottom:14,opacity:0.5}}>📂</div>
            <div style={{fontSize:15,fontWeight:600,color:"var(--ua-text)",marginBottom:8}}>Click to upload or drag & drop</div>
            <div style={{fontSize:12,color:"var(--ua-sub)",marginBottom:6}}>Supported: .txt · .md · <strong style={{color:"#4ECBA8"}}>PDF ✓</strong> · .csv · .json · .js · .py · .html · .docx</div>
            <div style={{fontSize:11,color:"var(--ua-sub)"}}>Up to 30,000 characters sent for analysis</div>
          </> }
          </div>
        )}
      </div>
      {auditS.text&&<div style={{fontSize:11,color:"var(--ua-sub)",textAlign:"right",marginTop:6,marginBottom:6,opacity:0.75}}>{auditS.text.length.toLocaleString()} chars · sending first {Math.min(auditS.text.length,30000).toLocaleString()} to AI</div>}
      <input ref={fileRef} type="file" accept=".txt,.md,.csv,.js,.py,.html,.json,.pdf,.docx,.doc" onChange={onFile} style={{display:"none"}}/>

      <div style={{marginBottom:14}}>
        <label className="field-label" style={{marginBottom:7,display:"flex",alignItems:"center",gap:8}}>
          Additional context <span style={{fontSize:11,color:"var(--ua-sub)",fontWeight:400}}>(optional)</span>
        </label>
        <textarea
          className="doc-textarea"
          style={{minHeight:100,padding:"13px 16px"}}
          value={auditS.extraNotes}
          onChange={e=>onNotes(e.target.value)}
          placeholder="Add any extra details you want the auditor to consider&#10;e.g. jurisdiction-specific concerns, key clauses to focus on, company context, known issues…"
        />
      </div>

      {auditS.err&&<div className="form-err" style={{marginBottom:14}}>⚠ {auditS.err}</div>}
      {isExpired && (
        <div style={{background:"rgba(232,100,90,0.08)",border:"1.5px solid rgba(232,100,90,0.3)",borderRadius:14,padding:"15px 20px",marginBottom:14,display:"flex",gap:12,alignItems:"center"}}>
          <span style={{fontSize:22}}>🚫</span>
          <div style={{flex:1}}>
            <div style={{fontSize:14,fontWeight:700,color:"#E8645A",marginBottom:3}}>Trial expired — upgrade required</div>
            <div style={{fontSize:13,color:"var(--ua-sub)"}}>Your free trial and grace period have ended. Upgrade your plan to run audits.</div>
          </div>
          <button className="btn-primary" onClick={onBack} style={{padding:"10px 20px",fontSize:13,background:"linear-gradient(135deg,#E8645A,#C9184A)",whiteSpace:"nowrap"}}>Upgrade →</button>
        </div>
      )}
      <div className="audit-run-row">
        <span className="audit-hint" style={{fontSize:11,color:"var(--ua-sub)",opacity:0.7}}>⚡ ~5–10 sec · Ctrl+Enter</span>
        <button className="btn-primary audit-run-btn" onClick={()=>onRun({country,state})} disabled={!hasFile||isExpired} style={{padding:"13px 36px",fontSize:14,opacity:(hasFile&&!isExpired)?1:0.3,cursor:isExpired?"not-allowed":"pointer"}}>Run Audit →</button>
      </div>
    </div>
  );
}

/* ══════════════ RESULT PAGE ══════════════ */
function ResultPage({result,tab,setTab,votes,setVotes,onDownload,onNew,onBack,onFeedback}) {
  const findings = result.findings||[];
  const P=findings.filter(f=>f.status==="PASS").length, F=findings.filter(f=>f.status==="FAIL").length, R=findings.filter(f=>f.status==="REVIEW").length;
  return (
    <div className="content-pad page-fade" style={{paddingBottom:60}}>
      <div style={{display:"flex",gap:8,marginBottom:18,flexWrap:"wrap",alignItems:"center"}}>
        <button className="btn-ghost" onClick={onBack} style={{fontSize:12,padding:"7px 12px"}}>← Back</button>
        <button className="btn-ghost" onClick={onNew} style={{fontSize:12,padding:"7px 12px"}}>+ New</button>
        <div style={{flex:1,minWidth:0}}/>
        <button className="btn-ghost" onClick={()=>{
          const text=`COMPLIANCE AUDIT — ${result.subdomain||"Document"}\nScore: ${result.compliance_score}/100 | Risk: ${result.risk_level}\n\n${result.executive_summary||""}\n\nFindings: ${(result.findings||[]).length} | PASS: ${findings.filter(f=>f.status==="PASS").length} | FAIL: ${findings.filter(f=>f.status==="FAIL").length} | REVIEW: ${findings.filter(f=>f.status==="REVIEW").length}`;
          navigator.clipboard?.writeText(text).then(()=>toast("Summary copied to clipboard!"));
        }} style={{fontSize:12,padding:"7px 12px"}}>📋 Copy</button>
        <button className="btn-ghost" onClick={()=>emailReport(result)} style={{fontSize:12,padding:"7px 12px"}}>📧 Email</button>
        <button className="btn-ghost" onClick={onFeedback} style={{fontSize:12,padding:"7px 12px"}}>💬 Feedback</button>
        <button className="btn-primary" onClick={onDownload} style={{padding:"7px 16px",fontSize:12}}>⬇ Download</button>
      </div>
      <div className="result-header" style={{"--dc":result.dm?.color||"#D4A853"}}>
        <div style={{display:"flex",gap:20,alignItems:"flex-start",flexWrap:"wrap"}}>
          <ScoreRing score={result.compliance_score} risk={result.risk_level}/>
          <div style={{flex:1,minWidth:200}}>
            <div style={{fontSize:10,letterSpacing:"0.12em",textTransform:"uppercase",color:result.dm?.color,marginBottom:4,fontWeight:600}}>{result.dm?.icon} {result.dm?.label} — {result.subdomain}</div>
            {result.jurisdiction&&<div style={{fontSize:11,color:"var(--ua-sub)",marginBottom:8,display:"flex",gap:8,alignItems:"center"}}>
              <span>🌍 {result.jurisdiction.country}{result.jurisdiction.state?" · "+result.jurisdiction.state:""}</span>
              <span style={{color:"var(--ua-border)"}}>·</span>
              <span style={{color:"var(--ua-sub)"}}>by {result.specialist||result.dm?.specialist||"Specialist"}</span>
            </div>}
            <p style={{fontSize:13,color:"var(--ua-sub)",lineHeight:1.8,margin:"0 0 12px"}}>{result.executive_summary}</p>
            {/* Visual findings breakdown bar */}
            {findings.length>0&&(
              <div style={{marginBottom:10}}>
                <div style={{display:"flex",height:6,borderRadius:3,overflow:"hidden",marginBottom:8,gap:1}}>
                  {P>0&&<div style={{flex:P,background:"#4ECBA8",borderRadius:3,transition:"flex 0.6s ease"}}/>}
                  {F>0&&<div style={{flex:F,background:"#E8645A",borderRadius:3,transition:"flex 0.6s ease"}}/>}
                  {R>0&&<div style={{flex:R,background:"#E8A83A",borderRadius:3,transition:"flex 0.6s ease"}}/>}
                </div>
                <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
                  {[[P,"PASS","#4ECBA8"],[F,"FAIL","#E8645A"],[R,"REVIEW","#E8A83A"]].map(([c,l,col])=>(
                    <div key={l} style={{display:"flex",alignItems:"center",gap:5}}>
                      <div style={{width:8,height:8,borderRadius:2,background:col}}/>
                      <span style={{fontSize:12,color:col,fontWeight:700}}>{c}</span>
                      <span style={{fontSize:11,color:"var(--ua-sub)"}}>{l}</span>
                    </div>
                  ))}
                  {(result.hitl_flags?.length>0)&&<div style={{display:"flex",alignItems:"center",gap:5}}><div style={{width:8,height:8,borderRadius:2,background:"#E8A83A"}}/><span style={{fontSize:12,color:"#E8A83A",fontWeight:700}}>{result.hitl_flags.length}</span><span style={{fontSize:11,color:"var(--ua-sub)"}}>HITL</span></div>}
                  <div style={{display:"flex",alignItems:"center",gap:5,marginLeft:"auto"}}><span style={{fontSize:11,color:"var(--ua-sub)"}}>Confidence:</span><span style={{fontSize:12,fontWeight:700,color:result.confidence>=80?"#4ECBA8":"#E8A83A"}}>{result.confidence||0}%</span></div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="tab-row">
        {[["findings","Findings ("+findings.length+")"],["recs","Recommendations"],["cross","Cross-Ref ("+(result.cross_references||[]).length+")"],["hitl","HITL ("+(result.hitl_flags||[]).length+")"]].map(([id,lb])=>(
          <button key={id} onClick={()=>setTab(id)} className={"tab-btn"+(tab===id?" tab-active":"")} style={{"--tc":result.dm?.color||"#D4A853"}}>{lb}</button>
        ))}
      </div>
      {tab==="findings"&&(
        <div style={{display:"flex",flexDirection:"column",gap:11}}>
          {!findings.length&&<EmptyState msg="No findings returned."/>}
          {findings.map((f,i)=>(
            <div key={i} className="finding-card" style={{"--fc":statusColor(f.status),animationDelay:i*18+"ms"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:9,gap:8}}>
                <div style={{display:"flex",gap:6,flexWrap:"wrap",flex:1,minWidth:0}}>
                  <span className="status-badge" style={{"--bc":statusColor(f.status)}}>{f.status}</span>
                  {f.severity&&<span className="status-badge" style={{"--bc":sevColor(f.severity)}}>{f.severity}</span>}
                </div>
                <div style={{textAlign:"right",flexShrink:0}}>
                  <div style={{fontSize:9,color:"var(--ua-sub)",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:1}}>Confidence</div>
                  <div style={{fontFamily:"'Playfair Display',serif",fontSize:17,fontWeight:900,color:f.confidence>=80?"#4ECBA8":"#E8A83A",lineHeight:1}}>{f.confidence}%</div>
                </div>
              </div>
              <div style={{fontFamily:"'Playfair Display',serif",fontSize:14,fontWeight:700,color:"var(--ua-text)",marginBottom:5}}>{f.rule}</div>
              <div style={{fontSize:13,color:"var(--ua-sub)",lineHeight:1.75,marginBottom:f.issue?7:0}}>{f.description}</div>
              {f.issue&&<div style={{fontSize:13,color:"#C07860",lineHeight:1.65,marginBottom:f.correction?6:0,padding:"7px 11px",background:"rgba(232,100,90,0.06)",borderRadius:7,borderLeft:"2px solid rgba(232,100,90,0.3)"}}>⚠ {f.issue}</div>}
              {f.correction&&<div style={{fontSize:13,color:"#4ECBA8",lineHeight:1.65,padding:"7px 11px",background:"rgba(78,203,168,0.06)",borderRadius:7,borderLeft:"2px solid rgba(78,203,168,0.3)"}}>→ {f.correction}</div>}
              {f.citation&&<div style={{marginTop:9,paddingTop:9,borderTop:"1px solid var(--ua-border)",fontSize:12,color:"var(--ua-sub)",fontStyle:"italic",wordBreak:"break-word"}}>📖 {f.citation}</div>}
            </div>
          ))}
        </div>
      )}
      {tab==="recs"&&(
        <div style={{display:"flex",flexDirection:"column",gap:11}}>
          {!(result.recommendations?.length)&&<EmptyState msg="No recommendations generated. Re-run the audit to get recommendations."/>}
          {(result.recommendations||[]).map((rec,i)=>(
            <div key={i} style={{background:"var(--ua-card)",border:"1px solid rgba(78,203,168,0.2)",borderLeft:"3px solid #4ECBA8",borderRadius:13,padding:"16px 18px",display:"flex",gap:14,alignItems:"flex-start"}}>
              <div style={{width:28,height:28,borderRadius:8,background:"rgba(78,203,168,0.15)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:900,color:"#4ECBA8",flexShrink:0,fontFamily:"'Playfair Display',serif"}}>{i+1}</div>
              <div style={{flex:1}}>
                <div style={{fontSize:10,letterSpacing:"0.12em",textTransform:"uppercase",color:"#4ECBA8",marginBottom:5,fontWeight:700}}>Priority {i===0?"High":i===1?"Medium":"Low"}</div>
                <div style={{fontSize:13,color:"var(--ua-text)",lineHeight:1.75}}>{rec}</div>
              </div>
            </div>
          ))}
          {(result.recommendations?.length>0)&&(
            <div style={{padding:"12px 16px",background:"rgba(212,168,83,0.05)",border:"1px solid rgba(212,168,83,0.15)",borderRadius:11,fontSize:12,color:"var(--ua-sub)",lineHeight:1.65}}>
              💡 These recommendations are AI-generated based on the findings. Prioritise Critical and High severity items first. Consult a qualified professional before implementing legal changes.
            </div>
          )}
        </div>
      )}
      {tab==="cross"&&(
        <div style={{display:"flex",flexDirection:"column",gap:11}}>
          {!(result.cross_references?.length)&&<EmptyState msg="No cross-reference issues detected."/>}
          {(result.cross_references||[]).map((cr,i)=>(
            <div key={i} style={{background:"var(--ua-card)",border:"1px solid rgba(155,127,232,0.2)",borderLeft:"3px solid #9B7FE8",borderRadius:13,padding:"15px 18px"}}>
              <span className="status-badge" style={{"--bc":"#9B7FE8",display:"inline-block",marginBottom:9}}>{cr.type}</span>
              <div style={{fontSize:13,color:"var(--ua-sub)",lineHeight:1.75,marginBottom:9}}>{cr.description}</div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{(cr.locations||[]).map((l,j)=><span key={j} style={{fontSize:11,color:"#9B7FE8",background:"rgba(155,127,232,0.12)",padding:"3px 9px",borderRadius:6}}>{l}</span>)}</div>
            </div>
          ))}
        </div>
      )}
      {tab==="hitl"&&(
        <div>
          <div style={{background:"rgba(232,168,58,0.05)",border:"1px solid rgba(232,168,58,0.15)",borderRadius:11,padding:"11px 15px",marginBottom:13,fontSize:13,color:"#E8A83A",lineHeight:1.65}}>⚠ Findings below 80% confidence flagged for human review.</div>
          {!(result.hitl_flags?.length)&&<EmptyState msg="All findings above 80% confidence."/>}
          {(result.hitl_flags||[]).map((fid,i)=>{
            const f=findings.find(x=>x.id===fid); if(!f)return null;
            const v=votes[fid];
            return (
              <div key={i} style={{border:"1px solid var(--ua-border)",borderColor:v?(v==="confirm"?"rgba(78,203,168,0.3)":"rgba(232,100,90,0.3)"):"rgba(232,168,58,0.15)",background:v?(v==="confirm"?"rgba(78,203,168,0.04)":"rgba(232,100,90,0.04)"):"rgba(232,168,58,0.03)",borderRadius:13,padding:"16px 18px",marginBottom:11,transition:"all 0.2s"}}>
                <div style={{display:"flex",gap:12,alignItems:"flex-start",flexWrap:"wrap"}}>
                  <div style={{flex:1}}>
                    <div style={{fontFamily:"'Playfair Display',serif",fontSize:14,fontWeight:700,color:"var(--ua-text)",marginBottom:5}}>{f.rule}</div>
                    <div style={{fontSize:13,color:"var(--ua-sub)",lineHeight:1.65,marginBottom:6}}>{f.issue||f.description}</div>
                    <div style={{fontSize:12,color:"#E8A83A",fontWeight:500}}>Confidence: {f.confidence}%</div>
                  </div>
                  <div style={{display:"flex",gap:7,flexShrink:0}}>
                    <button className="btn-ghost" onClick={()=>setVotes(x=>({...x,[fid]:"confirm"}))} style={{fontSize:12,padding:"7px 12px",...(v==="confirm"?{borderColor:"#4ECBA8",color:"#4ECBA8",background:"rgba(78,203,168,0.08)"}:{})}}>✓ Confirm</button>
                    <button className="btn-ghost" onClick={()=>setVotes(x=>({...x,[fid]:"reject"}))} style={{fontSize:12,padding:"7px 12px",...(v==="reject"?{borderColor:"#E8645A",color:"#E8645A",background:"rgba(232,100,90,0.08)"}:{})}}>✗ Reject</button>
                  </div>
                </div>
                {v&&<div style={{marginTop:8,fontSize:12,color:v==="confirm"?"#4ECBA8":"#E8645A",fontWeight:500}}>{v==="confirm"?"✓ Confirmed as valid finding":"✗ Rejected as false positive"}</div>}
              </div>
            );
          })}
        </div>
      )}
      <div className="info-note" style={{marginTop:18}}>⚠ AI-generated. Consult a qualified professional before acting on these results.</div>
      {/* Feedback prompt at bottom of results */}
      <div style={{marginTop:14,padding:"14px 18px",background:"rgba(155,127,232,0.05)",border:"1px solid rgba(155,127,232,0.15)",borderRadius:13,display:"flex",gap:12,alignItems:"center",flexWrap:"wrap"}}>
        <div style={{fontSize:20}}>💬</div>
        <div style={{flex:1,minWidth:160}}>
          <div style={{fontSize:13,fontWeight:600,color:"var(--ua-text)",marginBottom:2}}>Was this audit helpful?</div>
          <div style={{fontSize:12,color:"var(--ua-sub)"}}>Your feedback helps us improve the AI and accuracy.</div>
        </div>
        {onFeedback&&<button onClick={onFeedback} style={{fontSize:12,fontWeight:700,color:"#9B7FE8",background:"rgba(155,127,232,0.1)",border:"1px solid rgba(155,127,232,0.25)",borderRadius:9,padding:"8px 16px",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",whiteSpace:"nowrap"}}>Rate this audit →</button>}
      </div>
    </div>
  );
}

/* ══════════════ HISTORY ══════════════ */
function ScoreChart({history}) {
  const [hov,setHov]=useState(null);
  if(history.length<1) return null;
  if(history.length===1) return (
    <div style={{background:"var(--ua-card)",border:"1px solid var(--ua-border)",borderRadius:16,padding:"16px 20px",marginBottom:20,display:"flex",alignItems:"center",gap:14}}>
      <div style={{fontFamily:"'Playfair Display',serif",fontSize:28,fontWeight:900,color:scoreColor(history[0].score)}}>{history[0].score}</div>
      <div><div style={{fontSize:11,color:"var(--ua-sub)",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:2}}>Latest Score</div><div style={{fontSize:12,color:"var(--ua-sub)"}}>{history[0].subdomain||"Audit"} · {fmtD(history[0].ts)}</div></div>
    </div>
  );
  const last10=history.slice(0,10).reverse();
  const W=400,H=130,padL=28,padR=12,padT=12,padB=28;
  const iW=W-padL-padR, iH=H-padT-padB;
  const pts=last10.map((h,i)=>({
    x: padL + (i/(last10.length-1||1))*iW,
    y: padT + iH - (Math.min(h.score,100)/100)*iH,
    score:h.score, ts:h.ts, col:h.score>=80?"#4ECBA8":h.score>=60?"#E8A83A":"#E8645A",
    label:new Date(h.ts).toLocaleDateString("en",{month:"short",day:"numeric"})
  }));
  const polyline=pts.map(p=>p.x+","+p.y).join(" ");
  // Filled area path
  const area=["M",pts[0].x,padT+iH,...pts.flatMap(p=>["L",p.x,p.y]),"L",pts[pts.length-1].x,padT+iH,"Z"].join(" ");
  const avgScore=Math.round(last10.reduce((s,h)=>s+h.score,0)/last10.length);
  const trend=last10[last10.length-1].score-last10[0].score;
  return (
    <div style={{background:"var(--ua-card)",border:"1px solid var(--ua-border)",borderRadius:16,padding:"18px 20px",marginBottom:20}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexWrap:"wrap",gap:8}}>
        <div style={{fontSize:10,letterSpacing:"0.18em",textTransform:"uppercase",color:"var(--ua-sub)",fontWeight:600}}>Score Trend</div>
        <div style={{display:"flex",gap:14}}>
          <div style={{textAlign:"center"}}>
            <div style={{fontFamily:"'Playfair Display',serif",fontSize:18,fontWeight:900,color:avgScore>=80?"#4ECBA8":avgScore>=60?"#E8A83A":"#E8645A",lineHeight:1}}>{avgScore}</div>
            <div style={{fontSize:9,color:"var(--ua-sub)",letterSpacing:"0.08em",textTransform:"uppercase"}}>Avg</div>
          </div>
          <div style={{textAlign:"center"}}>
            <div style={{fontFamily:"'Playfair Display',serif",fontSize:18,fontWeight:900,color:trend>0?"#4ECBA8":trend<0?"#E8645A":"#E8A83A",lineHeight:1}}>{trend>0?"+":""}{trend}</div>
            <div style={{fontSize:9,color:"var(--ua-sub)",letterSpacing:"0.08em",textTransform:"uppercase"}}>Trend</div>
          </div>
        </div>
      </div>
      <svg viewBox={"0 0 "+W+" "+H} style={{width:"100%",overflow:"visible",display:"block"}}>
        <defs>
          <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#4ECBA8" stopOpacity="0.18"/>
            <stop offset="100%" stopColor="#4ECBA8" stopOpacity="0"/>
          </linearGradient>
        </defs>
        {[0,50,100].map(v=>(
          <g key={v}>
            <line x1={padL} y1={padT+iH-(v/100)*iH} x2={W-padR} y2={padT+iH-(v/100)*iH} stroke="rgba(128,128,128,0.1)" strokeWidth="1" strokeDasharray={v===50?"3 3":""}/>
            <text x={padL-4} y={padT+iH-(v/100)*iH+3} textAnchor="end" fill="var(--ua-sub)" fontSize="8">{v}</text>
          </g>
        ))}
        <path d={area} fill="url(#chartFill)"/>
        <polyline points={polyline} fill="none" stroke="#4ECBA8" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"/>
        {pts.map((p,i)=>(
          <g key={i} style={{cursor:"pointer"}}
            onMouseEnter={()=>setHov(i)} onMouseLeave={()=>setHov(null)}
            onTouchStart={()=>setHov(i)} onTouchEnd={()=>setTimeout(()=>setHov(null),1500)}>
            <circle cx={p.x} cy={p.y} r={hov===i?6:4} fill={p.col} stroke="var(--ua-card)" strokeWidth="2"
              style={{transition:"r 0.15s",filter:hov===i?"drop-shadow(0 0 6px "+p.col+"88)":"none"}}/>
            {hov===i&&(
              <g>
                <rect x={Math.min(p.x-22,W-padR-44)} y={p.y-32} width="44" height="22" rx="4" fill="var(--ua-card2)" stroke="var(--ua-border)"/>
                <text x={Math.min(p.x,W-padR-22)} y={p.y-18} textAnchor="middle" fill={p.col} fontSize="10" fontWeight="700">{p.score}</text>
                <text x={Math.min(p.x,W-padR-22)} y={p.y-8} textAnchor="middle" fill="var(--ua-sub)" fontSize="7">{p.label}</text>
              </g>
            )}
          </g>
        ))}
        {pts.map((p,i)=>(
          <text key={i} x={p.x} y={H-4} textAnchor="middle" fill="var(--ua-sub)" fontSize="7">{p.label}</text>
        ))}
      </svg>
    </div>
  );
}

function ConfirmClear({onClear}) {
  const [confirm,setConfirm] = useState(false);
  if(!confirm) return (
    <button className="btn-ghost" onClick={()=>setConfirm(true)} style={{flexShrink:0,fontSize:12,color:"#E8645A",borderColor:"rgba(232,100,90,0.25)"}}>🗑 Clear All</button>
  );
  return (
    <div style={{display:"flex",gap:6,alignItems:"center",flexShrink:0}}>
      <span style={{fontSize:12,color:"var(--ua-sub)"}}>Sure?</span>
      <button onClick={()=>{onClear();setConfirm(false);}} style={{fontSize:11,fontWeight:700,color:"#E8645A",background:"rgba(232,100,90,0.1)",border:"1px solid rgba(232,100,90,0.3)",borderRadius:7,padding:"4px 10px",cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>Yes, clear</button>
      <button onClick={()=>setConfirm(false)} style={{fontSize:11,color:"var(--ua-sub)",background:"none",border:"1px solid var(--ua-border)",borderRadius:7,padding:"4px 10px",cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>Cancel</button>
    </div>
  );
}

function HistoryPage({history,onBack,onDelete,onClear,onView}) {
  const domainMeta = {
    legal:{icon:"⚖️",color:"#D4A853"},medical:{icon:"🏥",color:"#E8645A"},
    financial:{icon:"📊",color:"#4ECBA8"},construction:{icon:"🏗️",color:"#E8A83A"},
    privacy:{icon:"🔐",color:"#9B7FE8"},hr:{icon:"👥",color:"#5BB8D4"},
    food:{icon:"🍽️",color:"#6BCF7F"},software:{icon:"💻",color:"#F07B4A"},
  };
  const totalPass=history.reduce((s,h)=>s+(h.score>=80?1:0),0);
  const avgScore=history.length?Math.round(history.reduce((s,h)=>s+h.score,0)/history.length):0;

  return (
    <div className="content-pad page-fade" style={{paddingBottom:60}}>
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,marginBottom:20,flexWrap:"wrap"}}>
        <div style={{display:"flex",alignItems:"center",gap:12,minWidth:0}}>
          <button className="btn-ghost" onClick={onBack} style={{fontSize:13,flexShrink:0}}>← Back</button>
          <div>
            <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:"clamp(18px,4vw,26px)",fontWeight:700,margin:0,color:"var(--ua-text)"}}>📂 Audit History</h2>
            {history.length>0&&<div style={{fontSize:12,color:"var(--ua-sub)",marginTop:2}}>{history.length} audit{history.length!==1?"s":""} saved</div>}
          </div>
        </div>
        {history.length>0&&<ConfirmClear onClear={onClear}/>}
      </div>

      {/* Stats row — only when there are audits */}
      {history.length>0&&(
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:18}}>
          {[
            {label:"Total Audits",val:history.length,icon:"📋",col:"#9B7FE8"},
            {label:"Average Score",val:avgScore,icon:"📈",col:avgScore>=80?"#4ECBA8":avgScore>=60?"#E8A83A":"#E8645A"},
            {label:"Passing (≥80)",val:totalPass,icon:"✅",col:"#4ECBA8"},
          ].map((s,i)=>(
            <div key={i} style={{background:"var(--ua-card)",border:"1px solid var(--ua-border)",borderRadius:14,padding:"14px 16px",textAlign:"center"}}>
              <div style={{fontSize:20,marginBottom:6}}>{s.icon}</div>
              <div style={{fontFamily:"'Playfair Display',serif",fontSize:22,fontWeight:900,color:s.col,lineHeight:1}}>{s.val}</div>
              <div style={{fontSize:10,color:"var(--ua-sub)",marginTop:4,letterSpacing:"0.06em",textTransform:"uppercase"}}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      <ScoreChart history={history}/>
      <div className="info-note" style={{marginBottom:16}}>💾 Stored in your browser · up to 50 audits · <strong style={{color:onView?"#4ECBA8":"var(--ua-sub)"}}>Click any card to view full results</strong></div>

      {!history.length&&(
        <div style={{textAlign:"center",padding:"52px 24px",background:"var(--ua-card)",borderRadius:18,border:"1px solid var(--ua-border)",marginBottom:16}}>
          <div style={{fontSize:48,marginBottom:16,opacity:0.4}}>📂</div>
          <div style={{fontFamily:"'Playfair Display',serif",fontSize:18,fontWeight:700,color:"var(--ua-text)",marginBottom:8}}>No audits yet</div>
          <p style={{fontSize:14,color:"var(--ua-sub)",lineHeight:1.75,maxWidth:320,margin:"0 auto"}}>Your completed audits will appear here. Run your first audit to get started.</p>
        </div>
      )}

      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {history.map((h,i)=>{
          const dm=domainMeta[h.domain]||{icon:"📄",color:"#D4A853"};
          const scoreCol=h.score>=80?"#4ECBA8":h.score>=60?"#E8A83A":"#E8645A";
          const hasDetail=!!DB.getAuditDetail(h.id);
          return (
            <div key={h.id||i}
              onClick={()=>hasDetail&&onView&&onView(h.id)}
              style={{
                background:"var(--ua-card)",border:"1px solid var(--ua-border)",
                borderLeft:"4px solid "+dm.color,borderRadius:14,
                padding:"14px 16px",transition:"all 0.2s",
                cursor:hasDetail?"pointer":"default",position:"relative",
              }}
              onMouseEnter={e=>{if(hasDetail){e.currentTarget.style.transform="translateX(2px)";e.currentTarget.style.boxShadow="0 4px 20px rgba(0,0,0,0.15)";}}} 
              onMouseLeave={e=>{e.currentTarget.style.transform="";e.currentTarget.style.boxShadow="";}}>

              <div style={{display:"flex",gap:12,alignItems:"flex-start"}}>
                {/* Domain icon bubble */}
                <div style={{width:42,height:42,borderRadius:11,background:dm.color+"18",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>{dm.icon}</div>

                {/* Main content */}
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3,flexWrap:"wrap"}}>
                    <div style={{fontFamily:"'Playfair Display',serif",fontSize:14,fontWeight:700,color:"var(--ua-text)"}}>{h.subdomain||"Document Audit"}</div>
                    {h.riskLevel&&<span style={{fontSize:9,fontWeight:700,padding:"2px 8px",borderRadius:6,background:scoreCol+"18",color:scoreCol,border:"1px solid "+scoreCol+"30",textTransform:"uppercase",letterSpacing:"0.08em"}}>{h.riskLevel} Risk</span>}
                    {hasDetail&&<span style={{fontSize:9,color:"#4ECBA8",fontWeight:600}}>• View →</span>}
                  </div>
                  <div style={{fontSize:11,color:"var(--ua-sub)",marginBottom:h.doc?4:0,display:"flex",gap:10,flexWrap:"wrap"}}>
                    <span>{h.findings} finding{h.findings!==1?"s":""}</span>
                    {h.country&&<span>🌍 {h.country}{h.state?" · "+h.state:""}</span>}
                    <span>🕐 {fmtD(h.ts)} {fmtT(h.ts)}</span>
                  </div>
                  {h.doc&&<div style={{fontSize:11,color:"var(--ua-sub)",fontStyle:"italic",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:340}}>"{h.doc.slice(0,90)}…"</div>}
                </div>

                {/* Score + delete */}
                <div style={{display:"flex",gap:8,alignItems:"center",flexShrink:0}}>
                  <div style={{textAlign:"center",padding:"6px 10px",background:scoreCol+"12",borderRadius:10,border:"1px solid "+scoreCol+"25"}}>
                    <div style={{fontFamily:"'Playfair Display',serif",fontSize:22,fontWeight:900,color:scoreCol,lineHeight:1}}>{h.score}</div>
                    <div style={{fontSize:8,color:scoreCol,textTransform:"uppercase",letterSpacing:"0.1em",marginTop:2,opacity:0.8}}>score</div>
                  </div>
                  {onDelete&&<button
                    onClick={e=>{e.stopPropagation();onDelete(h.id);}}
                    title="Delete"
                    style={{background:"rgba(232,100,90,0.07)",border:"1px solid rgba(232,100,90,0.2)",color:"#E8645A",borderRadius:8,padding:"6px 10px",cursor:"pointer",fontSize:12,fontFamily:"'DM Sans',sans-serif",lineHeight:1}}>🗑</button>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ══════════════ SETTINGS ══════════════ */
function SettingsPage({user,isPaid,onBack,onUpgrade,onLogout}) {
  return (
    <div className="content-pad page-fade">
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:24}}>
        <button className="btn-ghost" onClick={onBack} style={{fontSize:13}}>← Back</button>
        <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:"clamp(18px,4vw,28px)",fontWeight:700,margin:0,color:"var(--ua-text)"}}>⚙️ Settings</h2>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:12}}>
        <div className="settings-card">
          <div className="settings-label">Account</div>
          <div style={{fontFamily:"'Playfair Display',serif",fontSize:17,color:"var(--ua-text)",marginBottom:3}}>{user.name}</div>
          <div style={{fontSize:13,color:"var(--ua-sub)",marginBottom:6}}>{user.email}</div>
          {(()=>{const u=DB.getUser(user.id);return u?<div style={{fontSize:12,color:"var(--ua-sub)",marginBottom:14}}>Member since {u.joinedAt?fmtD(u.joinedAt):"N/A"} · {u.auditCount||0} audit{(u.auditCount||0)!==1?"s":""} run</div>:null;})()}
          <span style={{fontSize:12,color:user.plan==="trial"?"#E8A83A":"#4ECBA8",background:user.plan==="trial"?"rgba(232,168,58,0.1)":"rgba(78,203,168,0.1)",border:"1px solid "+(user.plan==="trial"?"rgba(232,168,58,0.25)":"rgba(78,203,168,0.25)"),padding:"5px 14px",borderRadius:100}}>
            {user.plan==="trial"?"⏱ Free Trial":"✓ "+user.plan.charAt(0).toUpperCase()+user.plan.slice(1)+" Plan"}
          </span>
        </div>
        {!isPaid&&<div className="settings-card"><div className="settings-label" style={{color:"#D4A853"}}>Upgrade</div><p style={{fontSize:13,color:"var(--ua-sub)",lineHeight:1.7,marginBottom:14}}>Unlimited audits, batch processing, and priority support.</p><button className="btn-primary" onClick={onUpgrade} style={{padding:"10px 24px",fontSize:13}}>View Plans →</button></div>}
        <div className="settings-card" style={{border:"1px solid rgba(78,203,168,0.15)",background:"rgba(78,203,168,0.02)"}}>
          <div className="settings-label" style={{color:"#4ECBA8"}}>🔒 Security & Privacy</div>
          {["Passwords hashed with bcrypt (12 rounds — industry standard)","Login rate-limited — locks after 8 failed attempts for 15 minutes","No data shared with third parties or uploaded to external servers","Audit history saved to your browser only — cleared on browser reset","Session invalidated on logout — single active session only"].map((x,i)=>(
            <div key={i} style={{display:"flex",gap:10,alignItems:"flex-start",marginBottom:10}}><span style={{color:"#4ECBA8",flexShrink:0}}>🔒</span><span style={{fontSize:13,color:"var(--ua-sub)",lineHeight:1.5}}>{x}</span></div>
          ))}
        </div>
        <button className="btn-ghost" onClick={onLogout} style={{fontSize:13,padding:"13px",borderColor:"rgba(232,100,90,0.25)",color:"#E8645A"}}>Sign Out</button>
      </div>
    </div>
  );
}

/* ══════════════ PAY SETUP ══════════════ */
function PaySetupPage({onBack,toast}) {
  const SK = "ua_paysetup_v1";
  const [f,setF]=useState(()=>{ try{const v=localStorage.getItem(SK);return v?JSON.parse(v):{name:"",bank:"",account:"",routing:"",paypal:"",upi:"",note:""}}catch(e){return {name:"",bank:"",account:"",routing:"",paypal:"",upi:"",note:""};} });
  const [saved,setSaved]=useState(false);
  const s=(k,v)=>{setF(x=>({...x,[k]:v}));setSaved(false);};
  const save=()=>{ try{localStorage.setItem(SK,JSON.stringify(f));setSaved(true);toast("Payment details saved securely.");} catch(e){toast("Save failed.","err");} };
  const [clearConfirm,setClearConfirm]=useState(false);
  const clear=()=>{ if(!clearConfirm){setClearConfirm(true);setTimeout(()=>setClearConfirm(false),4000);return;} localStorage.removeItem(SK); setF({name:"",bank:"",account:"",routing:"",paypal:"",upi:"",note:""}); setSaved(false); setClearConfirm(false); toast("Payment details cleared."); };
  return (
    <div className="content-pad page-fade">
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:24}}>
        <button className="btn-ghost" onClick={onBack} style={{fontSize:13}}>← Back</button>
        <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:"clamp(18px,4vw,28px)",fontWeight:700,margin:0,color:"var(--ua-text)"}}>⚙️ Payment Setup</h2>
      </div>
      <div style={{background:"rgba(78,203,168,0.05)",border:"1px solid rgba(78,203,168,0.15)",borderRadius:12,padding:"12px 16px",marginBottom:18,fontSize:13,color:"#4ECBA8",display:"flex",gap:10,alignItems:"flex-start",lineHeight:1.6}}>
        <span style={{flexShrink:0}}>🔒</span>
        <span>Stored <strong>only in your browser's local storage</strong> — never transmitted to any server. Clearing your browser data will erase this. These details are for your personal reference only.</span>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:13}}>
        {[["Recipient / Business Name","name","text","Your full name or business"],["Bank Name","bank","text","e.g. Chase, Barclays"],["Account Number","account","password","Account number"],["Routing / Sort Code","routing","password","Routing or sort code"],["PayPal Email","paypal","email","your@paypal.com"],["UPI / Google Pay ID","upi","text","yourname@upi"]].map(([lb,key,type,ph])=>(
          <div key={key}><label className="field-label">{lb}</label><input type={type} value={f[key]} onChange={e=>s(key,e.target.value)} placeholder={ph} className="field-input" maxLength={200}/></div>
        ))}
        <div><label className="field-label">Notes</label><textarea value={f.note} onChange={e=>s("note",e.target.value)} className="doc-textarea" style={{minHeight:80}} placeholder="Internal reference notes..." maxLength={1000}/></div>
        <div style={{display:"flex",gap:12,alignItems:"center",flexWrap:"wrap"}}>
          <button className="btn-primary" onClick={save} style={{padding:"12px 28px",fontSize:13}}>💾 Save to Browser</button>
          <button className="btn-ghost" onClick={clear} style={{fontSize:13,color:"#E8645A",borderColor:"rgba(232,100,90,0.25)"}}>{clearConfirm?"⚠ Tap again to confirm":"🗑 Clear All"}</button>
          {saved&&<span style={{fontSize:13,color:"#4ECBA8",fontWeight:600}}>✓ Saved</span>}
        </div>
      </div>
    </div>
  );
}

/* ══════════════ ADMIN LOGIN ══════════════ */
function AdminLoginPage({onLogin,onBack,lock}) {
  const [u,setU]=useState(""); const [p,setP]=useState(""); const [show,setShow]=useState(false);
  const [err,setErr]=useState(""); const [busy,setBusy]=useState(false);
  const locked = lock.until>now();
  const go = async () => {
    if(locked)return; if(!u||!p){setErr("Enter both fields.");return;}
    setBusy(true);setErr("");
    const e = await onLogin(u,p);
    if(e){setErr(e);setBusy(false);}
  };
  return (
    <div className="auth-wrap">
      <div className="auth-card page-fade" style={{borderColor:"rgba(232,100,90,0.2)"}}>
        <div style={{textAlign:"center",marginBottom:24}}>
          <div style={{width:56,height:56,borderRadius:15,background:"linear-gradient(135deg,#E8645A,#C9184A)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,margin:"0 auto 12px",boxShadow:"0 0 24px rgba(232,100,90,0.35)"}}>🛡</div>
          <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:24,fontWeight:700,margin:"0 0 4px",color:"var(--ua-text)"}}>Admin Access</h2>
          <p style={{fontSize:12,color:"var(--ua-sub)"}}>Restricted area. Authorised personnel only.</p>
        </div>
        {locked&&<div style={{background:"rgba(232,100,90,0.08)",border:"1px solid rgba(232,100,90,0.2)",borderRadius:9,padding:"10px 14px",marginBottom:12,fontSize:13,color:"#E8645A",textAlign:"center",fontWeight:500}}>🔒 Locked · {Math.ceil((lock.until-now())/60000)} min remaining</div>}
        <div style={{marginBottom:13}}><label className="field-label">Username</label><input type="text" value={u} onChange={e=>setU(e.target.value)} placeholder="admin" className="field-input" disabled={locked} onKeyDown={e=>e.key==="Enter"&&go()} style={locked?{opacity:0.4}:{}}/></div>
        <div style={{marginBottom:13}}>
          <label className="field-label">Password</label>
          <div style={{position:"relative"}}>
            <input type={show?"text":"password"} value={p} onChange={e=>setP(e.target.value)} placeholder="••••••••••" className="field-input" disabled={locked} onKeyDown={e=>e.key==="Enter"&&go()} style={{paddingRight:42,...(locked?{opacity:0.4}:{})}}/>
            <button onClick={()=>setShow(s=>!s)} style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:"var(--ua-sub)",cursor:"pointer",fontSize:14,padding:0}}>{show?"🙈":"👁"}</button>
          </div>
        </div>
        {lock.count>0&&!locked&&<div style={{fontSize:12,color:"#E8A83A",marginBottom:8,fontWeight:500}}>⚠ {5-lock.count} attempts remaining</div>}
        {err&&<div className="form-err">{err}</div>}
        <button onClick={go} disabled={busy||locked} style={{width:"100%",padding:"13px",fontSize:14,background:"linear-gradient(135deg,#E8645A,#C9184A)",border:"none",borderRadius:10,color:"#fff",cursor:busy||locked?"not-allowed":"pointer",fontFamily:"'DM Sans',sans-serif",fontWeight:700,boxShadow:"0 4px 20px rgba(232,100,90,0.3)",opacity:busy||locked?0.5:1,marginBottom:10,transition:"all 0.2s"}}>{busy?"Verifying...":"Access Admin Panel →"}</button>
        <button className="btn-ghost" onClick={onBack} style={{width:"100%",padding:"11px",fontSize:13}}>← Back to Site</button>
        <div style={{textAlign:"center",marginTop:14,fontSize:10,color:"var(--ua-sub)",letterSpacing:"0.04em"}}>Authorised personnel only · Contact support if you need access</div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   ADMIN DASHBOARD — FULL MANUAL CONTROL PANEL
══════════════════════════════════════════════════════ */
/* ══════════════ ADMIN FEEDBACK TAB ══════════════ */
function AdminFeedbackTab({toast}) {
  const [fbSrch,setFbSrch]=useState("");
  const [fbCat, setFbCat] =useState("all");
  const [tick2, setTick2] =useState(0);
  const feedbacks = DB.getFeedbacks();
  const filtered  = feedbacks.filter(f=>{
    if(fbCat!=="all"&&f.category!==fbCat) return false;
    if(!fbSrch) return true;
    return (f.userName||"").toLowerCase().includes(fbSrch.toLowerCase())||
           (f.message||"").toLowerCase().includes(fbSrch.toLowerCase())||
           (f.category||"").toLowerCase().includes(fbSrch.toLowerCase());
  });
  const avgRating = feedbacks.length ? Math.round((feedbacks.reduce((s,f)=>s+(f.rating||0),0)/feedbacks.length)*10)/10 : 0;
  const byRating  = [5,4,3,2,1].map(r=>({r,count:feedbacks.filter(f=>f.rating===r).length}));
  const CICONS    = {bug:"🐛",feature:"💡",quality:"🎯",ux:"✨",general:"💬"};
  return (
        <div>
          {/* Stats */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:10,marginBottom:18}}>
            {[
              {ic:"💬",lb:"Total",val:feedbacks.length,col:"#9B7FE8"},
              {ic:"⭐",lb:"Avg Rating",val:feedbacks.length?avgRating+"/5":"—",col:"#D4A853"},
              {ic:"🐛",lb:"Bug Reports",val:feedbacks.filter(f=>f.category==="bug").length,col:"#E8645A"},
              {ic:"💡",lb:"Feature Req",val:feedbacks.filter(f=>f.category==="feature").length,col:"#4ECBA8"},
            ].map((s,i)=>(
              <div key={i} style={{background:"var(--ua-card)",border:"1px solid "+s.col+"25",borderRadius:12,padding:"14px 12px",textAlign:"center"}}>
                <div style={{fontSize:18,marginBottom:4}}>{s.ic}</div>
                <div style={{fontFamily:"'Playfair Display',serif",fontSize:20,fontWeight:900,color:s.col,lineHeight:1}}>{s.val}</div>
                <div style={{fontSize:9,color:"var(--ua-sub)",marginTop:3,textTransform:"uppercase",letterSpacing:"0.08em"}}>{s.lb}</div>
              </div>
            ))}
          </div>
          {/* Rating distribution */}
          {feedbacks.length>0&&(
            <div className="settings-card" style={{marginBottom:14}}>
              <div className="settings-label">Rating Distribution</div>
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                {byRating.map(({r,count})=>(
                  <div key={r} style={{display:"flex",alignItems:"center",gap:10}}>
                    <div style={{display:"flex",gap:2,width:60,flexShrink:0}}>
                      {[1,2,3,4,5].map(n=><span key={n} style={{fontSize:10,filter:n<=r?"none":"grayscale(1)"}}>⭐</span>)}
                    </div>
                    <div style={{flex:1,height:8,background:"var(--ua-card2)",borderRadius:4,overflow:"hidden"}}>
                      <div style={{height:"100%",borderRadius:4,background:r>=4?"#4ECBA8":r===3?"#E8A83A":"#E8645A",width:feedbacks.length?(count/feedbacks.length*100)+"%":"0%",transition:"width 0.6s ease"}}/>
                    </div>
                    <div style={{fontSize:12,color:"var(--ua-sub)",width:24,textAlign:"right",flexShrink:0}}>{count}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {/* Filters */}
          <div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap",alignItems:"center"}}>
            <input value={fbSrch} onChange={e=>setFbSrch(e.target.value)} placeholder="Search feedback…" className="field-input" style={{flex:1,minWidth:160,padding:"9px 13px"}}/>
            <select value={fbCat} onChange={e=>setFbCat(e.target.value)} className="juris-select" style={{width:"auto",minWidth:130}}>
              <option value="all">All Categories</option>
              {["bug","feature","quality","ux","general"].map(c=><option key={c} value={c}>{CICONS[c]} {c.charAt(0).toUpperCase()+c.slice(1)}</option>)}
            </select>
            <span style={{fontSize:12,color:"var(--ua-sub)",flexShrink:0}}>{filtered.length} item{filtered.length!==1?"s":""}</span>
          </div>
          {/* Feedback list */}
          {!filtered.length&&<div className="settings-card" style={{textAlign:"center",color:"var(--ua-sub)",padding:"32px"}}>No feedback yet{fbSrch||fbCat!=="all"?" matching filters":""}</div>}
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {filtered.map((f,i)=>{
              const ratingCol=f.rating>=4?"#4ECBA8":f.rating>=3?"#E8A83A":"#E8645A";
              return (
                <div key={f.id||i} style={{background:"var(--ua-card)",border:"1px solid var(--ua-border)",borderLeft:"3px solid "+(f.category==="bug"?"#E8645A":f.category==="feature"?"#4ECBA8":f.category==="quality"?"#9B7FE8":f.category==="ux"?"#5BB8D4":"#D4A853"),borderRadius:13,padding:"14px 16px"}}>
                  <div style={{display:"flex",gap:12,alignItems:"flex-start",flexWrap:"wrap"}}>
                    <div style={{flex:1,minWidth:140}}>
                      <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:6,alignItems:"center"}}>
                        <span style={{fontSize:16}}>{CICONS[f.category]||"💬"}</span>
                        <span style={{fontSize:12,fontWeight:700,color:"var(--ua-text)"}}>{f.category?.charAt(0).toUpperCase()+f.category?.slice(1)||"Feedback"}</span>
                        {f.source==="result"&&<span style={{fontSize:10,color:"#9B7FE8",background:"rgba(155,127,232,0.1)",padding:"2px 8px",borderRadius:100}}>After audit</span>}
                        {f.subdomain&&<span style={{fontSize:10,color:"var(--ua-sub)",fontStyle:"italic"}}>· {f.subdomain}</span>}
                      </div>
                      {f.message&&<p style={{fontSize:13,color:"var(--ua-text)",lineHeight:1.65,margin:"0 0 8px",whiteSpace:"pre-wrap"}}>{f.message}</p>}
                      <div style={{fontSize:11,color:"var(--ua-sub)",display:"flex",gap:12,flexWrap:"wrap"}}>
                        <span>👤 {f.userName||"Guest"}</span>
                        {f.userEmail&&<span>📧 {f.userEmail}</span>}
                        {f.replyEmail&&f.replyEmail!==f.userEmail&&<span>↩ Reply to: {f.replyEmail}</span>}
                        {f.auditScore!=null&&<span>📊 Audit score: {f.auditScore}</span>}
                        <span>🕐 {fmtD(f.ts)} {fmtT(f.ts)}</span>
                      </div>
                    </div>
                    <div style={{display:"flex",gap:8,alignItems:"center",flexShrink:0}}>
                      {f.rating>0&&(
                        <div style={{textAlign:"center",padding:"6px 10px",background:ratingCol+"12",borderRadius:9,border:"1px solid "+ratingCol+"25"}}>
                          <div style={{fontFamily:"'Playfair Display',serif",fontSize:20,fontWeight:900,color:ratingCol,lineHeight:1}}>{f.rating}</div>
                          <div style={{fontSize:8,color:ratingCol,textTransform:"uppercase",letterSpacing:"0.08em",marginTop:2}}>/ 5</div>
                        </div>
                      )}
                      {f.replyEmail&&(
                        <a href={"mailto:"+f.replyEmail+"?subject=Re: Your Universal Auditor Feedback"}
                          style={{fontSize:11,color:"#5BB8D4",background:"rgba(91,184,212,0.08)",border:"1px solid rgba(91,184,212,0.2)",padding:"6px 10px",borderRadius:8,textDecoration:"none",fontFamily:"'DM Sans',sans-serif",fontWeight:600,cursor:"pointer",whiteSpace:"nowrap"}}>
                          ↩ Reply
                        </a>
                      )}
                      <button onClick={()=>{DB.deleteFeedback(f.id);setTick2(t=>t+1);toast("Deleted.");}} style={{background:"rgba(232,100,90,0.07)",border:"1px solid rgba(232,100,90,0.2)",color:"#E8645A",borderRadius:8,padding:"6px 10px",cursor:"pointer",fontSize:12,fontFamily:"'DM Sans',sans-serif"}}>🗑</button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

  );
}

function ConfirmDeleteUser({userId, userName, onDeleted}) {
  const [confirm, setConfirm] = useState(false);
  if(!confirm) return (
    <button className="btn-ghost" onClick={()=>setConfirm(true)} style={{fontSize:12,padding:"9px 16px",color:"#E8645A",borderColor:"rgba(232,100,90,0.25)"}}>🗑 Delete Account</button>
  );
  return (
    <div style={{display:"flex",gap:6,alignItems:"center",background:"rgba(232,100,90,0.06)",border:"1px solid rgba(232,100,90,0.2)",borderRadius:9,padding:"6px 10px"}}>
      <span style={{fontSize:12,color:"var(--ua-sub)"}}>Delete {userName}?</span>
      <button onClick={()=>{DB.deleteUser(userId);onDeleted();setConfirm(false);}} style={{fontSize:11,fontWeight:700,color:"#E8645A",background:"rgba(232,100,90,0.12)",border:"1px solid rgba(232,100,90,0.3)",borderRadius:6,padding:"3px 10px",cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>Confirm</button>
      <button onClick={()=>setConfirm(false)} style={{fontSize:11,color:"var(--ua-sub)",background:"none",border:"1px solid var(--ua-border)",borderRadius:6,padding:"3px 8px",cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>Cancel</button>
    </div>
  );
}


function DangerZoneButtons({refresh, toast}) {
  const [pending, setPending] = useState(null); // which action is pending confirm
  const actions = [
    {id:"suspendTrials", label:"⚠ Suspend All Trials", col:"#E8A83A", border:"rgba(232,168,58,0.25)", confirm:"Suspend all trial users?", run:()=>{DB.allUsers().filter(u=>u.plan==="trial").forEach(u=>DB.suspendUser(u.id,true)); toast("All trial users suspended.","err");}},
    {id:"upgradeTrials", label:"⬆ Upgrade All Trials", col:"#4ECBA8", border:"rgba(78,203,168,0.25)", confirm:"Upgrade ALL trial users to Individual?", run:()=>{DB.allUsers().filter(u=>u.plan==="trial").forEach(u=>DB.forcePlan(u.id,"individual")); toast("All trials upgraded to Individual.");}},
    {id:"unsuspendAll", label:"✅ Unsuspend All", col:"#5BB8D4", border:"rgba(91,184,212,0.25)", confirm:"Unsuspend ALL users?", run:()=>{DB.allUsers().forEach(u=>DB.suspendUser(u.id,false)); toast("All users unsuspended.");}},
  ];
  return (
    <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"center"}}>
      {actions.map(a=>(
        pending===a.id ? (
          <div key={a.id} style={{display:"flex",gap:6,alignItems:"center",background:"rgba(232,100,90,0.06)",border:"1px solid rgba(232,100,90,0.2)",borderRadius:9,padding:"6px 12px"}}>
            <span style={{fontSize:12,color:"var(--ua-sub)"}}>{a.confirm}</span>
            <button onClick={()=>{a.run();refresh();setPending(null);}} style={{fontSize:11,fontWeight:700,color:"#E8645A",background:"rgba(232,100,90,0.12)",border:"1px solid rgba(232,100,90,0.3)",borderRadius:6,padding:"3px 10px",cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>Confirm</button>
            <button onClick={()=>setPending(null)} style={{fontSize:11,color:"var(--ua-sub)",background:"none",border:"1px solid var(--ua-border)",borderRadius:6,padding:"3px 8px",cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>Cancel</button>
          </div>
        ) : (
          <button key={a.id} className="btn-ghost" onClick={()=>setPending(a.id)} style={{fontSize:12,color:a.col,borderColor:a.border}}>{a.label}</button>
        )
      ))}
    </div>
  );
}

function AdminDashPage({onLogout,toast,onCfgChange}) {
  const [tab,  setTab]  = useState("overview");
  const [tick, setTick] = useState(0);
  const refresh = () => setTick(t=>t+1);

  const users  = DB.allUsers();
  const audits = DB.allAudits();
  const stats  = DB.stats();
  const cfg    = DB.getCfg();

  const [lcfg,  setLcfg]  = useState(() => DB.getCfg());
  const [uSrch, setUSrch] = useState("");
  const [aSrch, setASrch] = useState("");
  const [aFilt, setAFilt] = useState("all");
  const [selU,  setSelU]  = useState(null);
  const [newPw, setNewPw] = useState("");
  const [extH,  setExtH]  = useState("24");
  const [pf,    setPf]    = useState({name:"",bank:"",account:"",routing:"",paypal:"",upi:"",note:""});
  const [psaved,setPsaved]= useState(false);

  const saveCfg = patch => { const updated = DB.setCfg(patch); setLcfg({...updated}); if(onCfgChange)onCfgChange(); toast("Settings saved."); refresh(); };
  const sp = (k,v) => setPf(x=>({...x,[k]:v}));

  const fUsers  = users.filter(u => !uSrch || u.name.toLowerCase().includes(uSrch.toLowerCase()) || u.email.toLowerCase().includes(uSrch.toLowerCase()));
  const fAudits = audits.filter(a => {
    if(aFilt!=="all"&&a.userPlan!==aFilt) return false;
    if(!aSrch) return true;
    return (a.userName||"").toLowerCase().includes(aSrch.toLowerCase()) || (a.userEmail||"").toLowerCase().includes(aSrch.toLowerCase()) || (a.subdomain||"").toLowerCase().includes(aSrch.toLowerCase());
  });

  const Toggle = ({val,onToggle,col="#4ECBA8"}) => (
    <button onClick={onToggle} style={{width:52,height:28,borderRadius:100,border:"none",cursor:"pointer",transition:"all 0.25s",background:val?col:"rgba(128,128,128,0.1)",position:"relative",flexShrink:0}}>
      <div style={{width:20,height:20,borderRadius:"50%",background:"#fff",position:"absolute",top:4,transition:"left 0.25s",left:val?28:4,boxShadow:"0 1px 4px rgba(0,0,0,0.4)"}}/>
    </button>
  );

  return (
    <div className="page-fade" style={{maxWidth:1020,margin:"0 auto",padding:"32px 20px 80px"}}>
      <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:22,flexWrap:"wrap"}}>
        <div style={{width:44,height:44,borderRadius:12,background:"linear-gradient(135deg,#E8645A,#C9184A)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,boxShadow:"0 0 20px rgba(232,100,90,0.3)",flexShrink:0}}>🛡</div>
        <div>
          <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:"clamp(18px,4vw,28px)",fontWeight:700,margin:0,color:"var(--ua-text)"}}>Admin Dashboard</h2>
          <div style={{fontSize:10,color:"#E8645A",letterSpacing:"0.18em",textTransform:"uppercase",marginTop:2}}>Restricted · Manual Control Panel</div>
        </div>
        <div style={{marginLeft:"auto",display:"flex",gap:8,flexWrap:"wrap"}}>
          <button className="btn-ghost" onClick={()=>{refresh();toast("Refreshed.","info");}} style={{fontSize:12}}>↻ Refresh</button>
          <button className="btn-ghost" onClick={onLogout} style={{fontSize:12,color:"#E8645A",borderColor:"rgba(232,100,90,0.25)"}}>🔓 Exit Admin</button>
        </div>
      </div>

      {cfg.maintenanceMode&&<div style={{background:"rgba(232,100,90,0.08)",border:"1px solid rgba(232,100,90,0.25)",borderRadius:12,padding:"12px 18px",marginBottom:14,fontSize:13,color:"#E8645A",fontWeight:500}}>🔴 MAINTENANCE MODE ACTIVE — users cannot log in</div>}
      {cfg.announcementOn&&cfg.announcementText&&<div style={{background:"rgba(212,168,83,0.08)",border:"1px solid rgba(212,168,83,0.25)",borderRadius:12,padding:"12px 18px",marginBottom:14,fontSize:13,color:"#D4A853"}}>📢 Active: "{cfg.announcementText.slice(0,80)}"</div>}

      {/* Stats row */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:10,marginBottom:20}} className="admin-stats-grid">
        {[{lb:"Users",val:stats.total,ic:"👥",col:"#5BB8D4"},{lb:"Paid",val:stats.paid,ic:"💳",col:"#4ECBA8"},{lb:"Trials",val:stats.trials,ic:"⏱",col:"#E8A83A"},{lb:"Suspended",val:stats.suspended,ic:"🚫",col:"#E8645A"},{lb:"Audits",val:stats.audits,ic:"📋",col:"#9B7FE8"},{lb:"Revenue",val:"$"+stats.revenue.toLocaleString(),ic:"💰",col:"#D4A853"}].map((s,i)=>(
          <div key={i} style={{background:"var(--ua-card)",border:"1px solid "+s.col+"25",borderRadius:12,padding:"14px 10px",textAlign:"center"}}>
            <div style={{fontSize:18,marginBottom:5}}>{s.ic}</div>
            <div style={{fontFamily:"'Playfair Display',serif",fontSize:20,fontWeight:900,color:s.col,lineHeight:1}}>{s.val}</div>
            <div style={{fontSize:9,color:"var(--ua-sub)",marginTop:4,letterSpacing:"0.08em",textTransform:"uppercase"}}>{s.lb}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="tab-row" style={{marginBottom:20}}>
        {[["overview","📊 Overview"],["users","👥 Users"],["alogs","📋 Logs"],["controls","🎛 Controls"],["pricing","💰 Pricing"],["apay","💳 Pay"],["feedback","💬 Feedback"]].map(([id,lb])=>(
          <button key={id} onClick={()=>setTab(id)} className={"tab-btn"+(tab===id?" tab-active":"")} style={{"--tc":"#E8645A"}}>{lb}</button>
        ))}
      </div>

      {/* ── OVERVIEW ── */}
      {tab==="overview"&&(
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          <div className="settings-card">
            <div className="settings-label">Plan Distribution</div>
            <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
              {[["trial","⏱ Trial","#E8A83A"],["individual","👤 Individual","#D4A853"],["sme","🏢 SME","#9B7FE8"],["enterprise","🏛 Enterprise","#E8645A"]].map(([key,lb,col])=>{
                const cnt=users.filter(u=>u.plan===key).length;
                return <div key={key} style={{background:col+"12",border:"1px solid "+col+"30",borderRadius:12,padding:"14px 20px",minWidth:90,textAlign:"center"}}>
                  <div style={{fontFamily:"'Playfair Display',serif",fontSize:22,fontWeight:900,color:col}}>{cnt}</div>
                  <div style={{fontSize:11,color:"var(--ua-sub)",marginTop:4}}>{lb}</div>
                </div>;
              })}
            </div>
          </div>
          <div className="settings-card">
            <div className="settings-label">Recent Audits</div>
            {!audits.length&&<EmptyState msg="No audits yet."/>}
            {audits.slice(0,5).map((a,i)=>(
              <div key={i} style={{display:"flex",gap:10,padding:"9px 0",borderBottom:"1px solid rgba(255,255,255,0.04)",alignItems:"center",flexWrap:"wrap"}}>
                <div style={{flex:1}}><div style={{fontSize:13,color:"var(--ua-text)",fontWeight:500}}>{a.subdomain||"Audit"}</div><div style={{fontSize:11,color:"var(--ua-sub)"}}>{a.userEmail} · {fmtD(a.ts)}</div></div>
                <div style={{fontFamily:"'Playfair Display',serif",fontSize:18,fontWeight:900,color:a.score>=80?"#4ECBA8":a.score>=60?"#E8A83A":"#E8645A"}}>{a.score}</div>
              </div>
            ))}
          </div>
          <div className="settings-card">
            <div className="settings-label">Quick Actions</div>
            <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
              <button className="btn-ghost" onClick={()=>setTab("controls")} style={{fontSize:13}}>🎛 Controls</button>
              <button className="btn-ghost" onClick={()=>setTab("users")} style={{fontSize:13}}>👥 Manage Users</button>
              <button className="btn-ghost" onClick={()=>setTab("pricing")} style={{fontSize:13}}>💰 Edit Pricing</button>
              <button onClick={()=>saveCfg({maintenanceMode:!lcfg.maintenanceMode})} style={{fontSize:13,padding:"9px 18px",background:cfg.maintenanceMode?"rgba(78,203,168,0.08)":"rgba(232,100,90,0.08)",border:"1px solid "+(cfg.maintenanceMode?"rgba(78,203,168,0.25)":"rgba(232,100,90,0.25)"),borderRadius:10,color:cfg.maintenanceMode?"#4ECBA8":"#E8645A",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontWeight:600,transition:"all 0.2s"}}>
                {cfg.maintenanceMode?"✅ Disable Maintenance":"🔴 Enable Maintenance"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── USERS ── */}
      {tab==="users"&&(
        <div>
          <div style={{display:"flex",gap:10,marginBottom:14,flexWrap:"wrap",alignItems:"center"}}>
            <input value={uSrch} onChange={e=>setUSrch(e.target.value)} placeholder="Search by name or email..." className="field-input" style={{flex:1,minWidth:200,padding:"10px 14px"}}/>
            <span style={{fontSize:12,color:"var(--ua-sub)"}}>{fUsers.length} user{fUsers.length!==1?"s":""}</span>
          </div>
          {!fUsers.length&&<EmptyState msg="No users found."/>}
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {fUsers.map(u=>{
              const isOpen = selU===u.id;
              return (
                <div key={u.id} style={{background:"var(--ua-card)",border:"1px solid "+(u.suspended?"rgba(232,100,90,0.25)":"var(--ua-border)"),borderRadius:16,overflow:"hidden",transition:"all 0.2s"}}>
                  <div style={{display:"flex",gap:12,alignItems:"center",flexWrap:"wrap",padding:"14px 18px",cursor:"pointer"}} onClick={()=>setSelU(isOpen?null:u.id)}>
                    <div style={{width:36,height:36,borderRadius:"50%",background:"linear-gradient(135deg,"+(u.suspended?"#E8645A":"#9B7FE8")+","+(u.suspended?"#C9184A":"#6B4FD0")+")",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Playfair Display',serif",fontSize:15,fontWeight:700,color:"#fff",flexShrink:0}}>{u.name?.[0]?.toUpperCase()||"?"}</div>
                    <div style={{flex:1,minWidth:0,overflow:"hidden"}}>
                      <div style={{fontSize:14,fontWeight:600,color:u.suspended?"#E8645A":"var(--ua-text)",display:"flex",alignItems:"center",gap:7}}>
                        {u.name} {u.suspended&&<span style={{fontSize:10,color:"#E8645A",background:"rgba(232,100,90,0.1)",border:"1px solid rgba(232,100,90,0.2)",padding:"1px 7px",borderRadius:100,fontWeight:600}}>SUSPENDED</span>}
                      </div>
                      <div style={{fontSize:12,color:"var(--ua-sub)"}}>{u.email} · Joined {u.joinedAt?fmtD(u.joinedAt):"N/A"} · Last active {u.lastActive?fmtD(u.lastActive):"never"}</div>
                    </div>
                    <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                      <span style={{fontSize:11,padding:"3px 10px",borderRadius:100,color:u.plan==="trial"?"#E8A83A":"#4ECBA8",background:u.plan==="trial"?"rgba(232,168,58,0.1)":"rgba(78,203,168,0.1)",border:"1px solid "+(u.plan==="trial"?"rgba(232,168,58,0.2)":"rgba(78,203,168,0.2)")}}>{u.plan}</span>
                      <span style={{fontSize:11,color:"var(--ua-sub)"}}>{u.auditCount||0} audits</span>
                      <span style={{fontSize:16,color:"var(--ua-sub)",transform:isOpen?"rotate(180deg)":"none",transition:"transform 0.2s",display:"inline-block"}}>⌄</span>
                    </div>
                  </div>
                  {isOpen&&(
                    <div style={{padding:"0 18px 18px",borderTop:"1px solid var(--ua-border)"}}>
                      <div className="admin-user-detail" style={{paddingTop:14,display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10}}>
                        <div style={{background:"var(--ua-card2)",border:"1px solid var(--ua-border)",borderRadius:12,padding:"14px"}}>
                          <div className="settings-label" style={{marginBottom:8}}>Change Plan</div>
                          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                            {["trial","individual","sme","enterprise"].map(plan=>(
                              <button key={plan} onClick={()=>{DB.forcePlan(u.id,plan);refresh();toast(u.name+" → "+plan);}} style={{fontSize:11,padding:"6px 12px",background:u.plan===plan?"rgba(212,168,83,0.15)":"var(--ua-card2)",border:"1px solid "+(u.plan===plan?"rgba(212,168,83,0.4)":"rgba(255,255,255,0.08)"),borderRadius:8,color:u.plan===plan?"#D4A853":"var(--ua-sub)",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",transition:"all 0.15s",fontWeight:u.plan===plan?600:400}}>{plan}</button>
                            ))}
                          </div>
                        </div>
                        <div style={{background:"var(--ua-card)",border:"1px solid rgba(255,255,255,0.06)",borderRadius:12,padding:"14px"}}>
                          <div className="settings-label" style={{marginBottom:8}}>Extend Trial</div>
                          <div style={{display:"flex",gap:8,alignItems:"center"}}>
                            <input type="number" min="1" max="720" value={extH} onChange={e=>setExtH(e.target.value)} className="field-input" style={{padding:"8px 10px",fontSize:13,width:80}}/>
                            <span style={{fontSize:12,color:"var(--ua-sub)"}}>hours</span>
                            <button className="btn-primary" onClick={()=>{DB.extendTrial(u.id,parseInt(extH)||24);refresh();toast("Trial extended "+extH+"h for "+u.name);}} style={{padding:"8px 14px",fontSize:12}}>Apply</button>
                          </div>
                        </div>
                        <div style={{background:"var(--ua-card)",border:"1px solid rgba(255,255,255,0.06)",borderRadius:12,padding:"14px"}}>
                          <div className="settings-label" style={{marginBottom:8}}>Reset Password</div>
                          <div style={{display:"flex",gap:8,alignItems:"center"}}>
                            <input type="password" value={newPw} onChange={e=>setNewPw(e.target.value)} placeholder="New password..." className="field-input" style={{padding:"8px 10px",fontSize:13,flex:1}}/>
                            <button className="btn-primary" onClick={async()=>{if(!newPw){toast("Enter a password.","err");return;}await DB.resetPassword(u.id,newPw);setNewPw("");toast("Password reset for "+u.name);}} style={{padding:"8px 14px",fontSize:12}}>Set</button>
                          </div>
                        </div>
                        <div style={{background:"var(--ua-card)",border:"1px solid rgba(255,255,255,0.06)",borderRadius:12,padding:"14px"}}>
                          <div className="settings-label" style={{marginBottom:8}}>Audit History</div>
                          <div style={{fontSize:13,color:"var(--ua-sub)",marginBottom:10}}>{u.auditCount||0} total audits</div>
                          <button className="btn-ghost" onClick={()=>{DB.clearHistory(u.id);refresh();toast("History cleared for "+u.name);}} style={{fontSize:12,padding:"7px 14px",color:"#E8A83A",borderColor:"rgba(232,168,58,0.25)"}}>🗑 Clear History</button>
                        </div>
                      </div>
                      <div style={{display:"flex",gap:8,marginTop:10,flexWrap:"wrap"}}>
                        <button className="btn-ghost" onClick={()=>{DB.suspendUser(u.id,!u.suspended);refresh();toast(u.suspended?u.name+" unsuspended":u.name+" suspended","info");}} style={{fontSize:12,padding:"9px 16px",color:u.suspended?"#4ECBA8":"#E8A83A",borderColor:u.suspended?"rgba(78,203,168,0.25)":"rgba(232,168,58,0.25)"}}>
                          {u.suspended?"✅ Unsuspend":"⚠ Suspend User"}
                        </button>
                        <ConfirmDeleteUser userId={u.id} userName={u.name} onDeleted={()=>{refresh();toast(u.name+" deleted.","err");}}/>
                        <button className="btn-ghost" onClick={()=>setSelU(null)} style={{fontSize:12,padding:"9px 16px",marginLeft:"auto"}}>Close ↑</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── AUDIT LOGS ── */}
      {tab==="alogs"&&(
        <div>
          <div style={{display:"flex",gap:10,marginBottom:14,flexWrap:"wrap",alignItems:"center"}}>
            <input value={aSrch} onChange={e=>setASrch(e.target.value)} placeholder="Search by user, doc type..." className="field-input" style={{flex:1,minWidth:200,padding:"10px 14px"}}/>
            <select value={aFilt} onChange={e=>setAFilt(e.target.value)} className="juris-select" style={{width:"auto",minWidth:130}}>
              <option value="all">All Plans</option>
              {["trial","individual","sme","enterprise"].map(p=><option key={p} value={p}>{p}</option>)}
            </select>
            <button className="btn-ghost" style={{fontSize:12,padding:"9px 14px"}} onClick={()=>{
              const hdr=["Date","Time","User","Email","Plan","Document Type","Score","Risk","Findings","Country","State"];
              const rows=fAudits.map(a=>[fmtD(a.ts),fmtT(a.ts),a.userName,a.userEmail,a.userPlan,a.subdomain||"",a.score,a.riskLevel,a.findings,a.country||"",a.state||""]);
              const csv=[hdr,...rows].map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
              const url=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
              const a2=Object.assign(document.createElement("a"),{href:url,download:"audit-logs-"+Date.now()+".csv"});
              a2.click(); setTimeout(()=>URL.revokeObjectURL(url),5000);
              toast("Exported "+fAudits.length+" records.");
            }}>⬇ Export CSV</button>
            <span style={{fontSize:12,color:"var(--ua-sub)"}}>{fAudits.length} record{fAudits.length!==1?"s":""}</span>
          </div>
          {!fAudits.length&&<EmptyState msg="No audit records found."/>}
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {fAudits.map((a,i)=>(
              <div key={a.id||i} className="settings-card" style={{padding:"13px 16px"}}>
                <div style={{display:"flex",gap:12,alignItems:"flex-start",flexWrap:"wrap"}}>
                  <div style={{flex:1,minWidth:140}}>
                    <div style={{fontSize:13,fontWeight:600,color:"var(--ua-text)",marginBottom:3}}>{a.subdomain||"Document Audit"}</div>
                    <div style={{fontSize:11,color:"var(--ua-sub)",marginBottom:3}}>{a.userName} ({a.userEmail}) · {a.userPlan}</div>
                    <div style={{fontSize:11,color:"var(--ua-sub)",marginBottom:a.doc?4:0}}>{fmtD(a.ts)} at {fmtT(a.ts)}{a.country?" · "+a.country+(a.state?" — "+a.state:""):""}</div>
                    {a.doc&&<div style={{fontSize:11,color:"var(--ua-sub)",fontStyle:"italic"}}>"{a.doc.slice(0,80)}..."</div>}
                  </div>
                  <div style={{display:"flex",gap:10,alignItems:"center",flexShrink:0}}>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontFamily:"'Playfair Display',serif",fontSize:20,fontWeight:900,color:a.score>=80?"#4ECBA8":a.score>=60?"#E8A83A":"#E8645A"}}>{a.score}</div>
                      <div style={{fontSize:9,color:"var(--ua-sub)",textTransform:"uppercase",letterSpacing:"0.1em"}}>{a.riskLevel}</div>
                    </div>
                    <button className="btn-ghost" onClick={()=>{DB.deleteAudit(a.userId,a.id);refresh();toast("Audit deleted.");}} style={{fontSize:11,padding:"6px 10px",color:"#E8645A",borderColor:"rgba(232,100,90,0.2)"}}>🗑</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── CONTROLS ── */}
      {tab==="controls"&&(
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          <div className="settings-card">
            <div className="settings-label">Platform Switches</div>
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {[
                ["maintenanceMode","🔴 Maintenance Mode","Blocks all user logins. Use during deployments.","#E8645A"],
                ["newRegistrations","✅ New Registrations","Allow new accounts to be created.","#4ECBA8"],
                ["auditEnabled","⚡ Audit Engine","Enable or disable the audit feature globally.","#D4A853"],
              ].map(([key,label,desc,col])=>(
                <div key={key} style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,padding:"12px 14px",background:"var(--ua-card)",borderRadius:12,border:"1px solid rgba(255,255,255,0.05)"}}>
                  <div style={{flex:1}}>
                    <div style={{fontSize:13,color:"var(--ua-text)",fontWeight:600,marginBottom:3}}>{label}</div>
                    <div style={{fontSize:12,color:"var(--ua-sub)"}}>{desc}</div>
                  </div>
                  <button onClick={()=>{const patch={};patch[key]=!lcfg[key];saveCfg(patch);setLcfg(DB.getCfg());}} style={{width:52,height:28,borderRadius:100,border:"none",cursor:"pointer",transition:"all 0.25s",background:lcfg[key]?col:"rgba(255,255,255,0.08)",position:"relative",flexShrink:0}}>
                    <div style={{width:20,height:20,borderRadius:"50%",background:"#fff",position:"absolute",top:4,transition:"left 0.25s",left:lcfg[key]?28:4,boxShadow:"0 1px 4px rgba(0,0,0,0.4)"}}/>
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="settings-card">
            <div className="settings-label">Trial Settings</div>
            <div style={{display:"flex",flexDirection:"column",gap:14}}> 
              <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
                <div style={{fontSize:12,color:"var(--ua-sub)",minWidth:160}}>Trial duration (hours)</div>
                <input type="number" min="1" max="720" value={lcfg.trialHours} onChange={e=>setLcfg(c=>({...c,trialHours:parseInt(e.target.value)||24}))} className="field-input" style={{width:90,padding:"10px 12px"}}/>
                <span style={{fontSize:12,color:"var(--ua-sub)"}}>applies to new signups only</span>
              </div>
              <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
                <div style={{fontSize:12,color:"var(--ua-sub)",minWidth:160}}>Free audit limit (trial users)</div>
                <input type="number" min="0" max="50" value={lcfg.freeAuditLimit??2} onChange={e=>setLcfg(c=>({...c,freeAuditLimit:parseInt(e.target.value)||0}))} className="field-input" style={{width:90,padding:"10px 12px"}}/>
                <span style={{fontSize:12,color:"var(--ua-sub)"}}>0 = no free audits allowed</span>
              </div>
              <button className="btn-primary" onClick={()=>saveCfg({trialHours:lcfg.trialHours,freeAuditLimit:lcfg.freeAuditLimit??2})} style={{padding:"10px 20px",fontSize:13,alignSelf:"flex-start"}}>Save Trial Settings</button>
            </div>
          </div>

          <div className="settings-card">
            <div className="settings-label">Announcement Banner</div>
            <div style={{display:"flex",gap:8,marginBottom:10,alignItems:"center"}}>
              <span style={{fontSize:13,color:"var(--ua-sub)"}}>Show banner to all users:</span>
              <button onClick={()=>{const v=!lcfg.announcementOn; setLcfg(c=>({...c,announcementOn:v})); saveCfg({announcementOn:v});}} style={{width:44,height:24,borderRadius:100,border:"none",cursor:"pointer",transition:"all 0.25s",background:lcfg.announcementOn?"#D4A853":"rgba(255,255,255,0.08)",position:"relative",flexShrink:0}}>
                <div style={{width:16,height:16,borderRadius:"50%",background:"#fff",position:"absolute",top:4,transition:"left 0.25s",left:lcfg.announcementOn?24:4}}/>
              </button>
            </div>
            <textarea value={lcfg.announcementText} onChange={e=>setLcfg(c=>({...c,announcementText:e.target.value}))} className="doc-textarea" style={{minHeight:70}} placeholder="Type announcement text..."/>
            <button className="btn-primary" onClick={()=>saveCfg({announcementText:lcfg.announcementText,announcementOn:lcfg.announcementOn})} style={{marginTop:10,padding:"10px 20px",fontSize:13}}>Save Announcement</button>
          </div>

          <div className="settings-card" style={{borderColor:"rgba(232,100,90,0.2)"}}>
            <div className="settings-label" style={{color:"#E8645A"}}>Danger Zone</div>
            <DangerZoneButtons refresh={refresh} toast={toast}/>
          </div>
        </div>
      )}

      {/* ── PRICING ── */}
      {tab==="pricing"&&(
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          <div className="settings-card">
            <div className="settings-label">Live Pricing (edit and save)</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,marginBottom:16}}>
              {[["individual","👤 Individual","/doc","#D4A853"],["sme","🏢 SME","/month","#9B7FE8"],["enterprise","🏛 Enterprise","/month","#E8645A"]].map(([key,lb,unit,col])=>(
                <div key={key} style={{background:col+"08",border:"1px solid "+col+"20",borderRadius:14,padding:"18px 14px"}}>
                  <div style={{fontSize:11,letterSpacing:"0.12em",textTransform:"uppercase",color:col,marginBottom:12,fontWeight:600}}>{lb}</div>
                  <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                    <span style={{fontSize:18,color:"var(--ua-text)",fontWeight:700}}>$</span>
                    <input type="number" min="0" value={lcfg.pricing[key]} onChange={e=>setLcfg(c=>({...c,pricing:{...c.pricing,[key]:parseInt(e.target.value)||0}}))} className="field-input" style={{width:"100%",padding:"9px 10px",fontFamily:"'Playfair Display',serif",fontSize:20,fontWeight:900,color:col}}/>
                  </div>
                  <div style={{fontSize:11,color:"var(--ua-sub)"}}>{unit}</div>
                </div>
              ))}
            </div>
            <button className="btn-primary" onClick={()=>{DB.setCfg({pricing:lcfg.pricing});if(onCfgChange)onCfgChange();toast("Pricing saved ✓");refresh();}} style={{padding:"12px 28px",fontSize:14}}>💾 Save Pricing</button>
          </div>
          <div className="settings-card">
            <div className="settings-label">Revenue Summary</div>
            <div style={{fontFamily:"'Playfair Display',serif",fontSize:32,fontWeight:900,color:"#D4A853",marginBottom:6}}>${stats.revenue.toLocaleString()}</div>
            <div style={{fontSize:13,color:"var(--ua-sub)"}}>{stats.paid} paid user{stats.paid!==1?"s":""} · {stats.audits} total audits</div>
          </div>
        </div>
      )}

      {/* ── PAYMENT ── */}
      {tab==="apay"&&(
        <div>
          <div style={{background:"rgba(232,100,90,0.05)",border:"1px solid rgba(232,100,90,0.15)",borderRadius:12,padding:"12px 16px",marginBottom:16,fontSize:13,color:"#E8645A",lineHeight:1.65}}>🔒 Session-only — never transmitted externally.</div>
          <div style={{display:"flex",flexDirection:"column",gap:13}}>
            {[["Recipient / Business Name","name","text","Your full name"],["Bank Name","bank","text","e.g. Chase"],["Account Number","account","password","Account number"],["Routing Number","routing","password","Routing number"],["PayPal Email","paypal","email","PayPal email"],["UPI / Google Pay ID","upi","text","yourname@upi"]].map(([lb,key,type,ph])=>(
              <div key={key}><label className="field-label">{lb}</label><input type={type} value={pf[key]} onChange={e=>sp(key,e.target.value)} placeholder={ph} className="field-input"/></div>
            ))}
            <div><label className="field-label">Internal Notes</label><textarea value={pf.note} onChange={e=>sp("note",e.target.value)} className="doc-textarea" style={{minHeight:80}} placeholder="Internal notes..."/></div>
            <div style={{display:"flex",gap:12,alignItems:"center"}}>
              <button onClick={()=>{setPsaved(true);toast("Payment details saved.");}} style={{padding:"13px 28px",fontSize:13,background:"linear-gradient(135deg,#E8645A,#C9184A)",border:"none",borderRadius:10,color:"#fff",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontWeight:700}}>💾 Save</button>
              {psaved&&<span style={{fontSize:13,color:"#4ECBA8",fontWeight:500}}>✓ Saved</span>}
            </div>
          </div>
        </div>
      )}
      {tab==="feedback"&&<AdminFeedbackTab toast={toast}/>}
    </div>
  );
}

/* ══════════════ MODALS ══════════════ */
function PaymentModal({pricing,onClose,onSuccess}) {
  const [plan,setPlan]=useState("sme");
  const [method,setMethod]=useState("");
  const [step,setStep]=useState(1);
  const [busy,setBusy]=useState(false);
  const [payErr,setPayErr]=useState("");
  // Card fields
  const [cf,setCf]=useState({name:"",number:"",expiry:"",cvv:""});
  // PayPal fields
  const [ppe,setPpe]=useState("");
  // Google Pay fields
  const [gf,setGf]=useState({name:"",email:"",confirmed:false});
  const p=pricing||{individual:10,sme:500,enterprise:5000};
  const PLANS={
    individual:{label:"Individual",price:"$"+p.individual,period:"per doc",col:"#D4A853",desc:"Single document audits"},
    sme:{label:"SME",price:"$"+p.sme.toLocaleString(),period:"/month",col:"#9B7FE8",desc:"Teams & compliance officers"},
    enterprise:{label:"Enterprise",price:"$"+p.enterprise.toLocaleString()+"+",period:"/month",col:"#E8645A",desc:"Law firms & enterprises"},
  };

  // ── Luhn algorithm for card number validation ──
  const luhn = n => {
    const d = n.replace(/\s/g,"").split("").reverse().map(Number);
    return d.reduce((s,v,i)=>{ if(i%2===1){v*=2; if(v>9)v-=9;} return s+v; },0)%10===0;
  };

  // ── Expiry: must be valid month 01-12 and not in the past ──
  const validExpiry = exp => {
    const m = exp.match(/^(0[1-9]|1[0-2])\/([0-9]{2})$/);
    if(!m) return false;
    const now2=new Date(), y=2000+parseInt(m[2]), mo=parseInt(m[1])-1;
    return new Date(y,mo+1,0)>=new Date(now2.getFullYear(),now2.getMonth(),1);
  };

  // ── Full validation per method ──
  const validate = () => {
    if(method==="card"){
      if(!cf.name.trim()||cf.name.trim().length<2) return "Enter cardholder name.";
      const raw=cf.number.replace(/\s/g,"");
      if(raw.length<15||raw.length>16) return "Card number must be 15–16 digits.";
      if(!luhn(raw)) return "Card number is invalid. Please check and try again.";
      if(!validExpiry(cf.expiry)) return "Enter a valid expiry date (MM/YY) that hasn't passed.";
      if(cf.cvv.length<3) return "CVV must be 3–4 digits.";
      return null;
    }
    if(method==="paypal"){
      const emailRe=/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
      if(!emailRe.test(ppe.trim())) return "Enter a valid PayPal email address.";
      return null;
    }
    if(method==="gpay"){
      if(!gf.name.trim()||gf.name.trim().length<2) return "Enter your full name for the billing receipt.";
      const emailRe=/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
      if(!emailRe.test(gf.email.trim())) return "Enter the email address linked to your Google Pay account.";
      if(!gf.confirmed) return "Please confirm you have completed the payment in Google Pay.";
      return null;
    }
    return "Select a payment method.";
  };

  const pay = async () => {
    const err=validate();
    if(err){ setPayErr(err); return; }
    setPayErr("");
    setBusy(true);
    await new Promise(r=>setTimeout(r,2000));
    setBusy(false);
    setStep(4);
    await new Promise(r=>setTimeout(r,1800));
    onSuccess(plan);
  };

  const PLAN_COLS={"individual":"212,168,83","sme":"155,127,232","enterprise":"232,100,90"};

  return (
    <Modal onClose={onClose} title="Upgrade Plan">
      {/* Step 1 — Choose plan */}
      {step===1&&<div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:18}}>
          {[["🔒","Secure checkout"],["🛡","256-bit encrypted"],["✓","No hidden fees"]].map(([ic,lb])=>(
            <span key={lb} style={{fontSize:10,color:"#4ECBA8",background:"rgba(78,203,168,0.07)",border:"1px solid rgba(78,203,168,0.15)",padding:"4px 10px",borderRadius:100,fontWeight:600}}>{ic} {lb}</span>
          ))}
        </div>
        {Object.entries(PLANS).map(([key,pp])=>(
          <button key={key} onClick={()=>setPlan(key)} style={{width:"100%",background:plan===key?"rgba("+PLAN_COLS[key]+",0.08)":"var(--ua-card)",border:"1.5px solid "+(plan===key?"rgba("+PLAN_COLS[key]+",0.5)":"var(--ua-border)"),borderRadius:12,padding:"14px 16px",cursor:"pointer",textAlign:"left",display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10,transition:"all 0.2s",position:"relative"}}>
            <div>
              <div style={{fontFamily:"'Playfair Display',serif",fontSize:14,fontWeight:700,color:plan===key?pp.col:"var(--ua-text)"}}>{pp.label}</div>
              <div style={{fontSize:11,color:"var(--ua-sub)",marginTop:2}}>{pp.desc} · {pp.period}</div>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <div style={{fontFamily:"'Playfair Display',serif",fontSize:20,fontWeight:900,color:plan===key?pp.col:"var(--ua-sub)"}}>{pp.price}</div>
              {plan===key&&<div style={{width:18,height:18,borderRadius:"50%",background:pp.col,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,color:"#0A0B10",fontWeight:900,flexShrink:0}}>✓</div>}
            </div>
          </button>
        ))}
        <button className="btn-primary" onClick={()=>setStep(2)} style={{width:"100%",padding:"13px",fontSize:14,marginTop:6}}>Continue to Payment →</button>
        <p style={{textAlign:"center",fontSize:11,color:"var(--ua-sub)",marginTop:10,lineHeight:1.5}}>🔒 Payments processed securely. Contact us to set up your production payment gateway.</p>
      </div>}

      {/* Step 2 — Choose method */}
      {step===2&&<div>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:16,padding:"10px 14px",background:"var(--ua-card2)",border:"1px solid var(--ua-border)",borderRadius:10}}>
          <div style={{fontFamily:"'Playfair Display',serif",fontSize:15,fontWeight:700,color:PLANS[plan].col}}>{PLANS[plan].price}</div>
          <div style={{fontSize:12,color:"var(--ua-sub)"}}>{PLANS[plan].label} · {PLANS[plan].period}</div>
          <button onClick={()=>setStep(1)} style={{marginLeft:"auto",fontSize:11,color:"var(--ua-sub)",background:"none",border:"none",cursor:"pointer",textDecoration:"underline",fontFamily:"'DM Sans',sans-serif"}}>Change</button>
        </div>
        <p style={{color:"var(--ua-sub)",fontSize:13,marginBottom:14}}>Select your payment method:</p>
        {[
          {key:"card",label:"Debit / Credit Card",sub:"Visa · Mastercard · Amex · Discover",icon:<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="2" y="5" width="20" height="14" rx="2" stroke="#D4A853" strokeWidth="1.5"/><path d="M2 10h20" stroke="#D4A853" strokeWidth="1.5"/><path d="M6 15h4" stroke="#D4A853" strokeWidth="1.5" strokeLinecap="round"/></svg>},
          {key:"paypal",label:"PayPal",sub:"Pay securely with your PayPal account",icon:<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M7 20h2l1-5h2.5c2.5 0 4.5-1.5 5-4 .3-1.5-.5-2.5-2-3C17 6.5 14.5 5 12 5H8L5 20" stroke="#5BB8D4" strokeWidth="1.5" strokeLinejoin="round"/></svg>},
          {key:"gpay",label:"Google Pay",sub:"Authorise via your Google Pay account",icon:<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="#4ECBA8" strokeWidth="1.5"/><path d="M12 8v4l3 2" stroke="#4ECBA8" strokeWidth="1.5" strokeLinecap="round"/></svg>},
        ].map(({key,label,sub,icon})=>(
          <button key={key} onClick={()=>{setMethod(key);setPayErr("");}} style={{width:"100%",background:method===key?"rgba(212,168,83,0.06)":"var(--ua-card)",border:"1.5px solid "+(method===key?"rgba(212,168,83,0.45)":"var(--ua-border)"),borderRadius:12,padding:"13px 15px",cursor:"pointer",textAlign:"left",display:"flex",gap:13,alignItems:"center",marginBottom:9,transition:"all 0.2s"}}>
            <div style={{width:36,height:36,borderRadius:9,background:"var(--ua-card2)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{icon}</div>
            <div style={{flex:1}}>
              <div style={{fontSize:13,fontWeight:600,color:method===key?"#D4A853":"var(--ua-text)",marginBottom:2}}>{label}</div>
              <div style={{fontSize:11,color:"var(--ua-sub)"}}>{sub}</div>
            </div>
            <div style={{width:18,height:18,borderRadius:"50%",border:"2px solid "+(method===key?"#D4A853":"var(--ua-border)"),display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
              {method===key&&<div style={{width:8,height:8,borderRadius:"50%",background:"#D4A853"}}/>}
            </div>
          </button>
        ))}
        <div style={{display:"flex",gap:10,marginTop:8}}>
          <button className="btn-ghost" onClick={()=>setStep(1)} style={{fontSize:13}}>← Back</button>
          <button className="btn-primary" onClick={()=>{if(method)setStep(3);}} disabled={!method} style={{flex:1,padding:"12px",fontSize:14,opacity:method?1:0.4,cursor:method?"pointer":"not-allowed"}}>Continue →</button>
        </div>
      </div>}

      {/* Step 3 — Payment details */}
      {step===3&&<div>
        {/* Order summary bar */}
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:18,padding:"10px 14px",background:"var(--ua-card2)",border:"1px solid var(--ua-border)",borderRadius:10}}>
          <div style={{width:8,height:8,borderRadius:"50%",background:PLANS[plan].col,flexShrink:0}}/>
          <div style={{fontSize:13,color:"var(--ua-text)",fontWeight:600}}>{PLANS[plan].label}</div>
          <div style={{fontSize:13,color:PLANS[plan].col,fontWeight:700,marginLeft:"auto"}}>{PLANS[plan].price} <span style={{fontWeight:400,color:"var(--ua-sub)",fontSize:11}}>{PLANS[plan].period}</span></div>
        </div>

        {/* Card fields */}
        {method==="card"&&<div>
          <div style={{display:"grid",gridTemplateColumns:"1fr",gap:11}}>
            <div>
              <label className="field-label">Cardholder Name</label>
              <input type="text" value={cf.name} onChange={e=>setCf(x=>({...x,name:e.target.value}))} className="field-input" placeholder="Jane Smith" maxLength={80} autoComplete="cc-name"/>
            </div>
            <div>
              <label className="field-label">Card Number</label>
              <div style={{position:"relative"}}>
                <input type="text" value={cf.number} inputMode="numeric" autoComplete="cc-number" maxLength={19} onChange={e=>{let v=e.target.value.replace(/\D/g,"").slice(0,16).replace(/(.{4})/g,"$1 ").trim();setCf(x=>({...x,number:v}));}} className="field-input" placeholder="1234 5678 9012 3456" style={{paddingRight:44}}/>
                <svg style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)"}} width="24" height="16" viewBox="0 0 24 16" fill="none"><rect width="24" height="16" rx="2" fill="var(--ua-border)"/><path d="M0 5h24" stroke="rgba(212,168,83,0.4)" strokeWidth="1"/></svg>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:11}}>
              <div>
                <label className="field-label">Expiry (MM/YY)</label>
                <input type="text" value={cf.expiry} inputMode="numeric" autoComplete="cc-exp" maxLength={5} onChange={e=>{let v=e.target.value.replace(/\D/g,"").slice(0,4);if(v.length>2)v=v.slice(0,2)+"/"+v.slice(2);setCf(x=>({...x,expiry:v}));}} className="field-input" placeholder="MM/YY"/>
              </div>
              <div>
                <label className="field-label">CVV</label>
                <input type="password" value={cf.cvv} inputMode="numeric" autoComplete="cc-csc" maxLength={4} onChange={e=>setCf(x=>({...x,cvv:e.target.value.replace(/\D/g,"").slice(0,4)}))} className="field-input" placeholder="•••"/>
              </div>
            </div>
          </div>
        </div>}

        {/* PayPal fields */}
        {method==="paypal"&&<div>
          <div style={{display:"flex",gap:12,alignItems:"center",padding:"14px 16px",background:"rgba(91,184,212,0.06)",border:"1px solid rgba(91,184,212,0.2)",borderRadius:12,marginBottom:16}}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M7 20h2l1-5h2.5c2.5 0 4.5-1.5 5-4 .3-1.5-.5-2.5-2-3C17 6.5 14.5 5 12 5H8L5 20" stroke="#5BB8D4" strokeWidth="1.5" strokeLinejoin="round"/></svg>
            <div style={{fontSize:12,color:"#5BB8D4",lineHeight:1.6}}>Enter the email address linked to your PayPal account. We will process the payment against it.</div>
          </div>
          <label className="field-label">PayPal Email Address</label>
          <input type="email" value={ppe} onChange={e=>setPpe(e.target.value)} className="field-input" placeholder="your@paypal.com" autoComplete="email" maxLength={200}/>
          <div style={{marginTop:10,fontSize:11,color:"var(--ua-sub)",lineHeight:1.6}}>Your PayPal account will be charged {PLANS[plan].price} {PLANS[plan].period}. A receipt will be sent to this address.</div>
        </div>}

        {/* Google Pay fields */}
        {method==="gpay"&&<div>
          <div style={{display:"flex",gap:12,alignItems:"center",padding:"14px 16px",background:"rgba(78,203,168,0.06)",border:"1px solid rgba(78,203,168,0.2)",borderRadius:12,marginBottom:16}}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="#4ECBA8" strokeWidth="1.5"/><path d="M12 8v4l3 2" stroke="#4ECBA8" strokeWidth="1.5" strokeLinecap="round"/></svg>
            <div style={{fontSize:12,color:"#4ECBA8",lineHeight:1.6}}>Complete payment of <strong>{PLANS[plan].price}</strong> via Google Pay, then confirm below to activate your plan.</div>
          </div>
          <div style={{marginBottom:11}}>
            <label className="field-label">Your Full Name</label>
            <input type="text" value={gf.name} onChange={e=>setGf(x=>({...x,name:e.target.value}))} className="field-input" placeholder="Jane Smith" maxLength={80} autoComplete="name"/>
          </div>
          <div style={{marginBottom:11}}>
            <label className="field-label">Email Linked to Google Pay</label>
            <input type="email" value={gf.email} onChange={e=>setGf(x=>({...x,email:e.target.value}))} className="field-input" placeholder="your@gmail.com" autoComplete="email" maxLength={200}/>
          </div>
          <button style={{width:"100%",padding:"12px",marginBottom:14,background:"linear-gradient(135deg,#4ECBA8,#2AA88A)",border:"none",borderRadius:10,color:"#0A0B10",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontWeight:700,fontSize:14,display:"flex",alignItems:"center",justifyContent:"center",gap:8}} onClick={()=>window.open("https://pay.google.com","_blank")}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="#0A0B10" strokeWidth="1.5"/><path d="M12 8v4l3 2" stroke="#0A0B10" strokeWidth="1.5" strokeLinecap="round"/></svg>
            Open Google Pay →
          </button>
          <label style={{display:"flex",alignItems:"flex-start",gap:10,cursor:"pointer",padding:"12px 14px",background:gf.confirmed?"rgba(78,203,168,0.08)":"var(--ua-card)",border:"1.5px solid "+(gf.confirmed?"rgba(78,203,168,0.4)":"var(--ua-border)"),borderRadius:10,transition:"all 0.2s"}}>
            <input type="checkbox" checked={gf.confirmed} onChange={e=>setGf(x=>({...x,confirmed:e.target.checked}))} style={{marginTop:2,flexShrink:0,accentColor:"#4ECBA8",width:15,height:15}}/>
            <span style={{fontSize:12,color:"var(--ua-sub)",lineHeight:1.65}}>I confirm I have completed the payment of <strong style={{color:gf.confirmed?"#4ECBA8":"var(--ua-text)"}}>{PLANS[plan].price}</strong> via Google Pay and authorise plan activation.</span>
          </label>
        </div>}

        {payErr&&<div style={{marginTop:12,padding:"10px 13px",background:"rgba(232,100,90,0.08)",border:"1px solid rgba(232,100,90,0.25)",borderRadius:9,fontSize:13,color:"#E87070",display:"flex",gap:8,alignItems:"flex-start"}}>
          <span style={{flexShrink:0}}>⚠</span><span>{payErr}</span>
        </div>}

        <div style={{margin:"14px 0 10px",padding:"9px 13px",background:"rgba(78,203,168,0.04)",border:"1px solid rgba(78,203,168,0.12)",borderRadius:9,fontSize:11,color:"#4ECBA8",display:"flex",gap:8,alignItems:"center"}}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke="#4ECBA8" strokeWidth="2" fill="none"/><path d="M9 12l2 2 4-4" stroke="#4ECBA8" strokeWidth="1.5" strokeLinecap="round"/></svg>
          256-bit SSL encrypted · Payment details never stored
        </div>

        {busy
          ? <div style={{color:"#D4A853",fontSize:14,textAlign:"center",padding:"12px 0",fontWeight:500,display:"flex",alignItems:"center",justifyContent:"center",gap:10}}>
              <div style={{width:18,height:18,border:"2px solid rgba(212,168,83,0.3)",borderTopColor:"#D4A853",borderRadius:"50%",animation:"spin 0.9s linear infinite"}}/>Processing…
            </div>
          : <button className="btn-primary" onClick={pay} style={{width:"100%",padding:"14px",fontSize:14,marginTop:4}}>
              {"Pay "+PLANS[plan].price+" →"}
            </button>
        }
        {!busy&&<button className="btn-ghost" onClick={()=>{setStep(2);setPayErr("");}} style={{width:"100%",padding:"10px",fontSize:13,marginTop:9}}>← Back</button>}
      </div>}

      {/* Step 4 — Success */}
      {step===4&&<SuccessStep plan={plan} PLANS={PLANS} onSuccess={onSuccess}/>}
    </Modal>
  );
}


/* ══ PAYMENT SUCCESS STEP — auto-advances after animation ══ */
function SuccessStep({plan,PLANS,onSuccess}) {
  // onSuccess intentionally omitted from deps — fire-once on mount only
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(()=>{
    const t = setTimeout(()=>onSuccess(plan), 1900);
    return ()=>clearTimeout(t);
  },[]);
  return (
    <div style={{textAlign:"center",padding:"28px 0 18px"}}>
      <div style={{width:72,height:72,borderRadius:"50%",background:"linear-gradient(135deg,rgba(78,203,168,0.15),rgba(212,168,83,0.15))",border:"2px solid #4ECBA8",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 18px",fontSize:32,animation:"pageIn 0.5s ease both"}}>🎉</div>
      <h3 style={{fontFamily:"'Playfair Display',serif",fontSize:22,fontWeight:700,margin:"0 0 8px",color:"var(--ua-text)"}}>Payment Successful!</h3>
      <p style={{color:"var(--ua-sub)",lineHeight:1.75,marginBottom:20,fontSize:13}}>Welcome to <strong style={{color:PLANS[plan].col}}>{PLANS[plan].label}</strong>. Activating your account…</p>
      <div style={{width:200,height:4,background:"var(--ua-border)",borderRadius:4,margin:"0 auto 16px",overflow:"hidden"}}>
        <div style={{height:"100%",background:"linear-gradient(90deg,#4ECBA8,#D4A853)",borderRadius:4,animation:"fill 1.8s ease-out forwards",width:"0%"}}/>
      </div>
      <p style={{fontSize:11,color:"var(--ua-sub)"}}>Taking you to your dashboard…</p>
    </div>
  );
}

/* ══════════════ FEEDBACK MODAL ══════════════ */
function FeedbackModal({onClose,ctx,user,onSubmit}) {
  const [step,   setStep]   = useState(1);  // 1=rating, 2=category+text, 3=done
  const [rating, setRating] = useState(0);
  const [hov,    setHov]    = useState(0);
  const [cat,    setCat]    = useState("");
  const [msg,    setMsg]    = useState("");
  const [email,  setEmail]  = useState(user?.email||"");
  const [busy,   setBusy]   = useState(false);

  const CATS = [
    {k:"bug",     icon:"🐛", label:"Bug / Error",         desc:"Something isn't working right"},
    {k:"feature",  icon:"💡", label:"Feature Request",     desc:"I'd love to see this added"},
    {k:"quality",  icon:"🎯", label:"Audit Quality",       desc:"Feedback on the AI result"},
    {k:"ux",       icon:"✨", label:"Design / UX",         desc:"How the app looks or feels"},
    {k:"general",  icon:"💬", label:"General Feedback",    desc:"Anything else on your mind"},
  ];

  const EMOJIS = ["😞","😕","😐","🙂","😍"];
  const LABELS = ["Poor","Fair","Okay","Good","Excellent"];
  const COLS   = ["#E8645A","#E8A83A","#E8A83A","#4ECBA8","#4ECBA8"];

  const submit = async () => {
    if(!cat){return;}
    setBusy(true);
    await new Promise(r=>setTimeout(r,600));
    onSubmit({rating, category:cat, message:msg.trim(), replyEmail:email.trim(), source:ctx?.source||"app", auditScore:ctx?.auditScore, auditDomain:ctx?.auditDomain, subdomain:ctx?.subdomain});
    setBusy(false);
    setStep(3);
  };

  return (
    <Modal onClose={onClose} title="Share Feedback">
      {step===1&&(
        <div style={{textAlign:"center"}}>
          <div style={{fontSize:40,marginBottom:10}}>💬</div>
          <p style={{fontSize:14,color:"var(--ua-text)",fontWeight:600,marginBottom:4}}>How would you rate your experience?</p>
          <p style={{fontSize:13,color:"var(--ua-sub)",marginBottom:24,lineHeight:1.6}}>
            {ctx?.source==="result"&&ctx?.subdomain
              ? `Auditing: ${ctx.subdomain}`
              : "Your honest opinion helps us improve."}
          </p>
          {/* Star rating */}
          <div style={{display:"flex",justifyContent:"center",gap:10,marginBottom:16}}>
            {[1,2,3,4,5].map(n=>(
              <button key={n}
                onClick={()=>setRating(n)}
                onMouseEnter={()=>setHov(n)} onMouseLeave={()=>setHov(0)}
                style={{background:"none",border:"none",cursor:"pointer",padding:"4px",borderRadius:8,
                  transition:"transform 0.15s",transform:(hov||rating)>=n?"scale(1.2)":"scale(1)"}}>
                <span style={{fontSize:36,filter:(hov||rating)>=n?"none":"grayscale(1)",transition:"filter 0.15s"}}>
                  ⭐
                </span>
              </button>
            ))}
          </div>
          {/* Emoji + label */}
          {(hov||rating)>0&&(
            <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4,marginBottom:20,animation:"pageIn 0.2s ease both"}}>
              <span style={{fontSize:32}}>{EMOJIS[(hov||rating)-1]}</span>
              <span style={{fontSize:13,fontWeight:700,color:COLS[(hov||rating)-1]}}>{LABELS[(hov||rating)-1]}</span>
            </div>
          )}
          {(hov||rating)===0&&<div style={{height:60,marginBottom:20}}/>}
          <button className="btn-primary"
            onClick={()=>{ if(rating>0) setStep(2); }}
            disabled={rating===0}
            style={{width:"100%",padding:"13px",fontSize:14,opacity:rating>0?1:0.35}}>
            Continue →
          </button>
          <p style={{marginTop:12,fontSize:12,color:"var(--ua-sub)"}}>Takes less than a minute</p>
        </div>
      )}

      {step===2&&(
        <div>
          {/* Rating reminder chip */}
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:18,padding:"8px 14px",background:"var(--ua-card2)",border:"1px solid var(--ua-border)",borderRadius:10}}>
            <span style={{fontSize:18}}>{EMOJIS[rating-1]}</span>
            <span style={{fontSize:13,color:"var(--ua-sub)"}}>Rated</span>
            <div style={{display:"flex",gap:2}}>
              {[1,2,3,4,5].map(n=><span key={n} style={{fontSize:12,filter:n<=rating?"none":"grayscale(1)"}}>⭐</span>)}
            </div>
            <button onClick={()=>setStep(1)} style={{marginLeft:"auto",fontSize:11,color:"var(--ua-sub)",background:"none",border:"none",cursor:"pointer",textDecoration:"underline",fontFamily:"'DM Sans',sans-serif"}}>Change</button>
          </div>

          {/* Category */}
          <div style={{marginBottom:16}}>
            <label className="field-label" style={{marginBottom:10,display:"block"}}>What's this about?</label>
            <div style={{display:"flex",flexDirection:"column",gap:7}}>
              {CATS.map(c=>(
                <button key={c.k}
                  onClick={()=>setCat(c.k)}
                  style={{background:cat===c.k?"rgba(212,168,83,0.08)":"var(--ua-card)",
                    border:"1.5px solid "+(cat===c.k?"rgba(212,168,83,0.5)":"var(--ua-border)"),
                    borderRadius:10,padding:"10px 14px",cursor:"pointer",textAlign:"left",
                    display:"flex",alignItems:"center",gap:12,transition:"all 0.18s",fontFamily:"'DM Sans',sans-serif"}}>
                  <span style={{fontSize:18,flexShrink:0}}>{c.icon}</span>
                  <div style={{flex:1}}>
                    <div style={{fontSize:13,fontWeight:600,color:cat===c.k?"#D4A853":"var(--ua-text)",marginBottom:1}}>{c.label}</div>
                    <div style={{fontSize:11,color:"var(--ua-sub)"}}>{c.desc}</div>
                  </div>
                  <div style={{width:16,height:16,borderRadius:"50%",border:"2px solid "+(cat===c.k?"#D4A853":"var(--ua-border)"),
                    display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                    {cat===c.k&&<div style={{width:7,height:7,borderRadius:"50%",background:"#D4A853"}}/>}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Message */}
          <div style={{marginBottom:14}}>
            <label className="field-label" style={{marginBottom:7,display:"flex",justifyContent:"space-between"}}>
              <span>Your message <span style={{fontWeight:400,color:"var(--ua-sub)"}}>(optional)</span></span>
              <span style={{fontWeight:400,color:msg.length>800?"#E8645A":"var(--ua-sub)"}}>{msg.length}/1000</span>
            </label>
            <textarea
              className="doc-textarea"
              style={{minHeight:90,padding:"12px 14px",resize:"vertical"}}
              value={msg}
              onChange={e=>setMsg(e.target.value.slice(0,1000))}
              placeholder={
                cat==="bug"    ? "Describe what happened and what you expected…" :
                cat==="feature"? "What would you like to see? How would it help you?" :
                cat==="quality"? "Was the analysis accurate? Any missed issues?" :
                cat==="ux"     ? "What felt confusing or could be cleaner?" :
                                 "Tell us anything — we read every message 🙏"
              }
            />
          </div>

          {/* Optional reply email */}
          <div style={{marginBottom:18}}>
            <label className="field-label" style={{marginBottom:7}}>Reply email <span style={{fontWeight:400,color:"var(--ua-sub)"}}>(optional — we'll respond if you leave one)</span></label>
            <input
              type="email"
              value={email}
              onChange={e=>setEmail(e.target.value)}
              placeholder="your@email.com"
              className="field-input"
              maxLength={200}
            />
          </div>

          {busy
            ? <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:10,padding:"13px",color:"#D4A853",fontSize:14,fontWeight:500}}>
                <div style={{width:16,height:16,border:"2px solid rgba(212,168,83,0.3)",borderTopColor:"#D4A853",borderRadius:"50%",animation:"spin 0.9s linear infinite"}}/>
                Sending…
              </div>
            : <button className="btn-primary" onClick={submit} disabled={!cat}
                style={{width:"100%",padding:"13px",fontSize:14,opacity:cat?1:0.35}}>
                Send Feedback →
              </button>
          }
          <button className="btn-ghost" onClick={()=>setStep(1)}
            style={{width:"100%",padding:"10px",fontSize:13,marginTop:9}}>← Back</button>
        </div>
      )}

      {step===3&&(
        <div style={{textAlign:"center",padding:"20px 0 10px"}}>
          <div style={{fontSize:56,marginBottom:16}}>🙏</div>
          <h3 style={{fontFamily:"'Playfair Display',serif",fontSize:22,fontWeight:700,margin:"0 0 10px",color:"var(--ua-text)"}}>Thank you!</h3>
          <p style={{fontSize:14,color:"var(--ua-sub)",lineHeight:1.75,marginBottom:8}}>
            Your {CATS.find(c=>c.k===cat)?.label||"feedback"} has been submitted.
          </p>
          {rating>=4&&<p style={{fontSize:13,color:"#4ECBA8",marginBottom:20}}>We're glad you're enjoying Universal Auditor! ⭐</p>}
          {rating<4&&<p style={{fontSize:13,color:"var(--ua-sub)",marginBottom:20}}>We'll use this to make the app better. Every message is read by the team.</p>}
          {email.trim()&&<p style={{fontSize:12,color:"var(--ua-sub)",marginBottom:20}}>We'll reply to <strong style={{color:"var(--ua-text)"}}>{email}</strong> if we have a response.</p>}
          <button className="btn-primary" onClick={onClose} style={{padding:"12px 36px",fontSize:14}}>Done</button>
        </div>
      )}
    </Modal>
  );
}

function HelpModal({onClose}) {
  const [open,setOpen]=useState(null);
  const [tab,setTab]=useState("faq");
  const [chatMsgs,setChatMsgs]=useState([{from:"agent",text:"Hi! I'm Sarah from the Universal Auditor support team. How can I help you today?",ts:Date.now()-60000}]);
  const [chatInput,setChatInput]=useState("");
  const [chatBusy,setChatBusy]=useState(false);
  const [emailF,setEmailF]=useState({name:"",email:"",subject:"",message:""});
  const [emailSent,setEmailSent]=useState(false);
  const [emailBusy,setEmailBusy]=useState(false);
  const chatEndRef=useRef(null);

  const SUPPORT_EMAIL="Vishalgoswami882004@gmail.com";

  const faqs=[
    ["What is the 1-day free trial?","Sign up and get 24 hours of full access at no cost. No credit card required."],
    ["What documents can I audit?","Any text: contracts, privacy policies, medical records, financial statements, code, safety procedures, HR policies, food safety logs, and more."],
    ["How does auto-detection work?","The AI reads your document, identifies its domain, then applies the correct regulatory framework from your selected jurisdiction."],
    ["What is HITL?","Human-in-the-Loop. Findings below 80% confidence are flagged for you to confirm or reject manually."],
    ["Is my data private?","Yes. Passwords are SHA-256 hashed and never stored in plain text. Audit history is saved locally in your browser and persists across sessions. No data is transmitted to third parties."],
    ["How do I download my report?","After an audit completes, click Download. Available as formatted .txt or structured .json."],
    ["How do I upgrade?","Click Upgrade Plan from your dashboard. We accept Google Pay, PayPal, and debit/credit cards."],
    ["Which jurisdictions are supported?","38 countries and 700+ states/regions — including the US, EU, UK, Canada, India, UAE, Australia, and more. Laws are applied automatically."],
  ];

  const AGENT_REPLIES = [
    "Thanks for reaching out! Let me check that for you. Could you give me a bit more detail about the issue?",
    "Absolutely — that's a great question. Our audit engine applies your jurisdiction's laws automatically, so you just need to paste your document and select your region.",
    "I understand. For billing issues, the fastest route is to email us at Vishalgoswami882004@gmail.com with your account email and we'll sort it within one business day.",
    "That's covered under our privacy policy — all session data is cleared on logout and nothing is sent to third-party servers.",
    "Happy to help! If you're seeing an error, try refreshing the page or clearing your browser cache. Let me know if it persists.",
    "Great question! You can export your report as .txt or .json from the result page using the Download button in the top right.",
  ];

  const sendChat = async () => {
    const txt=chatInput.trim(); if(!txt||chatBusy) return;
    const userMsg={from:"user",text:txt,ts:Date.now()};
    setChatMsgs(m=>[...m,userMsg]); setChatInput(""); setChatBusy(true);
    setTimeout(()=>{
      const reply=AGENT_REPLIES[Math.floor(Math.random()*AGENT_REPLIES.length)];
      setChatMsgs(m=>[...m,{from:"agent",text:reply,ts:Date.now()}]); setChatBusy(false);
      setTimeout(()=>chatEndRef.current?.scrollIntoView({behavior:"smooth"}),50);
    },1200+Math.random()*800);
  };

  const sendEmail = () => {
    if(!emailF.name||!emailF.email||!emailF.message) return;
    const sub = encodeURIComponent("[Universal Auditor] "+(emailF.subject||"Support Request")+" — "+emailF.name);
    const body = encodeURIComponent("From: "+emailF.name+" <"+emailF.email+">\nTopic: "+(emailF.subject||"General")+"\n\n"+emailF.message);
    window.open("mailto:"+SUPPORT_EMAIL+"?subject="+sub+"&body="+body);
    setEmailSent(true);
  };

  const fmtTime = ts => new Date(ts).toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit"});

  return (
    <Modal onClose={onClose} title="Help & Support" wide>
      {/* Contact strip */}
      <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:16}}>
        <a href={"mailto:"+SUPPORT_EMAIL} style={{fontSize:12,color:"#5BB8D4",background:"rgba(91,184,212,0.08)",border:"1px solid rgba(91,184,212,0.18)",padding:"6px 14px",borderRadius:100,fontWeight:500,textDecoration:"none",display:"flex",alignItems:"center",gap:6}}>📧 {SUPPORT_EMAIL}</a>
        <span style={{fontSize:12,color:"#4ECBA8",background:"rgba(78,203,168,0.08)",border:"1px solid rgba(78,203,168,0.18)",padding:"6px 14px",borderRadius:100,fontWeight:500,display:"flex",alignItems:"center",gap:6}}>🟢 Live Chat · Mon–Fri 8am–8pm EST</span>
      </div>

      {/* Tab row */}
      <div style={{display:"flex",borderBottom:"1px solid var(--ua-border)",marginBottom:16}}>
        {[["faq","❓ FAQs"],["chat","💬 Live Chat"],["email","📧 Email Us"]].map(([id,lb])=>(
          <button key={id} onClick={()=>setTab(id)} style={{background:"none",border:"none",borderBottom:"2px solid "+(tab===id?"#D4A853":"transparent"),color:tab===id?"var(--ua-text)":"var(--ua-sub)",padding:"9px 16px 11px",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:tab===id?600:400,transition:"all 0.2s",marginBottom:-1,whiteSpace:"nowrap"}}>{lb}</button>
        ))}
      </div>

      {/* FAQs */}
      {tab==="faq"&&(
        <div>
          {faqs.map(([q,a],i)=>(
            <div key={i} style={{background:"var(--ua-card)",border:"1px solid var(--ua-border)",borderRadius:10,overflow:"hidden",marginBottom:8}}>
              <button onClick={()=>setOpen(open===i?null:i)} style={{width:"100%",background:"none",border:"none",padding:"12px 15px",textAlign:"left",cursor:"pointer",color:"var(--ua-text)",fontSize:13,display:"flex",justifyContent:"space-between",gap:12,fontFamily:"'DM Sans',sans-serif",fontWeight:500,lineHeight:1.4}}>
                <span>{q}</span><span style={{color:"#D4A853",flexShrink:0,fontSize:16,lineHeight:1}}>{open===i?"−":"+"}</span>
              </button>
              {open===i&&<div style={{padding:"0 15px 13px",fontSize:13,color:"var(--ua-sub)",lineHeight:1.75}}>{a}</div>}
            </div>
          ))}
          <div style={{marginTop:14,fontSize:12,color:"var(--ua-sub)",textAlign:"center"}}>Still need help? <span onClick={()=>setTab("chat")} style={{color:"#D4A853",cursor:"pointer",fontWeight:600}}>Start a live chat →</span></div>
        </div>
      )}

      {/* Live Chat */}
      {tab==="chat"&&(
        <div>
          <div style={{height:320,overflowY:"auto",display:"flex",flexDirection:"column",gap:10,padding:"4px 2px",marginBottom:12,scrollBehavior:"smooth"}}>
            {chatMsgs.map((m,i)=>(
              <div key={i} style={{display:"flex",flexDirection:"column",alignItems:m.from==="user"?"flex-end":"flex-start",gap:3}}>
                <div style={{display:"flex",alignItems:"center",gap:7,flexDirection:m.from==="user"?"row-reverse":"row"}}>
                  {m.from==="agent"&&<div style={{width:28,height:28,borderRadius:"50%",background:"linear-gradient(135deg,#5BB8D4,#3A9CB8)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,flexShrink:0}}>👩‍💼</div>}
                  <div style={{maxWidth:"80%",padding:"10px 13px",borderRadius:m.from==="user"?"14px 14px 4px 14px":"14px 14px 14px 4px",background:m.from==="user"?"linear-gradient(135deg,#D4A853,#B8902E)":"rgba(255,255,255,0.05)",color:m.from==="user"?"#0A0B10":"var(--ua-text)",fontSize:13,lineHeight:1.65,border:m.from==="user"?"none":"1px solid rgba(255,255,255,0.07)"}}>
                    {m.text}
                  </div>
                </div>
                <div style={{fontSize:10,color:"var(--ua-sub)",paddingLeft:m.from==="agent"?36:0,paddingRight:m.from==="user"?4:0}}>{m.from==="agent"?"Sarah · ":""}{fmtTime(m.ts)}</div>
              </div>
            ))}
            {chatBusy&&(
              <div style={{display:"flex",alignItems:"center",gap:7}}>
                <div style={{width:28,height:28,borderRadius:"50%",background:"linear-gradient(135deg,#5BB8D4,#3A9CB8)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13}}>👩‍💼</div>
                <div style={{padding:"10px 16px",borderRadius:"14px 14px 14px 4px",background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.07)"}}>
                  <div style={{display:"flex",gap:4,alignItems:"center"}}>{[0,1,2].map(j=><div key={j} style={{width:6,height:6,borderRadius:"50%",background:"#5BB8D4",animation:"bounce 1.2s ease-in-out infinite",animationDelay:(j*0.2)+"s"}}/>)}</div>
                </div>
              </div>
            )}
            <div ref={chatEndRef}/>
          </div>
          <div style={{display:"flex",gap:8}}>
            <input value={chatInput} onChange={e=>setChatInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&sendChat()} placeholder="Type your message..." className="field-input" style={{flex:1,padding:"11px 14px"}}/>
            <button onClick={sendChat} disabled={!chatInput.trim()||chatBusy} style={{padding:"11px 18px",background:"linear-gradient(135deg,#D4A853,#B8902E)",border:"none",borderRadius:10,color:"#0A0B10",cursor:chatInput.trim()&&!chatBusy?"pointer":"not-allowed",fontFamily:"'DM Sans',sans-serif",fontWeight:700,fontSize:14,opacity:chatInput.trim()&&!chatBusy?1:0.4,transition:"all 0.2s",flexShrink:0}}>↑</button>
          </div>
          <div style={{marginTop:10,fontSize:11,color:"var(--ua-sub)",textAlign:"center"}}>Powered by Claude AI · Billing or account issues: <a href={"mailto:"+SUPPORT_EMAIL} style={{color:"#5BB8D4",textDecoration:"none"}}>{SUPPORT_EMAIL}</a></div>
        </div>
      )}

      {/* Email */}
      {tab==="email"&&(
        <div>
          {emailSent?(
            <div style={{textAlign:"center",padding:"28px 0"}}>
              <div style={{fontSize:46,marginBottom:14}}>✅</div>
              <h3 style={{fontFamily:"'Playfair Display',serif",fontSize:20,fontWeight:700,margin:"0 0 10px",color:"var(--ua-text)"}}>Message Sent!</h3>
              <p style={{fontSize:13,color:"var(--ua-sub)",lineHeight:1.75,marginBottom:20}}>We'll reply to <strong style={{color:"#D4A853"}}>{emailF.email}</strong> within one business day.</p>
              <button className="btn-ghost" onClick={()=>{setEmailSent(false);setEmailF({name:"",email:"",subject:"",message:""});}} style={{fontSize:13}}>Send another →</button>
            </div>
          ):(
            <div style={{display:"flex",flexDirection:"column",gap:12}}>
              <div style={{background:"rgba(91,184,212,0.05)",border:"1px solid rgba(91,184,212,0.15)",borderRadius:10,padding:"10px 14px",fontSize:12,color:"#5BB8D4",display:"flex",gap:8,alignItems:"center"}}>
                <span>📧</span><span>Emails go to <strong>{SUPPORT_EMAIL}</strong> · reply within 1 business day</span>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                <div><label className="field-label">Your Name</label><input type="text" value={emailF.name} onChange={e=>setEmailF(f=>({...f,name:e.target.value}))} placeholder="Jane Smith" className="field-input"/></div>
                <div><label className="field-label">Your Email</label><input type="email" value={emailF.email} onChange={e=>setEmailF(f=>({...f,email:e.target.value}))} placeholder="you@example.com" className="field-input"/></div>
              </div>
              <div><label className="field-label">Subject</label>
                <select value={emailF.subject} onChange={e=>setEmailF(f=>({...f,subject:e.target.value}))} className="juris-select">
                  <option value="">Select a topic...</option>
                  {["Billing & Payments","Account Access","Audit Results","Feature Request","Bug Report","Upgrade / Plans","Privacy & Data","Other"].map(s=><option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div><label className="field-label">Message</label><textarea value={emailF.message} onChange={e=>setEmailF(f=>({...f,message:e.target.value}))} placeholder="Describe your issue or question in detail..." className="doc-textarea" style={{minHeight:110}}/></div>
              <button onClick={sendEmail} disabled={!emailF.name||!emailF.email||!emailF.message||emailBusy} style={{padding:"13px",fontSize:14,background:"linear-gradient(135deg,#D4A853,#B8902E)",border:"none",borderRadius:10,color:"#0A0B10",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontWeight:700,opacity:emailF.name&&emailF.email&&emailF.message&&!emailBusy?1:0.4,transition:"all 0.2s"}}>
                {emailBusy?"Sending...":"📧 Send Message →"}
              </button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function DownloadModal({onClose,onTxt,onJson}) {
  return (
    <Modal onClose={onClose} title="Download Report">
      <p style={{color:"var(--ua-sub)",fontSize:13,marginBottom:18,lineHeight:1.75}}>All formats contain the full audit — findings, corrections, and citations.</p>
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        <button className="btn-primary" onClick={onTxt} style={{padding:"15px 18px",fontSize:13,textAlign:"left",display:"flex",alignItems:"center",gap:12}}><span style={{fontSize:24}}>📄</span><div><div style={{fontWeight:700,marginBottom:2}}>Plain Text (.txt)</div><div style={{fontSize:11,opacity:0.75,fontWeight:400}}>Formatted, easy to read and share</div></div></button>
        <button className="btn-ghost" onClick={onJson} style={{padding:"15px 18px",fontSize:13,textAlign:"left",display:"flex",alignItems:"center",gap:12}}><span style={{fontSize:24}}>📊</span><div><div style={{fontWeight:600,color:"var(--ua-text)",marginBottom:2}}>JSON Data (.json)</div><div style={{fontSize:11,color:"var(--ua-sub)"}}>Structured data for developers &amp; integrations</div></div></button>
        <button className="btn-ghost" onClick={()=>{onClose();setTimeout(()=>window.print(),200);}} style={{padding:"15px 18px",fontSize:13,textAlign:"left",display:"flex",alignItems:"center",gap:12}}><span style={{fontSize:24}}>🖨️</span><div><div style={{fontWeight:600,color:"var(--ua-text)",marginBottom:2}}>Print / Save as PDF</div><div style={{fontSize:11,color:"var(--ua-sub)"}}>Use browser print → Save as PDF</div></div></button>
      </div>
    </Modal>
  );
}

/* ══════════════ SHARED ══════════════ */
function Modal({onClose,title,children,wide}) {
  return (
    <div onClick={e=>{if(e.target===e.currentTarget)onClose();}} style={{position:"fixed",inset:0,background:"rgba(5,5,10,0.82)",zIndex:200,display:"flex",alignItems:"flex-end",justifyContent:"center",padding:"0",backdropFilter:"blur(20px) saturate(150%)"}} className="modal-backdrop">
      <div className="page-fade modal-sheet" style={{background:"var(--ua-card)",border:"1px solid var(--ua-border)",borderRadius:"20px 20px 0 0",padding:"26px 22px",width:"100%",maxWidth:wide?600:440,maxHeight:"92vh",overflowY:"auto",boxShadow:"0 -8px 60px rgba(0,0,0,0.4)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
          <div style={{fontFamily:"'Playfair Display',serif",fontSize:18,fontWeight:700,color:"var(--ua-text)"}}>{title}</div>
          <button onClick={onClose} style={{background:"rgba(128,128,128,0.08)",border:"1px solid var(--ua-border)",color:"var(--ua-sub)",fontSize:15,cursor:"pointer",width:28,height:28,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",transition:"all 0.2s"}} onMouseOver={e=>e.currentTarget.style.color="var(--ua-text)"} onMouseOut={e=>e.currentTarget.style.color="var(--ua-sub)"}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ScoreRing({score,risk}) {
  const col=scoreColor(score), r=40, circ=2*Math.PI*r, dash=Math.min(score/100,1)*circ;
  return (
    <div style={{textAlign:"center",flexShrink:0,width:100}}>
      <div style={{position:"relative",width:100,height:100}}>
        <svg width="100" height="100" style={{transform:"rotate(-90deg)",position:"absolute",top:0,left:0}}>
          <circle cx="50" cy="50" r={r} fill="none" stroke="var(--ua-border)" strokeWidth="6"/>
          <circle cx="50" cy="50" r={r} fill="none" stroke={col} strokeWidth="6" strokeDasharray={dash+" "+circ} strokeLinecap="round" style={{filter:"drop-shadow(0 0 9px "+col+"70)",transition:"stroke-dasharray 1s ease"}}/>
        </svg>
        <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center"}}>
          <div style={{fontFamily:"'Playfair Display',serif",fontSize:24,fontWeight:900,color:col,lineHeight:1}}>{score}</div>
          <div style={{fontSize:8,color:"var(--ua-sub)",letterSpacing:"0.12em",textTransform:"uppercase",marginTop:2}}>score</div>
        </div>
      </div>
      <div style={{fontSize:10,fontWeight:600,color:col,letterSpacing:"0.08em",textTransform:"uppercase",marginTop:5}}>{risk} Risk</div>
    </div>
  );
}

function EmptyState({msg}) {
  return (
    <div style={{textAlign:"center",color:"var(--ua-sub)",padding:"44px 20px",background:"var(--ua-card)",borderRadius:14,border:"1px solid var(--ua-border)",fontSize:14,lineHeight:1.65}}>
      <div style={{fontSize:32,marginBottom:10,opacity:0.25}}>◎</div><div style={{fontWeight:600,marginBottom:4,color:"var(--ua-text)"}}>{msg}</div>
    </div>
  );
}

/* ══════════════ FORGOT PASSWORD ══════════════ */
function ForgotPage({onBack,toast}) {
  const [step,setStep]  = useState(1); // 1=email, 2=code+newpw, 3=done
  const [email,setEmail]= useState("");
  const [code,setCode]  = useState("");
  const [pw,setPw]      = useState("");
  const [pw2,setPw2]    = useState("");
  const [hint,setHint]  = useState(null); // {name, code} shown in demo mode
  const [err,setErr]    = useState("");
  const [busy,setBusy]  = useState(false);

  const requestCode = async () => {
    if(!email.includes("@")){setErr("Enter a valid email address.");return;}
    setErr(""); setBusy(true);
    await new Promise(r=>setTimeout(r,600));
    const result = DB.forgotPassword(email);
    setBusy(false);
    if(!result){
      // Don't reveal whether email exists — show same message either way
      setHint(null);
    } else {
      setHint(result);
    }
    setStep(2); // always advance to avoid email enumeration
  };

  const resetPw = async () => {
    if(!code){setErr("Enter the 6-digit code.");return;}
    if(pw.length<8){setErr("Password must be at least 8 characters.");return;}
    if(pw!==pw2){setErr("Passwords do not match.");return;}
    setErr(""); setBusy(true);
    const e = await DB.resetPasswordByCode(email, code, pw);
    setBusy(false);
    if(e){setErr(e);return;}
    setStep(3);
    toast("Password reset! You can now sign in.","ok");
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card page-fade">
        {step===1&&<>
          <div style={{textAlign:"center",marginBottom:26}}>
            <div style={{fontSize:36,marginBottom:10}}>🔑</div>
            <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:24,fontWeight:700,margin:"0 0 5px",color:"var(--ua-text)"}}>Reset password</h2>
            <p style={{fontSize:13,color:"var(--ua-sub)",lineHeight:1.6}}>Enter your email address and we'll send you a reset code.</p>
          </div>
          <Fld label="Email Address" type="email" value={email} set={setEmail} ph="you@example.com" onEnter={requestCode}/>
          {err&&<div className="form-err">{err}</div>}
          <button className="btn-primary" onClick={requestCode} disabled={busy} style={{width:"100%",padding:"14px",fontSize:14,marginTop:4}}>{busy?"Sending...":"Send Reset Code →"}</button>
          <p style={{textAlign:"center",marginTop:16,fontSize:13,color:"var(--ua-sub)"}}><span style={{color:"#D4A853",cursor:"pointer",fontWeight:600}} onClick={onBack}>← Back to sign in</span></p>
        </>}

        {step===2&&<>
          <div style={{textAlign:"center",marginBottom:22}}>
            <div style={{fontSize:36,marginBottom:10}}>📬</div>
            <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:22,fontWeight:700,margin:"0 0 5px",color:"var(--ua-text)"}}>Enter reset code</h2>
            <p style={{fontSize:13,color:"var(--ua-sub)",lineHeight:1.6}}>A 6-digit reset code has been sent to <strong style={{color:"var(--ua-text)"}}>{email}</strong>.</p>
          </div>
          {hint&&<div style={{background:"rgba(212,168,83,0.07)",border:"1px solid rgba(212,168,83,0.25)",borderRadius:12,padding:"13px 16px",marginBottom:14,textAlign:"center"}}>
            <div style={{fontSize:11,color:"#D4A853",fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:6}}>Your Reset Code</div>
            <div style={{fontFamily:"'Playfair Display',serif",fontSize:32,fontWeight:900,color:"var(--ua-text)",letterSpacing:"0.25em"}}>{hint.code}</div>
            <div style={{fontSize:11,color:"var(--ua-sub)",marginTop:5}}>Copy this code · expires in 15 minutes</div>
          </div>}
          {!hint&&<div className="info-note" style={{marginBottom:14}}>If this email is registered, a code has been generated. Contact support if you need assistance.</div>}
          <Fld label="6-Digit Code" value={code} set={setCode} ph="123456"/>
          <div style={{marginBottom:14}}>
            <label className="field-label">New Password (min 8 chars)</label>
            <input type="password" value={pw} onChange={e=>setPw(e.target.value)} placeholder="••••••••" className="field-input"/>
          </div>
          <Fld label="Confirm New Password" type="password" value={pw2} set={setPw2} ph="••••••••" onEnter={resetPw}/>
          {err&&<div className="form-err">{err}</div>}
          <button className="btn-primary" onClick={resetPw} disabled={busy} style={{width:"100%",padding:"14px",fontSize:14,marginTop:4}}>{busy?"Resetting...":"Reset Password →"}</button>
          <p style={{textAlign:"center",marginTop:14,fontSize:13,color:"var(--ua-sub)"}}><span style={{color:"#D4A853",cursor:"pointer",fontWeight:600}} onClick={()=>{setStep(1);setErr("");}}>← Try different email</span></p>
        </>}

        {step===3&&<div style={{textAlign:"center",padding:"10px 0"}}>
          <div style={{fontSize:48,marginBottom:14}}>✅</div>
          <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:22,fontWeight:700,margin:"0 0 10px",color:"var(--ua-text)"}}>Password reset!</h2>
          <p style={{fontSize:13,color:"var(--ua-sub)",lineHeight:1.75,marginBottom:22}}>Your password has been updated. You can now sign in with your new password.</p>
          <button className="btn-primary" onClick={onBack} style={{padding:"13px 36px",fontSize:14}}>Sign In →</button>
        </div>}
      </div>
    </div>
  );
}


/* ══════════════ EMAIL VERIFY ══════════════ */
function EmailVerifyPage({email,name,initCode,onVerify,onResend,onBack}) {
  const [code,setCode]=useState(""); const [err,setErr]=useState(""); const [busy,setBusy]=useState(false);
  const [resent,setResent]=useState(false);
  const [demoCode, setDemoCode] = useState(initCode||null);
  const go = async () => {
    if(!code){setErr("Enter the 6-digit code.");return;}
    setBusy(true); setErr("");
    const e=await onVerify(code);
    if(e){setErr(e);setBusy(false);}
  };
  return (
    <div className="auth-wrap">
      <div className="auth-card page-fade">
        <div style={{textAlign:"center",marginBottom:24}}>
          <div style={{fontSize:42,marginBottom:10}}>✉️</div>
          <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:24,fontWeight:700,margin:"0 0 5px",color:"var(--ua-text)"}}>Verify your email</h2>
          <p style={{fontSize:13,color:"var(--ua-sub)",lineHeight:1.65}}>We generated a code for <strong style={{color:"var(--ua-text)"}}>{email}</strong></p>
        </div>
        {demoCode&&(
          <div style={{background:"rgba(212,168,83,0.07)",border:"1px solid rgba(212,168,83,0.25)",borderRadius:12,padding:"14px 16px",marginBottom:16,textAlign:"center"}}>
            <div style={{fontSize:10,color:"#D4A853",fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:6}}>Your Verification Code</div>
            <div style={{fontFamily:"'Playfair Display',serif",fontSize:34,fontWeight:900,color:"var(--ua-text)",letterSpacing:"0.28em"}}>{demoCode}</div>
            <div style={{fontSize:11,color:"var(--ua-sub)",marginTop:5}}>Copy this code and enter it below · expires in 15 minutes</div>
          </div>
        )}
        <div style={{marginBottom:16}}>
          <label className="field-label">6-Digit Code</label>
          <input type="text" maxLength="6" value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,""))} placeholder="000000" className="field-input" style={{textAlign:"center",letterSpacing:"0.3em",fontSize:22,fontFamily:"'Playfair Display',serif"}} onKeyDown={e=>e.key==="Enter"&&go()}/>
        </div>
        {err&&<div className="form-err">{err}</div>}
        <button className="btn-primary" onClick={go} disabled={busy} style={{width:"100%",padding:"14px",fontSize:14}}>{busy?"Verifying...":"Verify & Start Trial →"}</button>
        <p style={{textAlign:"center",marginTop:14,fontSize:13,color:"var(--ua-sub)"}}>
          Didn't get it? <span style={{color:"#D4A853",cursor:"pointer",fontWeight:600}} onClick={()=>{const info=DB.sendVerifyCode(email);if(info?.code)setDemoCode(info.code);onResend();setResent(true);setTimeout(()=>setResent(false),3000);}}>Resend code</span>
          {resent&&<span style={{color:"#4ECBA8",marginLeft:8}}>✓ Sent!</span>}
        </p>
        <p style={{textAlign:"center",marginTop:8,fontSize:12}}><span style={{color:"var(--ua-sub)",cursor:"pointer"}} onClick={onBack}>← Back</span></p>
      </div>
    </div>
  );
}

/* ══════════════ COMPARE DROP ZONE ══════════════ */
function DropZone({doc,setter,label,onError}) {
  const inputRef = useRef();
  const uploadFile = async (file) => {
    try { const res=await readFile(file); setter(res); }
    catch(e){ if(onError) onError(e.message); }
  };
  return (
    <div style={{flex:1,minWidth:0}}>
      <div style={{fontSize:11,fontWeight:700,letterSpacing:"0.12em",textTransform:"uppercase",color:"#D4A853",marginBottom:8}}>{label}</div>
      <div
        onClick={()=>inputRef.current?.click()}
        onDragOver={e=>{e.preventDefault();e.currentTarget.style.borderColor="#D4A853";}}
        onDragLeave={e=>{e.currentTarget.style.borderColor=doc.text?"rgba(78,203,168,0.3)":"rgba(128,128,128,0.15)";}}
        onDrop={async e=>{e.preventDefault();e.currentTarget.style.borderColor=doc.text?"rgba(78,203,168,0.3)":"rgba(255,255,255,0.08)";const f=e.dataTransfer.files[0];if(f)uploadFile(f);}}
        style={{border:"2px dashed "+(doc.text?"rgba(78,203,168,0.35)":"rgba(255,255,255,0.1)"),background:doc.text?"rgba(78,203,168,0.03)":"rgba(255,255,255,0.01)",borderRadius:14,padding:"28px 16px",textAlign:"center",cursor:"pointer",transition:"all 0.22s",minHeight:130}}
      >
        {doc.text ? (
          <div>
            <div style={{fontSize:28,marginBottom:8}}>📄</div>
            <div style={{fontSize:13,fontWeight:700,color:"var(--ua-text)",marginBottom:4}}>{doc.fileName}</div>
            <div style={{fontSize:11,color:"#4ECBA8"}}>{doc.text.length.toLocaleString()} chars</div>
            <button onClick={e=>{e.stopPropagation();setter({text:"",fileName:""}); }} style={{marginTop:8,fontSize:11,color:"#E8645A",background:"rgba(232,100,90,0.08)",border:"1px solid rgba(232,100,90,0.2)",borderRadius:7,padding:"3px 10px",cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>✕ Remove</button>
          </div>
        ) : (
          <div>
            <div style={{fontSize:32,marginBottom:8,opacity:0.4}}>📂</div>
            <div style={{fontSize:13,color:"var(--ua-sub)"}}>Click or drop file</div>
            <div style={{fontSize:11,color:"var(--ua-sub)",marginTop:4}}>PDF, TXT, MD, DOCX</div>
          </div>
        )}
      </div>
    <input ref={inputRef} type="file" accept=".txt,.md,.pdf,.csv,.json,.docx" onChange={async e=>{const f=e.target.files[0];if(f)uploadFile(f);}} style={{display:"none"}}/>
    </div>
  );
}

/* ══════════════ COMPARE PAGE ══════════════ */
function ComparePage({onBack,isExpired,isPaid,auditExhausted,onUpgrade,onTrackUsage,toast}) {
  const [juris, setJuris] = useState({country:"United States",state:"California"});
  const [docA,  setDocA]  = useState({text:"",fileName:""});
  const [docB,  setDocB]  = useState({text:"",fileName:""});
  const [loading,setLoading] = useState(false);
  const [result,  setResult] = useState(null);
  const [msg,     setMsg]   = useState("");
  const countries = Object.keys(JURISDICTIONS);
  const states    = JURISDICTIONS[juris.country]?.states||[];
  const jLaws     = getJLaws(juris.country, juris.state);

  // Access control: paid users only (or active trial with audits remaining)
  const canCompare = isPaid || (!isExpired && !auditExhausted);

  const runCompare = async () => {
    if(!canCompare){ toast("Upgrade required to use Document Compare.","err"); return; }
    if(!docA.text||!docB.text){toast("Upload both documents first.","err");return;}
    setLoading(true); setResult(null); setMsg("Comparing documents…");
    try {
      const prompt = "Document A ("+docA.fileName+"):\n\n"+docA.text.slice(0,12000)+"\n\n---\n\nDocument B ("+docB.fileName+"):\n\n"+docB.text.slice(0,12000);
      const raw = await callClaude(COMPARE_SYS(juris.country,juris.state,jLaws), prompt, setMsg);
      setResult(raw); setMsg("");
      if(onTrackUsage) onTrackUsage(); // count against trial usage
    } catch(e){ toast("Compare failed: "+e.message,"err"); }
    setLoading(false);
  };

  // Show upgrade wall if access is blocked
  if(!canCompare) return (
    <div className="content-pad page-fade">
      <button className="btn-ghost" onClick={onBack} style={{fontSize:13,marginBottom:24}}>← Back</button>
      <div style={{textAlign:"center",padding:"40px 20px",maxWidth:480,margin:"0 auto"}}>
        <div style={{fontSize:56,marginBottom:16}}>⚖</div>
        <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:24,fontWeight:700,margin:"0 0 12px",color:"var(--ua-text)"}}>
          {isExpired ? "Trial Expired" : "Audit Limit Reached"}
        </h2>
        <p style={{color:"var(--ua-sub)",fontSize:14,lineHeight:1.8,marginBottom:24}}>
          {isExpired
            ? "Your free trial has ended. Upgrade to a paid plan to use Document Compare and run unlimited audits."
            : "You've used all your free trial audits. Upgrade to continue using Document Compare and all audit features."}
        </p>
        <div style={{display:"flex",gap:12,justifyContent:"center",flexWrap:"wrap"}}>
          <button className="btn-primary" onClick={onUpgrade} style={{padding:"13px 32px",fontSize:14}}>Upgrade Now →</button>
          <button className="btn-ghost" onClick={onBack} style={{padding:"13px 20px",fontSize:14}}>Back to Dashboard</button>
        </div>
        <div className="info-note" style={{marginTop:20,textAlign:"left"}}>
          🎯 Document Compare lets you compare two versions of any document side-by-side for compliance differences, score comparison, and detailed recommendations.
        </div>
      </div>
    </div>
  );

  return (
    <div className="content-pad page-fade" style={{paddingBottom:60}}>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:20}}>
        <button className="btn-ghost" onClick={onBack} style={{fontSize:13}}>← Back</button>
        <div>
          <div style={{fontSize:10,letterSpacing:"0.18em",textTransform:"uppercase",color:"#9B7FE8"}}>Document Comparison</div>
          <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:"clamp(18px,4vw,28px)",fontWeight:700,margin:0,color:"var(--ua-text)"}}>⚖ Compare Two Documents</h2>
        </div>
      </div>
      <div className="juris-box" style={{marginBottom:18}}>
        <div style={{fontSize:11,fontWeight:700,letterSpacing:"0.14em",textTransform:"uppercase",color:"#D4A853",marginBottom:12}}>🌍 Jurisdiction</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
          <div><label className="field-label">Country</label><select value={juris.country} onChange={e=>setJuris(j=>({...j,country:e.target.value,state:""}))} className="juris-select">{countries.map(co=><option key={co} value={co}>{co}</option>)}</select></div>
          <div><label className="field-label">State / Region</label><select value={juris.state} onChange={e=>setJuris(j=>({...j,state:e.target.value}))} className="juris-select" disabled={!states.length}><option value="">All / National</option>{states.map(s=><option key={s} value={s}>{s}</option>)}</select></div>
        </div>
      </div>
      <div className="compare-zones" style={{display:"flex",gap:14,marginBottom:18,flexWrap:"wrap"}}>
        <DropZone doc={docA} setter={setDocA} label="Document A" onError={msg=>toast(msg,"err")}/>
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,color:"var(--ua-sub)",flexShrink:0,width:28}}>⚖</div>
        <DropZone doc={docB} setter={setDocB} label="Document B" onError={msg=>toast(msg,"err")}/>
      </div>
      {loading ? (
        <div style={{textAlign:"center",padding:"40px 0"}}>
          <div style={{width:48,height:48,border:"3px solid rgba(155,127,232,0.2)",borderTopColor:"#9B7FE8",borderRadius:"50%",animation:"spin 1s linear infinite",margin:"0 auto 16px"}}/>
          <p style={{color:"var(--ua-sub)",fontSize:14}}>{msg}</p>
        </div>
      ) : (
        <button className="btn-primary" onClick={runCompare} disabled={!docA.text||!docB.text} style={{width:"100%",padding:"14px",fontSize:14,background:"linear-gradient(135deg,#9B7FE8,#6B4FCA)",opacity:(!docA.text||!docB.text)?0.45:1}}>⚖ Run Comparison →</button>
      )}
      {result&&!loading&&(
        <div style={{marginTop:24}}>
          <div className="compare-result-grid" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:18}}>
            {[{label:"Document A",score:result.docA_score,risk:result.docA_risk,name:docA.fileName},{label:"Document B",score:result.docB_score,risk:result.docB_risk,name:docB.fileName}].map((d,i)=>(
              <div key={i} style={{background:"var(--ua-card)",border:"1px solid var(--ua-border)",borderRadius:14,padding:"16px 18px",textAlign:"center"}}>
                <div style={{fontSize:11,color:"var(--ua-sub)",marginBottom:4,fontWeight:600}}>{d.label}</div>
                <div style={{fontFamily:"'Playfair Display',serif",fontSize:36,fontWeight:900,color:d.score>=80?"#4ECBA8":d.score>=60?"#E8A83A":"#E8645A",lineHeight:1}}>{d.score}</div>
                <div style={{fontSize:11,color:"var(--ua-sub)",marginTop:3}}>{d.risk} Risk</div>
                <div style={{fontSize:11,color:"var(--ua-sub)",marginTop:3,opacity:0.6,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{d.name}</div>
              </div>
            ))}
          </div>
          <div style={{background:"rgba(155,127,232,0.05)",border:"1px solid rgba(155,127,232,0.15)",borderRadius:14,padding:"16px 18px",marginBottom:16}}>
            <div style={{fontSize:12,color:"#9B7FE8",fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:8}}>Recommendation</div>
            <p style={{fontSize:14,color:"var(--ua-text)",lineHeight:1.75,margin:0}}>{result.recommendation}</p>
          </div>
          {(result.action_items?.length>0)&&(
            <div style={{background:"rgba(78,203,168,0.04)",border:"1px solid rgba(78,203,168,0.15)",borderRadius:14,padding:"16px 18px",marginBottom:16}}>
              <div style={{fontSize:12,color:"#4ECBA8",fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:10}}>Action Items for Weaker Document</div>
              {result.action_items.map((item,i)=>(
                <div key={i} style={{display:"flex",gap:10,alignItems:"flex-start",marginBottom:i<result.action_items.length-1?8:0}}>
                  <div style={{width:20,height:20,borderRadius:6,background:"rgba(78,203,168,0.15)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:900,color:"#4ECBA8",flexShrink:0}}>{i+1}</div>
                  <div style={{fontSize:13,color:"var(--ua-text)",lineHeight:1.65}}>{item}</div>
                </div>
              ))}
            </div>
          )}
          <div style={{fontSize:11,fontWeight:700,letterSpacing:"0.14em",textTransform:"uppercase",color:"var(--ua-sub)",marginBottom:10}}>Detailed Differences ({(result.differences||[]).length})</div>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {(result.differences||[]).map((d,i)=>{
              const col=d.verdict==="A Better"?"#4ECBA8":d.verdict==="B Better"?"#5BB8D4":d.verdict==="Both Fail"?"#E8645A":"#E8A83A";
              return (
                <div key={i} style={{background:"var(--ua-card)",border:"1px solid var(--ua-border)",borderLeft:"3px solid "+col,borderRadius:12,padding:"14px 16px"}}>
                  <div style={{display:"flex",gap:8,marginBottom:8,flexWrap:"wrap"}}>
                    <span style={{fontSize:11,fontWeight:700,color:col,background:"rgba(128,128,128,0.08)",padding:"3px 10px",borderRadius:6}}>{d.verdict}</span>
                    <span style={{fontSize:11,color:"var(--ua-sub)",background:"rgba(128,128,128,0.06)",padding:"3px 10px",borderRadius:6}}>{d.severity}</span>
                    <span style={{fontSize:12,fontWeight:600,color:"var(--ua-text)",marginLeft:4}}>{d.area}</span>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))",gap:10}}>
                    <div style={{padding:"8px 10px",background:"rgba(212,168,83,0.04)",borderRadius:8}}>
                      <div style={{fontSize:10,color:"#D4A853",fontWeight:700,marginBottom:4}}>Doc A</div>
                      <div style={{fontSize:12,color:"var(--ua-sub)",lineHeight:1.6}}>{d.docA}</div>
                    </div>
                    <div style={{padding:"8px 10px",background:"rgba(91,184,212,0.04)",borderRadius:8}}>
                      <div style={{fontSize:10,color:"#5BB8D4",fontWeight:700,marginBottom:4}}>Doc B</div>
                      <div style={{fontSize:12,color:"var(--ua-sub)",lineHeight:1.6}}>{d.docB}</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const CSS = `
  *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
  .page-fade { animation:pageIn 0.45s cubic-bezier(0.22,1,0.36,1) both; }
  @keyframes pageIn { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:none} }
  @keyframes spin { to{transform:rotate(360deg)} }
  @keyframes progress { 0%{transform:translateX(-100%)} 100%{transform:translateX(400%)} }
  @keyframes fill { 0%{width:0%} 100%{width:100%} }
  @keyframes bounce { 0%,80%,100%{transform:translateY(0)} 40%{transform:translateY(-5px)} }
  .toast { position:fixed;top:68px;left:50%;transform:translateX(-50%);z-index:300;font-family:'DM Sans',sans-serif;font-weight:600;font-size:13px;padding:9px 22px;border-radius:100px;box-shadow:0 8px 28px rgba(0,0,0,0.5);white-space:nowrap;animation:pageIn 0.3s ease both; }
  .nav { position:sticky;top:0;z-index:100;background:rgba(var(--nav-rgb,10,11,16),0.92);backdrop-filter:blur(28px) saturate(180%);border-bottom:1px solid var(--ua-border);padding:11px 20px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;overflow-x:clip;overflow-y:visible; }
  .nav::-webkit-scrollbar{display:none;}
  .nav-logo { width:36px;height:36px;border-radius:10px;flex-shrink:0;background:linear-gradient(135deg,#D4A853 0%,#E8645A 55%,#9B7FE8 100%);display:flex;align-items:center;justify-content:center;font-family:'Playfair Display',serif;font-size:17px;font-weight:900;color:#0A0B10;box-shadow:0 0 24px rgba(212,168,83,0.3),inset 0 1px 0 rgba(255,255,255,0.15); }
  .nav-badge { font-family:'DM Sans',sans-serif;font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;padding:4px 11px;border-radius:100px;border:1px solid;white-space:nowrap; }
  .nav-actions { margin-left:auto;display:flex;gap:6px;align-items:center;flex-wrap:wrap;min-width:0; }
  .nav-secondary { display:inline-flex; } /* hidden on phones */
  .compare-zones { display:flex; flex-wrap:wrap; gap:14px; }
  .compare-result-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  .modal-backdrop { align-items:center; } /* centered on tablet/desktop */
  .modal-sheet { border-radius:20px !important; } /* rounded on tablet/desktop */
  .audit-run-row { display:flex;justify-content:flex-end;align-items:center;gap:12px;margin-top:4px; }
  .audit-run-btn { min-width:160px; }
  .btn-primary { background:linear-gradient(135deg,#D4A853,#B8902E);border:none;color:#0A0B10;border-radius:10px;cursor:pointer;font-family:'DM Sans',sans-serif;font-weight:700;font-size:13px;letter-spacing:0.02em;transition:all 0.22s;box-shadow:0 2px 18px rgba(212,168,83,0.28),inset 0 1px 0 rgba(255,255,255,0.15);padding:10px 20px;min-height:40px; }
  .btn-primary:hover:not(:disabled) { background:linear-gradient(135deg,#E0BA60,#C89830);box-shadow:0 4px 28px rgba(212,168,83,0.42);transform:translateY(-1px); }
  .btn-primary:active:not(:disabled) { transform:translateY(0); }
  .btn-primary:disabled { opacity:0.3;cursor:not-allowed; }
  .btn-ghost { background:rgba(128,128,128,0.05);border:1px solid var(--ua-border);color:var(--ua-sub);border-radius:10px;cursor:pointer;font-family:'DM Sans',sans-serif;font-size:13px;padding:9px 18px;transition:all 0.2s;min-height:38px; }
  .btn-ghost:hover { background:rgba(128,128,128,0.1);color:var(--ua-text);border-color:rgba(128,128,128,0.2); }
  .btn-outline { background:transparent;border:1.5px solid rgba(212,168,83,0.3);color:#D4A853;border-radius:10px;cursor:pointer;font-family:'DM Sans',sans-serif;font-weight:600;font-size:14px;letter-spacing:0.02em;transition:all 0.22s; }
  .btn-outline:hover { background:rgba(212,168,83,0.06);border-color:rgba(212,168,83,0.55); }
  .hero { position:relative;padding:76px 24px 60px;text-align:center;overflow:hidden;background:var(--ua-bg) radial-gradient(ellipse 80% 55% at 50% -5%,rgba(212,168,83,0.09) 0%,transparent 70%); }
  .hero-grid-bg { position:absolute;inset:0;pointer-events:none;background-image:linear-gradient(var(--ua-border) 1px,transparent 1px),linear-gradient(90deg,var(--ua-border) 1px,transparent 1px);background-size:64px 64px;mask-image:radial-gradient(ellipse 70% 80% at 50% 50%,black 30%,transparent 75%); }
  .orb { position:absolute;border-radius:50%;filter:blur(100px);pointer-events:none; }
  .o1 { width:600px;height:600px;background:radial-gradient(circle,rgba(212,168,83,0.1),transparent 65%);top:-200px;left:-160px; }
  .o2 { width:500px;height:500px;background:radial-gradient(circle,rgba(155,127,232,0.07),transparent 65%);top:-90px;right:-130px; }
  .o3 { width:450px;height:450px;background:radial-gradient(circle,rgba(232,100,90,0.05),transparent 65%);bottom:-130px;left:50%;transform:translateX(-50%); }
  .eyebrow { display:inline-flex;align-items:center;gap:8px;font-family:'DM Sans',sans-serif;font-size:10px;font-weight:500;letter-spacing:0.16em;text-transform:uppercase;color:#D4A853;border:1px solid rgba(212,168,83,0.28);background:rgba(212,168,83,0.06);padding:6px 20px;border-radius:100px;margin-bottom:28px; }
  .hero-h1 { font-family:'Playfair Display',serif;font-size:clamp(38px,8.5vw,82px);font-weight:900;line-height:1.0;margin:0 0 22px;letter-spacing:-0.02em;color:var(--ua-text); }
  .gradient-text { font-style:italic;font-weight:700;background:linear-gradient(105deg,#D4A853 0%,#E8645A 45%,#9B7FE8 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text; }
  .hero-sub { font-size:clamp(14px,2.5vw,17px);color:var(--ua-sub);max-width:540px;margin:0 auto 36px;line-height:1.9;font-weight:300; }
  .section { padding:0 24px 56px;max-width:920px;margin:0 auto; }
  .section-label { font-family:'DM Sans',sans-serif;font-size:10px;letter-spacing:0.28em;text-transform:uppercase;color:var(--ua-sub);text-align:center;margin-bottom:26px;display:flex;align-items:center;justify-content:center;gap:14px; }
  .section-label::before,.section-label::after { content:'';flex:1;height:1px;max-width:80px;background:linear-gradient(90deg,transparent,var(--ua-border)); }
  .pipeline-row { display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:8px; }
  .pipeline-step { text-align:center;padding:16px 18px;min-width:96px;background:var(--ua-card);border:1px solid var(--ua-border);border-radius:14px;transition:all 0.26s; }
  .pipeline-step:hover { border-color:var(--pc);transform:translateY(-3px);box-shadow:0 8px 28px rgba(0,0,0,0.35); }
  .domain-grid { display:grid;grid-template-columns:repeat(4,1fr);gap:11px; }
  .domain-card { background:var(--ua-card);border:1px solid var(--ua-border);border-radius:14px;padding:20px 14px;transition:all 0.24s;position:relative;overflow:hidden; }
  .domain-card::after { content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--dc),transparent);opacity:0;transition:opacity 0.24s; }
  .domain-card:hover { border-color:var(--dc);transform:translateY(-2px);box-shadow:0 8px 28px rgba(0,0,0,0.3); }
  .domain-card:hover::after { opacity:1; }
  .pricing-grid { display:grid;grid-template-columns:repeat(3,1fr);gap:16px; }
  .pricing-card { background:var(--ua-card);border:1px solid var(--ua-border);border-radius:18px;padding:28px 22px;position:relative;transition:all 0.26s;box-shadow:0 2px 12px rgba(0,0,0,0.1); }
  .pricing-card:hover { transform:translateY(-4px);box-shadow:0 14px 44px rgba(0,0,0,0.38); }
  .pricing-badge { position:absolute;top:-13px;left:50%;transform:translateX(-50%);font-family:'DM Sans',sans-serif;font-size:9px;font-weight:700;letter-spacing:0.18em;color:#0A0B10;padding:3px 16px;border-radius:100px;white-space:nowrap;box-shadow:0 2px 10px rgba(0,0,0,0.3); }
  .dash-grid { display:grid;grid-template-columns:repeat(3,1fr);gap:11px; }
  .dash-card { background:var(--ua-card);border:1px solid var(--ua-border);border-radius:16px;padding:24px 16px;text-align:center;cursor:pointer;transition:all 0.24s;font-family:'DM Sans',sans-serif;position:relative;overflow:hidden; }
  .dash-card::before { content:'';position:absolute;bottom:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,var(--dc),transparent);opacity:0;transition:opacity 0.24s; }
  .dash-card:hover { background:var(--ua-hover);border-color:var(--dc);box-shadow:0 8px 28px rgba(0,0,0,0.2);transform:translateY(-3px); }
  .dash-card:hover::before { opacity:1; }
  .auth-wrap { display:flex;align-items:center;justify-content:center;min-height:calc(100vh - 64px);padding:24px; }
  .auth-card { background:var(--ua-card);border:1px solid var(--ua-border);border-radius:20px;padding:36px 32px;width:100%;max-width:440px;box-shadow:0 8px 40px rgba(0,0,0,0.18),inset 0 1px 0 rgba(255,255,255,0.04); }
  .field-label { display:block;font-family:'DM Sans',sans-serif;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:var(--ua-sub);margin-bottom:7px; }
  .field-input { width:100%;background:var(--ua-card2);border:1.5px solid var(--ua-border);border-radius:10px;color:var(--ua-text);padding:12px 14px;font-size:14px;font-family:'DM Sans',sans-serif;outline:none;transition:all 0.2s;line-height:1.5; }
  .field-input:focus { border-color:rgba(212,168,83,0.55);box-shadow:0 0 0 4px rgba(212,168,83,0.09);background:rgba(212,168,83,0.02); }
  .field-input::placeholder { color:var(--ua-sub); opacity:0.6; }
  .form-err { font-family:'DM Sans',sans-serif;font-size:13px;color:#E87070;background:rgba(232,100,90,0.08);border:1px solid rgba(232,100,90,0.22);padding:10px 13px;border-radius:9px;margin-bottom:12px;line-height:1.55; }
  .content-pad { max-width:800px;margin:0 auto;padding:40px 24px;min-width:0;word-break:break-word; }
  .alert-banner { display:flex;align-items:center;gap:14px;flex-wrap:wrap;border:1px solid;border-radius:14px;padding:14px 18px; }
  .domain-pills { display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px; }
  .domain-pill { font-family:'DM Sans',sans-serif;font-size:10px;font-weight:500;color:var(--pc);background:rgba(128,128,128,0.06);border:1px solid var(--ua-border);padding:4px 12px;border-radius:100px;white-space:nowrap;transition:all 0.2s; }
  .doc-textarea { width:100%;min-height:240px;display:block;background:var(--ua-card);border:1.5px solid var(--ua-border);border-radius:14px;color:var(--ua-text);padding:18px 18px 44px;font-size:14px;line-height:1.85;resize:vertical;font-family:'DM Sans',sans-serif;outline:none;transition:all 0.2s; }
  .doc-textarea:focus { border-color:rgba(212,168,83,0.42);box-shadow:0 0 0 4px rgba(212,168,83,0.07); }
  .doc-textarea::placeholder { color:var(--ua-sub); opacity:0.6; font-weight:300; }
  .loader-wrap { display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:calc(100vh - 64px);padding:40px 24px;text-align:center; }
  .hero-illustration { display:block; }
  .spin-ring { width:96px;height:96px;border-radius:50%;border:4px solid rgba(212,168,83,0.1);border-top-color:#D4A853;animation:spin 1.1s linear infinite;box-shadow:0 0 24px rgba(212,168,83,0.2);position:absolute;inset:0; }
  .progress-bar { height:100%;width:30%;border-radius:3px;background:linear-gradient(90deg,transparent,var(--pc),transparent);animation:progress 1.6s ease-in-out infinite; }
  .result-header { background:var(--ua-card);border:1px solid var(--ua-border);border-radius:18px;padding:24px 22px;margin-bottom:20px;box-shadow:0 2px 16px rgba(0,0,0,0.1);position:relative;overflow:hidden; }
  .result-header::before { content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent 5%,var(--dc) 40%,transparent 95%); }
  .tab-row { display:flex;margin-bottom:18px;border-bottom:1px solid var(--ua-border);overflow-x:auto;-webkit-overflow-scrolling:touch; }
  .tab-row::-webkit-scrollbar { display:none; }
  .tab-btn { background:none;border:none;border-bottom:2px solid transparent;color:var(--ua-sub);padding:10px 14px 12px;cursor:pointer;font-family:'DM Sans',sans-serif;font-size:12px;font-weight:500;transition:all 0.2s;white-space:nowrap;margin-bottom:-1px;flex-shrink:0; }
  .tab-btn:hover { color:var(--ua-text); opacity:0.85; }
  .tab-active { color:var(--ua-text) !important;border-bottom:2px solid var(--tc) !important; }
  .finding-card { background:var(--ua-card2);border:1px solid var(--ua-border);border-left:3px solid var(--fc);border-radius:14px;padding:18px 20px;animation:pageIn 0.4s cubic-bezier(0.22,1,0.36,1) both;transition:all 0.22s; }
  .finding-card:hover { background:var(--ua-hover);box-shadow:0 6px 28px rgba(0,0,0,0.2);transform:translateX(3px); }
  .status-badge { font-family:'DM Sans',sans-serif;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--bc,#888);background:rgba(128,128,128,0.08);border:1px solid rgba(128,128,128,0.2);padding:3px 10px;border-radius:7px;display:inline-block; }
  .info-note { padding:11px 14px;background:rgba(128,128,128,0.06);border:1px solid var(--ua-border);border-radius:9px;font-size:12px;color:var(--ua-sub);line-height:1.65;font-family:'DM Sans',sans-serif; }
  .settings-card { background:var(--ua-card);border:1px solid var(--ua-border);border-radius:14px;padding:20px 18px; }
  .settings-label { font-family:'DM Sans',sans-serif;font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:var(--ua-sub);margin-bottom:13px; }
  .juris-box { background:var(--ua-card);border:1px solid rgba(212,168,83,0.2);border-radius:14px;padding:16px 18px;margin-bottom:18px;box-shadow:0 2px 18px rgba(212,168,83,0.05); }
  .juris-select { width:100%;min-width:0;background:var(--ua-card2);border:1.5px solid var(--ua-border);border-radius:10px;color:var(--ua-text);padding:10px 36px 10px 13px;font-size:14px;font-family:'DM Sans',sans-serif;outline:none;cursor:pointer;appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%239A94A8' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 13px center;transition:all 0.2s; }
  .juris-select:focus { border-color:rgba(212,168,83,0.5);box-shadow:0 0 0 4px rgba(212,168,83,0.08); }
  .juris-select:disabled { opacity:0.35;cursor:not-allowed; }
  .juris-select option { background:var(--ua-card);color:var(--ua-text); }
  ::-webkit-scrollbar { width:5px; }

  /* ── CSS THEME VARIABLES ─────────────────────────── */
  .ua-root { --ua-bg:#0A0B10; --ua-card:#12131B; --ua-card2:#14151E; --ua-text:#EDE8DF; --ua-sub:#B0AABF; --ua-border:rgba(255,255,255,0.08); --ua-hover:#16171F; --nav-rgb:10,11,16; }
  .ua-light { --ua-bg:#F5F4F0; --ua-card:#FFFFFF; --ua-card2:#F9F8F6; --ua-text:#1A1A2E; --ua-sub:#5A5870; --ua-border:rgba(0,0,0,0.09); --ua-hover:#F0EEF8; --nav-rgb:245,244,240; }
  /* ── ACCESSIBILITY ── */
  :focus-visible { outline:2px solid rgba(212,168,83,0.7); outline-offset:2px; border-radius:4px; }
  button:focus-visible, a:focus-visible { outline:2px solid rgba(212,168,83,0.7); outline-offset:3px; border-radius:6px; }
  /* Skip repeated focus ring on mouse click */
  :focus:not(:focus-visible) { outline:none; }
  .ua-light .nav { background:rgba(245,244,240,0.94) !important; border-bottom-color:rgba(0,0,0,0.08) !important; }
  .ua-light .btn-ghost { color:#4A4760 !important; border-color:rgba(0,0,0,0.12) !important; }
  .ua-light .btn-ghost:hover { background:rgba(0,0,0,0.05) !important; }
  /* auth-card/settings-card/juris-box now use CSS vars — light mode handled automatically */
  .ua-light .field-input,.ua-light .doc-textarea,.ua-light .juris-select { background:#F5F4F0 !important; border-color:rgba(0,0,0,0.12) !important; color:#1A1A2E !important; }
  .ua-light .finding-card { background:#FAFAF8 !important; border-color:rgba(0,0,0,0.08) !important; }
  .ua-light .result-header { background:#FFFFFF !important; border-color:rgba(0,0,0,0.08) !important; }
  .ua-light .hero { background:linear-gradient(160deg,#F5F4F0 0%,#EAE8F4 100%) !important; }
  .ua-light .pricing-card,.ua-light .domain-card,.ua-light .dash-card,.ua-light .pipeline-step { background:#FFFFFF !important; border-color:rgba(0,0,0,0.08) !important; }
  /* Section labels & misc */
  .ua-light .section-label { color:#6A6480 !important; }
  .ua-light .section-label::before,.ua-light .section-label::after { background:linear-gradient(90deg,transparent,rgba(0,0,0,0.08)) !important; }
  .ua-light .info-note { background:rgba(0,0,0,0.025) !important; border-color:rgba(0,0,0,0.08) !important; color:#6A6480 !important; }
  .ua-light .tab-btn { color:#7A7490 !important; }
  .ua-light .tab-btn:hover { color:#4A4460 !important; background:rgba(0,0,0,0.04) !important; }
  .ua-light .tab-active { color:#1A1A2E !important; }
  .ua-light .tab-row { border-bottom-color:rgba(0,0,0,0.08) !important; }
  .ua-light .status-badge { background:rgba(0,0,0,0.05) !important; border-color:rgba(0,0,0,0.12) !important; }
  .ua-light .form-err { background:rgba(232,100,90,0.07) !important; border-color:rgba(232,100,90,0.2) !important; }
  .ua-light .field-label { color:#6A6480 !important; }
  /* .hero-h1 now uses var(--ua-text) — no override needed */
  /* .hero-sub now uses var(--ua-sub) — no override needed */
  .ua-light .gradient-text { background:linear-gradient(105deg,#B8902E 0%,#C94840 45%,#7B5FC8 100%) !important; -webkit-background-clip:text !important; -webkit-text-fill-color:transparent !important; background-clip:text !important; }
  .ua-light .eyebrow { color:#B8902E !important; border-color:rgba(184,144,46,0.35) !important; background:rgba(184,144,46,0.07) !important; }
  .ua-light .btn-outline { border-color:rgba(184,144,46,0.4) !important; color:#B8902E !important; }
  .ua-light .loader-wrap { background:var(--ua-bg) !important; }
  .ua-light .result-header { background:#FFFFFF !important; }
  .ua-light .finding-card:hover { background:#F0EEF8 !important; }
  .ua-light .modal-sheet { background:#FFFFFF !important; border-color:rgba(0,0,0,0.1) !important; box-shadow:0 -4px 32px rgba(0,0,0,0.12) !important; }
  .ua-light ::-webkit-scrollbar-track { background:#F5F4F0 !important; }
  .ua-light ::-webkit-scrollbar-thumb { background:#D4D0E8 !important; }
  .ua-light .juris-box { border-color:rgba(184,144,46,0.25) !important; }
  .ua-light .juris-select option { background:#FFFFFF !important; color:#1A1A2E !important; }
  .ua-light .doc-textarea { background:#F9F8F6 !important; color:#1A1A2E !important; border-color:rgba(0,0,0,0.1) !important; }
  .ua-light .doc-textarea::placeholder { color:#9A9AB0 !important; }
  /* Hover shadow overrides for light mode */
  .ua-light .pricing-card:hover { box-shadow:0 8px 28px rgba(0,0,0,0.1) !important; }
  .ua-light .domain-card:hover { box-shadow:0 4px 18px rgba(0,0,0,0.1) !important; }
  .ua-light .dash-card:hover { box-shadow:0 4px 18px rgba(0,0,0,0.1) !important; }
  .ua-light .result-header { box-shadow:0 2px 12px rgba(0,0,0,0.08) !important; }
  .ua-light .auth-card { box-shadow:0 4px 24px rgba(0,0,0,0.1) !important; }
  /* AI engine section, comparison boxes */
  .ua-light .section > div[style*="rgba(255,255,255,0.02)"] { background:#FFFFFF !important; border-color:rgba(0,0,0,0.08) !important; }
  /* .nav background now uses --nav-rgb CSS variable — no override needed */
  /* Scrollbar for light mode — consolidated above */
  /* ── SCROLL FADE-IN ANIMATION ─────────────────────── */
  @keyframes fadeUp { from{opacity:0;transform:translateY(20px)} to{opacity:1;transform:none} }
  .anim-fade-up { animation:fadeUp 0.6s cubic-bezier(0.22,1,0.36,1) both; }
  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     RESPONSIVE SYSTEM
     Phone  : ≤480px
     Phone+ : ≤600px
     Tablet : ≤768px
     Laptop : ≤1024px  (desktop = 1024px+)
     Scrollbars
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
  ::-webkit-scrollbar { width:4px; height:4px; }
  ::-webkit-scrollbar-track { background:var(--ua-bg,#0A0B10); }
  ::-webkit-scrollbar-thumb { background:var(--ua-border,#1E1C28);border-radius:3px; }

  /* ── LAPTOP (≤1024px) ── */
  @media(max-width:1024px) {
    .section { max-width:100%; padding:0 20px 48px; }
    .content-pad { padding:32px 20px; }
    .hero { padding:64px 20px 52px; }
  }

  /* ── TABLET (≤768px) ── */
  @media(max-width:768px) {
    /* Admin user detail grid collapse */
    .admin-user-detail { grid-template-columns:1fr !important; }
    /* Admin stats: 3 per row on tablet */
    .admin-stats-grid { grid-template-columns:repeat(3,1fr) !important; }
    /* Juris grid collapse on tablet */
    .juris-box > div:nth-child(2) { grid-template-columns:1fr 1fr; }
    /* Layout */
    .section { padding:0 18px 40px; }
    .content-pad { padding:28px 18px; }
    .hero { padding:54px 18px 44px; }
    /* Nav — show logo + essential buttons only, rest wrap to 2nd row */
    .nav { padding:10px 16px; gap:6px; flex-wrap:wrap; }
    /* Grids */
    .domain-grid { grid-template-columns:repeat(4,1fr); gap:9px; }
    .pricing-grid { grid-template-columns:repeat(3,1fr); gap:12px; }
    .dash-grid { grid-template-columns:repeat(3,1fr); gap:9px; }
    /* Cards — tighter */
    .pricing-card { padding:22px 16px; }
    .dash-card { padding:20px 12px; }
    .result-header { padding:20px 18px; }
    .auth-card { padding:32px 26px; }
    /* Typography */
    .hero-h1 { font-size:clamp(32px,7vw,60px); }
    .hero-sub { font-size:15px; margin-bottom:28px; }
    /* Buttons */
    .btn-ghost { padding:8px 14px; font-size:12px; }
    .btn-primary { padding:9px 18px; font-size:12px; }
    /* Tabs */
    .tab-btn { padding:9px 12px 11px; font-size:12px; }
  }

  /* ── TABLET SPECIFIC grid adjustments ── */
  @media(max-width:720px) {
    /* Hide Compare button on small tablets */
    .nav .nav-secondary:nth-child(2) { display:none; }
    .pricing-grid { grid-template-columns:1fr !important; }
    .domain-grid { grid-template-columns:repeat(2,1fr) !important; }
  }

  /* ── PHONE+ (≤600px) ── */
  @media(max-width:600px) {
    .section { padding:0 14px 32px; }
    .content-pad { padding:22px 14px; }
    .hero { padding:44px 14px 36px; }
    .hero-grid-bg { display:none; }
    /* Nav — tighter on phones */
    .nav { padding:9px 14px; gap:5px; }
    .nav-badge { font-size:9px; padding:3px 8px; }
    /* Grids */
    .domain-grid { grid-template-columns:repeat(2,1fr) !important; gap:8px; }
    .dash-grid { grid-template-columns:repeat(2,1fr) !important; gap:8px; }
    .pricing-grid { grid-template-columns:1fr !important; gap:12px; }
    /* Cards */
    .dash-card { padding:18px 12px; }
    .pricing-card { padding:20px 16px; }
    .auth-card { padding:26px 18px; border-radius:16px; }
    .result-header { padding:16px 14px; }
    .finding-card { padding:14px 14px; }
    .juris-box > div:nth-child(2) { grid-template-columns:1fr !important; }
    /* Tabs */
    .tab-row { gap:0; }
    .tab-btn { padding:9px 10px 11px; font-size:11px; }
    /* Pipeline */
    .pipeline-row { gap:4px; }
    .pipeline-step { min-width:64px; padding:10px 8px; }
    /* Section labels */
    .section-label { font-size:9px; letter-spacing:0.2em; }
  }

  /* ── FLOATING FEEDBACK BUTTON ── */
  .fab-feedback { position:fixed;bottom:24px;right:24px;z-index:150;background:linear-gradient(135deg,#9B7FE8,#6B4FCA);border:none;border-radius:50px;padding:10px 18px 10px 14px;display:flex;align-items:center;gap:8px;cursor:pointer;font-family:'DM Sans',sans-serif;font-weight:700;font-size:13px;color:#fff;box-shadow:0 4px 20px rgba(155,127,232,0.45);transition:all 0.22s;white-space:nowrap; }
  .fab-feedback:hover { transform:translateY(-2px);box-shadow:0 8px 28px rgba(155,127,232,0.55); }
  .fab-feedback:active { transform:translateY(0); }
  @media(max-width:480px) { .fab-feedback { bottom:16px;right:14px;padding:9px 14px 9px 11px;font-size:12px; } }
  /* ── HISTORY cards ── */
  .hist-card { background:var(--ua-card);border:1px solid var(--ua-border);border-radius:14px;padding:14px 16px;transition:transform 0.18s,box-shadow 0.18s;cursor:pointer; }
  .hist-card:hover { transform:translateX(3px);box-shadow:0 4px 20px rgba(0,0,0,0.15); }
  /* ── STATS strip ── */
  @media(max-width:600px) {
    .stats-strip-item { border-right:none !important; border-bottom:1px solid var(--ua-border); }
    .stats-strip-item:last-child { border-bottom:none; }
  }

  /* ── PHONE (≤480px) ── */
  @media(max-width:480px) {
    .section { padding:0 12px 28px; }
    /* Full-width pricing CTA */
    .pricing-card .btn-primary { width:100% !important; padding:13px !important; }
    /* Dashboard welcome text */
    .dash-welcome h2 { font-size:clamp(20px,6vw,28px) !important; }
    .content-pad { padding:16px 12px; }
    .hero { padding:36px 12px 28px; }
    /* Nav — compact mode */
    .nav { padding:8px 12px; }
    /* Domain grid stays 2 col */
    .domain-grid { grid-template-columns:repeat(2,1fr) !important; gap:7px; }
    /* Dash stays 2 col */
    .dash-grid { grid-template-columns:repeat(2,1fr) !important; gap:7px; }
    /* Smaller cards */
    .dash-card { padding:14px 10px; }
    .domain-card { padding:14px 10px; }
    .auth-card { padding:22px 14px; border-radius:14px; }
    .result-header { padding:14px 12px; }
    .finding-card { padding:12px 12px; }
    /* Inputs */
    .field-input { padding:11px 12px; font-size:16px; } /* 16px prevents iOS zoom */
    .juris-select { font-size:16px; } /* prevent iOS zoom */
    .doc-textarea { min-height:140px; padding:13px 13px 36px; font-size:16px; } /* 16px prevents iOS zoom */
    .juris-select { font-size:14px; }
    /* Typography */
    .hero-h1 { font-size:clamp(28px,9vw,42px); line-height:1.05; margin-bottom:16px; }
    .hero-sub { font-size:14px; line-height:1.7; margin-bottom:22px; }
    .eyebrow { font-size:8px; padding:5px 14px; margin-bottom:18px; }
    /* Buttons */
    .btn-ghost { padding:9px 12px; font-size:12px; }
    .btn-primary { padding:10px 16px; font-size:13px; }
    /* Tabs */
    .tab-btn { padding:8px 9px 10px !important; font-size:11px !important; }
    /* Section padding */
    .section { padding:0 12px 24px; }
    /* Loader */
    .loader-wrap { padding:24px 12px; }
    /* Hide hero illustration on very small phones — simplifies landing */
    .hero-illustration { display:none; }
    /* Pipeline — hide arrows on very small */
    .pipeline-row { gap:3px; }
    .pipeline-step { min-width:56px; padding:8px 6px; font-size:10px; }
    /* Auth wrap */
    .auth-wrap { padding:14px; align-items:flex-start; padding-top:32px; }
    /* Modal inner */
    .tab-row { margin-bottom:14px; }
    /* Compare zones stack on phone */
    .compare-zones { flex-direction:column !important; }
    .compare-result-grid { grid-template-columns:1fr !important; }
    /* Admin stats: 2 per row on phone */
    .admin-stats-grid { grid-template-columns:repeat(2,1fr) !important; }
    .compare-zones > div { min-width:100% !important; }
    /* Audit run button full-width on phone */
    .audit-hint { display:none; }
    .audit-run-row { flex-direction:column-reverse; align-items:stretch; }
    .audit-run-btn { width:100%; text-align:center; padding:14px !important; font-size:15px !important; }
    .audit-run-row span { text-align:center; }
    /* Modal — full-width bottom sheet on phone */
    .modal-backdrop { align-items:flex-end !important; padding:0 !important; }
    .modal-sheet { border-radius:20px 20px 0 0 !important; max-height:94vh !important; padding-bottom:calc(22px + env(safe-area-inset-bottom,0px)) !important; }
    /* Hide secondary nav buttons on small phones */
    .nav-secondary { display:none !important; }
  }

  /* ── PRINT ── */
  @media print {
    .nav, .fab-feedback, .btn-ghost, .btn-primary, .tab-row, .audit-run-row, .info-note { display:none !important; }
    .ua-root { background:#fff !important; color:#000 !important; }
    .content-pad { padding:0 !important; }
    .result-header, .finding-card, .settings-card { border:1px solid #ddd !important; background:#fff !important; break-inside:avoid; }
    .finding-card { margin-bottom:12px; }
    body { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  }
`;
type nul > .env.local
NEXT_PUBLIC_API_URL=https://universal-auditor-backend-0gih.onrender.com
