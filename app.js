import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const $ = id => document.getElementById(id);
const VIEW_LABELS = {
  pos: 'شاشة البيع',
  shift: 'الوردية',
  products: 'المنتجات',
  inventory: 'المخزون',
  purchases: 'المشتريات',
  employees: 'الموظفين',
  reports: 'التقارير',
  accounts: 'الحسابات',
  settings: 'الإعدادات'
};
const EVENT_LABELS = {
  login: 'سجّل الدخول',
  logout: 'خرج من البرنامج',
  heartbeat: 'يعمل على الجهاز',
  view_opened: 'فتح شاشة',
  cart_updated: 'يعدّل السلة',
  shift_opened: 'فتح وردية',
  sale_completed: 'أتم بيعاً',
  sale_voided: 'ألغى فاتورة',
  cash_movement: 'حرّك الدرج',
  shift_closed: 'أغلق الوردية'
};

let session = JSON.parse(localStorage.getItem('managerSession') || 'null');
let selectedShift = null;
let selectedShiftId = null;
let currency = 'ج.م';
let refreshTimer = null;
let liveFeed = { cashiers: [], shifts: [], today: {} };
let cashierFilter = 'all';

function configured(){
  return SUPABASE_URL && SUPABASE_ANON_KEY
    && !SUPABASE_URL.includes('YOUR_PROJECT')
    && !SUPABASE_ANON_KEY.includes('YOUR_ANON_KEY');
}

async function request(path, options={}, retry=true){
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session?.access_token || SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(options.headers || {})
    }
  });
  if(response.status===401&&retry&&session?.refresh_token){
    await refreshSession();
    return request(path,options,false);
  }
  if(response.status===401){logout();throw new Error('انتهت الجلسة؛ سجّل الدخول مرة أخرى');}
  if(!response.ok){
    const body=await response.json().catch(()=>({}));
    throw new Error(body.message||body.error_description||body.hint||'تعذر الاتصال بالخادم');
  }
  if(response.status===204)return null;
  return response.json();
}

async function refreshSession(){
  const response=await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,{
    method:'POST',
    headers:{apikey:SUPABASE_ANON_KEY,Authorization:`Bearer ${SUPABASE_ANON_KEY}`,'Content-Type':'application/json'},
    body:JSON.stringify({refresh_token:session.refresh_token})
  });
  const body=await response.json().catch(()=>({}));
  if(!response.ok){logout();throw new Error('انتهت الجلسة؛ سجّل الدخول مرة أخرى');}
  session=body;
  localStorage.setItem('managerSession',JSON.stringify(session));
}

