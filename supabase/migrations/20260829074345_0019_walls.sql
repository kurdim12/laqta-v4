-- 0019_walls.sql
--
-- Phase 2: the data layer for the three walls.
--
--   THE LIGHTBOX IS A TABLE, NOT A COMPONENT'S MEMORY. Feature F requires "persisted cell
--   placement": a 28-cell wall whose arrangement survives a refresh, a power cut, and a
--   different device opening the same wall. State that must survive all three lives in the
--   database, so wall_cells is a table and the wall merely renders it.
--
--   THE PUBLISH GATE OUTRANKS EVERY OTHER RULE HERE. A placed photo that gets unapproved
--   vanishes from the wall even while the wall is frozen - "unpublished photos provably
--   unreachable" is the Phase 2 gate condition, and a freeze preserves what the room may see,
--   not what it may not.
--
--   THE WALL'S VIEW OF AN EVENT IS A NARROW SHAPE. api_event_by_slug returns the whole events
--   row - AI prompt, budgets, spend - to a caller that only needs names, colours and switches.
--   Walls are unauthenticated by design, so they get api_event_public, which structurally
--   cannot name any of that: the columns are not in its return type.
--
-- Append-only. Never edit a migration that has been applied; add a new one.

/* ------------------------------------------------------------------ the lightbox (F) */

create table wall_cells (
  event_id   uuid not null references events (id),
  cell_index integer not null check (cell_index between 0 and 27),
  photo_id   uuid not null,
  placed_by  uuid,
  updated_at timestamptz not null default now(),
  primary key (event_id, cell_index),
  constraint wall_cells_photo_same_event
    foreign key (photo_id, event_id) references photos (id, event_id),
  constraint wall_cells_operator_same_event
    foreign key (placed_by, event_id) references operators (id, event_id)
);

alter table wall_cells enable row level security;

-- One photo occupies one cell. Without this, two walls polling concurrently could each
-- autofill the same photo into different cells and the room would see it twice.
create unique index wall_cells_photo_uk on wall_cells (event_id, photo_id);

comment on table wall_cells is
  'The lightbox wall''s placement. A row is a photo in a cell; the wall renders this, it does not own it.';

/* ------------------------------------------- what an unauthenticated wall may know (7, law 9) */

