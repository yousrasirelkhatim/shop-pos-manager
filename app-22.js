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

let session = null;
let selectedShift = null;
let selectedShiftId = null;
let currency = 'ج.م';
let refreshTimer = null;
let liveFeed = { cashiers: [], shifts: [], today: {} };
let cashierFilter = 'all';
let invoicePage = 1;
const INVOICE_PAGE = 10;
let accountsSummary = null;

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
  saveSession(body);
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
  saveSession(body);
}

function saveSession(value){
  session=value;
  try{localStorage.setItem('managerSession',JSON.stringify(value));}catch(_error){}
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
  if(!email||!password){$('loginError').textContent='اكتبي البريد وكلمة المرور ثم اضغطي دخول';return;}
  if(button){button.disabled=true;button.textContent='جاري الدخول...';}
  try{
    await login(email,password);
    await loadProfile();
    await startLive();
  }catch(error){
    $('loginError').textContent=error.message||'تعذر الدخول. تأكد من الإنترنت وحاولي مرة أخرى.';
  }finally{
    if(button){button.disabled=false;button.textContent='دخول اللوحة';}
  }
}

function visibleCashiers(){
  return (liveFeed.cashiers||[]).filter(cashier=>
    cashier.event_type!=='accounts_summary' && cashier.device_id!=='__accounts__'
  );
}

function currentMonthKey(){
  const date=new Date();
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`;
}

function monthLabel(key){
  const months=['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  const [year,month]=String(key||'').split('-').map(Number);
  if(!year||!month)return '';
  return `${months[month-1]} ${year}`;
}

function monthKeyFromIso(value){
  if(!value)return '';
  const date=new Date(value);
  if(Number.isNaN(date.getTime()))return String(value).slice(0,7);
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`;
}

function saleQty(sale){
  return (sale.items||[]).reduce((sum,item)=>sum+Number(item.quantity||0),0);
}

