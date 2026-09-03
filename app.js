// ====== CONFIG — fill these in after deployment (see README.txt) ======
const CLIENT_ID ="252311945181-bvacq392co8b4991p21khegqumos06ak.apps.googleusercontent.com";
const SYNC_URL = "https://script.google.com/macros/s/AKfycbyXGsMLGTfhNkvBONhXoXWYpYhvlOeT1CsoxdDkqbZoxC7bKCrftYx00S6fNPZX1Qxraw/exec";
// =========================================================================

const services={"Spark Holdings":["Medical Supplies","Hardware Supplies","Office Supplies","Computers & Accessories","Industrial Safety Gear","Security Equipment","Other General Supplies"],"Spark Security Solutions":["Security Guarding","Residential Security","Commercial Security","Alarm Response","Security Assessment","Other Security Service"],"Spark Cleaning Solutions":["Contract Cleaning","Office Cleaning","Deep Cleaning","Specialised Cleaning","Post-Construction Cleaning","Other Cleaning Service"]};
const $=id=>document.getElementById(id);

let leads=[], activities=[], staff=[], me=null, token=null;
let knownLeadIds=new Set(), firstLoadDone=false, pollTimer=null;

function esc(s=""){return String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]))}
function money(n){return "MWK "+Number(n||0).toLocaleString()}
function due(d){if(!d)return false;let t=new Date();t.setHours(0,0,0,0);return new Date(d+"T00:00:00")<=t}
function decodeJwt(t){try{return JSON.parse(atob(t.split(".")[1].replace(/-/g,"+").replace(/_/g,"/")))}catch(e){return null}}

// ---------- Google Sign-In ----------
window.onload=()=>{
  if(!window.google){$("loginStatus").textContent="Could not load Google Sign-In. Check your internet connection.";return}
  google.accounts.id.initialize({client_id:CLIENT_ID,callback:handleCredentialResponse});
  google.accounts.id.renderButton($("googleBtn"),{theme:"outline",size:"large",text:"signin_with"});

  let saved=sessionStorage.getItem("sparkToken");
  if(saved){
    let payload=decodeJwt(saved);
    if(payload && payload.exp*1000>Date.now()){token=saved;startApp()}
    else sessionStorage.removeItem("sparkToken");
  }
};

function handleCredentialResponse(resp){
  token=resp.credential;
  sessionStorage.setItem("sparkToken",token);
  startApp();
}

async function startApp(){
  $("loginStatus").textContent="Signing in…";
  let res=await syncCall("GET",null);
  if(!res||!res.ok){
    let msg=res&&res.error==="not_authorized"
      ?`${res.email||"Your account"} isn't on the Spark staff list yet. Ask an admin to add your email to the Staff sheet.`
      :"Sign-in failed. Please try again.";
    $("loginStatus").textContent=msg;
    token=null;sessionStorage.removeItem("sparkToken");
    return;
  }
  me=res.you;
  applyData(res,false);
  $("loginScreen").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("userDisplay").textContent=`${me.name} (${me.role})`;
  render();
  startPolling();
}

$("logoutBtn").onclick=()=>{
  token=null;sessionStorage.removeItem("sparkToken");
  if(pollTimer)clearInterval(pollTimer);
  $("app").classList.add("hidden");$("loginScreen").classList.remove("hidden");
  $("loginStatus").textContent="";
};

// ---------- Sync ----------
async function syncCall(method,body){
  try{
    let url=SYNC_URL+(method==="GET"?`?token=${encodeURIComponent(token)}`:"");
    let opts=method==="GET"?{method:"GET"}:{method:"POST",headers:{"Content-Type":"text/plain;charset=utf-8"},body:JSON.stringify({...body,token})};
    let res=await fetch(url,opts);
    return await res.json();
  }catch(err){
    setSyncStatus("err","Sync failed — check your connection.");
    return null;
  }
}

function setSyncStatus(state,msg){
  let el=$("syncStatus");
  el.className=state==="on"?"on":state==="err"?"err":"";
  el.textContent=msg;
}

function applyData(res,isPoll){
  leads=res.leads||[];activities=res.activities||[];staff=res.staff||[];
  fillAssignedOptions();

  if(isPoll && firstLoadDone){
    let newOnes=leads.filter(l=>!knownLeadIds.has(l.id));
    newOnes.forEach(n=>notifyNewLead(n));
  }
  knownLeadIds=new Set(leads.map(l=>l.id));
  firstLoadDone=true;
  setSyncStatus("on",`Synced ${new Date().toLocaleTimeString()}`);
}

function startPolling(){
  if(pollTimer)clearInterval(pollTimer);
  pollTimer=setInterval(async()=>{
    let res=await syncCall("GET",null);
    if(res&&res.ok){applyData(res,true);render()}
    else if(res&&res.error==="invalid_token"){
      // token expired — ask them to sign in again
      clearInterval(pollTimer);
      $("app").classList.add("hidden");$("loginScreen").classList.remove("hidden");
      $("loginStatus").textContent="Your session expired — please sign in again.";
    }
  },20000);
}

