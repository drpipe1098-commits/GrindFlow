-- =============================================================================
-- Aserciones para las pruebas de RLS
-- =============================================================================
create schema if not exists tests;

create or replace function tests.assert(p_condition boolean, p_msg text)
returns void
language plpgsql
as $$
begin
  if p_condition is not true then
    raise exception 'FALLO: %', p_msg;
  end if;
  raise notice '  ok  %', p_msg;
end;
$$;

create or replace function tests.assert_count(p_sql text, p_expected bigint, p_msg text)
returns void
language plpgsql
as $$
declare
  v_actual bigint;
begin
  execute 'select count(*) from (' || p_sql || ') s' into v_actual;
  if v_actual is distinct from p_expected then
    raise exception 'FALLO: % (esperaba % filas, obtuvo %)', p_msg, p_expected, v_actual;
  end if;
  raise notice '  ok  % [% filas]', p_msg, v_actual;
end;
$$;

-- Ejecuta una sentencia esperando que la base la rechace. Si pasa, es un agujero.
create or replace function tests.assert_rejected(p_sql text, p_msg text)
returns void
language plpgsql
as $$
begin
  begin
    execute p_sql;
  exception when others then
    raise notice '  ok  % [rechazado: %]', p_msg, left(sqlerrm, 70);
    return;
  end;
  raise exception 'FALLO: % — la sentencia fue ACEPTADA y debia rechazarse', p_msg;
end;
$$;

-- Cuenta las filas que una escritura alcanza realmente. Bajo RLS, un UPDATE o
-- DELETE sobre filas ajenas no lanza error: simplemente no afecta a nadie. Por
-- eso se mide el alcance en vez de esperar una excepcion.
create or replace function tests.assert_affects(p_sql text, p_expected bigint, p_msg text)
returns void
language plpgsql
as $$
declare
  v_actual bigint;
begin
  execute p_sql;
  get diagnostics v_actual = row_count;
  if v_actual is distinct from p_expected then
    raise exception 'FALLO: % (esperaba afectar % filas, afecto %)', p_msg, p_expected, v_actual;
  end if;
  raise notice '  ok  % [% filas afectadas]', p_msg, v_actual;
end;
$$;

-- En un proyecto Supabase real, `service_role` tiene acceso completo al esquema
-- publico ademas de BYPASSRLS. El arranque de pruebas lo reproduce aqui, ya
-- aplicadas las migraciones: sin esto, una prueba que actue como worker chocaria
-- con un "permission denied" que no existe en produccion y llevaria a debilitar
-- la configuracion real para que pasara.
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- `service_role` incluido: las pruebas de la cola se ejecutan con ese rol,
-- que es el que usan los workers de Node.
grant usage on schema tests to authenticated, anon, service_role;
grant execute on all functions in schema tests to authenticated, anon, service_role;
