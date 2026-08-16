create table if not exists public.sale_items (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  source_id text not null,
  sale_source_id text not null,
  product_id text,
  name text not null,
  price numeric(14,2) not null default 0,
  quantity numeric(14,3) not null default 0,
  line_total numeric(14,2) not null default 0,
  unique (shop_id, source_id)
);

create table if not exists public.activity_events (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  source_id text not null,
  device_id text not null,
  employee_id text,
  employee_name text,
  employee_role text,
  shift_source_id text,
  event_type text not null,
  view_name text,
  details jsonb not null default '{}'::jsonb,
  happened_at timestamptz not null,
  unique (shop_id, source_id)
);

create table if not exists public.cash_movements (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  source_id text not null,
  shift_source_id text not null,
  movement_type text not null check (movement_type in ('in', 'out')),
  amount numeric(14,2) not null check (amount > 0),
  note text,
  happened_at timestamptz not null,
  unique (shop_id, source_id)
);

create index if not exists idx_cloud_shifts_shop_status on public.shifts(shop_id, status);
create index if not exists idx_cloud_sales_shop_date on public.sales(shop_id, sold_at desc);
create index if not exists idx_cloud_sales_shift on public.sales(shop_id, shift_source_id);
create index if not exists idx_cloud_moves_shift on public.cash_movements(shop_id, shift_source_id);
create index if not exists idx_cloud_sale_items_sale on public.sale_items(shop_id, sale_source_id);
create index if not exists idx_cloud_activity_shop_time on public.activity_events(shop_id, happened_at desc);
create index if not exists idx_cloud_activity_shift on public.activity_events(shop_id, shift_source_id, happened_at desc);

alter table public.sales add column if not exists subtotal numeric(14,2) not null default 0;
alter table public.sales add column if not exists discount numeric(14,2) not null default 0;
alter table public.sales add column if not exists tax numeric(14,2) not null default 0;
alter table public.sales add column if not exists paid numeric(14,2) not null default 0;
alter table public.sales add column if not exists change_due numeric(14,2) not null default 0;
alter table public.sales add column if not exists employee_id text;
alter table public.sales add column if not exists voided_at timestamptz;
alter table public.sales add column if not exists voided_by text;
alter table public.sales add column if not exists void_reason text;

alter table public.shops enable row level security;
alter table public.profiles enable row level security;
alter table public.shifts enable row level security;
alter table public.sales enable row level security;
alter table public.cash_movements enable row level security;
alter table public.sale_items enable row level security;
alter table public.activity_events enable row level security;

create or replace function public.current_shop_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select shop_id from public.profiles where user_id = auth.uid()
$$;

create or replace function public.is_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select role = 'manager' from public.profiles where user_id = auth.uid()), false)
$$;

drop policy if exists "shop members read shop" on public.shops;
create policy "shop members read shop" on public.shops
for select using (id = public.current_shop_id());

drop policy if exists "users read own profile" on public.profiles;
create policy "users read own profile" on public.profiles
for select using (user_id = auth.uid());

drop policy if exists "shop members read shifts" on public.shifts;
create policy "shop members read shifts" on public.shifts
for select using (shop_id = public.current_shop_id());

drop policy if exists "shop members read sales" on public.sales;
create policy "shop members read sales" on public.sales
for select using (shop_id = public.current_shop_id());

drop policy if exists "shop members read movements" on public.cash_movements;
create policy "shop members read movements" on public.cash_movements
for select using (shop_id = public.current_shop_id());

drop policy if exists "shop members read sale items" on public.sale_items;
create policy "shop members read sale items" on public.sale_items
for select using (shop_id = public.current_shop_id());

drop policy if exists "managers read activity" on public.activity_events;
create policy "managers read activity" on public.activity_events
for select using (shop_id = public.current_shop_id() and public.is_manager());

create or replace function public.manager_close_shift(
  p_shift_id uuid,
  p_actual_cash numeric default null,
  p_reason text default ''
)
returns public.shifts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shift public.shifts;
  v_expected numeric(14,2);
