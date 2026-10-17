(() => {
  const cfg = window.GESTION_TECNICA_CONFIG || {};
  const $ = (s, root=document) => root.querySelector(s);
  const $$ = (s, root=document) => [...root.querySelectorAll(s)];
  const state = { client:null, user:null, profile:null, loadingUserId:null, page:'dashboard', data:{}, pageNum:0, pageSize:10, filters:{} };
  const labels = {dashboard:'Resumen',orders:'Órdenes de servicio',activities:'Otras actividades',crews:'Cuadrillas',staffing:'Personal diario',technicians:'Técnicos',zones:'Zonas',services:'Servicios y estándares',reports:'Informes'};
  const root = () => $('#pageRoot');
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  // Función global y estable para fechas ISO locales; evita errores de alcance/caché.
  window.isoLocal = window.isoLocal || function(date) { const d = date instanceof Date ? date : new Date(date); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
  const dateToday = () => window.isoLocal(new Date());

  // Calendario laboral de Colombia usado por los informes de productividad.
  // Lunes a viernes: 470 minutos; sábado: 235; domingo y festivos: 0.
  function easterSunday(year){
    const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4;
    const f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30;
    const i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451);
    const month=Math.floor((h+l-7*m+114)/31),day=((h+l-7*m+114)%31)+1;
    return new Date(year,month-1,day,12,0,0,0);
  }
  function moveToMonday(date){
    const d=new Date(date);
    if(d.getDay()!==1)d.setDate(d.getDate()+(8-d.getDay())%7);
    return d;
  }
  function colombianHolidays(year){
    const holidays=new Set();
    const fixed=[[1,1,false],[1,6,true],[3,19,true],[5,1,false],[6,29,true],[7,20,false],[8,7,false],[8,15,true],[10,12,true],[11,1,true],[11,11,true],[12,8,false],[12,25,false]];
    fixed.forEach(([month,day,movesToMonday])=>{
      const date=new Date(year,month-1,day,12,0,0,0);
      holidays.add(window.isoLocal(movesToMonday?moveToMonday(date):date));
    });
    const easter=easterSunday(year);
    [-3,-2,39,60,68].forEach(offset=>{
      const date=new Date(easter);
      date.setDate(date.getDate()+offset);
      holidays.add(window.isoLocal(offset>0?moveToMonday(date):date));
    });
    return holidays;
  }
  function scheduledMinutes(date){
    if(!date)return 470;
    const dayDate=String(date).slice(0,10);
    const parsed=new Date(`${dayDate}T12:00:00`);
    if(Number.isNaN(parsed.getTime()))return 0;
    const day=parsed.getDay();
    if(day===0||colombianHolidays(parsed.getFullYear()).has(dayDate))return 0;
    return day===6?235:470;
  }
  // ---- Cálculos puros (sin DOM), expuestos en window.GT_CALC para poder probarlos ----
  function datesBetween(start,end,max=370){const out=[];if(!start||!end||start>end)return out;const c=new Date(`${start}T12:00:00`),e=new Date(`${end}T12:00:00`);while(c<=e&&out.length<max){out.push(window.isoLocal(c));c.setDate(c.getDate()+1)}return out}
  function activityMinutesFor(activities,date,crewId){return activities.reduce((sum,x)=>x.work_date===date&&(x.crew_id==null||x.crew_id===crewId)?sum+Number(x.minutes||0):sum,0)}
  // Minutos disponibles para servicios = jornada (470 L-V, 235 sáb, 0 dom/festivo) o minutos efectivos de Personal diario,
  // menos otras actividades. Una cuadrilla cuenta UNA jornada por día (se toma el mayor tiempo efectivo de sus integrantes,
  // así el resultado no depende del orden de las filas). Los días SIN ninguna asignación registrada usan la jornada
  // estándar para las cuadrillas/técnicos que tienen órdenes; así el rendimiento no se infla cuando solo algunos días tienen personal.
  function computeAvailableMinutes({dates,records,staffingRows,activities,crewIds=[],techIds=[]}){
    const dateSet=new Set(dates),slots=new Map();
    const slotKey=(crewId,techId,date)=>crewId?`crew:${crewId}|${date}`:`tech:${techId}|${date}`;
    for(const a of staffingRows){
      if(!dateSet.has(a.work_date))continue;
      const key=slotKey(a.crew_id,a.technician_id,a.work_date);
      const slot=slots.get(key)||{crewId:a.crew_id||null,date:a.work_date,base:0};
      if(a.status==='trabajado'){const sched=scheduledMinutes(a.work_date),worked=a.worked_minutes==null?sched:Number(a.worked_minutes);slot.base=Math.max(slot.base,Math.min(sched,worked))}
      slots.set(key,slot);
    }
    const groups=new Map();
    for(const r of records){
      if(r.crew_id){if(crewIds.length&&!crewIds.includes(r.crew_id))continue;groups.set(`crew:${r.crew_id}`,{crewId:r.crew_id,techId:null})}
      else{if(techIds.length&&!techIds.includes(r.technician_id))continue;groups.set(`tech:${r.technician_id}`,{crewId:null,techId:r.technician_id})}
    }
    for(const g of groups.values())for(const d of dates){const key=slotKey(g.crewId,g.techId,d);if(!slots.has(key))slots.set(key,{crewId:g.crewId,date:d,base:scheduledMinutes(d)})}
    let available=0;for(const slot of slots.values())available+=Math.max(0,slot.base-activityMinutesFor(activities,slot.date,slot.crewId));
    return {availableMinutes:available,slots:slots.size};
  }
  // Una orden registrada sin cuadrilla por alguien que pertenece a una cuadrilla es trabajo de esa cuadrilla:
  // se atribuye a la cuadrilla con la que trabajó ese día (Personal diario) o, si no hay registro, a su única cuadrilla habitual.
  // Así el jefe, el auxiliar y la cuadrilla ven las mismas órdenes y no se cuentan dos jornadas para la misma persona.
  function attributeCrews(orders,{assignments=[],crewMembers=[],crews=[]}={}){
    const activeCrew=new Set(crews.filter(c=>c.active!==false).map(c=>c.id)),habitual=new Map(),worked=new Map();
    crewMembers.forEach(m=>{if(!activeCrew.has(m.crew_id))return;const set=habitual.get(m.technician_id)||new Set();set.add(m.crew_id);habitual.set(m.technician_id,set)});
    assignments.forEach(a=>{if(a.crew_id&&a.status==='trabajado')worked.set(`${a.technician_id}|${a.work_date}`,a.crew_id)});
    return orders.map(o=>{
      if(o.crew_id)return {...o,crew_inferred:false};
      const day=worked.get(`${o.technician_id}|${o.service_date}`);if(day)return {...o,crew_id:day,crew_inferred:true};
      const set=habitual.get(o.technician_id);if(set&&set.size===1)return {...o,crew_id:[...set][0],crew_inferred:true};
      return {...o,crew_inferred:false};
    });
  }
  // Filas de Personal diario que definen la disponibilidad según los filtros.
  // Al filtrar por técnico (p. ej. el jefe) la disponibilidad es la de su CUADRILLA ese día (todas las filas de la cuadrilla,
  // no solo la suya), igual que al filtrar por la cuadrilla; así jefe y cuadrilla dan el mismo rendimiento.
  function selectStaffingRows({assignments,crews=[],records,techIds=[],crewIds=[],zoneIds=[]}){
    let rows=assignments;
    if(techIds.length){
      const involved=new Set(records.map(r=>r.crew_id).filter(Boolean));
      const techCrewDays=new Set(assignments.filter(a=>a.crew_id&&techIds.includes(a.technician_id)).map(a=>`${a.crew_id}|${a.work_date}`));
      rows=rows.filter(a=>a.crew_id?(involved.has(a.crew_id)||techCrewDays.has(`${a.crew_id}|${a.work_date}`)):techIds.includes(a.technician_id));
    }
    if(crewIds.length)rows=rows.filter(a=>crewIds.includes(a.crew_id));
    if(zoneIds.length)rows=rows.filter(a=>zoneIds.includes(crews.find(c=>c.id===a.crew_id)?.zone_id));
    return rows;
  }
  // Rendimiento = tiempo real / minutos disponibles (470 por día laboral). Si una orden no tiene tiempo real
  // (el campo es opcional: "déjalo vacío si no hubo demora") se usa su tiempo estándar total.
  function computePerformance(records,availableMinutes){
    const realUsed=records.reduce((sum,r)=>sum+Number(r.minutos_reales_calculo||0),0);
    return {realUsedMinutes:realUsed,withoutReal:records.filter(r=>r.minutos_reales==null).length,effectiveness:availableMinutes>0?realUsed/availableMinutes*100:0};
  }
  // Reparte el tiempo trabajado en estándar + adicional, de modo que SIEMPRE estándar + adicional = tiempo real.
  // Ej.: estándar 45, real 60 -> estándar 45 + adicional 15 = 60. Si terminó antes (estándar 45, real 30) -> estándar 30 + adicional 0.
  // Sin tiempo real registrado (campo opcional) se asume que tardó lo estándar.
  function timeBreakdown(standardTotal,actual){const std=Number(standardTotal||0),hasReal=actual!=null&&actual!=='',real=hasReal?Number(actual):std;return {standard:Math.min(std,real),extra:Math.max(0,real-std),real,hasReal}}
  window.GT_CALC={attributeCrews,selectStaffingRows,timeBreakdown,scheduledMinutes,datesBetween,computeAvailableMinutes,computePerformance,colombianHolidays};
  const friendlyError=err=>{const m=String(err?.message||err||'Error inesperado');if(err?.code==='23505'||/duplicate key/i.test(m))return 'Ya existe un registro con ese valor (nombre, documento o fecha repetida).';if(err?.code==='42501'||/row-level security|permission denied/i.test(m))return 'No tienes permisos para esta acción (se requiere rol Administrador o Registrador).';if(err?.code==='23503')return 'No se puede completar: el registro está relacionado con otros datos.';return m};
  const pageStorageKey = 'gestion-tecnica-active-page';
  const savedPage = () => { try { const p=localStorage.getItem(pageStorageKey); return labels[p] ? p : 'dashboard'; } catch (_) { return 'dashboard'; } };
  const savePage = page => { try { localStorage.setItem(pageStorageKey, labels[page] ? page : 'dashboard'); } catch (_) {} };
  const fmtDate = v => v ? new Date(`${v}T00:00:00`).toLocaleDateString('es-CO',{year:'numeric',month:'short',day:'2-digit'}) : '—';
  const num = v => Number(v||0).toLocaleString('es-CO');
  const notify = (msg, error=false) => { const t=$('#toast'); t.textContent=msg; t.classList.toggle('error',error); t.classList.remove('hidden'); clearTimeout(notify.timer); notify.timer=setTimeout(()=>t.classList.add('hidden'),4500); };
  const isConfigured = () => cfg.supabaseUrl && cfg.supabaseAnonKey && !cfg.supabaseUrl.includes('TU-PROYECTO') && !cfg.supabaseAnonKey.includes('PEGA_AQUI');
  async function init(){
    if (!window.supabase) { $('#loginError').textContent='No se pudo cargar la biblioteca de conexión. Revisa tu conexión a Internet.'; return; }
    if (!isConfigured()) { $('#loginError').textContent='Configura la URL y la clave anon de Supabase en js/config.js antes de iniciar sesión.'; return; }
    state.client=window.supabase.createClient(cfg.supabaseUrl,cfg.supabaseAnonKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
    $('#loginForm').addEventListener('submit', login); $('#logoutBtn').addEventListener('click', logout); $('#logoutTopBtn').addEventListener('click', logout);
    $('#mainNav').addEventListener('click',e=>{const b=e.target.closest('[data-page]');if(b)go(b.dataset.page)});
    $('#openSidebar').addEventListener('click',()=>$('#sidebar').classList.add('open')); $('#closeSidebar').addEventListener('click',()=>$('#sidebar').classList.remove('open'));
    // No recargar la aplicación en TOKEN_REFRESHED: eso enviaba al usuario al Resumen
    // cada vez que Supabase renovaba la sesión al volver a la pestaña.
    state.client.auth.onAuthStateChange((event,session)=>{
      if(session?.user){
        if(state.user?.id===session.user.id && state.profile) return;
        if(state.loadingUserId===session.user.id) return;
        setTimeout(()=>{ if(state.user?.id!==session.user.id || !state.profile) loadApp(session.user); },0);
      } else if(event==='SIGNED_OUT'){ state.user=null; state.profile=null; state.loadingUserId=null; showLogin(); }
    });
    const {data:{session}}=await state.client.auth.getSession(); if(session?.user) await loadApp(session.user); else showLogin();
  }
  async function login(e){e.preventDefault();$('#loginError').textContent='';const email=$('#loginEmail').value.trim(),password=$('#loginPassword').value;const {error}=await state.client.auth.signInWithPassword({email,password});if(error)$('#loginError').textContent=error.message;}
  async function logout(){const {error}=await state.client.auth.signOut();if(error)notify('No se pudo cerrar sesión: '+error.message,true);}
  function showLogin(){$('#appView').classList.add('hidden');$('#loginView').classList.remove('hidden');}
  async function loadApp(user){
    if(state.user?.id===user.id && state.profile) return;
    if(state.loadingUserId===user.id) return;
    state.loadingUserId=user.id;
    try{
      const {data,error}=await state.client.from('profiles').select('id,full_name,role,active').eq('id',user.id).maybeSingle();
      if(error||!data||!data.active){state.loadingUserId=null;await state.client.auth.signOut();$('#loginError').textContent='Tu usuario no tiene un perfil activo. Solicita al administrador que lo habilite en Supabase.';return;}
      state.user=user;state.profile=data;$('#loginView').classList.add('hidden');$('#appView').classList.remove('hidden');$('#userEmail').textContent=data.full_name||user.email;$('#userRole').textContent=({admin:'Administrador',registrador:'Registrador',consulta:'Consulta'})[data.role]||data.role;$('#userAvatar').textContent=(data.full_name||user.email||'U').trim().charAt(0).toUpperCase();
      const page=savedPage(); await go(page);
    } finally { if(state.loadingUserId===user.id) state.loadingUserId=null; }
  }
  const canWrite = () => ['admin','registrador'].includes(state.profile?.role);
  async function go(page){if(!labels[page])page='dashboard';state.page=page;savePage(page);state.pageNum=0;$('#breadcrumbPage').textContent=labels[page]||page;$$('.nav-item[data-page]').forEach(b=>b.classList.toggle('active',b.dataset.page===page));$('#sidebar').classList.remove('open');root().innerHTML='<div class="empty-state"><div class="big-icon">◌</div>Cargando información…</div>';try{if(page==='dashboard')await renderDashboard();else if(page==='orders')await renderOrders();else if(page==='activities')await renderActivities();else if(page==='crews')await renderCrews();else if(page==='staffing')await renderStaffing();else if(page==='technicians')await renderTechnicians();else if(page==='zones')await renderZones();else if(page==='services')await renderServices();else if(page==='reports')await renderReports();}catch(e){root().innerHTML=`<div class="panel"><h3>No se pudo cargar esta sección</h3><p class="muted">${esc(e.message||'Error de consulta')}</p><p class="muted">Si el detalle menciona una tabla, columna o autorización, revisa Supabase. Si no, es un error de la aplicación.</p></div>`;}}
  async function rows(table, opts={}){let q=state.client.from(table).select(opts.select||'*',{count:opts.count?'exact':undefined});if(opts.order)q=q.order(opts.order,{ascending:opts.ascending??false});if(opts.eq)for(const [k,v] of Object.entries(opts.eq))q=q.eq(k,v);if(opts.gte)for(const [k,v] of Object.entries(opts.gte))q=q.gte(k,v);if(opts.lte)for(const [k,v] of Object.entries(opts.lte))q=q.lte(k,v);if(opts.limit)q=q.limit(opts.limit);if(opts.range)q=q.range(opts.range[0],opts.range[1]);const {data,error,count}=await q;if(error)throw error;return {data:data||[],count};}
  // Descarga paginada (1000 por página: límite de Supabase) para no truncar resultados en silencio.
  async function fetchAll(table,{select='*',eq={},gte={},lte={},order=[],max=20000}={}){
    const out=[],page=1000;
    for(let start=0;start<max;start+=page){
      let q=state.client.from(table).select(select);
      for(const [k,v] of Object.entries(eq))q=q.eq(k,v);
      for(const [k,v] of Object.entries(gte))q=q.gte(k,v);
      for(const [k,v] of Object.entries(lte))q=q.lte(k,v);
      for(const [col,asc] of order)q=q.order(col,{ascending:asc});
      const {data,error}=await q.range(start,start+page-1);
      if(error)throw error;
      out.push(...(data||[]));
      if(!data||data.length<page)break;
    }
    return out;
  }
  // Conteo sin descargar filas (HEAD): costo mínimo de transferencia.
  async function countRows(table,eq={}){let q=state.client.from(table).select('id',{count:'exact',head:true});for(const [k,v] of Object.entries(eq))q=q.eq(k,v);const {count,error}=await q;if(error)throw error;return count||0}
  // Solo se descargan las filas del período del informe, con las columnas necesarias; se reutiliza 2 min
  // mientras cambien solo los filtros de técnico/cuadrilla/zona (esos se aplican en el navegador).
  async function loadReportData(from,to,force=false){
    const key=`${from}|${to}`,c=state.reportCache;
    if(!force&&c&&c.key===key&&Date.now()-c.ts<120000)return c;
    if(!force&&state.reportInflight?.key===key)return state.reportInflight.promise; // misma consulta ya en curso
    const promise=(async()=>{
      const [orders,activities,assignments]=await Promise.all([
        fetchAll('work_orders',{select:'id,service_date,technician_id,crew_id,zone_id,service_type_id,quantity,standard_minutes_snapshot,actual_minutes,notes,status',eq:{status:'completada'},gte:{service_date:from},lte:{service_date:to},order:[['service_date',true],['id',true]]}),
        fetchAll('other_activities',{select:'id,work_date,crew_id,minutes',gte:{work_date:from},lte:{work_date:to},order:[['work_date',true],['id',true]]}),
        fetchAll('daily_personnel_assignments',{select:'id,work_date,technician_id,crew_id,role,status,worked_minutes',gte:{work_date:from},lte:{work_date:to},order:[['work_date',true],['id',true]]}).catch(err=>{console.warn('Personal diario no disponible:',err);notify('No se pudo leer «Personal diario»; el rendimiento usa la jornada estándar.',true);return []})
      ]);
      return state.reportCache={key,ts:Date.now(),orders,activities,assignments};
    })();
    state.reportInflight={key,promise};
    promise.then(()=>{},()=>{}).then(()=>{if(state.reportInflight?.promise===promise)state.reportInflight=null});
    return promise;
  }
  async function renderDashboard(){
    const [techCount,zoneCount,orders,todayCount]=await Promise.all([countRows('technicians',{active:true}),countRows('zones',{active:true}),rows('work_orders',{select:'id,status,created_at,client_name,service_types(name),technicians(name),zones(name)',order:'created_at',limit:6}),countRows('work_orders',{service_date:dateToday()})]);
    root().innerHTML=`<div class="page-heading"><div><span class="eyebrow purple">PANEL OPERATIVO</span><h2>Resumen general</h2><p>Vista rápida de la operación y de los registros recientes.</p></div><div class="heading-actions">${canWrite()?'<button class="btn primary" data-action="new-order">＋ Registrar orden</button>':''}<button class="btn ghost" data-action="refresh">↻ Actualizar</button></div></div>
      <div class="kpi-grid"><div class="kpi-card"><div class="kpi-top">Técnicos activos <span class="kpi-icon">♙</span></div><div class="kpi-value">${num(techCount)}</div><div class="kpi-note">Personal registrado</div></div><div class="kpi-card"><div class="kpi-top">Zonas activas <span class="kpi-icon">⌖</span></div><div class="kpi-value">${num(zoneCount)}</div><div class="kpi-note">Zonas operativas</div></div><div class="kpi-card"><div class="kpi-top">Órdenes registradas hoy <span class="kpi-icon">▤</span></div><div class="kpi-value">${num(todayCount)}</div><div class="kpi-note">Según fecha del servicio</div></div></div>
      <div class="content-grid"><section class="panel"><div class="panel-header"><div><h3>Órdenes recientes</h3><p>Últimos registros de la plataforma</p></div><button class="btn ghost" data-go="orders">Ver órdenes →</button></div>${recentOrders(orders.data)}</section><section class="panel"><div class="panel-header"><div><h3>Accesos rápidos</h3><p>Acciones frecuentes</p></div></div><div class="quick-list"><button class="quick-action" data-action="new-order"><span class="quick-symbol">＋</span><span><strong>Nueva orden</strong><small>Registrar servicio ejecutado</small></span></button><button class="quick-action" data-go="activities"><span class="quick-symbol">◴</span><span><strong>Otras actividades</strong><small>Reuniones y actividades de empresa</small></span></button><button class="quick-action" data-go="technicians"><span class="quick-symbol">♙</span><span><strong>Administrar técnicos</strong><small>Personal y zona habitual</small></span></button><button class="quick-action" data-go="reports"><span class="quick-symbol">▥</span><span><strong>Consultar informes</strong><small>Informes diarios, semanales y mensuales</small></span></button></div></section></div>`;
    bindCommon();
  }
  function recentOrders(list){if(!list.length)return '<div class="empty-state"><div class="big-icon">▤</div><strong>No hay órdenes registradas</strong><p>Cuando se creen órdenes, aparecerán aquí.</p></div>';return `<div class="table-wrap"><table><thead><tr><th>Servicio</th><th>Cliente</th><th>Técnico</th><th>Zona</th></tr></thead><tbody>${list.map(o=>`<tr><td><strong>${esc(o.service_types?.name||'Servicio')}</strong><br><span class="muted">${fmtDate((o.created_at||'').slice(0,10))}</span></td><td>${esc(o.client_name||'—')}</td><td>${esc(o.technicians?.name||'—')}</td><td>${esc(o.zones?.name||'—')}</td></tr>`).join('')}</tbody></table></div>`;}
  async function renderCrews(){
    const [c,z,t,m]=await Promise.all([
      rows('crews',{order:'name',ascending:true,limit:500}),
      rows('zones',{order:'name',ascending:true,limit:500}),
      rows('technicians',{order:'name',ascending:true,limit:1000}),
      rows('crew_members',{limit:2000})
    ]);
    state.data={...state.data,crews:c.data,zones:z.data,technicians:t.data,crewMembers:m.data};
    const draw=list=>`<div class="table-wrap"><table><thead><tr><th>Cuadrilla</th><th>Zona</th><th>Jefe</th><th>Auxiliares</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>${list.length?list.map(x=>{
      const members=m.data.filter(y=>y.crew_id===x.id);
      const leader=members.find(y=>y.role==='jefe');
      const assistants=members.filter(y=>y.role==='auxiliar').map(y=>t.data.find(p=>p.id===y.technician_id)?.name||'Técnico no disponible');
      return `<tr><td><strong>${esc(x.name)}</strong></td><td>${esc(z.data.find(y=>y.id===x.zone_id)?.name||'Sin zona')}</td><td>${esc(t.data.find(y=>y.id===leader?.technician_id)?.name||'Sin jefe asignado')}</td><td>${esc(assistants.join(', ')||'Sin auxiliar')}</td><td><span class="badge ${x.active?'green':'orange'}">${x.active?'Activa':'Inactiva'}</span></td><td>${canWrite()?`<button class="btn ghost" data-action="edit-crew" data-id="${x.id}">Editar</button>`:'—'}</td></tr>`;
    }).join(''):`<tr><td colspan="6" class="table-empty">No hay cuadrillas registradas.</td></tr>`}</tbody></table></div>`;
    root().innerHTML=`${heading('Cuadrillas','Organiza jefe, auxiliares y zona de trabajo.',canWrite()?'<button class="btn primary" data-action="new-crew">＋ Nueva cuadrilla</button>':'')}<section class="panel table-panel"><div class="panel-header"><div><h3>Cuadrillas registradas</h3><p>${c.data.length} cuadrillas</p></div><input id="quickSearch" placeholder="Buscar cuadrilla, zona o técnico…" style="max-width:260px"></div><div id="tableHolder">${draw(c.data)}</div></section>`;
    bindCommon();
    $('#quickSearch').addEventListener('input',e=>{const q=e.target.value.toLowerCase();const filtered=c.data.filter(x=>{const members=m.data.filter(y=>y.crew_id===x.id).map(y=>t.data.find(p=>p.id===y.technician_id)?.name||'').join(' ');return `${x.name} ${z.data.find(y=>y.id===x.zone_id)?.name||''} ${members}`.toLowerCase().includes(q)});$('#tableHolder').innerHTML=draw(filtered)});
  }
  async function renderStaffing(){
    const [techs,crews]=await Promise.all([
      rows('technicians',{select:'id,name',order:'name',ascending:true,limit:1000}),
      rows('crews',{select:'id,name',order:'name',ascending:true,limit:500})
    ]);
    state.data={...state.data,technicians:techs.data,crews:crews.data};
    let assignments=[],seq=0;
    const statusLabel={trabajado:'Trabajó',descanso:'Descanso',permiso:'Permiso',incapacidad:'Incapacidad',otro:'Otra novedad'};
    const draw=list=>`<div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Persona</th><th>Rol del día</th><th>Cuadrilla efectiva</th><th>Estado</th><th>Tiempo efectivo</th><th>Observaciones</th><th></th></tr></thead><tbody>${list.length?list.map(a=>`<tr><td>${fmtDate(a.work_date)}</td><td><strong>${esc(techs.data.find(t=>t.id===a.technician_id)?.name||'Técnico no disponible')}</strong></td><td>${a.role==='jefe'?'Jefe':a.role==='auxiliar'?'Auxiliar':'Otro'}</td><td>${esc(crews.data.find(c=>c.id===a.crew_id)?.name||'Sin cuadrilla')}</td><td>${esc(statusLabel[a.status]||a.status)}</td><td>${num(a.worked_minutes||0)} min</td><td>${esc(a.notes||'—')}</td><td>${canWrite()?`<button class="btn ghost" data-action="edit-daily-assignment" data-id="${a.id}">Editar</button>`:'—'}</td></tr>`).join(''):`<tr><td colspan="8" class="table-empty">No hay asignaciones para esta fecha.</td></tr>`}</tbody></table></div>`;
    root().innerHTML=`${heading('Personal diario','Registra quién trabajó realmente en cada cuadrilla por fecha. Los cambios quedan guardados por día y no alteran fechas anteriores.',canWrite()?'<button class="btn primary" data-action="new-daily-assignment">＋ Registrar personal</button>':'')}<div class="panel" style="margin-bottom:15px"><div class="form-grid"><label>Fecha de trabajo<input type="date" id="staffingDate" value="${esc(state.staffingDate||dateToday())}"></label><label>Buscar persona<input id="staffingSearch" placeholder="Nombre o cuadrilla"></label></div><p class="muted" style="margin-bottom:0">Registra una fila por persona y fecha. Si un auxiliar cambia de cuadrilla, edita su asignación de ese día; las demás fechas permanecen intactas. Para descanso, permiso o incapacidad, registra la novedad y 0 minutos.</p></div><section class="panel table-panel"><div class="panel-header"><div><h3>Asignaciones y novedades</h3><p id="staffingCount">Cargando…</p></div></div><div id="staffingTable">${draw([])}</div></section>`;
    bindCommon();
    const refresh=()=>{const date=$('#staffingDate').value,q=$('#staffingSearch').value.toLowerCase();const list=assignments.filter(a=>(`${techs.data.find(t=>t.id===a.technician_id)?.name||''} ${crews.data.find(c=>c.id===a.crew_id)?.name||''}`).toLowerCase().includes(q));$('#staffingTable').innerHTML=draw(list);$('#staffingCount').textContent=`${list.length} personas para ${fmtDate(date)}`};
    // Solo se consulta la fecha elegida (antes se descargaban hasta 3.000 filas históricas).
    const load=async()=>{const date=$('#staffingDate').value||dateToday(),mine=++seq;state.staffingDate=date;try{const r=await rows('daily_personnel_assignments',{eq:{work_date:date},order:'created_at',ascending:true,limit:500});if(mine!==seq)return;assignments=r.data;refresh()}catch(err){if(mine===seq)notify('No se pudo cargar Personal diario: '+friendlyError(err),true)}};
    $('#staffingDate').addEventListener('change',load);$('#staffingSearch').addEventListener('input',refresh);
    await load();
  }
  async function openDailyAssignment(id){
    if(!canWrite())return;
    const [techsResult,crewsResult,existingResult]=await Promise.all([
      rows('technicians',{select:'id,name',order:'name',ascending:true,limit:1000}),
      rows('crews',{select:'id,name',order:'name',ascending:true,limit:500}),
      id?rows('daily_personnel_assignments',{eq:{id},limit:1}):Promise.resolve({data:[]})
    ]);
    const x=existingResult.data[0]||{work_date:$('#staffingDate')?.value||dateToday(),technician_id:'',crew_id:'',status:'trabajado',role:'',worked_minutes:scheduledMinutes($('#staffingDate')?.value||dateToday()),notes:''};
    const f=modal(id?'Editar asignación diaria':'Registrar personal del día','Una persona solo puede tener una asignación por fecha. Cambiar la cuadrilla actualiza ese día y conserva el historial de otras fechas.',`<div class="form-grid"><label>Fecha<input name="work_date" id="dailyAssignmentDate" type="date" required value="${esc(x.work_date)}"></label><label>Persona<select name="technician_id" required>${techsResult.data.map(t=>`<option value="${t.id}" ${x.technician_id===t.id?'selected':''}>${esc(t.name)}</option>`).join('')}</select></label><label>Rol que cumplió ese día<select name="role" required><option value="">Selecciona rol</option><option value="jefe" ${x.role==='jefe'?'selected':''}>Jefe de cuadrilla</option><option value="auxiliar" ${x.role==='auxiliar'?'selected':''}>Auxiliar</option><option value="otro" ${x.role==='otro'?'selected':''}>Otro / apoyo</option></select></label><label>Cuadrilla donde trabajó ese día<select name="crew_id"><option value="">Trabajo individual / sin cuadrilla</option>${crewsResult.data.map(c=>`<option value="${c.id}" ${x.crew_id===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select></label><label>Estado del día<select name="status" id="dailyAssignmentStatus"><option value="trabajado" ${x.status==='trabajado'?'selected':''}>Trabajó</option><option value="descanso" ${x.status==='descanso'?'selected':''}>Descanso</option><option value="permiso" ${x.status==='permiso'?'selected':''}>Permiso</option><option value="incapacidad" ${x.status==='incapacidad'?'selected':''}>Incapacidad</option><option value="otro" ${x.status==='otro'?'selected':''}>Otra novedad</option></select></label><label>Tiempo efectivo (minutos)<input name="worked_minutes" id="dailyWorkedMinutes" type="number" min="0" max="1440" step="1" required value="${Number(x.worked_minutes||0)}"></label><label class="wide">Observaciones<textarea name="notes" rows="3" maxlength="1500" placeholder="Ej. reemplazó al auxiliar de la cuadrilla B">${esc(x.notes||'')}</textarea></label></div>`);
    const status=$('#dailyAssignmentStatus',f),minutes=$('#dailyWorkedMinutes',f),dateInput=$('#dailyAssignmentDate',f);const updateStatus=()=>{if(status.value!=='trabajado')minutes.value='0';else if(Number(minutes.value)===0)minutes.value=String(scheduledMinutes(dateInput.value))};status.addEventListener('change',updateStatus);dateInput.addEventListener('change',()=>{if(status.value==='trabajado')minutes.value=String(scheduledMinutes(dateInput.value))});
    f.__submit=async e=>{e.preventDefault();if(!f.reportValidity())return;const v=Object.fromEntries(new FormData(f));v.crew_id=v.crew_id||null;v.worked_minutes=Number(v.worked_minutes);v.notes=(v.notes||'').trim()||null;if(v.status!=='trabajado'&&v.worked_minutes!==0){notify('Las novedades de ausencia deben tener 0 minutos efectivos.',true);return}if(v.status==='trabajado'&&v.worked_minutes===0&&!v.notes){notify('Confirma el tiempo en cero o agrega una observación que explique el caso.',true);return}v.created_by=state.user?.id||null;let result;if(id){const changes={...v};delete changes.created_by;result=await state.client.from('daily_personnel_assignments').update(changes).eq('id',id)}else result=await state.client.from('daily_personnel_assignments').upsert(v,{onConflict:'technician_id,work_date'});if(result.error)throw result.error;state.staffingDate=v.work_date;$('#modalRoot').innerHTML='';notify('Asignación diaria guardada.');await go('staffing')};
  }
  async function renderActivities(){
    const [a,c,z]=await Promise.all([
      rows('other_activities',{order:'work_date',ascending:false,limit:2000}),
      rows('crews',{order:'name',ascending:true,limit:500}),
      rows('zones',{order:'name',ascending:true,limit:500})
    ]);
    state.data={...state.data,activities:a.data,crews:c.data,zones:z.data};
    const draw=list=>`<div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Actividad</th><th>Aplicación</th><th>Inicio</th><th>Fin</th><th>Duración</th><th>Observaciones</th><th>Acciones</th></tr></thead><tbody>${list.length?list.map(x=>`<tr><td>${fmtDate(x.work_date)}</td><td><strong>${esc(x.activity_type)}</strong></td><td>${esc(x.crew_id?(c.data.find(y=>y.id===x.crew_id)?.name||'Cuadrilla no disponible'):'Toda la empresa')}</td><td>${esc(String(x.start_time||'').slice(0,5)||'—')}</td><td>${esc(String(x.end_time||'').slice(0,5)||'—')}</td><td>${num(x.minutes)} min</td><td>${esc(x.notes||'—')}</td><td>${canWrite()?`<button class="btn ghost" data-action="edit-activity" data-id="${x.id}">Editar</button>`:'—'}</td></tr>`).join(''):`<tr><td colspan="8" class="table-empty">No hay otras actividades registradas.</td></tr>`}</tbody></table></div>`;
    root().innerHTML=`${heading('Otras actividades','Registra reuniones, capacitaciones y tareas de empresa que reducen el tiempo disponible para atender servicios.',canWrite()?'<button class="btn primary" data-action="new-activity">＋ Registrar actividad</button>':'')}<section class="panel table-panel"><div class="panel-header"><div><h3>Actividades de empresa</h3><p>${a.data.length} registros · la duración se calcula desde la hora de inicio y fin.</p></div><input id="quickSearch" placeholder="Buscar actividad o cuadrilla…" style="max-width:260px"></div><div id="tableHolder">${draw(a.data)}</div></section>`;
    bindCommon();$('#quickSearch').addEventListener('input',e=>{const q=e.target.value.toLowerCase();$('#tableHolder').innerHTML=draw(a.data.filter(x=>`${x.activity_type} ${x.notes||''} ${x.crew_id?(c.data.find(y=>y.id===x.crew_id)?.name||''):'Toda la empresa'}`.toLowerCase().includes(q)))});
  }
  async function renderZones(){const {data}=await rows('zones',{order:'name',ascending:true,limit:500});root().innerHTML=`${heading('Zonas','Administra las zonas operativas y su disponibilidad',canWrite()?'<button class="btn primary" data-action="new-zone">＋ Nueva zona</button>':'')}<section class="panel table-panel"><div class="panel-header"><div><h3>Catálogo de zonas</h3><p>${data.length} registros</p></div><input id="quickSearch" placeholder="Buscar zona…" style="max-width:220px"></div><div id="tableHolder">${simpleTable(data,[['name','Zona'],['description','Descripción'],['active','Estado']], 'zone')}</div></section>`;bindCommon();$('#quickSearch').addEventListener('input',e=>$('#tableHolder').innerHTML=simpleTable(data.filter(x=>(x.name+' '+(x.description||'')).toLowerCase().includes(e.target.value.toLowerCase())),[['name','Zona'],['description','Descripción'],['active','Estado']],'zone'));}
  async function renderTechnicians(){const [t,z]=await Promise.all([rows('technicians',{order:'name',ascending:true,limit:1000}),rows('zones',{order:'name',ascending:true,limit:500})]);state.data.zones=z.data;root().innerHTML=`${heading('Técnicos','Personal, identificación y zona habitual',canWrite()?'<button class="btn primary" data-action="new-tech">＋ Nuevo técnico</button>':'')}<div class="filter-bar"><input id="quickSearch" placeholder="Buscar por nombre o documento…"><select id="activeFilter"><option value="all">Todos los estados</option><option value="true">Activos</option><option value="false">Inactivos</option></select><span class="spacer"></span><span class="muted">${t.data.length} técnicos</span></div><section class="panel table-panel"><div id="tableHolder">${techTable(t.data,z.data)}</div></section>`;bindCommon();const filter=()=>{const q=$('#quickSearch').value.toLowerCase(),a=$('#activeFilter').value;$('#tableHolder').innerHTML=techTable(t.data.filter(x=>(`${x.name} ${x.document_number||''}`).toLowerCase().includes(q)&&(a==='all'||String(x.active)===a)),z.data)};$('#quickSearch').addEventListener('input',filter);$('#activeFilter').addEventListener('change',filter);}
  async function renderServices(){const {data}=await rows('service_types',{order:'name',ascending:true,limit:1000});root().innerHTML=`${heading('Servicios y estándares','Catálogo inicial sujeto a validación con el Excel oficial',canWrite()?'<button class="btn primary" data-action="new-service">＋ Nuevo servicio</button>':'')}<div class="panel" style="margin-bottom:15px"><span class="badge orange">Importante</span><p class="muted" style="margin:10px 0 0;line-height:1.6">Los minutos estándar son una referencia configurable. Las modificaciones deben conservar trazabilidad y no deben alterar silenciosamente informes cerrados. Valida los tiempos iniciales con el archivo oficial antes de usarlos para medir productividad.</p></div><section class="panel table-panel"><div class="panel-header"><div><h3>Catálogo de servicios</h3><p>${data.length} servicios registrados</p></div><input id="quickSearch" placeholder="Buscar servicio…" style="max-width:220px"></div><div id="tableHolder">${serviceTable(data)}</div></section>`;bindCommon();$('#quickSearch').addEventListener('input',e=>$('#tableHolder').innerHTML=serviceTable(data.filter(x=>x.name.toLowerCase().includes(e.target.value.toLowerCase()))));}
  async function renderOrders(){
    const now=new Date(),firstDay=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    const [t,z,s,c]=await Promise.all([rows('technicians',{select:'id,name',order:'name',ascending:true,limit:1000}),rows('zones',{select:'id,name',order:'name',ascending:true,limit:500}),rows('service_types',{select:'id,name',order:'name',ascending:true,limit:1000}),rows('crews',{select:'id,name',order:'name',ascending:true,limit:500})]);
    state.data={technicians:t.data,zones:z.data,services:s.data,crews:c.data,orderRows:[],orderFiltered:[]};
    root().innerHTML=`${heading('Órdenes de servicio','Registra los servicios realizados por técnico, incluyendo la cantidad de trabajos iguales.',canWrite()?'<button class="btn primary" data-action="new-order">＋ Registrar orden</button>':'')}<div class="filter-bar"><input id="quickSearch" placeholder="Buscar servicio, técnico, zona u observaciones…"><input type="date" id="fromDate" aria-label="Desde" value="${firstDay}"><input type="date" id="toDate" aria-label="Hasta" value="${dateToday()}"><span class="spacer"></span><button class="btn ghost" data-action="export-orders">Exportar CSV</button></div><section class="panel table-panel"><div class="panel-header"><div><h3>Registro de órdenes</h3><p id="ordersNote">Fuente de verdad para el conteo de servicios</p></div><span class="badge purple" id="ordersBadge">0 órdenes</span></div><div id="tableHolder">${ordersTable([],t.data,z.data,s.data,c.data)}</div></section>`;
    bindCommon();
    let orders=[],seq=0;
    const draw=()=>{const q=$('#quickSearch').value.toLowerCase();const filtered=orders.filter(x=>{const tech=t.data.find(y=>y.id===x.technician_id)?.name||'',zone=z.data.find(y=>y.id===x.zone_id)?.name||'',service=s.data.find(y=>y.id===x.service_type_id)?.name||'',crew=c.data.find(y=>y.id===x.crew_id)?.name||'';return `${tech} ${zone} ${service} ${crew} ${x.notes||''}`.toLowerCase().includes(q)});state.data.orderFiltered=filtered;$('#tableHolder').innerHTML=ordersTable(filtered,t.data,z.data,s.data,c.data);$('#ordersBadge').textContent=`${filtered.length} órdenes`};
    // Las fechas se filtran en Supabase (no se descarga todo el historial) y se pagina de 1.000 en 1.000.
    const load=async()=>{
      const from=$('#fromDate').value,to=$('#toDate').value,mine=++seq;
      if(from&&to&&from>to){notify('La fecha inicial no puede ser posterior a la final.',true);return}
      $('#tableHolder').style.opacity='.55';
      try{
        const data=await fetchAll('work_orders',{select:'id,service_date,technician_id,crew_id,zone_id,service_type_id,quantity,standard_minutes_snapshot,actual_minutes,notes,status',gte:from?{service_date:from}:{},lte:to?{service_date:to}:{},order:[['service_date',false],['id',false]],max:from||to?20000:1000});
        if(mine!==seq)return;
        orders=data;state.data.orderRows=data;
        $('#ordersNote').textContent=from||to?'Fuente de verdad para el conteo de servicios':'Sin fechas: se muestran solo las 1.000 órdenes más recientes.';
        draw();
      }catch(err){if(mine===seq)notify('No se pudieron cargar las órdenes: '+friendlyError(err),true)}
      finally{if(mine===seq)$('#tableHolder').style.opacity=''}
    };
    $('#quickSearch').addEventListener('input',draw);['fromDate','toDate'].forEach(id=>$('#'+id).addEventListener('change',load));
    await load();
  }
  async function renderReports(){
    const [t,z,s,c,m]=await Promise.all([rows('technicians',{select:'id,name,active',order:'name',ascending:true,limit:1000}),rows('zones',{select:'id,name,active',order:'name',ascending:true,limit:500}),rows('service_types',{select:'id,name',order:'name',ascending:true,limit:1000}),rows('crews',{select:'id,name,zone_id,active',order:'name',ascending:true,limit:500}),rows('crew_members',{select:'crew_id,technician_id,role',limit:2000})]);
    state.reportCache=null;state.reportSeq=0;
    state.data={...state.data,reportOrders:[],technicians:t.data,zones:z.data,services:s.data,reportDays:[],reportActivities:[],crews:c.data,crewMembers:m.data,dailyAssignments:[]};
    root().innerHTML=`${heading('Informes','Consulta la operación por día, semana o mes; resumen y gráficos primero, detalle completo después.')}
      <section class="panel report-filters"><div class="report-filter-grid report-filter-grid-period"><label class="field">Período<select id="reportPeriod"><option value="daily">Diario</option><option value="weekly">Semanal</option><option value="monthly">Mensual</option><option value="custom">Personalizado</option></select></label><label class="field">Desde<input type="date" id="reportFrom" value="${dateToday()}"></label><label class="field">Hasta<input type="date" id="reportTo" value="${dateToday()}"></label><div class="field report-multi-field"><label for="reportTechToggle">Técnicos</label><small>Selecciona uno o varios; sin selección incluye todos.</small><details class="report-multi" id="reportTechDropdown"><summary id="reportTechToggle">Todos los técnicos</summary><div class="report-multi-menu"><label class="report-select-all"><input type="checkbox" data-report-select-all="reportTech"> Seleccionar todos</label>${t.data.map(x=>`<label class="report-multi-option"><input type="checkbox" data-report-filter="reportTech" value="${x.id}"> <span>${esc(x.name)}</span></label>`).join('')}</div></details><select id="reportTech" multiple hidden aria-label="Seleccionar uno o varios técnicos">${t.data.map(x=>`<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></div><div class="field report-multi-field"><label for="reportCrewToggle">Cuadrillas</label><small>Selecciona una o varias; sin selección incluye todas.</small><details class="report-multi" id="reportCrewDropdown"><summary id="reportCrewToggle">Todas las cuadrillas</summary><div class="report-multi-menu"><label class="report-select-all"><input type="checkbox" data-report-select-all="reportCrew"> Seleccionar todas</label>${c.data.filter(x=>x.active!==false).map(x=>`<label class="report-multi-option"><input type="checkbox" data-report-filter="reportCrew" value="${x.id}"> <span>${esc(x.name)}</span></label>`).join('')}</div></details><select id="reportCrew" multiple hidden aria-label="Seleccionar una o varias cuadrillas">${c.data.filter(x=>x.active!==false).map(x=>`<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></div><div class="field report-multi-field"><label for="reportZoneToggle">Zonas de ejecución</label><small>Selecciona una o varias; sin selección incluye todas.</small><details class="report-multi" id="reportZoneDropdown"><summary id="reportZoneToggle">Todas las zonas</summary><div class="report-multi-menu"><label class="report-select-all"><input type="checkbox" data-report-select-all="reportZone"> Seleccionar todas</label>${z.data.map(x=>`<label class="report-multi-option"><input type="checkbox" data-report-filter="reportZone" value="${x.id}"> <span>${esc(x.name)}</span></label>`).join('')}</div></details><select id="reportZone" multiple hidden aria-label="Seleccionar una o varias zonas">${z.data.map(x=>`<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></div></div><div class="report-actions"><button class="btn primary" id="applyReport" type="button">Actualizar informe</button><button class="btn primary" id="downloadReportPdf" type="button">Generar y descargar PDF</button><button class="btn secondary" id="downloadReportXlsx" type="button">Descargar Excel</button><button class="btn ghost" id="previewReport" type="button">Imprimir / guardar PDF</button></div></section><section class="panel report-preview" id="reportPreview"><div id="reportResults"><div class="empty-state">Preparando informe…</div></div></section><p class="muted report-note">Rendimiento = tiempo real ÷ minutos disponibles (470 por día laboral de lunes a viernes, 235 los sábados, 0 domingos y festivos; se descuentan las otras actividades). Si una orden no tiene tiempo real, se usa su estándar. Cada registro puede representar varias unidades del mismo servicio; el informe multiplica el estándar por la cantidad. El tiempo adicional es la diferencia positiva entre el tiempo real y el estándar; no equivale automáticamente a horas extra laborales.</p>`;
    bindCommon();
    $('#reportPeriod').addEventListener('change',()=>{setReportPeriod($('#reportPeriod').value);applyReport()});
    $('#applyReport').addEventListener('click',()=>applyReport(true));
    $('#downloadReportPdf').addEventListener('click',downloadReportPdf);
    $('#previewReport').addEventListener('click',printReport);
    $('#downloadReportXlsx').addEventListener('click',downloadReportXlsx);
    ['reportFrom','reportTo'].forEach(id=>$('#'+id).addEventListener('change',()=>{if($('#reportPeriod').value!=='custom')$('#reportPeriod').value='custom';applyReport()}));
    ['reportZone'].forEach(id=>$('#'+id).addEventListener('change',()=>applyReport()));
    function syncReportMulti(id){
      const select=$('#'+id),checks=$$(`[data-report-filter="${id}"]`),selected=checks.filter(x=>x.checked).map(x=>x.value);
      [...select.options].forEach(o=>o.selected=selected.includes(o.value));
      const toggle=$('#'+id+'Toggle'),all=checks.length>0&&selected.length===checks.length;
      const allLabel=id==='reportTech'?'Todos los técnicos':id==='reportCrew'?'Todas las cuadrillas':'Todas las zonas';toggle.textContent=selected.length===0?allLabel:all?allLabel:`${selected.length} seleccionada${selected.length===1?'':'s'}`;
      const allBox=$(`[data-report-select-all="${id}"]`);if(allBox)allBox.checked=all;
      applyReport();
    }
    $$('[data-report-filter]').forEach(box=>box.addEventListener('change',()=>syncReportMulti(box.dataset.reportFilter)));
    $$('[data-report-select-all]').forEach(box=>box.addEventListener('change',()=>{$$(`[data-report-filter="${box.dataset.reportSelectAll}"]`).forEach(item=>item.checked=box.checked);syncReportMulti(box.dataset.reportSelectAll)}));
    setReportPeriod('daily');
    await applyReport();
  }
  function setReportPeriod(period){
    const now=new Date();const today=window.isoLocal(now);let from=today,to=today;
    if(period==='weekly'){const day=now.getDay(),offset=day===0?6:day-1;const monday=new Date(now);monday.setDate(now.getDate()-offset);from=window.isoLocal(monday)}
    if(period==='monthly')from=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    if(period==='custom')return;
    $('#reportFrom').value=from;$('#reportTo').value=to;
  }
  function groupReport(records,key){const m=new Map();records.forEach(r=>{const k=r[key]||'Sin dato';m.set(k,(m.get(k)||0)+Math.max(1,Number(r.cantidad||1)))});const total=[...m.values()].reduce((a,b)=>a+b,0);return [...m.entries()].map(([name,count])=>({name,count,percent:total?count/total*100:0})).sort((a,b)=>b.count-a.count)}
  const REPORT_COLORS=['#7c3aed','#16a34a','#f59e0b','#ef4444','#0ea5e9','#d946ef','#64748b','#84cc16','#f97316','#14b8a6'];
  function reportBars(title,items){const max=Math.max(1,...items.map(x=>x.count));return `<section class="report-chart"><h3>${esc(title)}</h3>${items.length?items.slice(0,8).map(x=>`<div class="bar-row"><div class="bar-label"><span>${esc(x.name)}</span><strong>${num(x.count)} · ${x.percent.toLocaleString('es-CO',{maximumFractionDigits:1})}%</strong></div><div class="bar-track"><span style="width:${Math.max(0,Math.min(100,x.count/max*100))}%"></span></div></div>`).join(''):'<p class="muted">Sin datos para graficar.</p>'}</section>`}
  function reportDonut(title,items){
    const total=items.reduce((sum,x)=>sum+x.count,0);const displayItems=items.length>8?[...items.slice(0,7),{name:'Otros',count:items.slice(7).reduce((sum,x)=>sum+x.count,0),percent:total?items.slice(7).reduce((sum,x)=>sum+x.count,0)/total*100:0}]:items;let angle=-Math.PI/2;const cx=90,cy=90,outer=66,inner=39;
    const point=(r,a)=>({x:cx+r*Math.cos(a),y:cy+r*Math.sin(a)});
    const nonzero=displayItems.filter(x=>x.count>0);
    const slices=nonzero.map((item,i)=>{const start=angle;angle+=item.count/(total||1)*Math.PI*2;const end=angle,color=REPORT_COLORS[i%REPORT_COLORS.length];if(nonzero.length===1)return `<circle cx="${cx}" cy="${cy}" r="${(outer+inner)/2}" fill="none" stroke="${color}" stroke-width="${outer-inner}"/>`;const a=point(outer,start),b=point(outer,end),c=point(inner,end),d=point(inner,start),large=end-start>Math.PI?1:0;return `<path d="M ${a.x.toFixed(3)} ${a.y.toFixed(3)} A ${outer} ${outer} 0 ${large} 1 ${b.x.toFixed(3)} ${b.y.toFixed(3)} L ${c.x.toFixed(3)} ${c.y.toFixed(3)} A ${inner} ${inner} 0 ${large} 0 ${d.x.toFixed(3)} ${d.y.toFixed(3)} Z" fill="${color}"/>`}).join('');
    const legend=displayItems.map((x,i)=>`<div><i style="background:${REPORT_COLORS[i%REPORT_COLORS.length]}"></i><span title="${esc(x.name)}">${esc(x.name)}</span><strong>${x.percent.toLocaleString('es-CO',{maximumFractionDigits:1})}%</strong></div>`).join('');
    return `<section class="report-chart"><h3>${esc(title)}</h3><div class="status-chart-wrap"><svg class="report-donut-svg" viewBox="0 0 180 180" role="img" aria-label="${esc(title)}">${slices||`<circle cx="90" cy="90" r="52" fill="none" stroke="#e5e7eb" stroke-width="27"/>`}<text x="90" y="87" text-anchor="middle" font-size="23" font-weight="700" fill="#242036">${num(total)}</text><text x="90" y="106" text-anchor="middle" font-size="10" fill="#6b6578">servicios</text></svg><div class="status-legend">${legend||'<span class="muted">Sin datos</span>'}</div></div></section>`;
  }
  function reportTable(records){
    const sum=k=>records.reduce((t,r)=>t+Number(r[k]||0),0);
    const foot=records.length?`<tfoot><tr class="report-total-row"><td colspan="5"><strong>Total del período</strong></td><td><strong>${num(records.reduce((t,r)=>t+Number(r.cantidad||1),0))}</strong></td><td><strong>${num(sum('minutos_estandar'))}</strong></td><td><strong>${num(sum('minutos_reales_calculo'))}</strong></td><td><strong>${num(sum('minutos_adicionales'))}</strong></td><td>Tiempo real = estándar + adicional</td></tr></tfoot>`:'';
    return `<div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Técnico responsable</th><th>Cuadrilla</th><th>Zona</th><th>Servicio realizado</th><th>Cantidad</th><th>Estándar aplicado (min)</th><th>Tiempo real (min)</th><th>Adicional (min)</th><th>Observaciones</th></tr></thead><tbody>${records.map(r=>`<tr><td>${fmtDate(r.fecha)}</td><td>${esc(r.tecnico)}</td><td>${esc(r.cuadrilla||'Individual')}${r.cuadrilla_inferida?' <span class="muted">(deducida)</span>':''}</td><td>${esc(r.zona)}</td><td>${esc(r.servicio)}</td><td>${num(r.cantidad||1)}</td><td>${num(r.minutos_estandar)}</td><td>${num(r.minutos_reales_calculo)}${r.minutos_reales==null?' <span class="muted">(estándar)</span>':''}</td><td>${num(r.minutos_adicionales)}</td><td class="report-observations">${esc(r.observaciones||'—')}</td></tr>`).join('')||'<tr><td colspan="10" class="table-empty">No hay datos para los filtros seleccionados.</td></tr>'}</tbody>${foot}</table></div>`}
  async function applyReport(force=false){
    const from=$('#reportFrom')?.value,to=$('#reportTo')?.value;
    if(!from||!to){notify('Selecciona la fecha inicial y la fecha final.',true);return false}
    if(from>to){notify('La fecha inicial no puede ser posterior a la fecha final.',true);return false}
    if(datesBetween(from,to,400).length>366){notify('El rango máximo del informe es de 366 días.',true);return false}
    const seq=state.reportSeq=(state.reportSeq||0)+1,box=$('#reportResults');
    if(box)box.style.opacity='.55';
    try{
      const data=await loadReportData(from,to,force===true);
      if(seq!==state.reportSeq)return null; // llegó otra solicitud más reciente
      state.data.reportOrders=data.orders;state.data.reportActivities=data.activities;state.data.dailyAssignments=data.assignments;
    }catch(err){if(seq===state.reportSeq)notify('No se pudieron cargar los datos del informe: '+friendlyError(err),true);return false}
    finally{if(seq===state.reportSeq&&box)box.style.opacity=''}
    const records=getReportRows();const total=records.reduce((a,x)=>a+Number(x.cantidad||1),0),orderEntries=records.length,minutes=records.reduce((a,x)=>a+Number(x.minutos_estandar||0),0),actualMinutes=records.reduce((a,x)=>a+Number(x.minutos_reales_calculo||0),0),extraMinutes=records.reduce((a,x)=>a+Number(x.minutos_adicionales||0),0);
    const byTech=groupReport(records,'tecnico'),byZone=groupReport(records,'zona'),byService=groupReport(records,'servicio');
    const selectedTechIds=$('#reportTech')?[...$('#reportTech').selectedOptions].map(o=>o.value):[];const selectedCrewIds=$('#reportCrew')?[...$('#reportCrew').selectedOptions].map(o=>o.value):[];const selectedZoneIds=$('#reportZone')?[...$('#reportZone').selectedOptions].map(o=>o.value):[];
    const staffingRows=selectStaffingRows({assignments:(state.data.dailyAssignments||[]).filter(a=>(!from||a.work_date>=from)&&(!to||a.work_date<=to)),crews:state.data.crews||[],records,techIds:selectedTechIds,crewIds:selectedCrewIds,zoneIds:selectedZoneIds});
    // La tabla «Personal efectivo» muestra solo a las personas filtradas; la disponibilidad usa la cuadrilla completa.
    const summaryRows=(state.data.dailyAssignments||[]).filter(a=>(!from||a.work_date>=from)&&(!to||a.work_date<=to)&&(!selectedCrewIds.length||selectedCrewIds.includes(a.crew_id))&&(!selectedTechIds.length||selectedTechIds.includes(a.technician_id))&&(!selectedZoneIds.length||selectedZoneIds.includes((state.data.crews||[]).find(c=>c.id===a.crew_id)?.zone_id)));
    const dates=datesBetween(from,to,370);
    const {availableMinutes}=computeAvailableMinutes({dates,records,staffingRows,activities:state.data.reportActivities||[],crewIds:selectedCrewIds,techIds:selectedTechIds});
    const {realUsedMinutes,withoutReal,effectiveness}=computePerformance(records,availableMinutes);
    const staffTotals=new Map();summaryRows.forEach(a=>{const key=`${a.crew_id||'individual'}|${a.technician_id}|${a.role||'otro'}`;const cur=staffTotals.get(key)||{crew_id:a.crew_id,technician_id:a.technician_id,worked_minutes:0,days:0,absence_days:0,statuses:[]};cur.role=a.role||cur.role;if(a.status==='trabajado'&&Number(a.worked_minutes||0)>0){cur.worked_minutes+=Number(a.worked_minutes||0);cur.days+=1}else cur.absence_days+=1;cur.statuses.push(a.status);staffTotals.set(key,cur)});const staffSummary=[...staffTotals.values()].map(a=>({...a,novedades:Object.entries(a.statuses.reduce((acc,status)=>{if(status!=='trabajado')acc[status]=(acc[status]||0)+1;return acc},{})).map(([status,count])=>`${({descanso:'Descanso',permiso:'Permiso',incapacidad:'Incapacidad',otro:'Otra novedad'})[status]||status}: ${count}`).join(', ')||'—',persona:(state.data.technicians||[]).find(t=>t.id===a.technician_id)?.name||'Técnico no disponible',cuadrilla:(state.data.crews||[]).find(c=>c.id===a.crew_id)?.name||'Individual'})).sort((a,b)=>a.cuadrilla.localeCompare(b.cuadrilla)||a.persona.localeCompare(b.persona));const staffTable=`<section class="report-detail report-staffing"><div class="panel-header"><div><h3>Personal efectivo por cuadrilla</h3><p>Tiempo y novedades según la asignación diaria real; los auxiliares temporales se atribuyen a la cuadrilla de ese día.</p></div></div><div class="table-wrap"><table><thead><tr><th>Cuadrilla del día</th><th>Rol</th><th>Persona</th><th>Días trabajados</th><th>Días con novedad</th><th>Detalle de novedades</th><th>Tiempo efectivo</th><th>Horas efectivas</th></tr></thead><tbody>${staffSummary.map(a=>`<tr><td>${esc(a.cuadrilla)}</td><td>${a.role==='jefe'?'Jefe':a.role==='auxiliar'?'Auxiliar':'Otro'}</td><td>${esc(a.persona)}</td><td>${num(a.days)}</td><td>${num(a.absence_days)}</td><td>${esc(a.novedades)}</td><td>${num(a.worked_minutes)} min</td><td>${(a.worked_minutes/60).toLocaleString('es-CO',{maximumFractionDigits:2})}</td></tr>`).join('')||'<tr><td colspan="8">Sin asignaciones diarias registradas para este período.</td></tr>'}</tbody></table></div></section>`;const productiveMinutes=minutes;const periodLabel=({daily:'Diario',weekly:'Semanal',monthly:'Mensual',custom:'Personalizado'})[$('#reportPeriod')?.value||'custom'];
    $('#reportResults').innerHTML=`<div class="report-title"><div><span class="eyebrow purple">INFORME ${esc(periodLabel.toUpperCase())}</span><h2>Detalle de servicios realizados</h2><p>Período: ${esc(from?fmtDate(from):'Sin fecha inicial')} — ${esc(to?fmtDate(to):'Sin fecha final')}</p></div><span class="badge purple">${num(total)} servicios · ${num(orderEntries)} registros</span></div><section class="report-metrics-section"><h3>Resumen del período</h3><div class="report-summary"><div class="report-box"><small>Servicios realizados</small><strong>${num(total)}</strong><span class="metric-caption">Suma de cantidades registradas (${num(orderEntries)} registros)</span></div><div class="report-box"><small>Minutos estándar aplicados</small><strong>${num(minutes)}</strong><span class="metric-caption">Parte del tiempo trabajado que cabe en el estándar</span></div><div class="report-box"><small>Horas estándar aplicadas</small><strong>${(minutes/60).toLocaleString('es-CO',{maximumFractionDigits:1})}</strong><span class="metric-caption">Minutos estándar ÷ 60</span></div><div class="report-box"><small>Tiempo real trabajado</small><strong>${num(actualMinutes)} min</strong><span class="metric-caption">= ${num(minutes)} estándar + ${num(extraMinutes)} adicional</span></div><div class="report-box"><small>Tiempo adicional</small><strong>${num(extraMinutes)} min</strong><span class="metric-caption">Tiempo real que superó el estándar</span></div><div class="report-box"><small>Rendimiento (tiempo real)</small><strong>${effectiveness.toLocaleString('es-CO',{minimumFractionDigits:2,maximumFractionDigits:2})}%</strong><span class="metric-caption">${num(realUsedMinutes)} min de tiempo real / ${num(availableMinutes)} min disponibles (470 por día laboral)${withoutReal?` · ${num(withoutReal)} registro(s) sin tiempo real usan su estándar`:''}</span></div></div></section><div class="report-chart-grid">${reportDonut('Distribución por tipo de servicio',byService)}${reportDonut('Distribución por zona',byZone)}${reportDonut('Distribución por técnico',byTech)}${reportBars('Servicios más realizados',byService)}</div>${staffTable}<section class="report-detail"><div class="panel-header"><div><h3>Detalle completo de órdenes</h3><p>Una fila por registro; la cantidad y las observaciones quedan visibles para cada servicio.</p></div></div>${reportTable(records)}</section>`;
    state.data.currentReport={records,metrics:{total,minutes,actualMinutes,extraMinutes,availableMinutes,productiveMinutes,realUsedMinutes,withoutReal,effectiveness,hours:minutes/60},byTech,byZone,byService,staffSummary,from,to,periodLabel};
    return true;
  }
  function heading(title,desc,action=''){return `<div class="page-heading"><div><span class="eyebrow purple">GESTIÓN OPERATIVA</span><h2>${title}</h2><p>${desc}</p></div><div class="heading-actions">${action}</div></div>`;}
  function simpleTable(data,cols,kind){return `<div class="table-wrap"><table><thead><tr>${cols.map(c=>`<th>${c[1]}</th>`).join('')}<th>Acciones</th></tr></thead><tbody>${data.length?data.map(x=>`<tr>${cols.map(c=>`<td>${c[0]==='active'?`<span class="badge ${x.active?'green':'orange'}">${x.active?'Activo':'Inactivo'}</span>`:`${esc(x[c[0]]||'—')}`}</td>`).join('')}<td>${canWrite()?`<button class="btn ghost" data-action="edit-${kind}" data-id="${x.id}">Editar</button>`:'—'}</td></tr>`).join(''):`<tr><td colspan="${cols.length+1}" class="table-empty">No hay registros para mostrar.</td></tr>`}</tbody></table></div>`;}
  function techTable(data,zones){return `<div class="table-wrap"><table><thead><tr><th>Técnico</th><th>Documento</th><th>Zona habitual</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>${data.length?data.map(x=>`<tr><td><strong>${esc(x.name)}</strong></td><td>${esc(x.document_number||'—')}</td><td>${esc(zones.find(z=>z.id===x.home_zone_id)?.name||'Sin asignar')}</td><td><span class="badge ${x.active?'green':'orange'}">${x.active?'Activo':'Inactivo'}</span></td><td>${canWrite()?`<button class="btn ghost" data-action="edit-tech" data-id="${x.id}">Editar</button>`:'—'}</td></tr>`).join(''):`<tr><td colspan="5" class="table-empty">No hay técnicos registrados.</td></tr>`}</tbody></table></div>`;}
  function serviceTable(data){return `<div class="table-wrap"><table><thead><tr><th>Servicio</th><th>Minutos estándar</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>${data.length?data.map(x=>`<tr><td><strong>${esc(x.name)}</strong><br><span class="muted">${esc(x.code||'')}</span></td><td>${num(x.standard_minutes)} min</td><td><span class="badge ${x.active?'green':'orange'}">${x.active?'Activo':'Inactivo'}</span></td><td>${canWrite()?`<button class="btn ghost" data-action="edit-service" data-id="${x.id}">Editar</button>`:'—'}</td></tr>`).join(''):`<tr><td colspan="4" class="table-empty">No hay servicios. Ejecuta la carga inicial de estándares del SQL.</td></tr>`}</tbody></table></div>`;}
  function ordersTable(data,techs,zones,services,crews=[]){return `<div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Cuadrilla / técnico</th><th>Zona ejecutada</th><th>Servicio</th><th>Cantidad</th><th>Estándar aplicado</th><th>Tiempo real</th><th>Adicional</th><th>Observaciones</th></tr></thead><tbody>${data.length?data.map(x=>{const quantity=Math.max(1,Number(x.quantity||1)),tb=timeBreakdown(Number(x.standard_minutes_snapshot||0)*quantity,x.actual_minutes),crew=crews.find(c=>c.id===x.crew_id);return `<tr><td>${fmtDate(x.service_date)}</td><td>${esc(crew?.name||techs.find(t=>t.id===x.technician_id)?.name||'—')}</td><td>${esc(zones.find(z=>z.id===x.zone_id)?.name||'—')}</td><td>${esc(services.find(s=>s.id===x.service_type_id)?.name||'—')}</td><td>${num(quantity)}</td><td>${num(tb.standard)} min</td><td>${num(tb.real)} min${tb.hasReal?'':' <span class="muted">(estándar)</span>'}</td><td><strong class="${tb.extra?'text-warning':'text-success'}">${num(tb.extra)} min</strong></td><td class="order-observations">${esc(x.notes||'—')}</td></tr>`}).join(''):`<tr><td colspan="9" class="table-empty">No hay órdenes que coincidan con los filtros.</td></tr>`}</tbody></table></div>`;}
  async function downloadReportPdf(){
    if(!window.html2pdf){notify('No se pudo cargar el generador PDF. Verifica la conexión a Internet e inténtalo de nuevo.',true);return}
    const valid=await applyReport();if(!valid)return;
    const report=state.data.currentReport;if(!report){notify('No se pudo preparar el informe.',true);return}
    const button=$('#downloadReportPdf');if(button){button.disabled=true;button.textContent='Generando PDF…'}
    try{
      const filename=`informe-gestion-tecnica-${report.from||'inicio'}-${report.to||'hoy'}.pdf`;
      await window.html2pdf().set({margin:[8,8,10,8],filename,image:{type:'jpeg',quality:0.98},html2canvas:{scale:2,useCORS:true,backgroundColor:'#ffffff',logging:false},jsPDF:{unit:'mm',format:'a4',orientation:'landscape'},pagebreak:{mode:['css','legacy'],before:['.report-detail'],avoid:['.report-box','.report-chart','tr']}}).from($('#reportPreview')).save();
      notify('Informe PDF descargado correctamente.');
    }catch(error){notify('No se pudo descargar el PDF: '+(error.message||'error inesperado'),true)}
    finally{if(button){button.disabled=false;button.textContent='Generar y descargar PDF'}}
  }
  function printReport(){const preview=$('#reportPreview');if(!preview||!state.data.currentReport){notify('Primero genera la vista previa del informe.',true);return}const w=window.open('','_blank');if(!w){notify('El navegador bloqueó la ventana. Permite ventanas emergentes para descargar el PDF.',true);return}w.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Informe Gestión Técnica</title><style>body{font:12px Arial,sans-serif;color:#242036;padding:20px}h2,h3{margin:4px 0 10px}.muted,.metric-caption{color:#666}.report-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:15px 0}.report-box,.report-chart{border:1px solid #ddd;border-radius:8px;padding:10px;break-inside:avoid}.report-box strong{display:block;font-size:20px;margin:8px 0}.report-chart-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.bar-label{display:flex;justify-content:space-between;gap:8px;font-size:10px}.bar-track{height:8px;background:#eee;margin:5px 0 10px}.bar-track span{display:block;height:100%;background:#7c3aed}.status-chart-wrap{display:flex;gap:16px;align-items:center}.report-donut-svg{width:155px;height:155px;flex:0 0 155px}.status-legend>div{display:grid;grid-template-columns:10px minmax(50px,1fr) auto;gap:6px;align-items:center;margin:5px 0}.status-legend i{width:8px;height:8px;border-radius:50%}table{width:100%;border-collapse:collapse;font-size:9px}th,td{text-align:left;padding:6px;border-bottom:1px solid #ddd}th{background:#f3f0f9}.report-actions,.report-filters{display:none}.report-detail{margin-top:15px;break-before:page}.report-chart-grid{grid-template-columns:1fr 1fr;align-items:stretch}.report-chart{min-width:0;overflow:visible;break-inside:avoid}.status-chart-wrap{display:grid;grid-template-columns:110px minmax(0,1fr);gap:6px}.report-donut-svg{width:110px;height:110px;flex:0 0 110px}.status-legend{min-width:0}.status-legend>div{grid-template-columns:8px minmax(0,1fr) auto;gap:4px}.status-legend span{overflow-wrap:anywhere;white-space:normal}.bar-label span{overflow-wrap:anywhere}.report-preview table{table-layout:fixed;white-space:normal}.report-preview th,.report-preview td{white-space:normal;overflow-wrap:anywhere;vertical-align:top}.report-observations{max-width:none;white-space:normal}@page{size:A4 landscape;margin:12mm}</style></head><body>${preview.innerHTML}<script>window.onload=()=>{setTimeout(()=>window.print(),350)};<\/script></body></html>`);w.document.close()}
  async function downloadReportXlsx(){
    const r=state.data.currentReport;if(!r){notify('Primero genera la vista previa del informe.',true);return}
    if(!window.ExcelJS){notify('No se pudo cargar el módulo Excel. Revisa tu conexión e inténtalo otra vez.',true);return}
    try{
      const {records,metrics,byTech,byZone,byService,from,to,periodLabel}=r;const wb=new ExcelJS.Workbook();wb.creator='Gestión Técnica';wb.subject='Informe de métricas operativas';wb.title='Informe Gestión Técnica';
      const header=ws=>{ws.views=[{state:'frozen',ySplit:1}];ws.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};ws.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF6D28D9'}};ws.getRow(1).alignment={vertical:'middle'};ws.autoFilter={from:'A1',to:ws.getRow(1).getCell(ws.getRow(1).cellCount).address};};
      const staffing=wb.addWorksheet('Personal por cuadrilla');staffing.addRow(['Cuadrilla del día','Rol','Persona','Días trabajados','Días con novedad','Detalle de novedades','Minutos efectivos','Horas efectivas']);(r.staffSummary||[]).forEach(x=>staffing.addRow([x.cuadrilla,x.role==='jefe'?'Jefe':x.role==='auxiliar'?'Auxiliar':'Otro',x.persona,x.days,x.absence_days,x.novedades,x.worked_minutes,Number((x.worked_minutes/60).toFixed(2))]));staffing.columns=[{width:26},{width:16},{width:30},{width:18},{width:18},{width:32},{width:20},{width:18}];header(staffing);const detail=wb.addWorksheet('Detalle completo');detail.addRow(['Fecha','Técnico responsable','Cuadrilla','Zona','Servicio','Cantidad','Minutos estándar aplicados','Minutos reales (estándar + adicional)','Minutos adicionales','Observaciones']);records.forEach(x=>detail.addRow([x.fecha,x.tecnico,x.cuadrilla,x.zona,x.servicio,x.cantidad,Number(x.minutos_estandar),Number(x.minutos_reales_calculo),Number(x.minutos_adicionales),x.observaciones||'']));detail.columns=[{width:14},{width:26},{width:24},{width:22},{width:32},{width:12},{width:22},{width:20},{width:22},{width:42}];header(detail);detail.autoFilter={from:'A1',to:'J1'};
      const metricsWs=wb.addWorksheet('Resumen');metricsWs.columns=[{header:'Métrica',key:'metric',width:38},{header:'Valor',key:'value',width:24},{header:'Notas',key:'note',width:55}];metricsWs.addRows([['Tipo de informe',periodLabel,''],['Período inicial',from||'Sin límite',''],['Período final',to||'Sin límite',''],['Servicios realizados',metrics.total,'Suma de las cantidades registradas'],['Minutos estándar aplicados',metrics.minutes,'Parte del tiempo trabajado que cabe en el estándar de cada orden'],['Horas estándar aplicadas',Number(metrics.hours.toFixed(2)),'Minutos estándar aplicados divididos por 60'],['Tiempo real trabajado (min)',metrics.actualMinutes||0,'Estándar aplicado + adicional. Si una orden no tiene tiempo real se usa su estándar ('+(metrics.withoutReal||0)+' registro(s))'],['Minutos adicionales',metrics.extraMinutes||0,'Tiempo real que superó el estándar'],['Minutos disponibles para servicios',metrics.availableMinutes||0,'470 por día laboral (L-V), 235 sábados, 0 domingos/festivos, menos otras actividades'],['Rendimiento (%)',Number((metrics.effectiveness||0).toFixed(2)),'Tiempo real / minutos disponibles de las cuadrillas o técnicos incluidos en los filtros']]);header(metricsWs);
      const addGroupSheet=(name,label,items)=>{const ws=wb.addWorksheet(name);ws.addRow([label,'Cantidad de servicios','Porcentaje (%)','Representación']);items.forEach(x=>ws.addRow([x.name,x.count,Number(x.percent.toFixed(2)),'█'.repeat(Math.max(1,Math.round(x.percent/5)))]));ws.columns=[{width:34},{width:22},{width:18},{width:30}];header(ws);ws.getColumn(3).numFmt='0.00';return ws};
      addGroupSheet('Por técnico','Técnico',byTech);addGroupSheet('Por zona','Zona',byZone);addGroupSheet('Por servicio','Servicio',byService);
      const makeChart=(title,items,mode='bar')=>{const canvas=document.createElement('canvas');canvas.width=900;canvas.height=460;const c=canvas.getContext('2d');c.fillStyle='#ffffff';c.fillRect(0,0,900,460);c.fillStyle='#242036';c.font='bold 25px Arial';c.fillText(title,28,38);if(!items.length){c.font='18px Arial';c.fillText('Sin datos para graficar',28,90);return canvas.toDataURL('image/png')};const colors=REPORT_COLORS;if(mode==='donut'){const totalAll=items.reduce((a,x)=>a+x.count,0)||1;const top=items.length>8?[...items.slice(0,7),{name:'Otros',count:items.slice(7).reduce((a,x)=>a+x.count,0),percent:items.slice(7).reduce((a,x)=>a+x.count,0)/totalAll*100}]:items;const total=top.reduce((a,x)=>a+x.count,0)||1;let angle=-Math.PI/2;top.forEach((it,i)=>{const next=angle+it.count/total*Math.PI*2;c.beginPath();c.moveTo(210,245);c.arc(210,245,150,angle,next);c.closePath();c.fillStyle=colors[i%colors.length];c.fill();angle=next});c.beginPath();c.arc(210,245,82,0,Math.PI*2);c.fillStyle='#fff';c.fill();c.fillStyle='#242036';c.font='bold 27px Arial';c.textAlign='center';c.fillText(String(total),210,240);c.font='16px Arial';c.fillText('servicios',210,266);c.textAlign='left';top.forEach((it,i)=>{const y=100+i*40;c.fillStyle=colors[i%colors.length];c.fillRect(430,y-15,17,17);c.fillStyle='#242036';c.font='16px Arial';c.fillText(`${String(it.name).slice(0,30)}: ${it.count} (${it.percent.toFixed(1)}%)`,458,y)})}else{const top=items.slice(0,8),max=Math.max(1,...top.map(x=>x.count));top.forEach((it,i)=>{const y=88+i*43;c.fillStyle='#f1edf9';c.fillRect(300,y,470,23);c.fillStyle=colors[i%colors.length];c.fillRect(300,y,470*it.count/max,23);c.fillStyle='#242036';c.font='15px Arial';c.fillText(String(it.name).slice(0,27),28,y+17);c.textAlign='right';c.fillText(`${it.count} · ${it.percent.toFixed(1)}%`,870,y+17);c.textAlign='left'})}return canvas.toDataURL('image/png')};
      let row=metricsWs.rowCount+2;for(const [title,data] of [['Distribución por servicio',makeChart('Distribución por servicio',byService,'donut')],['Distribución por zona',makeChart('Distribución por zona',byZone,'donut')],['Servicios por técnico',makeChart('Servicios por técnico',byTech)],['Servicios por tipo',makeChart('Servicios por tipo',byService)]]){metricsWs.getCell(row,1).value=`Gráfico: ${title}`;metricsWs.getCell(row,1).font={bold:true,size:14,color:{argb:'FF6D28D9'}};const imageId=wb.addImage({base64:data,extension:'png'});metricsWs.addImage(imageId,{tl:{col:0,row:row},br:{col:7,row:row+13}});row+=15}
      const buffer=await wb.xlsx.writeBuffer();const blob=new Blob([buffer],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`informe-gestion-tecnica-${from||'inicio'}-${to||'hoy'}.xlsx`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);notify('Excel descargado: el detalle completo está en la primera hoja y los gráficos en Resumen.');
    }catch(e){notify('No se pudo generar el Excel: '+(e.message||'error inesperado'),true)}
  }
  function bindCommon(){root().onclick=async e=>{const b=e.target.closest('[data-action],[data-go]');if(!b)return;if(b.dataset.go)return go(b.dataset.go);const a=b.dataset.action,id=b.dataset.id;try{if(a==='refresh')return go(state.page);if(a==='new-order')return openOrder();if(a==='new-zone')return openZone();if(a==='edit-zone')return openZone(id);if(a==='new-tech')return openTech();if(a==='edit-tech')return openTech(id);if(a==='new-service')return openService();if(a==='edit-service')return openService(id);if(a==='new-crew')return openCrew();if(a==='edit-crew')return openCrew(id);if(a==='new-activity')return openActivity();if(a==='edit-activity')return openActivity(id);if(a==='new-daily-assignment')return openDailyAssignment();if(a==='edit-daily-assignment')return openDailyAssignment(id);if(a==='export-orders')return exportCsv('ordenes.csv',(state.data.orderFiltered||state.data.orderRows||[]).map(o=>({fecha:o.service_date,tecnico:state.data.technicians?.find(t=>t.id===o.technician_id)?.name||'',zona:state.data.zones?.find(z=>z.id===o.zone_id)?.name||'',servicio:state.data.services?.find(s=>s.id===o.service_type_id)?.name||'',cantidad:o.quantity||1,observaciones:o.notes||'',cuadrilla:state.data.crews?.find(c=>c.id===o.crew_id)?.name||'Individual',...(()=>{const tb=timeBreakdown(Number(o.standard_minutes_snapshot||0)*Math.max(1,Number(o.quantity||1)),o.actual_minutes);return {minutos_estandar_aplicado:tb.standard,minutos_reales:tb.real,minutos_adicionales:tb.extra,tiempo_real_registrado:tb.hasReal?'si':'no (se uso el estandar)'}})(),estado:o.status||''}))); if(a==='export-report')return downloadReportXlsx();}catch(err){notify(err.message||'No se pudo completar la acción',true)}};}
  function modal(title,desc,body,submitLabel='Guardar'){const r=$('#modalRoot');r.innerHTML=`<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true"><div class="modal-header"><div><h3>${title}</h3><p>${desc}</p></div><button class="icon-btn" type="button" data-close>×</button></div><form id="modalForm"><div class="modal-body">${body}</div><div class="modal-footer"><button class="btn ghost" type="button" data-close>Cancelar</button><button class="btn primary" type="submit">${submitLabel}</button></div></form></section></div>`;$$('[data-close]',r).forEach(b=>b.onclick=()=>r.innerHTML='');$('.modal-backdrop',r).onclick=e=>{if(e.target.classList.contains('modal-backdrop'))r.innerHTML=''};const form=$('#modalForm',r);
    // Todos los formularios asignan form.__submit: aquí se capturan los errores (antes quedaban en silencio) y se evita el doble envío.
    form.addEventListener('submit',async e=>{e.preventDefault();const handler=form.__submit;if(typeof handler!=='function')return;const btn=form.querySelector('button[type=submit]');if(btn)btn.disabled=true;try{await handler(e)}catch(err){console.error(err);notify('No se pudo guardar: '+friendlyError(err),true)}finally{if(btn&&document.body.contains(btn))btn.disabled=false}});
    return form;}
  async function openZone(id){if(!canWrite())return;let x={name:'',description:'',active:true};if(id){const r=await rows('zones',{eq:{id},limit:1});x=r.data[0]||x}const f=modal(id?'Editar zona':'Nueva zona','Las zonas reales de ejecución se registran en cada orden.',`<div class="form-grid"><label>Nombre de la zona<input name="name" required maxlength="100" value="${esc(x.name)}"></label><label>Estado<select name="active"><option value="true" ${x.active?'selected':''}>Activa</option><option value="false" ${!x.active?'selected':''}>Inactiva</option></select></label><label class="wide">Descripción<textarea name="description" rows="3">${esc(x.description||'')}</textarea></label></div>`);f.__submit=async e=>{e.preventDefault();const v=Object.fromEntries(new FormData(f));v.active=v.active==='true';const q=id?state.client.from('zones').update(v).eq('id',id):state.client.from('zones').insert(v);const {error}=await q;if(error)throw error;$('#modalRoot').innerHTML='';notify('Zona guardada correctamente');await go('zones')};}
  async function openTech(id){if(!canWrite())return;const zones=state.data.zones|| (await rows('zones',{order:'name',ascending:true,limit:500})).data;let x={name:'',document_number:'',phone:'',home_zone_id:'',active:true};if(id){const r=await rows('technicians',{eq:{id},limit:1});x=r.data[0]||x}const f=modal(id?'Editar técnico':'Nuevo técnico','La zona habitual puede cambiar; las órdenes conservan la zona real donde se ejecutaron.',`<div class="form-grid"><label>Nombre completo<input name="name" required maxlength="140" value="${esc(x.name)}"></label><label>Documento<input name="document_number" value="${esc(x.document_number||'')}"></label><label>Teléfono<input name="phone" value="${esc(x.phone||'')}"></label><label>Zona habitual<select name="home_zone_id"><option value="">Sin asignar</option>${zones.filter(z=>z.active).map(z=>`<option value="${z.id}" ${x.home_zone_id===z.id?'selected':''}>${esc(z.name)}</option>`).join('')}</select></label><label class="wide">Estado<select name="active"><option value="true" ${x.active?'selected':''}>Activo</option><option value="false" ${!x.active?'selected':''}>Inactivo</option></select></label></div>`);f.__submit=async e=>{e.preventDefault();const v=Object.fromEntries(new FormData(f));v.active=v.active==='true';v.home_zone_id=v.home_zone_id||null;const q=id?state.client.from('technicians').update(v).eq('id',id):state.client.from('technicians').insert(v);const {error}=await q;if(error)throw error;$('#modalRoot').innerHTML='';notify('Técnico guardado correctamente');await go('technicians')};}
  async function openService(id){if(!canWrite())return;let x={name:'',code:'',standard_minutes:0,active:true};if(id){const r=await rows('service_types',{eq:{id},limit:1});x=r.data[0]||x}const f=modal(id?'Editar servicio':'Nuevo servicio','El tiempo estándar es configurable; valida su vigencia con el responsable operativo.',`<div class="form-grid"><label class="wide">Nombre del servicio<input name="name" required maxlength="160" value="${esc(x.name)}"></label><label>Código<input name="code" value="${esc(x.code||'')}"></label><label>Minutos estándar<input name="standard_minutes" type="number" min="0" max="1440" step="1" required value="${Number(x.standard_minutes)}"></label><label class="wide">Estado<select name="active"><option value="true" ${x.active?'selected':''}>Activo</option><option value="false" ${!x.active?'selected':''}>Inactivo</option></select></label></div>`);f.__submit=async e=>{e.preventDefault();const v=Object.fromEntries(new FormData(f));v.active=v.active==='true';v.standard_minutes=Number(v.standard_minutes);const q=id?state.client.from('service_types').update(v).eq('id',id):state.client.from('service_types').insert(v);const {error}=await q;if(error)throw error;$('#modalRoot').innerHTML='';notify('Servicio guardado correctamente');await go('services')};}
  async function openCrew(id){
    if(!canWrite())return;
    const [zonesResult,techResult,membersResult]=await Promise.all([
      rows('zones',{select:'id,name,active',order:'name',ascending:true,limit:500}),
      rows('technicians',{select:'id,name,active',order:'name',ascending:true,limit:1000}),
      id?rows('crew_members',{eq:{crew_id:id},limit:500}):Promise.resolve({data:[]})
    ]);
    let x={name:'',zone_id:'',active:true};
    if(id){const result=await rows('crews',{eq:{id},limit:1});x=result.data[0]||x}
    const currentMembers=membersResult.data.filter(m=>m.crew_id===id);
    const leader=currentMembers.find(m=>m.role==='jefe')?.technician_id||'';
    const assistants=currentMembers.filter(m=>m.role==='auxiliar').map(m=>m.technician_id);
    const activeZones=zonesResult.data.filter(z=>z.active),zones=activeZones.length?activeZones:zonesResult.data;
    const memberIds=new Set(currentMembers.map(m=>m.technician_id)),activeTechs=techResult.data.filter(t=>t.active||memberIds.has(t.id)),techs=activeTechs.length?activeTechs:techResult.data;
    const techOptions=selected=>`<option value="">Selecciona técnico</option>${techs.map(t=>`<option value="${t.id}" ${selected===t.id?'selected':''}>${esc(t.name)}${t.active===false?' (inactivo)':''}</option>`).join('')}`;const assistantOptions=selected=>techs.map(t=>`<option value="${t.id}" ${selected.includes(t.id)?'selected':''}>${esc(t.name)}${t.active===false?' (inactivo)':''}</option>`).join('');
    const f=modal(id?'Editar cuadrilla':'Nueva cuadrilla','Asigna un jefe obligatorio y uno o varios auxiliares habituales. Los cambios temporales se registran en Personal diario.',`<div class="form-grid"><label>Nombre de la cuadrilla<input name="name" required maxlength="120" value="${esc(x.name)}"></label><label>Zona habitual<select name="zone_id"><option value="">Sin zona asignada</option>${zones.map(z=>`<option value="${z.id}" ${x.zone_id===z.id?'selected':''}>${esc(z.name)}</option>`).join('')}</select></label><label>Jefe de cuadrilla<select name="leader_id" required>${techOptions(leader)}</select></label><label class="wide">Auxiliares habituales (opcional)<select name="assistant_ids" id="crewAssistantIds" multiple size="5">${assistantOptions(assistants)}</select><small>Puedes seleccionar varios auxiliares con Ctrl (Windows) o Cmd (Mac). La asignación efectiva por fecha se administra en Personal diario.</small></label><label class="wide">Estado<select name="active"><option value="true" ${x.active?'selected':''}>Activa</option><option value="false" ${!x.active?'selected':''}>Inactiva</option></select></label></div>`);
    f.__submit=async e=>{
      e.preventDefault();const v=Object.fromEntries(new FormData(f));
      const assistantIds=[...$('#crewAssistantIds',f).selectedOptions].map(o=>o.value);if(assistantIds.includes(v.leader_id)){notify('El jefe no puede figurar también como auxiliar.',true);return}
      const payload={name:v.name.trim(),zone_id:v.zone_id||null,active:v.active==='true'};
      let crewId=id;
      if(id){const {error}=await state.client.from('crews').update(payload).eq('id',id);if(error)throw error}
      else{const {data,error}=await state.client.from('crews').insert({...payload,created_by:state.user?.id||null}).select('id').single();if(error)throw error;crewId=data.id}
      const desired=[{technician_id:v.leader_id,role:'jefe'},...assistantIds.map(technician_id=>({technician_id,role:'auxiliar'}))];
      const existing=membersResult.data.filter(m=>m.crew_id===crewId),kept=new Set();
      try{
        for(const d of desired){
          const old=existing.find(m=>m.technician_id===d.technician_id&&!kept.has(m.id));
          if(old){kept.add(old.id);if(old.role!==d.role){const {error}=await state.client.from('crew_members').update({role:d.role}).eq('id',old.id);if(error)throw error}}
          else{const {error}=await state.client.from('crew_members').insert({crew_id:crewId,...d});if(error)throw error}
        }
        for(const old of existing){if(!kept.has(old.id)){const {error}=await state.client.from('crew_members').delete().eq('id',old.id);if(error)throw error}}
      }catch(err){if(!id){await state.client.from('crew_members').delete().eq('crew_id',crewId);await state.client.from('crews').delete().eq('id',crewId)}throw err}
      $('#modalRoot').innerHTML='';notify(id?'Cuadrilla actualizada correctamente':'Cuadrilla creada correctamente');await go('crews');
    };
  }
  async function openActivity(id){
    if(!canWrite())return;
    const [crewsResult,activityResult]=await Promise.all([
      rows('crews',{order:'name',ascending:true,limit:500}),
      id?rows('other_activities',{eq:{id},limit:1}):Promise.resolve({data:[]})
    ]);
    const x=activityResult.data[0]||{work_date:dateToday(),crew_id:'',activity_type:'',start_time:'08:00',end_time:'09:00',minutes:60,notes:''};
    const f=modal(id?'Editar actividad':'Registrar otra actividad','Estas actividades cuentan como tiempo de empresa y se descuentan del tiempo disponible para servicios.',`<div class="form-grid"><label>Fecha<input name="work_date" type="date" required value="${esc(x.work_date||dateToday())}"></label><label>Aplica a<select name="crew_id"><option value="">Toda la empresa / todas las cuadrillas</option>${crewsResult.data.map(c=>`<option value="${c.id}" ${x.crew_id===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select></label><label class="wide">Tipo de actividad<input name="activity_type" required maxlength="120" placeholder="Reunión, capacitación, trámite…" value="${esc(x.activity_type||'')}"></label><label>Hora de inicio<input name="start_time" id="activityStart" type="time" required value="${esc(String(x.start_time||'08:00').slice(0,5))}"></label><label>Hora de finalización<input name="end_time" id="activityEnd" type="time" required value="${esc(String(x.end_time||'09:00').slice(0,5))}"></label><div class="wide"><p id="activityDuration" class="muted" style="margin:0">Duración calculada: ${num(x.minutes||60)} minutos</p><input id="activityMinutes" name="minutes" type="hidden" value="${Number(x.minutes||60)}"></div><label class="wide">Observaciones<textarea name="notes" rows="3" maxlength="1500">${esc(x.notes||'')}</textarea></label></div>`);
    const updateDuration=()=>{const start=$('#activityStart',f).value,end=$('#activityEnd',f).value;let minutes=0;if(start&&end){const [sh,sm]=start.split(':').map(Number),[eh,em]=end.split(':').map(Number);minutes=(eh*60+em)-(sh*60+sm);if(minutes<0)minutes=0}$('#activityMinutes',f).value=String(minutes);$('#activityDuration',f).textContent=minutes>0?`Duración calculada: ${num(minutes)} minutos`:'La hora de finalización debe ser posterior a la hora de inicio.'};
    $('#activityStart',f).addEventListener('change',updateDuration);$('#activityEnd',f).addEventListener('change',updateDuration);updateDuration();
    f.__submit=async e=>{e.preventDefault();if(!f.reportValidity())return;const v=Object.fromEntries(new FormData(f));v.crew_id=v.crew_id||null;v.activity_type=v.activity_type.trim();v.minutes=Number(v.minutes);if(!v.minutes||v.minutes>1440){notify('Revisa el horario: la duración debe ser mayor que cero y máximo 24 horas.',true);return}if(v.end_time<=v.start_time){notify('La hora de finalización debe ser posterior a la hora de inicio.',true);return}let query;if(id)query=state.client.from('other_activities').update(v).eq('id',id);else query=state.client.from('other_activities').insert({...v,created_by:state.user?.id||null});const {error}=await query;if(error)throw error;$('#modalRoot').innerHTML='';notify(id?'Actividad actualizada correctamente':'Actividad registrada correctamente');await go('activities')};
  }
  async function openOrder(){
    if(!canWrite())return;
    // Intentar usar primero registros activos, pero no dejar el formulario vacío si
    // los datos existentes no tienen active=true (por ejemplo, datos antiguos).
    const [allTechs,allZones,allServices,allCrews,allMembers]=await Promise.all([
      rows('technicians',{order:'name',ascending:true,limit:1000}),
      rows('zones',{order:'name',ascending:true,limit:500}),
      rows('service_types',{order:'name',ascending:true,limit:1000}),
      rows('crews',{eq:{active:true},order:'name',ascending:true,limit:500}),
      rows('crew_members',{limit:2000})
    ]);
    const techRows=allTechs.data.filter(x=>x.active), zoneRows=allZones.data.filter(x=>x.active), serviceRows=allServices.data.filter(x=>x.active);
    const techs=techRows.length?techRows:allTechs.data;
    const zones=zoneRows.length?zoneRows:allZones.data;
    const services=serviceRows.length?serviceRows:allServices.data;
    state.data={...state.data,technicians:techs,zones,services,crews:allCrews.data,crewMembers:allMembers.data};
    const optionEmpty=(label)=>`<option value="">${label}</option>`;
    const noTech=!techs.length, noZone=!zones.length, noService=!services.length;
    const warning=(noTech||noZone||noService)?`<div class="toast error" role="alert">${[
      noTech?'No hay técnicos registrados. Crea un técnico antes de registrar órdenes.':'',
      noZone?'No hay zonas registradas. Crea una zona antes de registrar órdenes.':'',
      noService?'No hay servicios registrados. Crea un servicio antes de registrar órdenes.':''
    ].filter(Boolean).join('<br>')}</div>`:'';
    const f=modal('Registrar orden de servicio','Registra una sola vez el servicio y la cantidad realizada. Para Revisión externa se propone cantidad 5, que puedes cambiar.',`${warning}<div class="form-grid"><label>Fecha del servicio<input name="service_date" id="orderDate" type="date" required value="${dateToday()}"></label><label>Cantidad realizada<input name="quantity" id="orderQuantity" type="number" min="1" max="1000" step="1" required value="1"></label><label class="wide">Cuadrilla (opcional)<select name="crew_id" id="orderCrew"><option value="">Trabajo individual / sin cuadrilla</option>${allCrews.data.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label><label>Técnico responsable<select name="technician_id" id="orderTech" required ${noTech?'disabled':''}>${optionEmpty(noTech?'No hay técnicos disponibles':'Selecciona técnico')}${techs.map(t=>`<option value="${t.id}">${esc(t.name)}${t.active===false?' (inactivo)':''}</option>`).join('')}</select></label><label>Zona real de ejecución<select name="zone_id" required ${noZone?'disabled':''}>${optionEmpty(noZone?'No hay zonas disponibles':'Selecciona zona')}${zones.map(z=>`<option value="${z.id}">${esc(z.name)}${z.active===false?' (inactiva)':''}</option>`).join('')}</select></label><label class="wide">Servicio realizado<select name="service_type_id" required ${noService?'disabled':''}>${optionEmpty(noService?'No hay servicios disponibles':'Selecciona servicio')}${services.map(s=>`<option value="${s.id}">${esc(s.name)} · ${num(s.standard_minutes)} min/unidad${s.active===false?' (inactivo)':''}</option>`).join('')}</select></label><label>Tiempo real (opcional; solo si hubo imprevisto)<input name="actual_minutes" id="actualMinutes" type="number" min="0" max="1440" step="1" placeholder="Déjalo vacío si no hubo demora"></label><label class="wide">Observaciones<textarea name="notes" rows="2"></textarea></label></div>`);
    $('#orderCrew',f).addEventListener('change',()=>{const crewId=$('#orderCrew',f).value;if(!crewId)return;const leader=allMembers.data.find(m=>m.crew_id===crewId&&m.role==='jefe');const crew=allCrews.data.find(c=>c.id===crewId);if(crew?.zone_id)$('select[name="zone_id"]',f).value=crew.zone_id;if(leader){$('#orderTech',f).value=leader.technician_id}});const serviceSelect=$('select[name="service_type_id"]',f);serviceSelect.addEventListener('change',()=>{const selected=services.find(x=>x.id===serviceSelect.value),name=(selected?.name||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();if(name.includes('revision externa')&&Number($('#orderQuantity',f).value)===1)$('#orderQuantity',f).value='5';$('#actualMinutes',f).placeholder=name==='otros'?'Otros: escribe manualmente el tiempo real total':selected&&Number(selected.standard_minutes)>0?`Estándar: ${selected.standard_minutes} min por unidad; ingresa el tiempo real total`:'Ingresa el tiempo real total'});
    f.__submit=async e=>{e.preventDefault();if(!f.reportValidity())return;const submitButton=f.querySelector('button[type=submit]');if(submitButton){submitButton.disabled=true;submitButton.dataset.originalText=submitButton.textContent;submitButton.textContent='Guardando…'}try{const v=Object.fromEntries(new FormData(f));v.crew_id=v.crew_id||null;v.quantity=Math.max(1,Number(v.quantity||1));v.status='completada';v.actual_minutes=String(v.actual_minutes??'').trim()===''?null:Number(v.actual_minutes);v.client_name='';v.order_code=null;v.created_by=state.user?.id||null;const {error}=await state.client.from('work_orders').insert(v);if(error)throw error;$('#modalRoot').innerHTML='';notify('Orden registrada correctamente');await go('orders')}catch(error){console.error('Error al guardar la orden:',error);let message=error?.message||'Error desconocido al guardar la orden.';if(/quantity|column/i.test(message))message+=' Ejecuta en Supabase el archivo supabase/migration_cantidad_otros_rendimiento.sql.';else if(/row-level security|permission|not allowed|42501/i.test(message))message+=' Verifica que el usuario tenga perfil activo con rol Administrador o Registrador y permisos de escritura en work_orders.';notify('No se pudo guardar la orden: '+message,true)}finally{if(submitButton&&document.body.contains(submitButton)){submitButton.disabled=false;submitButton.textContent=submitButton.dataset.originalText||'Guardar'}}};
  }
  function getReportRows(){const from=$('#reportFrom')?.value,to=$('#reportTo')?.value,techSelect=$('#reportTech'),crewSelect=$('#reportCrew'),zoneSelect=$('#reportZone');const techs=techSelect?[...techSelect.selectedOptions].map(o=>o.value):[],crews=crewSelect?[...crewSelect.selectedOptions].map(o=>o.value):[],zones=zoneSelect?[...zoneSelect.selectedOptions].map(o=>o.value):[];return attributeCrews(state.data.reportOrders||[],{assignments:state.data.dailyAssignments||[],crewMembers:state.data.crewMembers||[],crews:state.data.crews||[]}).filter(x=>String(x.status||'completada').toLowerCase()==='completada'&&(!from||x.service_date>=from)&&(!to||x.service_date<=to)&&(!techs.length||techs.includes(x.technician_id)||(x.crew_id&&(state.data.crewMembers||[]).some(m=>m.crew_id===x.crew_id&&techs.includes(m.technician_id))))&&(!crews.length||crews.includes(x.crew_id))&&(!zones.length||zones.includes(x.zone_id))).map(o=>{const quantity=Math.max(1,Number(o.quantity||1)),standardEach=Number(o.standard_minutes_snapshot||0),actual=o.actual_minutes==null?null:Number(o.actual_minutes),tb=timeBreakdown(standardEach*quantity,actual);return {crew_id:o.crew_id||null,technician_id:o.technician_id,fecha:o.service_date||'',orden:o.order_code||'',cliente:o.client_name||'',tecnico:state.data.technicians.find(t=>t.id===o.technician_id)?.name||'Sin técnico',cuadrilla:state.data.crews?.find(c=>c.id===o.crew_id)?.name||'Individual',cuadrilla_inferida:!!o.crew_inferred,zona:state.data.zones.find(z=>z.id===o.zone_id)?.name||'Sin zona',servicio:state.data.services.find(s=>s.id===o.service_type_id)?.name||'Servicio',cantidad:quantity,minutos_estandar:tb.standard,minutos_estandar_servicio:standardEach*quantity,minutos_reales:actual,minutos_reales_calculo:tb.real,minutos_adicionales:tb.extra,observaciones:o.notes||'',estado:o.status||'Sin estado'};});}
  function exportCsv(filename,records){if(!records?.length){notify('No hay datos para exportar.',true);return}const keys=Object.keys(records[0]),csv=[keys.join(';'),...records.map(r=>keys.map(k=>{let v=String(r[k]??'');if(/^[=+\-@\t\r]/.test(v))v="'"+v;return `"${v.replace(/"/g,'""')}"`}).join(';'))].join('\r\n');const blob=new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8;'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;a.click();URL.revokeObjectURL(url);}
  document.addEventListener('DOMContentLoaded',init);
})();