function escapeHtml(value){
  return String(value??'').replace(/[&<>"']/g, char=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[char]));
}
function money(value){
  return `${Number(value||0).toLocaleString('ar-EG',{maximumFractionDigits:2})} ${currency}`;
}

function formatTime(value){
  if(!value)return '—';
  return new Date(value).toLocaleString('ar-EG');
}

function ago(value){
  if(!value)return '';
  const seconds=Math.max(0,Math.round((Date.now()-new Date(value).getTime())/1000));
  if(seconds<20)return 'الآن';
  if(seconds<60)return `قبل ${seconds} ثانية`;
  const minutes=Math.round(seconds/60);
  if(minutes<60)return `قبل ${minutes} دقيقة`;
  return formatTime(value);
}

function eventLabel(event){
  const base=EVENT_LABELS[event?.event_type]||'نشاط مسجّل';
  const details=event?.details||{};
  if(event?.event_type==='view_opened')return `${base}: ${VIEW_LABELS[event.view_name]||event.view_name||''}`.trim();
  if(event?.event_type==='cart_updated')return `${base} (${Number(details.itemCount||0)} أصناف)`;
  if(event?.event_type==='sale_completed')return `${base} #${details.invoiceNo||''} — ${money(details.total)}`.trim();
  if(event?.event_type==='sale_voided')return `${base} #${details.invoiceNo||''}`;
  if(event?.event_type==='cash_movement')return `${base}: ${details.movementType==='out'?'سحب':'إيداع'} ${money(details.amount)}`;
  if(event?.event_type==='heartbeat' && event.view_name)return `${base} — ${VIEW_LABELS[event.view_name]||event.view_name}`;
  return base;
}

function currentAction(cashier){
  if(!cashier)return 'لا يوجد نشاط حديث';
  if(!cashier.online)return `آخر نشاط: ${eventLabel(cashier)}`;
  return eventLabel(cashier);
}

async function login(email,password){
  const response=await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`,{
    method:'POST',
    headers:{apikey:SUPABASE_ANON_KEY,Authorization:`Bearer ${SUPABASE_ANON_KEY}`,'Content-Type':'application/json'},
    body:JSON.stringify({email,password})
  });
  const body=await response.json().catch(()=>({}));
  if(!response.ok){
    const msg=body.error_description||body.msg||'بيانات الدخول غير صحيحة';
    if(/invalid login credentials/i.test(msg)) throw new Error('البريد أو كلمة المرور غير صحيحة. استخدم إيميل السحابة، مش رقم الكاشير.');
    throw new Error(msg);
  }
  session=body;
  localStorage.setItem('managerSession',JSON.stringify(session));
}

function logout(){
  session=null;
  localStorage.removeItem('managerSession');
  clearInterval(refreshTimer);
  $('dashboard').classList.add('hidden');
  $('loginView').classList.remove('hidden');
}

function sessionUserId(){
  return session?.user?.id || session?.user_id || '';
}

async function loadProfile(){
  const userId=sessionUserId();
  if(!userId)throw new Error('تعذر قراءة حساب الدخول. جرّبي مرة أخرى.');
  const rows=await request(`/rest/v1/profiles?select=display_name,role,shops(name,currency)&user_id=eq.${encodeURIComponent(userId)}`);
  const profile=rows[0];
  if(!profile||profile.role!=='manager')throw new Error('هذا الحساب لا يملك صلاحية المدير');
  $('shopName').textContent=profile.shops?.name||'المحل';
  currency=profile.shops?.currency||'ج.م';
}

function showDashboard(){
  $('loginView').classList.add('hidden');
  $('dashboard').classList.remove('hidden');
}

async function handleLogin(){
  const button=$('loginButton');
  const email=$('email').value.trim();
  const password=$('password').value;
  $('loginError').textContent='';
  if(!configured()){$('loginError').textContent='أضف بيانات Supabase في config.js أولاً';return;}
  if(!email||!password){$('loginError').textContent='اكتبي البريد وكلمة المرور';return;}
  if(button){button.disabled=true;button.textContent='جاري الدخول...';}
  try{
    await login(email,password);
    await loadProfile();
    showDashboard();
    await refresh();
    clearInterval(refreshTimer);
    refreshTimer=setInterval(refresh,8000);
  }catch(error){
    $('loginError').textContent=error.message||'تعذر الدخول. تأكد من الإنترنت وحاولي مرة أخرى.';
  }finally{
    if(button){button.disabled=false;button.textContent='دخول';}
  }
}

function matchingShift(cashier){
  return (liveFeed.shifts||[]).find(shift=>
    shift.source_id===cashier.shift_source_id
    || (cashier.employee_id && shift.employee_id===cashier.employee_id && shift.status==='open')
    || (shift.employee_name===cashier.employee_name && shift.status==='open')
  );
}

function filteredShifts(){
  const shifts=liveFeed.shifts||[];
  if(cashierFilter==='all')return shifts;
  return shifts.filter(shift=>
    shift.employee_id===cashierFilter
    || shift.employee_name===cashierFilter
    || shift.source_id===cashierFilter
  );
}

function renderCashierFilter(){
  const select=$('cashierFilter');
  const current=select.value||'all';
  const options=['<option value="all">كل الكاشيرات</option>'];
  (liveFeed.cashiers||[]).forEach(cashier=>{
    const value=cashier.employee_id||cashier.employee_name;
    options.push(`<option value="${value}">${cashier.employee_name}</option>`);
  });
  select.innerHTML=options.join('');
  select.value=[...select.options].some(option=>option.value===current)?current:'all';
  cashierFilter=select.value;
}

function renderCashiers(){
  const list=$('cashierList');
  list.replaceChildren();
  const cashiers=liveFeed.cashiers||[];
  if(!cashiers.length){
    const empty=document.createElement('article');
    empty.className='card muted';
    empty.textContent='لا يوجد كاشير نشط خلال الساعات الماضية. افتح برنامج الكاشير وربطه بالسحابة ليظهر هنا.';
    list.append(empty);
    return;
  }
  cashiers.forEach(cashier=>{
    if(cashierFilter!=='all' && cashier.employee_id!==cashierFilter && cashier.employee_name!==cashierFilter)return;
    const shift=matchingShift(cashier);
    const card=document.createElement('article');
    card.className=`card cashier ${cashier.online?'online':'offline'}`;
    card.innerHTML=`
      <div class="cashier-head">
        <div>
          <h3>${escapeHtml(cashier.employee_name)}</h3>
          <p>${cashier.employee_role==='manager'?'مدير':'كاشير'}</p>
        </div>
        <span class="status">${cashier.online?'متصل الآن':'غير متصل'}</span>
      </div>
      <p class="now">${escapeHtml(currentAction(cashier))}</p>
      <p>صاحب الوردية: <strong>${escapeHtml(shift?.employee_name||cashier.shift_owner||'لا توجد وردية مفتوحة')}</strong></p>
      <p>آخر نشاط: ${ago(cashier.happened_at)}</p>
      ${Number(cashier.details?.itemCount)>0?`<p>السلة الحالية: ${cashier.details.itemCount} أصناف / ${cashier.details.quantity||0} قطعة</p>`:''}
    `;
    list.append(card);
  });
}

function saleCard(sale){
  const items=(sale.items||[]).map(item=>
    `<li><span>${escapeHtml(item.name)} × ${escapeHtml(item.quantity)}</span><strong>${money(item.line_total)}</strong></li>`
  ).join('')||'<li>لا توجد أصناف محفوظة لهذه الفاتورة بعد</li>';
  return `
    <article class="sale ${sale.voided?'voided':''}">
      <div class="sale-head">
        <h4>فاتورة #${sale.invoice_no||'—'}</h4>
        <span>${sale.voided?'ملغاة':(sale.payment==='card'?'فيزا':'نقدي')}</span>
      </div>
      <p>${formatTime(sale.sold_at)} — الكاشير: ${escapeHtml(sale.employee_name||'—')}</p>
      <ul class="items">${items}</ul>
      <div class="totals">
        <span>فرعي ${money(sale.subtotal)}</span>
        <span>خصم ${money(sale.discount)}</span>
        <span>ضريبة ${money(sale.tax)}</span>
        <strong>الإجمالي ${money(sale.total)}</strong>
      </div>
      <p>المدفوع ${money(sale.paid)} — الباقي ${money(sale.change_due)}</p>
      ${sale.voided?`<p class="void">ألغاها ${escapeHtml(sale.voided_by||'—')} — ${escapeHtml(sale.void_reason||'بدون سبب')}</p>`:''}
    </article>
  `;
}

function renderShifts(){
  const list=$('shiftList');
  list.replaceChildren();
  const shifts=filteredShifts();
  if(!shifts.length){
    const empty=document.createElement('article');
    empty.className='card muted';
    empty.textContent='لا توجد ورديات للعرض';
    list.append(empty);
    return;
  }
  shifts.forEach(shift=>{
    const open=shift.status==='open';
    const sales=shift.sales||[];
    const activeSales=sales.filter(sale=>!sale.voided);
    const card=document.createElement('article');
    card.className='card shift';
    const expanded=selectedShiftId===shift.id;
    card.innerHTML=`
      <div class="shift-head">
        <div>
          <h3>${escapeHtml(shift.employee_name)}</h3>
          <p>بدأت: ${formatTime(shift.opened_at)}</p>
          <p class="expected">المتوقع في الدرج: ${money(shift.expected_cash)}</p>
          <p>${open?'وردية مفتوحة':`أُغلقت ${shift.close_mode==='remote'?'عن بُعد':'محلياً'}`}</p>
        </div>
        <div class="shift-actions">
          <span class="pill">${activeSales.length} فواتير</span>
          ${open?`<button class="danger close-shift">إغلاق</button>`:''}
          <button class="secondary toggle-details">${expanded?'إخفاء التفاصيل':'عرض كل التفاصيل'}</button>
        </div>
      </div>
      ${expanded?`
        <div class="details">
          <h4>الفواتير والأصناف</h4>
          ${sales.length?sales.map(saleCard).join(''):'<p class="muted">لا توجد فواتير في هذه الوردية</p>'}
          <h4>حركات الدرج</h4>
          ${(shift.movements||[]).length
            ?(shift.movements||[]).map(move=>`<p>${move.movement_type==='out'?'سحب':'إيداع'} ${money(move.amount)} — ${move.note||'بدون ملاحظة'} — ${formatTime(move.happened_at)}</p>`).join('')
            :'<p class="muted">لا توجد حركات درج</p>'}
          <h4>آخر نشاط في هذه الوردية</h4>
          ${(shift.activity||[]).length
            ?(shift.activity||[]).map(event=>`<p>${eventLabel(event)} — ${ago(event.happened_at)}</p>`).join('')
            :'<p class="muted">لا يوجد سجل نشاط بعد</p>'}
        </div>
      `:''}
    `;
    card.querySelector('.toggle-details').addEventListener('click',()=>{
      selectedShiftId=expanded?null:shift.id;
      renderShifts();
    });
    const closeButton=card.querySelector('.close-shift');
    if(closeButton)closeButton.addEventListener('click',()=>openCloseDialog(shift));
    list.append(card);
  });
}

function renderFeed(){
  const today=liveFeed.today||{};
  $('todaySales').textContent=money(today.sales_total);
  $('todayCount').textContent=String(today.invoice_count||0);
  $('openCount').textContent=String(today.open_shifts||0);
  $('onlineCount').textContent=String((liveFeed.cashiers||[]).filter(cashier=>cashier.online).length);
  renderCashierFilter();
  renderCashiers();
  renderShifts();
}

async function refresh(){
  $('refreshButton').disabled=true;
  try{
    liveFeed=await request('/rest/v1/rpc/manager_live_feed',{method:'POST',body:'{}'});
    currency=liveFeed.currency||currency;
    if(liveFeed.shop_name)$('shopName').textContent=liveFeed.shop_name;
    renderFeed();
    $('lastRefresh').textContent=`آخر تحديث: ${new Date(liveFeed.generated_at||Date.now()).toLocaleTimeString('ar-EG')}`;
  }catch(error){
    $('lastRefresh').textContent=error.message;
  }finally{
    $('refreshButton').disabled=false;
  }
}

function openCloseDialog(shift){
  selectedShift=shift;
  $('closeShiftName').textContent=`${shift.employee_name} — المتوقع ${money(shift.expected_cash)}`;
  $('actualCash').value='';
  $('closeReason').value='';
  $('closeError').textContent='';
  $('closeDialog').showModal();
}

window.__managerAppReady=true;
$('loginForm').addEventListener('submit',async event=>{
  event.preventDefault();
  event.stopPropagation();
  await handleLogin();
});

$('closeForm').addEventListener('submit',async event=>{
  event.preventDefault();
  if(!selectedShift)return;
  const raw=$('actualCash').value;
  const actual=raw===''?null:Number(raw);
  if(actual!==null&&(!Number.isFinite(actual)||actual<0)){$('closeError').textContent='اكتب نقدية فعلية صحيحة';return;}
  try{
    await request('/rest/v1/rpc/manager_close_shift',{
      method:'POST',
      body:JSON.stringify({
        p_shift_id:selectedShift.id,
        p_actual_cash:actual,
        p_reason:$('closeReason').value.trim()
      })
    });
    $('closeDialog').close();
    await refresh();
  }catch(error){$('closeError').textContent=error.message;}
});

$('cancelClose').addEventListener('click',()=>$('closeDialog').close());
$('refreshButton').addEventListener('click',refresh);
$('logoutButton').addEventListener('click',logout);
$('cashierFilter').addEventListener('change',event=>{
  cashierFilter=event.target.value;
  renderCashiers();
  renderShifts();
});

if(session&&configured()){
  loadProfile().then(()=>{
    showDashboard();
    refresh();
    refreshTimer=setInterval(refresh,8000);
  }).catch(error=>{$('loginError').textContent=error.message;logout();});
}

if('serviceWorker' in navigator && !location.pathname.includes('/functions/v1/')){
  navigator.serviceWorker.register('./service-worker.js?v=6').catch(()=>{});
}