begin
  if not public.is_manager() then
    raise exception 'manager permission required';
  end if;

  select * into v_shift
  from public.shifts
  where id = p_shift_id
    and shop_id = public.current_shop_id()
  for update;

  if v_shift.id is null then raise exception 'shift not found'; end if;
  if v_shift.status <> 'open' then raise exception 'shift already closed'; end if;
  if p_actual_cash is not null and p_actual_cash < 0 then raise exception 'invalid actual cash'; end if;

  select v_shift.open_cash
    + coalesce(sum(case when s.payment = 'cash' and not s.voided then s.total else 0 end), 0)
    + coalesce((select sum(case when m.movement_type = 'in' then m.amount else -m.amount end)
                from public.cash_movements m
                where m.shop_id = v_shift.shop_id
                  and m.shift_source_id = v_shift.source_id), 0)
  into v_expected
  from public.sales s
  where s.shop_id = v_shift.shop_id
    and s.shift_source_id = v_shift.source_id;

  update public.shifts
  set closed_at = now(),
      close_cash = coalesce(p_actual_cash, v_expected),
      expected_cash = v_expected,
      difference = coalesce(p_actual_cash, v_expected) - v_expected,
      status = 'remote_closed',
      close_mode = 'remote',
      close_reason = nullif(trim(p_reason), ''),
      closed_by = auth.uid(),
      updated_at = now()
  where id = v_shift.id
  returning * into v_shift;

  return v_shift;
end;
$$;

revoke all on function public.manager_close_shift(uuid, numeric, text) from public;
grant execute on function public.manager_close_shift(uuid, numeric, text) to authenticated;