// ---------- Notifications ----------
let unreadCount=0;
function notifyNewLead(lead){
  unreadCount++;
  $("toastText").textContent=`${lead.name} — ${lead.service} (${lead.source})`;
  $("toast").classList.remove("hidden");
  clearTimeout(window.toastTimer);window.toastTimer=setTimeout(()=>$("toast").classList.add("hidden"),6000);
  if("Notification" in window && Notification.permission==="granted"){
    new Notification("New Spark Lead",{body:`${lead.name} — ${lead.service}`});
  }
}
$("toast").onclick=()=>{unreadCount=0;$("notifCount").textContent=0;$("toast").classList.add("hidden")};
$("notifyBtn").onclick=async()=>{
  if(!("Notification" in window)){alert("This browser does not support desktop notifications.");return}
  if(Notification.permission==="default"){
    let p=await Notification.requestPermission();
    alert(p==="granted"?"Browser notifications enabled for this device.":"Notifications were not enabled.");
  }else if(Notification.permission==="granted"){alert("Browser notifications are already enabled for this device.")}
  else{alert("Notifications are blocked. Allow them in your browser/site settings.")}
  unreadCount=0;$("notifCount").textContent=0;
};

// ---------- Rendering ----------
function fillAssignedOptions(){
  let sel=$("assigned"), cur=sel.value;
  sel.innerHTML='<option value="">Unassigned</option>';
  staff.forEach(s=>{let o=document.createElement("option");o.value=o.textContent=s.name;sel.appendChild(o)});
  sel.value=cur;
}

function table(data){
  if(!data.length)return '<div class="muted">No records found.</div>';
  return `<div style="overflow:auto"><table><thead><tr><th>Customer</th><th>Business</th><th>Product / Service</th><th>Source</th><th>Status</th><th>Follow-up</th><th>Value</th><th>Assigned</th><th></th></tr></thead><tbody>${data.map(x=>`<tr><td><b>${esc(x.name)}</b><br>${esc(x.company||"")}</td><td>${esc(x.business)}</td><td>${esc(x.service)}</td><td>${esc(x.source)}</td><td><span class="badge ${esc(x.status)}">${esc(x.status)}</span></td><td>${x.followup||"—"}</td><td>${money(x.value)}</td><td>${esc(x.assigned||"—")}</td><td><button class="rowbtn" onclick="editLead('${x.id}')">Edit</button><button class="rowbtn" onclick="delLead('${x.id}')">Delete</button></td></tr>`).join("")}</tbody></table></div>`;
}

function render(){
  $("notifCount").textContent=unreadCount;
  $("mTotal").textContent=leads.length;
  $("mNew").textContent=leads.filter(x=>x.status==="New").length;
  $("mQual").textContent=leads.filter(x=>x.status==="Qualified").length;
  $("mQuoted").textContent=leads.filter(x=>x.status==="Quoted").length;
  $("mWon").textContent=leads.filter(x=>x.status==="Won").length;
  $("mLost").textContent=leads.filter(x=>x.status==="Lost").length;
  let closed=leads.filter(x=>["Won","Lost"].includes(x.status)).length;
  $("mConv").textContent=(closed?Math.round(leads.filter(x=>x.status==="Won").length/closed*100):0)+"%";

  let pv=leads.filter(x=>["Qualified","Quoted"].includes(x.status)).reduce((a,x)=>a+Number(x.value||0),0);
  $("pipelineValue").textContent=money(pv);
  $("progressBar").style.width=Math.min(100,pv?60:0)+"%";

  let sources={};leads.forEach(x=>sources[x.source]=(sources[x.source]||0)+1);
  let max=Math.max(1,...Object.values(sources));
  $("sourceStats").innerHTML=Object.entries(sources).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`<div class="source-row"><span>${esc(k)}</span><div class="bar"><i style="width:${v/max*100}%"></i></div><b>${v}</b></div>`).join("")||'<span class="muted">No source data yet.</span>';

  let sorted=[...leads].sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
  $("recent").innerHTML=table(sorted.slice(0,6));
  applyFilters();
  renderKanban();

  let f=leads.filter(x=>due(x.followup)&&!["Won","Lost"].includes(x.status)).sort((a,b)=>String(a.followup||"").localeCompare(String(b.followup||"")));
  $("followups").innerHTML=table(f);

  $("activity").innerHTML=activities.map(a=>`<div class="activity-item"><b>${esc(a.text)}</b><br><span class="muted">${esc(a.leadName)} · ${esc(a.actorName)} · ${new Date(a.date).toLocaleString()}</span></div>`).join("")||'<div class="muted">No activity yet.</div>';
}

function applyFilters(){
  let q=$("search").value.toLowerCase(),b=$("businessFilter").value,s=$("statusFilter").value;
  let d=leads.filter(x=>(!q||[x.name,x.company,x.service,x.phone,x.email,x.description].join(" ").toLowerCase().includes(q))&&(!b||x.business===b)&&(!s||x.status===s));
  $("allLeads").innerHTML=table(d);
}

