-- =============================================================================
-- Pruebas de aislamiento RLS
-- =============================================================================
-- Cada bloque suplanta a un usuario real fijando el mismo `request.jwt.claims`
-- que pondria PostgREST y adoptando el rol `authenticated`. No hay atajos: si
-- una politica esta mal, estas consultas devuelven datos ajenos.

\set QUIET on
\set ON_ERROR_STOP on
\set studio_a '00000000-0000-0000-0000-00000000a002'
\set editor_a '00000000-0000-0000-0000-00000000a003'
\set model_a1 '00000000-0000-0000-0000-00000000a004'
\set studio_b '00000000-0000-0000-0000-00000000b001'
\set admin_p  '00000000-0000-0000-0000-00000000a001'
\set org_a    '00000000-0000-0000-0000-0000000000aa'
\set org_b    '00000000-0000-0000-0000-0000000000bb'

-- =====================================================================
\echo '== A. Aislamiento entre organizaciones =='
-- =====================================================================
reset role;
select set_config('request.jwt.claims', json_build_object('sub', :'studio_a')::text, false);
set role authenticated;

select tests.assert_count('select * from public.profiles', 2,
  'studio de Alfa ve las 2 modelos de su agencia');
select tests.assert_count('select * from public.media_assets', 3,
  'studio de Alfa ve los 3 assets de su agencia');
select tests.assert_count(
  format('select * from public.profiles where organization_id = %L', :'org_b'), 0,
  'studio de Alfa NO ve ningun perfil de Beta');
select tests.assert_count('select * from public.organizations', 1,
  'studio de Alfa solo ve su propia organizacion');

reset role;
select set_config('request.jwt.claims', json_build_object('sub', :'studio_b')::text, false);
set role authenticated;

select tests.assert_count('select * from public.media_assets', 1,
  'studio de Beta ve solo su unico asset');
select tests.assert_count('select * from public.financial_records', 1,
  'studio de Beta ve solo su propia liquidacion');
select tests.assert_count(
  'select * from public.media_assets where id = ''00000000-0000-0000-0000-000000000e01''', 0,
  'studio de Beta NO puede leer un asset de Alfa ni pidiendolo por id');
select tests.assert_count('select * from public.platform_credentials', 1,
  'studio de Beta solo ve sus propias credenciales');

select tests.assert_affects(
  'update public.media_assets set outfit_tag = ''secuestrado''
     where id = ''00000000-0000-0000-0000-000000000e01''', 0,
  'studio de Beta NO puede modificar un asset de Alfa');
select tests.assert_affects(
  'delete from public.tracking_links where id = ''00000000-0000-0000-0000-000000000c01''', 0,
  'studio de Beta NO puede borrar un enlace de Alfa');