create or replace function public.manager_open_shifts()
returns table (
  id uuid,
  source_id text,
  employee_name text,
  opened_at timestamptz,
  open_cash numeric,
  expected_cash numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select sh.id,
         sh.source_id,
         sh.employee_name,
         sh.opened_at,
         sh.open_cash,
         sh.open_cash
           + coalesce((select sum(sa.total)
                       from public.sales sa
                       where sa.shop_id = sh.shop_id
                         and sa.shift_source_id = sh.source_id
                         and sa.payment = 'cash'
                         and not sa.voided), 0)
           + coalesce((select sum(case when cm.movement_type = 'in' then cm.amount else -cm.amount end)
                       from public.cash_movements cm
                       where cm.shop_id = sh.shop_id
                         and cm.shift_source_id = sh.source_id), 0) as expected_cash
  from public.shifts sh
  where sh.shop_id = public.current_shop_id()
    and sh.status = 'open'
    and public.is_manager()
  order by sh.opened_at desc
$$;

revoke all on function public.manager_open_shifts() from public;
grant execute on function public.manager_open_shifts() to authenticated;

create or replace function public.sync_pos_snapshot(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop_id uuid;
  v_item jsonb;
  v_remote jsonb;
begin
  select shop_id into v_shop_id
  from public.profiles
  where user_id = auth.uid();

  if v_shop_id is null then
    raise exception 'shop profile required';
  end if;

  update public.shops
  set name = coalesce(nullif(trim(p_payload->'shop'->>'name'), ''), name),
      currency = coalesce(nullif(trim(p_payload->'shop'->>'currency'), ''), currency)
  where id = v_shop_id;

  for v_item in
    select value from jsonb_array_elements(coalesce(p_payload->'shifts', '[]'::jsonb))
  loop
    insert into public.shifts(
      shop_id, source_id, employee_id, employee_name, opened_at, open_cash,
      closed_at, close_cash, expected_cash, difference, status, close_mode,
      close_reason, updated_at
    )
    values(
      v_shop_id,
      v_item->>'source_id',
      nullif(v_item->>'employee_id', ''),
      coalesce(nullif(v_item->>'employee_name', ''), 'موظف'),
      (v_item->>'opened_at')::timestamptz,
      coalesce((v_item->>'open_cash')::numeric, 0),
      nullif(v_item->>'closed_at', '')::timestamptz,
      nullif(v_item->>'close_cash', '')::numeric,
      nullif(v_item->>'expected_cash', '')::numeric,
      nullif(v_item->>'difference', '')::numeric,
      case when v_item->>'status' = 'closed' then 'closed' else 'open' end,
      nullif(v_item->>'close_mode', ''),
      nullif(v_item->>'close_reason', ''),
      now()
    )
    on conflict (shop_id, source_id) do update
    set employee_id = excluded.employee_id,
        employee_name = excluded.employee_name,
        opened_at = excluded.opened_at,
        open_cash = excluded.open_cash,
        closed_at = case when shifts.status = 'remote_closed' then shifts.closed_at else excluded.closed_at end,
        close_cash = case when shifts.status = 'remote_closed' then shifts.close_cash else excluded.close_cash end,
        expected_cash = case when shifts.status = 'remote_closed' then shifts.expected_cash else excluded.expected_cash end,
        difference = case when shifts.status = 'remote_closed' then shifts.difference else excluded.difference end,
        status = case when shifts.status = 'remote_closed' then shifts.status else excluded.status end,
        close_mode = case when shifts.status = 'remote_closed' then shifts.close_mode else excluded.close_mode end,
        close_reason = case when shifts.status = 'remote_closed' then shifts.close_reason else excluded.close_reason end,
        updated_at = now();
  end loop;

  for v_item in
    select value from jsonb_array_elements(coalesce(p_payload->'sales', '[]'::jsonb))
  loop
    insert into public.sales(
      shop_id, source_id, shift_source_id, invoice_no, subtotal, discount, tax, total,
      payment, paid, change_due, employee_id, employee_name, sold_at, voided,
      voided_at, voided_by, void_reason, updated_at
    )
    values(
      v_shop_id,
      v_item->>'source_id',
      v_item->>'shift_source_id',
      nullif(v_item->>'invoice_no', '')::bigint,
      coalesce((v_item->>'subtotal')::numeric, 0),
      coalesce((v_item->>'discount')::numeric, 0),
      coalesce((v_item->>'tax')::numeric, 0),
      coalesce((v_item->>'total')::numeric, 0),
      case when v_item->>'payment' = 'card' then 'card' else 'cash' end,
      coalesce((v_item->>'paid')::numeric, (v_item->>'total')::numeric, 0),
      coalesce((v_item->>'change_due')::numeric, 0),
      nullif(v_item->>'employee_id', ''),
      coalesce(nullif(v_item->>'employee_name', ''), 'موظف'),
      (v_item->>'sold_at')::timestamptz,
      coalesce((v_item->>'voided')::boolean, false),
      nullif(v_item->>'voided_at', '')::timestamptz,
      nullif(v_item->>'voided_by', ''),
      nullif(v_item->>'void_reason', ''),
      now()
    )
    on conflict (shop_id, source_id) do update
    set shift_source_id = excluded.shift_source_id,
        invoice_no = excluded.invoice_no,
        subtotal = excluded.subtotal,
        discount = excluded.discount,
        tax = excluded.tax,
        total = excluded.total,
        payment = excluded.payment,
        paid = excluded.paid,
        change_due = excluded.change_due,
        employee_id = excluded.employee_id,
        employee_name = excluded.employee_name,
        sold_at = excluded.sold_at,
        voided = excluded.voided,
        voided_at = excluded.voided_at,
        voided_by = excluded.voided_by,
        void_reason = excluded.void_reason,
        updated_at = now();

    delete from public.sale_items
    where shop_id = v_shop_id and sale_source_id = v_item->>'source_id';

    insert into public.sale_items(
      shop_id, source_id, sale_source_id, product_id, name, price, quantity, line_total
    )
    select
      v_shop_id,
      item->>'source_id',
      v_item->>'source_id',
      nullif(item->>'product_id', ''),
      coalesce(nullif(item->>'name', ''), 'صنف'),
      coalesce((item->>'price')::numeric, 0),
      coalesce((item->>'quantity')::numeric, 0),
      coalesce((item->>'line_total')::numeric, 0)
    from jsonb_array_elements(coalesce(v_item->'items', '[]'::jsonb)) item
    on conflict (shop_id, source_id) do update
    set name = excluded.name,
        price = excluded.price,
        quantity = excluded.quantity,
        line_total = excluded.line_total,
        product_id = excluded.product_id;
  end loop;

  for v_item in
    select value from jsonb_array_elements(coalesce(p_payload->'cash_movements', '[]'::jsonb))
  loop
    insert into public.cash_movements(
      shop_id, source_id, shift_source_id, movement_type, amount, note, happened_at
    )
    values(
      v_shop_id,
      v_item->>'source_id',
      v_item->>'shift_source_id',
      case when v_item->>'movement_type' = 'out' then 'out' else 'in' end,
      (v_item->>'amount')::numeric,
      nullif(v_item->>'note', ''),
      (v_item->>'happened_at')::timestamptz
    )
    on conflict (shop_id, source_id) do update
    set shift_source_id = excluded.shift_source_id,
        movement_type = excluded.movement_type,
        amount = excluded.amount,
        note = excluded.note,
        happened_at = excluded.happened_at;
  end loop;

  for v_item in
    select value from jsonb_array_elements(coalesce(p_payload->'activity_events', '[]'::jsonb))
  loop
    insert into public.activity_events(
      shop_id, source_id, device_id, employee_id, employee_name, employee_role,
      shift_source_id, event_type, view_name, details, happened_at
    )
    values(
      v_shop_id,
      v_item->>'source_id',
      coalesce(nullif(v_item->>'device_id', ''), 'pos'),
      nullif(v_item->>'employee_id', ''),
      nullif(v_item->>'employee_name', ''),
      nullif(v_item->>'employee_role', ''),
      nullif(v_item->>'shift_source_id', ''),
      coalesce(nullif(v_item->>'event_type', ''), 'heartbeat'),
      nullif(v_item->>'view_name', ''),
      coalesce(v_item->'details', '{}'::jsonb),
      (v_item->>'happened_at')::timestamptz
    )
    on conflict (shop_id, source_id) do update
    set device_id = excluded.device_id,
        employee_id = excluded.employee_id,
        employee_name = excluded.employee_name,
        employee_role = excluded.employee_role,
        shift_source_id = excluded.shift_source_id,
        event_type = excluded.event_type,
        view_name = excluded.view_name,
        details = excluded.details,
        happened_at = excluded.happened_at;
  end loop;

  select coalesce(jsonb_agg(to_jsonb(remote_rows)), '[]'::jsonb)
  into v_remote
  from (
    select source_id, closed_at, close_cash, expected_cash, difference,
           close_reason, closed_by
    from public.shifts
    where shop_id = v_shop_id and status = 'remote_closed'
  ) remote_rows;

  return jsonb_build_object(
    'synced_at', now(),
    'remote_closures', v_remote
  );
end;
$$;

revoke all on function public.sync_pos_snapshot(jsonb) from public;
grant execute on function public.sync_pos_snapshot(jsonb) to authenticated;

create or replace function public.pos_remote_closures()
returns table (
  source_id text,
  closed_at timestamptz,
  close_cash numeric,
  expected_cash numeric,
  difference numeric,
  close_reason text,
  closed_by uuid
)
language sql
stable
security definer
set search_path = public
as $$
  select sh.source_id, sh.closed_at, sh.close_cash, sh.expected_cash,
         sh.difference, sh.close_reason, sh.closed_by
  from public.shifts sh
  where sh.shop_id = public.current_shop_id()
    and sh.status = 'remote_closed'
$$;

revoke all on function public.pos_remote_closures() from public;
grant execute on function public.pos_remote_closures() to authenticated;

create or replace function public.manager_live_feed()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_shop_id uuid;
  v_result jsonb;
begin
  if not public.is_manager() then
    raise exception 'manager permission required';
  end if;

  v_shop_id := public.current_shop_id();
  if v_shop_id is null then
    raise exception 'shop profile required';
  end if;

  select jsonb_build_object(
    'generated_at', now(),
    'currency', coalesce((select currency from public.shops where id = v_shop_id), 'ج.م'),
    'shop_name', coalesce((select name from public.shops where id = v_shop_id), 'المحل'),
    'today', jsonb_build_object(
      'sales_total', coalesce((
        select sum(sa.total) from public.sales sa
        where sa.shop_id = v_shop_id and not sa.voided and sa.sold_at >= date_trunc('day', now())
      ), 0),
      'invoice_count', coalesce((
        select count(*) from public.sales sa
        where sa.shop_id = v_shop_id and not sa.voided and sa.sold_at >= date_trunc('day', now())
      ), 0),
      'open_shifts', coalesce((
        select count(*) from public.shifts sh
        where sh.shop_id = v_shop_id and sh.status = 'open'
      ), 0)
    ),
    'cashiers', coalesce((
      select jsonb_agg(to_jsonb(c) order by c.online desc, c.happened_at desc)
      from (
        select
          coalesce(a.employee_id, a.employee_name, a.device_id) as cashier_key,
          a.employee_id,
          coalesce(nullif(a.employee_name, ''), 'موظف') as employee_name,
          a.employee_role,
          a.device_id,
          a.event_type,
          a.view_name,
          a.details,
          a.happened_at,
          a.shift_source_id,
          (a.event_type <> 'logout' and a.happened_at > now() - interval '45 seconds') as online,
          (
            select sh.employee_name from public.shifts sh
            where sh.shop_id = v_shop_id and sh.source_id = a.shift_source_id
            limit 1
          ) as shift_owner
        from public.activity_events a
        join (
          select distinct on (coalesce(employee_id, employee_name, device_id)) id
          from public.activity_events
          where shop_id = v_shop_id
            and happened_at > now() - interval '36 hours'
          order by coalesce(employee_id, employee_name, device_id), happened_at desc
        ) latest on latest.id = a.id
      ) c
    ), '[]'::jsonb),
    'shifts', coalesce((
      select jsonb_agg(s.shift_row order by (s.shift_row->>'status') = 'open' desc, s.shift_row->>'opened_at' desc)
      from (
        select jsonb_build_object(
          'id', sh.id,
          'source_id', sh.source_id,
          'employee_id', sh.employee_id,
          'employee_name', sh.employee_name,
          'opened_at', sh.opened_at,
          'open_cash', sh.open_cash,
          'closed_at', sh.closed_at,
          'status', sh.status,
          'close_mode', sh.close_mode,
          'expected_cash', sh.open_cash
            + coalesce((
                select sum(sa.total) from public.sales sa
                where sa.shop_id = sh.shop_id
                  and sa.shift_source_id = sh.source_id
                  and sa.payment = 'cash'
                  and not sa.voided
              ), 0)
            + coalesce((
                select sum(case when cm.movement_type = 'in' then cm.amount else -cm.amount end)
                from public.cash_movements cm
                where cm.shop_id = sh.shop_id and cm.shift_source_id = sh.source_id
              ), 0),
          'sales', coalesce((
            select jsonb_agg(sale_obj order by sold_at desc)
            from (
              select jsonb_build_object(
                'source_id', sa.source_id,
                'invoice_no', sa.invoice_no,
                'subtotal', sa.subtotal,
                'discount', sa.discount,
                'tax', sa.tax,
                'total', sa.total,
                'payment', sa.payment,
                'paid', sa.paid,
                'change_due', sa.change_due,
                'employee_name', sa.employee_name,
                'sold_at', sa.sold_at,
                'voided', sa.voided,
                'voided_at', sa.voided_at,
                'voided_by', sa.voided_by,
                'void_reason', sa.void_reason,
                'items', coalesce((
                  select jsonb_agg(jsonb_build_object(
                    'name', si.name,
                    'price', si.price,
                    'quantity', si.quantity,
                    'line_total', si.line_total
                  ) order by si.name)
                  from public.sale_items si
                  where si.shop_id = sa.shop_id and si.sale_source_id = sa.source_id
                ), '[]'::jsonb)
              ) as sale_obj,
              sa.sold_at
              from public.sales sa
              where sa.shop_id = sh.shop_id and sa.shift_source_id = sh.source_id
            ) sales_inner
          ), '[]'::jsonb),
          'movements', coalesce((
            select jsonb_agg(jsonb_build_object(
              'movement_type', cm.movement_type,
              'amount', cm.amount,
              'note', cm.note,
              'happened_at', cm.happened_at
            ) order by cm.happened_at desc)
            from public.cash_movements cm
            where cm.shop_id = sh.shop_id and cm.shift_source_id = sh.source_id
          ), '[]'::jsonb),
          'activity', coalesce((
            select jsonb_agg(jsonb_build_object(
              'event_type', ae.event_type,
              'view_name', ae.view_name,
              'details', ae.details,
              'happened_at', ae.happened_at,
              'employee_name', ae.employee_name
            ) order by ae.happened_at desc)
            from (
              select * from public.activity_events ae
              where ae.shop_id = sh.shop_id and ae.shift_source_id = sh.source_id
              order by ae.happened_at desc
              limit 30
            ) ae
          ), '[]'::jsonb)
        ) as shift_row
        from public.shifts sh
        where sh.shop_id = v_shop_id
          and (sh.status = 'open' or sh.opened_at >= date_trunc('day', now()) - interval '1 day')
      ) s
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.manager_live_feed() from public;
grant execute on function public.manager_live_feed() to authenticated;
