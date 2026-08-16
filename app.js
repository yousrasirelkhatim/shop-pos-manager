import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const $ = id => document.getElementById(id);
let session = JSON.parse(localStorage.getItem('managerSession') || 'null');
let selectedShift = null;
let currency = 'ج.م';
let refreshTimer = null;

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
    headers:{apikey:SUPABASE_ANON_KEY,'Content-Type':'application/json'},
    body:JSON.stringify({refresh_token:session.refresh_token})
  });
  const body=await response.json().catch(()=>({}));
  if(!response.ok){logout();throw new Error('انتهت الجلسة؛ سجّل الدخول مرة أخرى');}
  session=body;
  localStorage.setItem('managerSession',JSON.stringify(session));
}

function money(value){
  return `${Number(value||0).toLocaleString('ar-EG',{maximumFractionDigits:2})} ${currency}`;
}

async function login(email,password){
  const response=await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`,{
    method:'POST',
    headers:{apikey:SUPABASE_ANON_KEY,'Content-Type':'application/json'},
    body:JSON.stringify({email,password})
  });
  const body=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(body.error_description||body.msg||'بيانات الدخول غير صحيحة');
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

async function loadProfile(){
  const rows=await request(`/rest/v1/profiles?select=display_name,role,shops(name,currency)&user_id=eq.${encodeURIComponent(session.user.id)}`);
  const profile=rows[0];
  if(!profile||profile.role!=='manager')throw new Error('هذا الحساب لا يملك صلاحية المدير');
  $('shopName').textContent=profile.shops?.name||'المحل';
  currency=profile.shops?.currency||'ج.م';
}

async function refresh(){
  $('refreshButton').disabled=true;
  try{
    const start=new Date();start.setHours(0,0,0,0);
    const [sales,shifts]=await Promise.all([
      request(`/rest/v1/sales?select=total&voided=eq.false&sold_at=gte.${encodeURIComponent(start.toISOString())}`),
      request('/rest/v1/rpc/manager_open_shifts',{method:'POST',body:'{}'})
    ]);
    const total=sales.reduce((sum,row)=>sum+Number(row.total||0),0);
    $('todaySales').textContent=money(total);
    $('todayCount').textContent=String(sales.length);
    $('openCount').textContent=String(shifts.length);
    renderShifts(shifts);
    $('lastRefresh').textContent=`آخر تحديث: ${new Date().toLocaleTimeString('ar-EG')}`;
  }catch(error){
    $('lastRefresh').textContent=error.message;
  }finally{
    $('refreshButton').disabled=false;
  }
}

function renderShifts(shifts){
  const list=$('shiftList');
  list.replaceChildren();
  if(!shifts.length){
    const empty=document.createElement('article');
    empty.className='card muted';
    empty.textContent='لا توجد ورديات مفتوحة حالياً';
    list.append(empty);
    return;
  }
  shifts.forEach(shift=>{
    const card=document.createElement('article');card.className='card shift';
    const info=document.createElement('div');
    const title=document.createElement('h3');title.textContent=shift.employee_name;
    const opened=document.createElement('p');opened.textContent=`بدأت: ${new Date(shift.opened_at).toLocaleString('ar-EG')}`;
    const expected=document.createElement('p');expected.className='expected';expected.textContent=`المتوقع: ${money(shift.expected_cash)}`;
    const button=document.createElement('button');button.className='danger';button.textContent='إغلاق الوردية';
    button.addEventListener('click',()=>openCloseDialog(shift));
    info.append(title,opened,expected);card.append(info,button);list.append(card);
  });
}

function openCloseDialog(shift){
  selectedShift=shift;
  $('closeShiftName').textContent=`${shift.employee_name} — المتوقع ${money(shift.expected_cash)}`;
  $('actualCash').value='';
  $('closeReason').value='';
  $('closeError').textContent='';
  $('closeDialog').showModal();
}

$('loginForm').addEventListener('submit',async event=>{
  event.preventDefault();
  $('loginError').textContent='';
  if(!configured()){$('loginError').textContent='أضف بيانات Supabase في config.js أولاً';return;}
  try{
    await login($('email').value.trim(),$('password').value);
    await loadProfile();
    $('loginView').classList.add('hidden');
    $('dashboard').classList.remove('hidden');
    await refresh();
    refreshTimer=setInterval(refresh,15000);
  }catch(error){$('loginError').textContent=error.message;logout();}
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

if(session&&configured()){
  loadProfile().then(()=>{
    $('loginView').classList.add('hidden');
    $('dashboard').classList.remove('hidden');
    refresh();
    refreshTimer=setInterval(refresh,15000);
  }).catch(error=>{$('loginError').textContent=error.message;logout();});
}

if('serviceWorker' in navigator && !location.pathname.includes('/functions/v1/')){
  navigator.serviceWorker.register('./service-worker.js').catch(()=>{});
}
