-- =============================================================================
-- Pruebas de las compuertas duras de la base
-- =============================================================================
-- Aqui no se prueba quien ve que, sino que la base se niegue a aceptar datos
-- peligrosos aunque quien los envie tenga todos los permisos.

\set QUIET on
\set ON_ERROR_STOP on
\set studio_a '00000000-0000-0000-0000-00000000a002'

\echo '== F. Compuertas de publicacion =='
reset role;
select set_config('request.jwt.claims', json_build_object('sub', :'studio_a')::text, false);
set role authenticated;

select tests.assert_affects(
  'insert into public.schedules
     (organization_id, profile_id, asset_id, platform, scheduled_at, caption_text)
   values (''00000000-0000-0000-0000-0000000000aa'', ''00000000-0000-0000-0000-000000000f01'',
           ''00000000-0000-0000-0000-000000000e01'', ''telegram'',
           now() + interval ''2 hours'', ''Nuevo set disponible'')', 1,
  'se programa un asset sanitizado de una modelo con expediente vigente');

-- El asset e02 conserva EXIF: publicarlo podria revelar el domicilio de la
-- modelo. Es la barrera mas importante del sistema.
select tests.assert_rejected(
  'insert into public.schedules
     (organization_id, profile_id, asset_id, platform, scheduled_at, caption_text)
   values (''00000000-0000-0000-0000-0000000000aa'', ''00000000-0000-0000-0000-000000000f01'',
           ''00000000-0000-0000-0000-000000000e02'', ''telegram'',
           now() + interval ''3 hours'', ''Video nuevo'')',
  'NO se programa un asset que aun conserva metadatos EXIF/GPS');

-- El perfil alfa_dos no tiene expediente 2257 verificado.
select tests.assert_rejected(
  'insert into public.schedules
     (organization_id, profile_id, asset_id, platform, scheduled_at, caption_text)
   values (''00000000-0000-0000-0000-0000000000aa'', ''00000000-0000-0000-0000-000000000f02'',
           ''00000000-0000-0000-0000-000000000e03'', ''telegram'',
           now() + interval ''4 hours'', ''Set nuevo'')',
  'NO se programa contenido de una modelo sin expediente 2257 verificado');

select tests.assert_rejected(
  'insert into public.schedules
     (organization_id, profile_id, asset_id, platform, scheduled_at, caption_text)
   values (''00000000-0000-0000-0000-0000000000aa'', ''00000000-0000-0000-0000-000000000f01'',
           ''00000000-0000-0000-0000-000000000e01'', ''telegram'',
           now() + interval ''9 hours'', ''Repetido'')',
  'NO se puede encolar dos veces el mismo asset en la misma plataforma');

\echo '== G. Integridad del expediente y del dinero =='
reset role;

select tests.assert_rejected(
  'insert into public.compliance_records (organization_id, profile_id, status, verified_at)
   values (''00000000-0000-0000-0000-0000000000aa'', ''00000000-0000-0000-0000-000000000f02'',
           ''verified'', now())',
  'un expediente NO se marca verificado sin documento, liberacion ni custodio');

select tests.assert_rejected(
  'insert into public.compliance_records
     (organization_id, profile_id, status, id_document_r2_key, model_release_r2_key,
      date_of_birth, verified_at, custodian_name)
   values (''00000000-0000-0000-0000-0000000000aa'', ''00000000-0000-0000-0000-000000000f02'',
           ''verified'', ''a.pdf'', ''b.pdf'', current_date - interval ''17 years'',
           now(), ''Agencia Alfa S.A.S.'')',
  'NO se verifica un expediente de una persona menor de 18 anos');

select tests.assert_rejected(
  'insert into public.financial_records
     (organization_id, profile_id, period_start, period_end, gross_amount, agency_fee)
   values (''00000000-0000-0000-0000-0000000000aa'', ''00000000-0000-0000-0000-000000000f01'',
           ''2026-05-01'', ''2026-05-31'', 1000, 1500)',
  'la comision de la agencia NO puede superar lo facturado');

select tests.assert_rejected(
  'insert into public.financial_records
     (organization_id, profile_id, period_start, period_end, gross_amount, agency_fee)
   values (''00000000-0000-0000-0000-0000000000aa'', ''00000000-0000-0000-0000-000000000f01'',
           ''2026-03-01'', ''2026-03-31'', 500, 100)',
  'NO se puede duplicar la liquidacion de un perfil para el mismo periodo');

select tests.assert(
  (select net_amount = 2940.00 from public.financial_records
    where profile_id = '00000000-0000-0000-0000-000000000f01' and period_start = '2026-03-01'),
  'el neto de la modelo lo calcula la base: 4200 - 1260 = 2940');

\echo '== H. Cola de trabajos =='
reset role;
insert into public.jobs (organization_id, job_type, payload)
select '00000000-0000-0000-0000-0000000000aa', 'sanitize_exif',
       jsonb_build_object('asset_id', '00000000-0000-0000-0000-000000000e02', 'n', g)
from generate_series(1, 3) g;

select tests.assert_count(
  'select * from app.claim_jobs(''worker-1'', 2)', 2,
  'un worker toma exactamente el lote que pidio');
select tests.assert_count(
  'select * from app.claim_jobs(''worker-2'', 5)', 1,
  'un segundo worker recibe solo lo que quedaba: nada se entrega dos veces');
select tests.assert_count(
  'select * from app.claim_jobs(''worker-3'', 5)', 0,
  'sin trabajos pendientes, la cola no devuelve nada');

select app.complete_job(id, false, 'ffmpeg: exit 1')
from public.jobs where claimed_by = 'worker-1' limit 1;

select tests.assert(
  (select status = 'pending' and attempts = 1 and run_after > now()
     from public.jobs where claimed_by = 'worker-1' and last_error is not null limit 1),
  'un trabajo fallido vuelve a pendiente con espera exponencial');

\echo ''
\echo 'Compuertas: todas las aserciones pasaron.'