create or replace function api_event_public(p_event_slug text)
returns table (
  slug text, name text, name_ar text, name_en text, status text,
  locale_default text, locales text[],
  brand_primary text, brand_secondary text, brand_font_family text,
  wall_frozen boolean, panic_brand_only boolean,
  banner_active boolean, banner_text_en text, banner_text_ar text,
  guest_mode text, wall_config jsonb
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select e.slug, e.name, e.name_ar, e.name_en, e.status,
         e.locale_default, e.locales,
         e.brand_primary, e.brand_secondary, e.brand_font_family,
         e.wall_frozen, e.panic_brand_only,
         e.banner_active, e.banner_text_en, e.banner_text_ar,
         e.guest_mode, e.wall_config
    from events e
   where e.slug = p_event_slug;
$$;

comment on function api_event_public(text) is
  'The whole of what a wall or guest surface may know about an event. AI prompt, budgets and spend are structurally absent: not in the return type.';

/* ------------------------------------------------------------- the lightbox tick (F, E, 5) */

create or replace function wall_lightbox(p_event_slug text)
returns table (cell_index integer, photo_id uuid, thumb_path text, kind text)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_event events;
begin
  select * into v_event from events e where e.slug = p_event_slug;
  if not found then
    return;
  end if;

  -- The publish gate outranks the freeze: a photo that is no longer publishable leaves the
  -- wall NOW, whatever the switches say. This is what "unpublished photos provably
  -- unreachable" means when a placement table sits between the photo and the room.
  delete from wall_cells wc
   using photos p
   where wc.event_id = v_event.id
     and p.id = wc.photo_id
     and not (p.approved and p.status = 'ready');

  if v_event.panic_brand_only then
    return;
  end if;

  -- A frozen wall keeps what it has and takes nothing new. An unfrozen wall fills its empty
  -- cells with the newest publishable photos that are not already placed. Both unique
  -- constraints defend the concurrent case - two walls ticking at once cannot double-place.
  if not v_event.wall_frozen then
    insert into wall_cells (event_id, cell_index, photo_id)
    select v_event.id, e.i, u.id
      from (select gs.i, row_number() over (order by gs.i) as rn
              from generate_series(0, 27) gs(i)
             where not exists (select 1 from wall_cells wc
                                where wc.event_id = v_event.id and wc.cell_index = gs.i)) e
      join (select p.id, row_number() over (order by p.created_at desc) as rn
              from photos p
             where p.event_id = v_event.id
               and p.approved and p.status = 'ready'
               and not exists (select 1 from wall_cells wc
                                where wc.event_id = v_event.id and wc.photo_id = p.id)) u
        using (rn)
    on conflict do nothing;
  end if;

  return query
    select wc.cell_index, p.id, p.thumb_path, p.kind
      from wall_cells wc
      join photos p on p.id = wc.photo_id and p.event_id = wc.event_id
     where wc.event_id = v_event.id
       and p.approved and p.status = 'ready'
     order by wc.cell_index;
end;
$$;

comment on function wall_lightbox(text) is
  'One tick of the lightbox: heal dead placements, autofill unless frozen, return nothing under panic. Thumbnails only - no storage_path in the type.';

/* -------------------------------------------------- placing a photo by hand (F, and G later) */

create or replace function api_lightbox_place(
  p_event_id    uuid,
  p_cell_index  integer,
  p_photo_id    uuid default null,
  p_operator_id uuid default null,
  p_admin_id    uuid default null
)
returns table (cell_index integer, photo_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before uuid;
  v_label  text := 'system';
  v_kind   text := 'system';
begin
  if p_cell_index not between 0 and 27 then
    raise exception 'BAD_CELL' using hint = 'The lightbox has cells 0 through 27.';
  end if;

  select wc.photo_id into v_before
    from wall_cells wc
   where wc.event_id = p_event_id and wc.cell_index = p_cell_index;

  if p_photo_id is null then
    delete from wall_cells wc
     where wc.event_id = p_event_id and wc.cell_index = p_cell_index;
  else
    if not exists (select 1 from photos p
                    where p.id = p_photo_id and p.event_id = p_event_id
                      and p.approved and p.status = 'ready') then
      raise exception 'NOT_PUBLISHABLE'
        using hint = 'Only an approved, ready photo from this event can be placed on the wall.';
    end if;

    -- One photo, one cell: placing it here removes it from wherever it was.
    delete from wall_cells wc
     where wc.event_id = p_event_id and wc.photo_id = p_photo_id
       and wc.cell_index <> p_cell_index;

    insert into wall_cells (event_id, cell_index, photo_id, placed_by)
    values (p_event_id, p_cell_index, p_photo_id, p_operator_id)
    on conflict (event_id, cell_index)
      do update set photo_id = excluded.photo_id,
                    placed_by = excluded.placed_by,
                    updated_at = now();
  end if;

  if p_admin_id is not null then
    select ad.username || ' (admin)' into v_label from admins ad where ad.id = p_admin_id;
    v_kind := 'admin';
  elsif p_operator_id is not null then
    select o.username || ' (' || o.role || ')' into v_label from operators o where o.id = p_operator_id;
    v_kind := 'operator';
  end if;

  insert into audit_log (event_id, actor_kind, actor_operator_id, actor_label,
                         action, target_kind, target_id, before, after, reason)
  values (p_event_id, v_kind, p_operator_id, coalesce(v_label, 'system'),
          'lightbox_place', 'wall_cell', p_photo_id,
          jsonb_build_object('cell', p_cell_index, 'photoId', v_before),
          jsonb_build_object('cell', p_cell_index, 'photoId', p_photo_id),
          'wall placement');

  return query
    select wc.cell_index, wc.photo_id from wall_cells wc
     where wc.event_id = p_event_id and wc.cell_index = p_cell_index;
end;
$$;

/* --------------------------------------------------------------------- the Phase 2 gate */

create or replace function gate_phase_2()
returns table (area text, check_name text, expected text, actual text, pass boolean)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  a uuid; b uuid; opA uuid; opB uuid;
  p1 uuid; p2 uuid; p3 uuid; p4 uuid; pb uuid;
  n integer; t text; ok boolean;
begin
  perform gate_cleanup();

  insert into events (slug, name, status) values ('gate-wall', 'Gate Wall', 'live') returning id into a;
  insert into events (slug, name, status) values ('gate-wall-b', 'Gate Wall B', 'live') returning id into b;
  select id into opA from api_create_operator(a, 'gatewall', 'Gate Wall', 'A', 'operator', '8080');
  select id into opB from api_create_operator(b, 'gatewallb', 'Gate Wall B', 'A', 'operator', '8081');

  -- three publishable photos and one that is not
  p1 := gen_random_uuid(); p2 := gen_random_uuid(); p3 := gen_random_uuid(); p4 := gen_random_uuid();
  insert into photos (id, event_id, operator_id, kind, storage_path, thumb_path, bytes, status, approved, approved_by, approved_at)
  values (p1, a, opA, 'original', 'o/1.jpg', 't/1.jpg', 10, 'ready', true, opA, now()),
         (p2, a, opA, 'original', 'o/2.jpg', 't/2.jpg', 10, 'ready', true, opA, now()),
         (p3, a, opA, 'original', 'o/3.jpg', 't/3.jpg', 10, 'ready', true, opA, now());
  insert into photos (id, event_id, operator_id, kind, storage_path, thumb_path, bytes, status)
  values (p4, a, opA, 'original', 'o/4.jpg', 't/4.jpg', 10, 'ready');  -- never approved

  area := 'F lightbox'; check_name := 'autofill places only publishable photos';
  select count(*) into n from wall_lightbox('gate-wall');
  expected := '3'; actual := n::text; pass := (n = 3); return next;

  area := 'law E'; check_name := 'the unapproved photo is not among them';
  select count(*) into n from wall_lightbox('gate-wall') w where w.photo_id = p4;
  expected := '0'; actual := n::text; pass := (n = 0); return next;

  -- the placement is persisted state, not component memory
  area := 'F lightbox'; check_name := 'placement is identical on the next tick (a refresh)';
  select count(*) into n from wall_lightbox('gate-wall') w
   where w.photo_id in (p1, p2, p3);
  expected := '3'; actual := n::text; pass := (n = 3); return next;

  -- the publish gate outranks the wall, and outranks the freeze
  update events set wall_frozen = true, wall_frozen_at = now() where id = a;
  perform unapprove_photo(p2, opA);

  area := 'law E'; check_name := 'an unapproved photo leaves the wall even while frozen';
  select count(*) into n from wall_lightbox('gate-wall') w where w.photo_id = p2;
  expected := '0'; actual := n::text; pass := (n = 0); return next;

  area := 'F lightbox'; check_name := 'and a frozen wall takes nothing new in its place';
  select count(*) into n from wall_lightbox('gate-wall');
  expected := '2'; actual := n::text; pass := (n = 2); return next;

  update events set wall_frozen = false, wall_frozen_at = null where id = a;
  perform approve_photo(p2, opA);

  area := 'F lightbox'; check_name := 'unfrozen, the wall heals back to full';
  select count(*) into n from wall_lightbox('gate-wall');
  expected := '3'; actual := n::text; pass := (n = 3); return next;

  update events set panic_brand_only = true where id = a;

  area := 'law 5'; check_name := 'panic empties the lightbox';
  select count(*) into n from wall_lightbox('gate-wall');
  expected := '0'; actual := n::text; pass := (n = 0); return next;

  update events set panic_brand_only = false where id = a;

  area := 'F lightbox'; check_name := 'and it recovers alone when panic clears';
  select count(*) into n from wall_lightbox('gate-wall');
  expected := '3'; actual := n::text; pass := (n = 3); return next;

  -- manual placement: one photo, one cell
  perform api_lightbox_place(a, 27, p1, opA, null);
  perform api_lightbox_place(a, 5, p1, opA, null);

  area := 'F lightbox'; check_name := 'a photo placed by hand occupies exactly one cell';
  select count(*) into n from wall_cells where event_id = a and photo_id = p1;
  expected := '1'; actual := n::text; pass := (n = 1); return next;

  area := 'F lightbox'; check_name := 'and it is the cell it was last placed in';
  select wc.cell_index into n from wall_cells wc where wc.event_id = a and wc.photo_id = p1;
  expected := '5'; actual := n::text; pass := (n = 5); return next;

  area := 'law E'; check_name := 'the hand placement is in the audit trail';
  select count(*) into n from audit_log where event_id = a and action = 'lightbox_place';
  expected := '>= 2'; actual := n::text; pass := (n >= 2); return next;

  -- a cross-event placement is refused by the schema, not by vigilance
  pb := gen_random_uuid();
  insert into photos (id, event_id, operator_id, kind, storage_path, thumb_path, bytes, status, approved, approved_by, approved_at)
  values (pb, b, opB, 'original', 'o/b.jpg', 't/b.jpg', 10, 'ready', true, opB, now());
  begin
    insert into wall_cells (event_id, cell_index, photo_id) values (a, 9, pb);
    ok := false;
  exception when others then ok := true;
  end;
  area := 'law 5'; check_name := 'another event''s photo cannot be placed on this wall';
  expected := 'refused'; actual := case when ok then 'refused' else 'ALLOWED' end;
  pass := ok; return next;

  -- the public event shape structurally cannot leak operations data
  area := 'law 7'; check_name := 'the wall''s event shape has no AI, budget or spend columns';
  select pg_get_function_result(p.oid) into t
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'api_event_public';
  expected := 'absent from the type'; actual := left(coalesce(t, '(missing)'), 60);
  pass := (t is not null and t !~* '(ai_prompt|ai_model|budget|spend|generations|intake_paused)');
  return next;

  area := 'law 7'; check_name := 'the lightbox type cannot name an original';
  select pg_get_function_result(p.oid) into t
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'wall_lightbox';
  expected := 'no storage_path'; actual := left(coalesce(t, '(missing)'), 60);
  pass := (t is not null and t !~ 'storage_path'); return next;

  -- per-event layout, round-tripped through the update path the admin uses
  perform api_update_event('gate-wall', null, null, null, null, null,
                           '{"led":{"columns":5,"rows":3,"cycleSeconds":6,"brandPattern":"corners"}}'::jsonb);

  area := 'feature F'; check_name := 'the LED layout is a per-event setting that round-trips';
  select (ep.wall_config #>> '{led,columns}') into t from api_event_public('gate-wall') ep;
  expected := '5'; actual := coalesce(t, '(null)'); pass := (t = '5'); return next;

  area := 'law 5'; check_name := 'and the other event''s layout is untouched';
  select coalesce(ep.wall_config #>> '{led,columns}', '(unset)') into t from api_event_public('gate-wall-b') ep;
  expected := '(unset)'; actual := t; pass := (t = '(unset)'); return next;

  perform gate_cleanup();
  return;
end;
$$;

create or replace function run_all_gates()
returns table (phase text, area text, check_name text, expected text, actual text, pass boolean)
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select 'phase 0'::text, g.area, g.check_name, g.expected, g.actual, g.pass
    from run_phase_0_gate() g
  union all
  select 'phase 0'::text, g.area, g.check_name, g.expected, g.actual, g.pass
    from gate_phase_0_capture() g
  union all
  select 'phase 1'::text, g.area, g.check_name, g.expected, g.actual, g.pass
    from gate_phase_1() g
  union all
  select 'phase 2'::text, g.area, g.check_name, g.expected, g.actual, g.pass
    from gate_phase_2() g;
$$;

-- gate_cleanup must sweep the new table too, and before photos (FK order).
create or replace function gate_cleanup()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_ids uuid[];
begin
  select coalesce(array_agg(id), '{}') into v_ids from events where slug like 'gate-%';
  delete from wall_cells             where event_id = any(v_ids);
  delete from guest_codes            where event_id = any(v_ids);
  delete from ai_jobs                where event_id = any(v_ids);
  delete from photos                 where event_id = any(v_ids);
  delete from guests                 where event_id = any(v_ids);
  delete from audit_log              where event_id = any(v_ids);
  delete from ops_events             where event_id = any(v_ids);
  delete from ops_quota              where event_id = any(v_ids);
  delete from rate_limits            where event_id = any(v_ids);
  delete from operator_login_attempts where event_id = any(v_ids);
  delete from stations               where event_id = any(v_ids);
  delete from operators              where event_id = any(v_ids);
  delete from events                 where id = any(v_ids);
  delete from platform_rate_limits   where subject like 'gate-%';
  delete from admins                 where username like 'gateadmin%';
  delete from sweeper_runs           where sweeper like 'gate_%';
end;
$$;

select apply_function_grants();

do $$
declare v_count integer;
begin
  select count(*) into v_count from assert_schema_locked();
  if v_count > 0 then
    raise exception 'schema lock assertion failed with % violation(s) after 0019', v_count;
  end if;
end
$$;
