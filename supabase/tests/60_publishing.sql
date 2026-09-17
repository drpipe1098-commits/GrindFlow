-- =============================================================================
-- Pruebas del motor de publicacion
-- =============================================================================

\set QUIET on
\set ON_ERROR_STOP on
\set studio_a '00000000-0000-0000-0000-00000000a002'
\set editor_a '00000000-0000-0000-0000-00000000a003'
\set model_a1 '00000000-0000-0000-0000-00000000a004'
\set studio_b '00000000-0000-0000-0000-00000000b001'

\echo '== R. Un solo trabajo de publicacion vivo por programacion =='

reset role;
delete from public.jobs where job_type = 'publish';

-- Dos trabajos vivos para la misma fila publicarian el mismo contenido dos veces
-- en la cuenta de la modelo, y eso el publico si lo ve.
select tests.assert_affects(
  'insert into public.jobs (organization_id, job_type, payload)
   select organization_id, ''publish'', jsonb_build_object(''schedule_id'', id)
     from public.schedules limit 1', 1,
  'la primera publicacion de una programacion se encola');

select tests.assert_rejected(
  'insert into public.jobs (organization_id, job_type, payload)
   select organization_id, ''publish'', jsonb_build_object(''schedule_id'', id)
     from public.schedules limit 1',
  'la segunda se rechaza: publicar dos veces lo mismo se ve en la cuenta');

\echo '== S. Aplazar y matar trabajos =='

reset role;
set role service_role;

select tests.assert_count(
  'select * from public.claim_jobs(''pub-1'', 1, array[''publish'']::public.job_type[])', 1,
  'el worker de publicacion toma su trabajo');

-- Un 429 no es culpa del trabajo: la plataforma pidio esperar. Gastarle un
-- intento haria que una racha de 429 lo diera por muerto sin intentarlo de verdad.
select public.defer_job(
  (select id from public.jobs where claimed_by = 'pub-1' limit 1), 120, 'rate limit');

reset role;
select tests.assert(
  (select status = 'pending' and run_after > now() + interval '100 seconds' and attempts = 0
     from public.jobs where claimed_by = 'pub-1' limit 1),
  'aplazar devuelve el trabajo a pendiente, con espera y sin gastar intento');

set role service_role;
select public.kill_job(
  (select id from public.jobs where claimed_by = 'pub-1' limit 1), 'texto invalido');

reset role;
select tests.assert(
  (select status = 'dead' and last_error = 'texto invalido'
     from public.jobs where claimed_by = 'pub-1' limit 1),
  'matar un trabajo lo deja muerto sin agotar los cinco intentos');

\echo '== T. Suspension de envios por perfil y red =='

reset role;
select tests.assert(
  not app.is_publishing_suspended('00000000-0000-0000-0000-000000000f01', 'telegram'),
  'sin suspension, los envios estan permitidos');

insert into public.publish_suspensions
  (organization_id, profile_id, platform, reason, last_error)
values
  ('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000f01',
   'telegram', 'credencial rechazada por la plataforma', '401 Unauthorized');

select tests.assert(
  app.is_publishing_suspended('00000000-0000-0000-0000-000000000f01', 'telegram'),
  'tras un 401, los envios de ese perfil a esa red quedan parados');

-- Es por perfil Y red: que caiga el Telegram de una modelo no debe parar su X
-- ni el Telegram de sus companeras.
select tests.assert(
  not app.is_publishing_suspended('00000000-0000-0000-0000-000000000f01', 'x'),
  'la suspension no alcanza a las otras redes del mismo perfil');
select tests.assert(
  not app.is_publishing_suspended('00000000-0000-0000-0000-000000000f02', 'telegram'),
  'la suspension no alcanza a otras modelos de la misma agencia');

select tests.assert_rejected(
  'insert into public.publish_suspensions
     (organization_id, profile_id, platform, reason)
   values (''00000000-0000-0000-0000-0000000000aa'', ''00000000-0000-0000-0000-000000000f01'',
           ''telegram'', ''otra vez'')',
  'no se acumulan suspensiones vivas del mismo perfil y red');

-- Una suspension con `until` ya pasado se levanta sola.
update public.publish_suspensions set until = now() - interval '1 minute'
 where profile_id = '00000000-0000-0000-0000-000000000f01';
select tests.assert(
  not app.is_publishing_suspended('00000000-0000-0000-0000-000000000f01', 'telegram'),
  'una suspension caducada deja de contar sin que nadie haga nada');

update public.publish_suspensions set until = null
 where profile_id = '00000000-0000-0000-0000-000000000f01';

\echo '== U. Quien ve y quien levanta una suspension =='

select set_config('request.jwt.claims', json_build_object('sub', :'model_a1')::text, false);
set role authenticated;
select tests.assert_count('select * from public.publish_suspensions', 1,
  'la modelo ve por que se paro su cuenta');
select tests.assert_affects(
  'update public.publish_suspensions set lifted_at = now()
     where profile_id = ''00000000-0000-0000-0000-000000000f01''', 0,
  'la modelo NO puede levantar la suspension: implica reconectar la cuenta');

reset role;
select set_config('request.jwt.claims', json_build_object('sub', :'editor_a')::text, false);
set role authenticated;
select tests.assert_affects(
  'update public.publish_suspensions set lifted_at = now()
     where profile_id = ''00000000-0000-0000-0000-000000000f01''', 0,
  'el editor tampoco: no tiene acceso a las credenciales');

reset role;
select set_config('request.jwt.claims', json_build_object('sub', :'studio_b')::text, false);
set role authenticated;
select tests.assert_count('select * from public.publish_suspensions', 0,
  'el studio de Beta no ve las suspensiones de Alfa');

reset role;
select set_config('request.jwt.claims', json_build_object('sub', :'studio_a')::text, false);
set role authenticated;
select tests.assert_rejected(
  'insert into public.publish_suspensions
     (organization_id, profile_id, platform, reason)
   values (''00000000-0000-0000-0000-0000000000aa'', ''00000000-0000-0000-0000-000000000f02'',
           ''telegram'', ''a mano'')',
  'nadie crea suspensiones desde el panel: seria un boton para parar a otra persona');
select tests.assert_affects(
  'update public.publish_suspensions set lifted_at = now()
     where profile_id = ''00000000-0000-0000-0000-000000000f01''', 1,
  'el studio SI levanta la suspension tras reconectar la cuenta');

reset role;
select tests.assert(
  not app.is_publishing_suspended('00000000-0000-0000-0000-000000000f01', 'telegram'),
  'levantada la suspension, los envios se reanudan');

\echo '== V. Las compuertas siguen vigentes al publicar =='

reset role;
-- Pasar a 'publishing' vuelve a disparar el trigger de compuertas. No es
-- redundante: el expediente 2257 pudo caducar entre programar y publicar.
update public.compliance_records set expires_at = now() - interval '1 day'
 where profile_id = '00000000-0000-0000-0000-000000000f01';

select tests.assert_rejected(
  'update public.schedules set status = ''publishing''
     where profile_id = ''00000000-0000-0000-0000-000000000f01'' and status = ''queued''',
  'NO se publica si el expediente 2257 caduco despues de programar');

update public.compliance_records set expires_at = now() + interval '300 days'
 where profile_id = '00000000-0000-0000-0000-000000000f01';

\echo ''
\echo 'Publicacion: todas las aserciones pasaron.'