function renderKanban(){
  let sts=["New","Contacted","Qualified","Quoted","Won","Lost"];
  $("kanban").innerHTML=sts.map(s=>`<div class="column"><h3>${s} <span>(${leads.filter(x=>x.status===s).length})</span></h3>${leads.filter(x=>x.status===s).map(x=>`<div class="leadcard"><b>${esc(x.name)}</b><p>${esc(x.service)}</p><p>${money(x.value)}</p><button class="rowbtn" onclick="editLead('${x.id}')">Open</button></div>`).join("")}</div>`).join("");
}

function fillServices(sel=""){
  let b=$("business").value;$("service").innerHTML='<option value="">Select</option>';
  (services[b]||[]).forEach(v=>{let o=document.createElement("option");o.value=o.textContent=v;if(v===sel)o.selected=true;$("service").appendChild(o)});
}

// ---------- Nav ----------
document.querySelectorAll(".nav").forEach(b=>b.onclick=()=>go(b.dataset.view));
document.querySelectorAll("[data-go]").forEach(b=>b.onclick=()=>go(b.dataset.go));
function go(v){
  document.querySelectorAll(".view").forEach(x=>x.classList.remove("active"));
  $(v+"View").classList.add("active");
  document.querySelectorAll(".nav").forEach(x=>x.classList.toggle("active",x.dataset.view===v));
  $("pageTitle").textContent={dashboard:"Marketing & Sales Dashboard",leads:"All Leads",pipeline:"Sales Pipeline",followups:"Follow-ups",activity:"Activity Log"}[v];
}

// ---------- Lead form ----------
$("business").onchange=()=>fillServices();
$("newLeadBtn").onclick=()=>{$("leadForm").reset();$("leadId").value="";$("formTitle").textContent="New Lead";fillServices();fillAssignedOptions();$("dlg").showModal()};
$("cancel").onclick=()=>$("dlg").close();
$("closeDlg").onclick=()=>$("dlg").close();

$("leadForm").onsubmit=async e=>{
  e.preventDefault();
  let id=$("leadId").value||crypto.randomUUID();
  let old=leads.find(x=>x.id===id);
  let r={id,createdAt:old?.createdAt,name:$("name").value,company:$("company").value,phone:$("phone").value,email:$("email").value,business:$("business").value,service:$("service").value,source:$("source").value,status:$("status").value,value:Number($("value").value||0),followup:$("followup").value,assigned:$("assigned").value,nextAction:$("nextAction").value,description:$("description").value,notes:$("notes").value};
  $("dlg").close();
  let res=await syncCall("POST",{action:"upsert",lead:r});
  if(res&&res.ok){let full=await syncCall("GET",null);if(full&&full.ok){applyData(full,false);render()}}
  else alert("Could not save — check your connection and try again.");
};

window.editLead=id=>{
  let x=leads.find(y=>y.id===id);
  $("leadId").value=x.id;$("name").value=x.name;$("company").value=x.company;$("phone").value=x.phone;$("email").value=x.email;
  $("business").value=x.business;fillServices(x.service);$("source").value=x.source;$("status").value=x.status;$("value").value=x.value;
  $("followup").value=x.followup;fillAssignedOptions();$("assigned").value=x.assigned;$("nextAction").value=x.nextAction;$("description").value=x.description;$("notes").value=x.notes;
  $("formTitle").textContent="Edit Lead";$("dlg").showModal();
};

window.delLead=async id=>{
  if(me && me.role!=="admin"){alert("Only an admin can delete leads. Ask an admin to remove this one.");return}
  let x=leads.find(y=>y.id===id);
  if(!confirm(`Delete ${x?.name||"this lead"}? This can't be undone.`))return;
  let res=await syncCall("POST",{action:"delete",id});
  if(res&&res.ok){let full=await syncCall("GET",null);if(full&&full.ok){applyData(full,false);render()}}
  else alert(res&&res.error==="forbidden_not_admin"?"Only an admin can delete leads.":"Could not delete — check your connection.");
};

["search","businessFilter","statusFilter"].forEach(id=>$(id).addEventListener("input",render));

$("exportBtn").onclick=()=>{
  let h=["Created","Customer","Company","Phone","Email","Business","Service","Source","Status","Value","Follow-up","Assigned","Next Action","Requirement","Notes"];
  let rows=leads.map(x=>[x.createdAt,x.name,x.company,x.phone,x.email,x.business,x.service,x.source,x.status,x.value,x.followup,x.assigned,x.nextAction,x.description,x.notes]);
  let q=v=>`"${String(v??"").replaceAll('"','""')}"`;
  let csv=[h,...rows].map(r=>r.map(q).join(",")).join("\n");
  let a=document.createElement("a");a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));a.download="spark-leads-v3.csv";a.click();
};