select tests.assert_rejected(
  format('insert into public.profiles (organization_id, display_name, handle, r2_folder_path)
          values (%L, ''Intrusa'', ''intrusa'', ''x'')', :'org_a'),
  'studio de Beta NO puede crear un perfil dentro de Alfa');
select tests.assert_rejected(
  format('insert into public.media_assets
            (organization_id, profile_id, r2_key, file_type, mime_type, bytes)
          values (%L, ''00000000-0000-0000-0000-000000000f01'', ''intruso.jpg'',
                  ''image'', ''image/jpeg'', 1000)', :'org_a'),
  'studio de Beta NO puede inyectar un asset en un perfil de Alfa');

-- =====================================================================
\echo '== B. Aislamiento entre modelos de la MISMA organizacion =='
-- =====================================================================
reset role;
select set_config('request.jwt.claims', json_build_object('sub', :'model_a1')::text, false);
set role authenticated;

select tests.assert_count('select * from public.profiles', 1,
  'una modelo ve unicamente su propio perfil, no el de su companera');
select tests.assert_count('select * from public.media_assets', 2,
  'una modelo ve unicamente sus 2 assets');
select tests.assert_count(
  'select * from public.media_assets where id = ''00000000-0000-0000-0000-000000000e03''', 0,
  'una modelo NO ve el material de su companera de agencia');
select tests.assert_count('select * from public.financial_records', 1,
  'una modelo ve solo su propia liquidacion');
select tests.assert_count('select * from public.memberships', 1,
  'una modelo solo ve su propia membresia');
select tests.assert_count('select * from public.tracking_links', 1,
  'una modelo solo ve sus propios enlaces rastreados');

select tests.assert_rejected(
  'insert into public.media_assets (organization_id, profile_id, r2_key, file_type, mime_type, bytes)
   values (''00000000-0000-0000-0000-0000000000aa'', ''00000000-0000-0000-0000-000000000f02'',
           ''robado.jpg'', ''image'', ''image/jpeg'', 1000)',
  'una modelo NO puede subir contenido al perfil de otra');
select tests.assert_affects(
  'update public.profiles set display_name = ''Secuestrada''
     where id = ''00000000-0000-0000-0000-000000000f02''', 0,
  'una modelo NO puede editar el perfil de otra');

select tests.assert_rejected(
  'update public.users set role = ''admin'' where id = ''00000000-0000-0000-0000-00000000a004''',
  'una modelo NO puede ascenderse a admin de plataforma');
select tests.assert_rejected(
  'update public.profiles set rev_share_percentage = 100
     where id = ''00000000-0000-0000-0000-000000000f01''',
  'una modelo NO puede subirse su propio porcentaje de reparto');
select tests.assert_rejected(
  'update public.profiles set organization_id = ''00000000-0000-0000-0000-0000000000bb''
     where id = ''00000000-0000-0000-0000-000000000f01''',
  'un perfil NO puede fugarse a otra organizacion');

select tests.assert_affects(
  'update public.profiles set display_name = ''Alfa Uno Oficial''
     where id = ''00000000-0000-0000-0000-000000000f01''', 1,
  'una modelo SI puede editar su propio nombre publico');

-- =====================================================================
\echo '== C. El editor: ingesta si, datos sensibles no =='
-- =====================================================================
reset role;
select set_config('request.jwt.claims', json_build_object('sub', :'editor_a')::text, false);
set role authenticated;

select tests.assert_count('select * from public.media_assets', 3,
  'el editor ve todo el material de la agencia para poder prepararlo');
select tests.assert_count('select * from public.financial_records', 0,
  'el editor NO ve ninguna cifra de dinero');
select tests.assert_count('select * from public.compliance_records', 0,
  'el editor NO ve documentos de identidad ni expedientes 2257');
select tests.assert_count('select * from public.platform_credentials', 0,
  'el editor NO ve credenciales de las plataformas');
select tests.assert_rejected(
  'insert into public.financial_records
     (organization_id, profile_id, period_start, period_end, gross_amount, agency_fee)
   values (''00000000-0000-0000-0000-0000000000aa'', ''00000000-0000-0000-0000-000000000f01'',
           ''2026-04-01'', ''2026-04-30'', 999, 0)',
  'el editor NO puede inventar registros financieros');
select tests.assert_affects(
  'insert into public.media_assets (organization_id, profile_id, r2_key, file_type, mime_type, bytes)
   values (''00000000-0000-0000-0000-0000000000aa'', ''00000000-0000-0000-0000-000000000f02'',
           ''org-alfa/alfa_dos/set02/img009.jpg'', ''image'', ''image/jpeg'', 1500000)', 1,
  'el editor SI puede ingerir material para cualquier modelo de su agencia');

-- =====================================================================
\echo '== D. Admin de plataforma: cruza organizaciones =='
-- =====================================================================
reset role;
select set_config('request.jwt.claims', json_build_object('sub', :'admin_p')::text, false);
set role authenticated;

select tests.assert_count('select * from public.profiles', 3,
  'el admin de plataforma ve los perfiles de las dos agencias');
select tests.assert_count('select * from public.financial_records', 3,
  'el admin de plataforma ve todas las liquidaciones');
select tests.assert_count('select * from public.organizations', 2,
  'el admin de plataforma ve las dos organizaciones');

-- =====================================================================
\echo '== E. Visitante anonimo: solo el redirector =='
-- =====================================================================
reset role;
select set_config('request.jwt.claims', '', false);
set role anon;

-- El rechazo aqui llega antes que el RLS: a `anon` no se le concede ningun
-- privilegio sobre las tablas, asi que PostgreSQL corta en la capa de permisos.
-- Son dos barreras independientes, y esta es la de fuera.
select tests.assert_rejected('select * from public.tracking_links',
  'un anonimo NO puede ni tocar la tabla de enlaces rastreados');
select tests.assert_rejected('select * from public.media_assets',
  'un anonimo NO puede ni tocar la tabla de material');
select tests.assert_rejected('select * from public.profiles',
  'un anonimo NO puede ni tocar la tabla de perfiles');
select tests.assert_count(
  'select * from public.resolve_tracking_link(''alfa-tg-01'')', 1,
  'un anonimo SI puede resolver un slug vigente (es el redirector publico)');
select tests.assert_count(
  'select * from public.resolve_tracking_link(''no-existe'')', 0,
  'un slug inexistente no resuelve a nada');
select public.record_link_click('alfa-tg-01', 'co', 'https://t.me/canal', 'Chrome');

reset role;
select tests.assert_count(
  'select * from public.link_clicks where tracking_link_id = ''00000000-0000-0000-0000-000000000c01''', 1,
  'el clic anonimo quedo registrado por el RPC');
select tests.assert(
  (select clicks_count = 1 from public.tracking_links where slug = 'alfa-tg-01'),
  'el contador agregado del enlace subio a 1');

\echo ''
\echo 'RLS: todas las aserciones de aislamiento pasaron.'
