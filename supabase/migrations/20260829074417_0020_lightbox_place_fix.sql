-- 0020_lightbox_place_fix.sql
--
-- The Phase 2 gate caught api_lightbox_place failing at runtime: its RETURNS TABLE declares an
-- OUT column named cell_index, and inside PL/pgSQL that name shadows the table column in
-- `on conflict (event_id, cell_index)` - an ambiguity Postgres only resolves when the
-- statement actually runs, which is why 0019 applied cleanly and then failed under test.
-- Naming the constraint instead of its columns removes the collision without changing the
-- function's public shape.
--
-- Append-only. Never edit a migration that has been applied; add a new one.

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
    on conflict on constraint wall_cells_pkey
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

select apply_function_grants();

-- Applying this migration proves the fix: the whole suite must pass, including the placement
-- checks that exposed the ambiguity.
do $$
declare v_fails integer;
begin
  select count(*) into v_fails from run_all_gates() where not pass;
  if v_fails > 0 then
    raise exception 'gate suite red after 0020: % failing check(s)', v_fails;
  end if;
end
$$;