function dayKey(value){
  const date=value instanceof Date?value:new Date(value||Date.now());
  if(Number.isNaN(date.getTime()))return '';
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

function summaryFromInvoices(sales){
  const month=currentMonthKey();
  const rows=(sales||[]).filter(sale=>!sale.voided && monthKeyFromIso(sale.sold_at)===month);
  const days=new Set(rows.map(sale=>dayKey(sale.sold_at)).filter(Boolean));
  const qty=rows.reduce((sum,sale)=>sum+saleQty(sale),0);
  const today=dayKey(new Date());
  const todayRows=(sales||[]).filter(sale=>!sale.voided && dayKey(sale.sold_at)===today);
  return {
    month,
    month_label:monthLabel(month),
    sales:rows.reduce((sum,sale)=>sum+Number(sale.total||0),0),
    invoices:rows.length,
    from_invoices:true,
    avg_daily:days.size?Math.round((qty/days.size)*10)/10:0,
    today_qty:todayRows.reduce((sum,sale)=>sum+saleQty(sale),0),
    days_sold:days.size
  };
}

function cashierKey(row){
  const name=String(row?.employee_name||row?.shift_name||'').trim();
  const id=String(row?.employee_id||'').trim();
  const device=String(row?.device_id||'').trim();
  return name || id || device;
}

function matchesCashierFilter(row){
  if(cashierFilter==='all')return true;
  const name=String(row?.employee_name||row?.shift_name||'').trim();
  const id=String(row?.employee_id||'').trim();
  const device=String(row?.device_id||'').trim();
  const shiftId=String(row?.shift_source_id||row?.source_id||'').trim();
  return cashierFilter===name || cashierFilter===id || cashierFilter===device || cashierFilter===shiftId;
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
  return shifts.filter(shift=>matchesCashierFilter(shift));
}

function setCashierFilter(value){
  const next=String(value||'all').trim()||'all';
  cashierFilter=cashierFilter===next?'all':next;
  invoicePage=1;
  renderCashierFilter();
  renderCashiers();
  renderShifts();
  renderInvoices();
}

function renderCashierFilter(){
  const tabs=$('cashierTabs');
  if(!tabs)return;
  const seen=new Set();
  const items=[{value:'all',label:'الكل'}];
  visibleCashiers().forEach(cashier=>{
    const value=cashierKey(cashier);
    if(!value||seen.has(value))return;
    seen.add(value);
    items.push({value,label:cashier.employee_name||value});
  });
  if(cashierFilter!=='all' && !items.some(item=>item.value===cashierFilter)){
    items.push({value:cashierFilter,label:cashierFilter});
  }
  tabs.replaceChildren();
  items.forEach(item=>{
    const button=document.createElement('button');
    button.type='button';
    button.className=`tab ${item.value===cashierFilter?'active':''}`;
    button.textContent=item.label;
    button.addEventListener('click',()=>{
      cashierFilter=item.value;
      invoicePage=1;
      renderCashierFilter();
      renderCashiers();
      renderShifts();
      renderInvoices();
    });
    tabs.append(button);
  });
}

function renderCashiers(){
  const list=$('cashierList');
  list.replaceChildren();
  const cashiers=visibleCashiers().slice().sort((a,b)=>Number(!!b.online)-Number(!!a.online));
  if(!cashiers.length){
    const empty=document.createElement('article');
    empty.className='empty-card';
    empty.textContent='لا يوجد كاشير متصل حالياً. اترك برنامج الكاشير مفتوحاً وهو مربوط بالسحابة.';
    list.append(empty);
    return;
  }
  cashiers.forEach(cashier=>{
    const shift=matchingShift(cashier);
    const sales=(shift?.sales||[]).filter(sale=>!sale.voided);
    const total=sales.reduce((sum,sale)=>sum+Number(sale.total||0),0);
    const cart=Number(cashier.details?.itemCount||0);
    const name=cashier.employee_name||'موظف';
    const card=document.createElement('article');
    card.className=`cashier ${cashier.online?'online':'offline'} ${cashierFilter!=='all'&&matchesCashierFilter(cashier)?'active-filter':''}`;
    card.innerHTML=`
      <div class="cashier-head">
        <div class="identity">
          <div class="avatar">${escapeHtml(name.trim().slice(0,1))}</div>
          <div>
            <h3>${escapeHtml(name)}</h3>
            <p>${cashier.employee_role==='manager'?'مدير':'كاشير'}</p>
          </div>
        </div>
        <span class="status status-pill">${cashier.online?'متصل':'غير متصل'}</span>
      </div>
      <p class="cashier-action">${escapeHtml(currentAction(cashier))}</p>
      ${cart>0?`<span class="cart-flag">السلة: ${cart} أصناف</span>`:''}
      <p class="cashier-meta">${ago(cashier.happened_at)||'لا يوجد نشاط حديث'}</p>
      <div class="station-stats">
        <div><span>فواتير الوردية</span><strong>${sales.length}</strong></div>
        <div><span>مبيعات الوردية</span><strong>${money(total)}</strong></div>
      </div>
    `;
    list.append(card);
    card.addEventListener('click',()=>setCashierFilter(cashierKey(cashier)));
  });
}

function shortTime(value){
  if(!value)return '—';
  return new Date(value).toLocaleString('ar-EG',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
}

function paymentLabel(sale){
  if(sale?.voided)return 'ملغاة';
  return sale?.payment==='card'?'بطاقة':'نقدي';
}

function allInvoices(){
  const list=[];
  for(const shift of liveFeed.shifts||[]){
    for(const sale of shift.sales||[]){
      list.push({
        ...sale,
        employee_id:sale.employee_id||shift.employee_id,
        employee_name:sale.employee_name||shift.employee_name,
        shift_status:shift.status,
        shift_name:shift.employee_name,
        shift_source_id:sale.shift_source_id||shift.source_id
      });
    }
  }
  return list.sort((a,b)=>new Date(b.sold_at||0)-new Date(a.sold_at||0));
}

function filteredInvoices(){
  const query=(($('invoiceSearch')&&$('invoiceSearch').value)||'').trim().toLowerCase();
  const pay=($('invoicePay')&&$('invoicePay').value)||'all';
  return allInvoices().filter(sale=>{
    if(!matchesCashierFilter(sale))return false;
    if(pay==='voided' && !sale.voided)return false;
    if(pay==='cash' && (sale.voided || sale.payment!=='cash'))return false;
    if(pay==='card' && (sale.voided || sale.payment!=='card'))return false;
    if(!query)return true;
    const items=(sale.items||[]).map(item=>item.name||'').join(' ');
    return String(sale.invoice_no||'').includes(query)
      || String(sale.employee_name||'').toLowerCase().includes(query)
      || items.toLowerCase().includes(query);
  });
}

function clockTime(value){
  if(!value)return '';
  return new Date(value).toLocaleTimeString('ar-EG',{hour:'2-digit',minute:'2-digit'});
}

function dayHeading(key){
  const today=dayKey(new Date());
  const yesterday=dayKey(new Date(Date.now()-86400000));
  if(key===today)return 'اليوم';
  if(key===yesterday)return 'أمس';
  const date=new Date(`${key}T12:00:00`);
  if(Number.isNaN(date.getTime()))return key;
  return date.toLocaleDateString('ar-EG',{weekday:'long',day:'numeric',month:'long'});
}

function paymentClass(sale){
  if(sale?.voided)return 'void';
  return sale?.payment==='card'?'card':'cash';
}

function itemPreview(sale){
  const items=sale.items||[];
  if(!items.length)return `${saleQty(sale)||0} قطعة`;
  const names=items.slice(0,2).map(item=>item.name).join('، ');
  const extra=items.length>2?` +${items.length-2}`:'';
  return `${names}${extra} · ${saleQty(sale)} قطعة`;
}

function openInvoice(sale){
  const body=$('invoiceDialogBody');
  const dialog=$('invoiceDialog');
  if(!body||!dialog)return;
  const items=(sale.items||[]).map(item=>
    `<li><span>${escapeHtml(item.name)} × ${escapeHtml(item.quantity)}</span><strong>${money(item.line_total)}</strong></li>`
  ).join('')||'<li>لا توجد أصناف محفوظة</li>';
  body.innerHTML=`
    <p class="receipt-kicker">فاتورة مبيعات</p>
    <h2>رقم ${sale.invoice_no||'—'}</h2>
    <p class="muted">${shortTime(sale.sold_at)} · ${escapeHtml(sale.employee_name||'—')}</p>
    <p><span class="pay-chip ${paymentClass(sale)}">${paymentLabel(sale)}</span></p>
    <ul class="items">${items}</ul>
    <div class="totals">
      <span>المجموع الفرعي ${money(sale.subtotal)}</span>
      <span>الخصم ${money(sale.discount)}</span>
      <span>الضريبة ${money(sale.tax)}</span>
      <strong>الإجمالي ${money(sale.total)}</strong>
    </div>
    <p>المدفوع ${money(sale.paid)} — الباقي ${money(sale.change_due)}</p>
    ${sale.voided?`<p class="void">أُلغيت بواسطة ${escapeHtml(sale.voided_by||'—')} — ${escapeHtml(sale.void_reason||'بدون سبب')}</p>`:''}
  `;
  dialog.showModal();
}

function renderInvoices(){
  const feed=$('invoiceFeed');
  if(!feed)return;
  const list=filteredInvoices();
  const pages=Math.max(1,Math.ceil(list.length/INVOICE_PAGE));
  if(invoicePage>pages)invoicePage=pages;
  if(invoicePage<1)invoicePage=1;
  const start=(invoicePage-1)*INVOICE_PAGE;
  const page=list.slice(start,start+INVOICE_PAGE);
  const count=$('invoiceCount');
  if(count)count.textContent=`${list.length} فاتورة`;
  const info=$('pageInfo');
  if(info)info.textContent=list.length?`${start+1}–${start+page.length} من ${list.length}`:'لا توجد فواتير مطابقة';
  const prev=$('prevPage');
  const next=$('nextPage');
  if(prev)prev.disabled=invoicePage<=1;
  if(next)next.disabled=invoicePage>=pages;
  if(!page.length){
    feed.innerHTML='<article class="empty-card">لا توجد فواتير ضمن هذا البحث. غيّر كلمة البحث أو طريقة الدفع.</article>';
    return;
  }
  const groups=[];
  page.forEach(sale=>{
    const key=dayKey(sale.sold_at)||'other';
    const last=groups[groups.length-1];
    if(!last||last.key!==key)groups.push({key,sales:[sale]});
    else last.sales.push(sale);
  });
  feed.innerHTML=groups.map(group=>{
    const total=group.sales.filter(sale=>!sale.voided).reduce((sum,sale)=>sum+Number(sale.total||0),0);
    return `<section class="day-group">
      <header class="day-head">
        <h3>${dayHeading(group.key)}</h3>
        <span>${group.sales.length} فاتورة · ${money(total)}</span>
      </header>
      ${group.sales.map((sale,index)=>{
        const global=page.indexOf(sale);
        return `<article class="inv-row ${sale.voided?'voided':''}">
          <button type="button" class="inv-hit view-invoice" data-index="${global}">
            <strong class="inv-amount">${money(sale.total)}</strong>
            <div class="inv-body">
              <b>فاتورة ${escapeHtml(sale.invoice_no||'—')}</b>
              <p>${escapeHtml(sale.employee_name||'—')} · ${escapeHtml(itemPreview(sale))}</p>
            </div>
            <div class="inv-aside">
              <span class="pay-chip ${paymentClass(sale)}">${paymentLabel(sale)}</span>
              <time>${clockTime(sale.sold_at)}</time>
            </div>
          </button>
        </article>`;
      }).join('')}
    </section>`;
  }).join('');
  feed.querySelectorAll('.view-invoice').forEach(button=>{
    button.addEventListener('click',()=>openInvoice(page[Number(button.dataset.index)]));
  });
}

function shiftCard(shift){
  const open=shift.status==='open';
  const sales=shift.sales||[];
  const activeSales=sales.filter(sale=>!sale.voided);
  const total=activeSales.reduce((sum,sale)=>sum+Number(sale.total||0),0);
  const card=document.createElement('article');
  card.className=`shift ${open?'open':''}`;
  card.innerHTML=`
    <div class="shift-head">
      <div>
        <h3>${escapeHtml(shift.employee_name)}</h3>
        <p>${open?'وردية مفتوحة':'وردية مغلقة'} — ${shortTime(shift.opened_at)}</p>
        <p class="expected">المتوقع في الدرج: ${money(shift.expected_cash)}</p>
      </div>
      <div class="shift-actions">
        <span class="pill">${activeSales.length} فاتورة</span>
        <strong>${money(total)}</strong>
        ${open?`<button class="btn danger close-shift" type="button">إغلاق الوردية</button>`:''}
        <button class="btn ghost show-shift-invoices" type="button">فواتير الكاشير</button>
      </div>
    </div>
  `;
  const closeButton=card.querySelector('.close-shift');
  if(closeButton)closeButton.addEventListener('click',event=>{
    event.stopPropagation();
    openCloseDialog(shift);
  });
  card.querySelector('.show-shift-invoices').addEventListener('click',event=>{
    event.stopPropagation();
    cashierFilter=cashierKey(shift)||'all';
    invoicePage=1;
    renderCashierFilter();
    renderCashiers();
    renderShifts();
    renderInvoices();
    $('invoiceSearch')?.scrollIntoView({behavior:'smooth',block:'start'});
  });
  return card;
}

function renderShifts(){
  const openBox=$('openShifts');
  const shifts=filteredShifts();
  const open=shifts.filter(shift=>shift.status==='open');
  if(!openBox)return;
  openBox.replaceChildren();
  if(!open.length){
    const empty=document.createElement('article');
    empty.className='empty-card';
    empty.textContent='لا توجد وردية مفتوحة الآن.';
    openBox.append(empty);
    return;
  }
  open.forEach(shift=>openBox.append(shiftCard(shift)));
}

function renderAccountsPanel(){
  const panel=$('accountsPanel');
  const label=$('accountsMonthLabel');
  if(!panel)return;
  const summary=accountsSummary;
  if(label)label.textContent=summary?.month_label||'';
  if(!summary||summary.sales==null&&!summary.month){
    panel.innerHTML='<article class="empty-card">ما في أرقام هذا الشهر بعد. أول ما يحصل بيع على جهاز مربوط، المبيعات تظهر هنا تلقائياً.</article>';
    return;
  }
  const snapshot=!summary.from_invoices && summary.net!=null;
  const profit=Number(summary.net||0)>=0;
  const dayTarget=Number(summary.day_target||0);
  const todayQty=Number(summary.today_qty!=null?summary.today_qty:summary.avg_daily||0);
  const breakEven=Number(summary.break_even_day||0);
  const maxScale=Math.max(todayQty,dayTarget,breakEven,1)*1.35;
  const fill=Math.min(100,todayQty/maxScale*100);
  const bePos=Math.min(98,Math.max(1,breakEven/maxScale*100));
  panel.innerHTML=`
    <article class="accounts-hero ${snapshot?(profit?'profit':'loss'):''}">
      <div>
        <div class="lbl">${snapshot?'صافي الربح الشهري':'إجمالي مبيعات الشهر'}</div>
        <div class="val">${snapshot?money(summary.net):money(summary.sales)}</div>
      </div>
      <span class="status-pill">${snapshot?(profit?'ربح':'خسارة'):`${summary.invoices||0} فاتورة`}</span>
    </article>
    <div class="accounts-stats">
      <article class="mini-kpi kpi-card tone-sales"><div class="kpi-icon"><svg viewBox="0 0 24 24" fill="none"><path d="M4 16l5-5 4 3 7-8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></div><span>إجمالي المبيعات</span><strong>${money(summary.sales)}</strong></article>
      <article class="mini-kpi kpi-card tone-profit"><div class="kpi-icon"><svg viewBox="0 0 24 24" fill="none"><path d="M12 3v18M7 8h8a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></div><span>ربح المبيعات</span><strong>${snapshot?money(summary.profit):'—'}</strong></article>
      <article class="mini-kpi kpi-card tone-loss"><div class="kpi-icon"><svg viewBox="0 0 24 24" fill="none"><path d="M4 7h16M7 7l1 13h8l1-13M9 7V5h6v2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></div><span>المصاريف الثابتة</span><strong>${snapshot?money(summary.expenses):'—'}</strong></article>
      <article class="mini-kpi kpi-card tone-online"><div class="kpi-icon"><svg viewBox="0 0 24 24" fill="none"><path d="M4 16l5-5 4 3 7-8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></div><span>البيع اليومي الفعلي</span><strong>${Number(todayQty||0).toLocaleString('ar-EG',{maximumFractionDigits:1})}</strong></article>
      <article class="mini-kpi kpi-card tone-target"><div class="kpi-icon"><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.8"/></svg></div><span>تارجت اليوم</span><strong>${dayTarget?Number(dayTarget).toLocaleString('ar-EG'):'—'}</strong></article>
      <article class="mini-kpi kpi-card tone-invoices"><div class="kpi-icon"><svg viewBox="0 0 24 24" fill="none"><path d="M5 19V6h14v13l-7-3-7 3z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></div><span>تارجت الشهر</span><strong>${snapshot?Number(summary.month_target||0).toLocaleString('ar-EG'):'—'}</strong></article>
      <article class="mini-kpi kpi-card tone-shifts"><div class="kpi-icon"><svg viewBox="0 0 24 24" fill="none"><path d="M5 19h14M7 16V8m5 8V5m5 11v-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></div><span>نقطة التعادل</span><strong>${snapshot?Number(summary.break_even_day||0).toLocaleString('ar-EG',{maximumFractionDigits:1}):'—'}</strong></article>
    </div>
    <div class="meter-wrap">
      <p class="muted">اليوم ${Number(todayQty||0).toLocaleString('ar-EG',{maximumFractionDigits:1})} منتج${dayTarget?` / التارجت ${dayTarget}`:''}</p>
      <svg class="meter-svg" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">
        <rect width="100" height="8" rx="4" fill="#0f172a"></rect>
        <rect width="${fill.toFixed(1)}" height="8" rx="4" fill="#2dd4bf"></rect>
        ${dayTarget?`<rect x="${bePos.toFixed(1)}" y="0" width="1.6" height="8" fill="#fb7185"></rect>`:''}
      </svg>
      <div class="acc-meter-scale"><span>0</span><span>${Math.round(maxScale)}</span></div>
    </div>
  `;
}

function parseDetails(value){
  if(value==null)return null;
  if(typeof value==='string'){
    try{value=JSON.parse(value);}catch(_error){return null;}
  }
  if(typeof value!=='object')return null;
  if(value.details && (value.kind==null && value.month==null))return parseDetails(value.details);
  return value;
}

function summaryFromRecord(value){
  const data=parseDetails(value);
  if(!data||data.from_invoices)return null;
  if(data.kind==='accounts_summary' || (data.month && (data.profit!=null || data.net!=null || data.day_target!=null)))return data;
  return null;
}

async function loadAccountsSummary(){
  const fromLive=(liveFeed.cashiers||[]).map(summaryFromRecord).find(Boolean);
  if(fromLive)return fromLive;
  const paths=[
    '/rest/v1/activity_events?device_id=eq.__accounts__&select=details,happened_at&order=happened_at.desc&limit=5',
    '/rest/v1/activity_events?view_name=eq.accounts&select=details,happened_at&order=happened_at.desc&limit=10',
    '/rest/v1/profiles?select=shops(accounts_summary)'
  ];
  for(const path of paths){
    try{
      const rows=await request(path);
      if(path.includes('profiles')){
        const summary=summaryFromRecord(rows&&rows[0]&&rows[0].shops&&rows[0].shops.accounts_summary);
        if(summary)return summary;
        continue;
      }
      for(const row of rows||[]){
        const summary=summaryFromRecord(row);
        if(summary)return summary;
      }
    }catch(_error){}
  }
  return summaryFromRecord(liveFeed.accounts_summary);
}

function renderFeed(){
  const today=liveFeed.today||{};
  const all=liveFeed.all||{};
  $('todaySales').textContent=money(today.sales_total);
  $('todayCount').textContent=String(today.invoice_count||0);
  $('openCount').textContent=String(today.open_shifts||0);
  $('onlineCount').textContent=String((liveFeed.cashiers||[]).filter(cashier=>cashier.online && cashier.event_type!=='accounts_summary' && cashier.device_id!=='__accounts__').length);
  const hint=$('historyHint');
  if(hint){
    if(all.invoice_count){
      hint.textContent=`${all.invoice_count} فاتورة مرفوعة — ${money(all.sales_total)}`;
    }else{
      hint.textContent='لم تُرفع فواتير بعد. اترك برنامج الكاشير مفتوحاً ومتصلاً بالسحابة.';
    }
  }
  renderCashierFilter();
  renderCashiers();
  renderShifts();
  renderAccountsPanel();
  renderInvoices();
}

async function loadHistory(){
  try{
    const [sales, items, shifts]=await Promise.all([
      request('/rest/v1/sales?select=id,source_id,shift_source_id,invoice_no,subtotal,discount,tax,total,payment,paid,change_due,employee_id,employee_name,sold_at,voided,voided_by,void_reason&order=sold_at.desc&limit=300'),
      request('/rest/v1/sale_items?select=sale_source_id,name,price,quantity,line_total&limit=3000'),
      request('/rest/v1/shifts?select=id,source_id,employee_id,employee_name,opened_at,open_cash,closed_at,status,close_mode,expected_cash&order=opened_at.desc&limit=100')
    ]);
    const itemsBySale={};
    (items||[]).forEach(item=>{
      (itemsBySale[item.sale_source_id]||(itemsBySale[item.sale_source_id]=[])).push(item);
    });
    const mappedSales=(sales||[]).map(sale=>({
      ...sale,
      items:itemsBySale[sale.source_id]||[]
    }));
    const salesByShift={};
    mappedSales.forEach(sale=>{
      (salesByShift[sale.shift_source_id]||(salesByShift[sale.shift_source_id]=[])).push(sale);
    });
    return {
      sales:mappedSales,
      shifts:(shifts||[]).map(shift=>({
        ...shift,
        sales:salesByShift[shift.source_id]||[],
        movements:[],
        activity:[]
      }))
    };
  }catch(_error){
    return { sales:[], shifts:[] };
  }
}

function mergeHistory(feed, history){
  const byKey=new Map((feed.shifts||[]).map(shift=>[shift.source_id||shift.id, shift]));
  for(const shift of history.shifts||[]){
    const key=shift.source_id||shift.id;
    if(!byKey.has(key)) byKey.set(key, shift);
    else if(!(byKey.get(key).sales||[]).length && (shift.sales||[]).length){
      byKey.get(key).sales=shift.sales;
    }
  }
  feed.shifts=[...byKey.values()];
  const active=(history.sales||[]).filter(sale=>!sale.voided);
  feed.all={
    invoice_count:active.length,
    sales_total:active.reduce((sum,sale)=>sum+Number(sale.total||0),0)
  };
  return feed;
}

async function refresh(){
  $('refreshButton').disabled=true;
  try{
    liveFeed=await request('/rest/v1/rpc/manager_live_feed',{method:'POST',body:'{}'});
    const history=await loadHistory();
    liveFeed=mergeHistory(liveFeed, history);
    accountsSummary=await loadAccountsSummary();
    const invoiceStats=summaryFromInvoices(history.sales);
    if(!accountsSummary||accountsSummary.month==null){
      accountsSummary=invoiceStats;
    }else{
      accountsSummary={
        ...invoiceStats,
        ...accountsSummary,
        today_qty:accountsSummary.today_qty!=null?accountsSummary.today_qty:invoiceStats.today_qty
      };
    }
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

async function startLive(){
  showDashboard();
  await refresh();
  clearInterval(refreshTimer);
  refreshTimer=setInterval(refresh,8000);
}

window.__managerAppReady=true;
window.__managerHandleLogin=handleLogin;
window.__managerAfterLogin=async function(){
  session=window.__managerSession||null;
  if(!session?.access_token){
    try{session=JSON.parse(localStorage.getItem('managerSession')||'null');}catch(_error){session=null;}
  }
  if(!session?.access_token)return;
  try{
    await loadProfile();
    await startLive();
  }catch(_error){
    if(session.refresh_token){
      try{
        await refreshSession();
        await loadProfile();
        await startLive();
        return;
      }catch(_retry){}
    }
    logout();
  }
};
if(window.__pendingManagerRestore){
  window.__pendingManagerRestore=false;
  window.__managerAfterLogin();
}

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
if($('invoiceSearch'))$('invoiceSearch').addEventListener('input',()=>{invoicePage=1;renderInvoices();});
if($('invoicePay'))$('invoicePay').addEventListener('change',()=>{invoicePage=1;renderInvoices();});
document.querySelectorAll('#payTabs [data-pay]').forEach(button=>{
  button.addEventListener('click',()=>{
    if($('invoicePay'))$('invoicePay').value=button.dataset.pay;
    document.querySelectorAll('#payTabs .tab').forEach(tab=>tab.classList.toggle('active',tab===button));
    invoicePage=1;
    renderInvoices();
  });
});
if($('prevPage'))$('prevPage').addEventListener('click',()=>{invoicePage-=1;renderInvoices();});
if($('nextPage'))$('nextPage').addEventListener('click',()=>{invoicePage+=1;renderInvoices();});
