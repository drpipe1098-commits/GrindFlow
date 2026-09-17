-- =============================================================================
-- Pruebas de los conectores de nube
-- =============================================================================
-- `cloud_connections` guarda refresh tokens que dan acceso continuado al Drive
-- completo de una persona. Es la tabla mas sensible del esquema y se prueba como
-- tal: lo que importa no es quien puede leerla sino quien NO.

\set QUIET on
\set ON_ERROR_STOP on
\set studio_a '00000000-0000-0000-0000-00000000a002'
\set editor_a '00000000-0000-0000-0000-00000000a003'
\set model_a1 '00000000-0000-0000-0000-00000000a004'
\set studio_b '00000000-0000-0000-0000-00000000b001'

\echo '== L. Conectores de nube: acceso a los tokens =='

reset role;
insert into public.cloud_connections
  (id, organization_id, provider, account_email, label,
   access_ciphertext, refresh_ciphertext, token_expires_at, root_folder_id, default_profile_id)
values
  ('00000000-0000-0000-0000-000000000d01', '00000000-0000-0000-0000-0000000000aa',
   'google_drive', 'alfa@gmail.com', 'Drive de Agencia Alfa',
   'v1.aaa.bbb.ccc', 'v1.ddd.eee.fff', now() + interval '1 hour',
   'carpeta-alfa', '00000000-0000-0000-0000-000000000f01'),
  ('00000000-0000-0000-0000-000000000d02', '00000000-0000-0000-0000-0000000000bb',
   'dropbox', 'beta@gmail.com', 'Dropbox de Agencia Beta',
   'v1.ggg.hhh.iii', 'v1.jjj.kkk.lll', now() + interval '1 hour',
   'carpeta-beta', '00000000-0000-0000-0000-000000000f03');

insert into public.cloud_ingest_items
  (connection_id, organization_id, remote_file_id, remote_name, remote_mime_type, remote_size_bytes)
values
  ('00000000-0000-0000-0000-000000000d01', '00000000-0000-0000-0000-0000000000aa',
   'drive-file-001', 'sesion-2023-03-14.mp4', 'video/mp4', 840000000),
  ('00000000-0000-0000-0000-000000000d01', '00000000-0000-0000-0000-0000000000aa',
   'drive-file-002', 'IMG_0042.jpg', 'image/jpeg', 3200000),
  ('00000000-0000-0000-0000-000000000d02', '00000000-0000-0000-0000-0000000000bb',
   'dropbox-file-001', 'set-antiguo.jpg', 'image/jpeg', 2100000);

select set_config('request.jwt.claims', json_build_object('sub', :'studio_a')::text, false);
set role authenticated;

select tests.assert_count('select * from public.cloud_connections', 1,
  'el studio ve solo la conexion de su propia agencia');
select tests.assert_count('select * from public.cloud_ingest_items', 2,
  'el studio ve solo los archivos descubiertos en su agencia');

reset role;
select set_config('request.jwt.claims', json_build_object('sub', :'studio_b')::text, false);
set role authenticated;

select tests.assert_count(
  'select * from public.cloud_connections where organization_id = ''00000000-0000-0000-0000-0000000000aa''', 0,
  'el studio de Beta NO ve la conexion de Alfa ni sus refresh tokens');
select tests.assert_count('select * from public.cloud_ingest_items', 1,
  'el studio de Beta solo ve sus propios archivos descubiertos');
select tests.assert_rejected(
  'insert into public.cloud_connections
     (organization_id, provider, label, access_ciphertext, refresh_ciphertext, token_expires_at)
   values (''00000000-0000-0000-0000-0000000000aa'', ''dropbox'', ''intrusa'',
           ''x'', ''y'', now() + interval ''1 hour'')',
  'el studio de Beta NO puede conectar una nube dentro de Alfa');

\echo '== M. El editor y la modelo no tocan las llaves =='

reset role;
select set_config('request.jwt.claims', json_build_object('sub', :'editor_a')::text, false);
set role authenticated;

select tests.assert_count('select * from public.cloud_connections', 0,
  'el editor NO ve las conexiones de nube: necesita material, no llaves');
select tests.assert_count('select * from public.cloud_ingest_items', 2,
  'el editor SI ve el inventario de archivos: es quien cura que se ingiere');
select tests.assert_affects(
  'update public.cloud_ingest_items set status = ''skipped'', skip_reason = ''duplicado''
     where remote_file_id = ''drive-file-002''', 1,
  'el editor SI puede descartar un archivo');
select tests.assert_rejected(
  'insert into public.cloud_ingest_items
     (connection_id, organization_id, remote_file_id, remote_name)
   values (''00000000-0000-0000-0000-000000000d01'', ''00000000-0000-0000-0000-0000000000aa'',
           ''inventado-001'', ''inventado.jpg'')',
  'nadie puede inventar archivos remotos: solo los crea el worker de escaneo');

reset role;
select set_config('request.jwt.claims', json_build_object('sub', :'model_a1')::text, false);
set role authenticated;

select tests.assert_count('select * from public.cloud_connections', 0,
  'una modelo NO ve las conexiones de nube de su agencia');

\echo '== N. Deduplicacion del escaneo =='

reset role;
-- Sin esta restriccion, cada pasada del escaneo volveria a descargar los mismos
-- gigabytes y crearia assets duplicados en el vault.
select tests.assert_rejected(
  'insert into public.cloud_ingest_items
     (connection_id, organization_id, remote_file_id, remote_name)
   values (''00000000-0000-0000-0000-000000000d01'', ''00000000-0000-0000-0000-0000000000aa'',
           ''drive-file-001'', ''sesion-2023-03-14.mp4'')',
  'el mismo archivo remoto no se registra dos veces en la misma conexion');

select tests.assert_rejected(
  'insert into public.cloud_connections
     (organization_id, provider, account_email, label,
      access_ciphertext, refresh_ciphertext, token_expires_at)
   values (''00000000-0000-0000-0000-0000000000aa'', ''google_drive'', ''alfa@gmail.com'',
           ''Duplicada'', ''x'', ''y'', now() + interval ''1 hour'')',
  'una misma cuenta remota no se conecta dos veces a la misma organizacion');

select tests.assert(
  (select default_profile_id is not null from public.cloud_connections
    where id = '00000000-0000-0000-0000-000000000d01'),
  'la conexion apunta al perfil destino por defecto');

\echo '== O. Enrutado, duplicados y acceso a la cola =='

reset role;
select tests.assert_rejected(
  'update public.cloud_ingest_items set content_sha256 = ''no-es-un-hash''
     where remote_file_id = ''drive-file-001''',
  'content_sha256 solo acepta un SHA-256 en hexadecimal');

select tests.assert_rejected(
  'update public.cloud_ingest_items set assignment_source = ''adivinado''
     where remote_file_id = ''drive-file-001''',
  'assignment_source solo acepta default, folder_match o manual');

-- Un duplicado NO se descarta: se conserva con el enlace al original, para que
-- el panel pueda explicar por que ese archivo no se publicara otra vez.
select tests.assert_affects(
  'update public.cloud_ingest_items
      set status = ''duplicate'',
          duplicate_of_item_id = (select id from public.cloud_ingest_items
                                   where remote_file_id = ''drive-file-001''),
          skip_reason = ''mismo contenido que un archivo ya ingerido''
    where remote_file_id = ''drive-file-002''', 1,
  'un duplicado se marca y apunta al original, en vez de desaparecer');

select tests.assert(
  (select duplicate_of_item_id is not null and skip_reason is not null
     from public.cloud_ingest_items where remote_file_id = 'drive-file-002'),
  'el duplicado conserva el motivo y el enlace al original');

-- La cola es de los workers. Un cliente con sesion no puede tomar trabajos.
select set_config('request.jwt.claims', json_build_object('sub', :'studio_a')::text, false);
set role authenticated;
select tests.assert_rejected(
  'select * from public.claim_jobs(''intruso'', 1)',
  'un usuario con sesion NO puede tomar trabajos de la cola');
select tests.assert_rejected(
  'select public.complete_job(gen_random_uuid(), true)',
  'un usuario con sesion NO puede cerrar trabajos');

reset role;
set role anon;
select tests.assert_rejected(
  'select * from public.claim_jobs(''intruso'', 1)',
  'un anonimo tampoco alcanza la cola');

reset role;
insert into public.jobs (organization_id, job_type, payload)
values ('00000000-0000-0000-0000-0000000000aa', 'scan_cloud_folder',
        jsonb_build_object('connection_id', '00000000-0000-0000-0000-000000000d01'));

-- Recorrido real del worker de Node: tomar por el envoltorio publico y cerrar.
-- Comprobar solo el permiso dejaria sin verificar que el envoltorio delega bien
-- en `app.claim_jobs`, que es donde vive el SKIP LOCKED.
set role service_role;
select tests.assert_count(
  'select * from public.claim_jobs(''ingest-1'', 5, array[''scan_cloud_folder'']::public.job_type[])', 1,
  'service_role toma el trabajo de escaneo por el envoltorio publico');

select tests.assert_count(
  'select * from public.claim_jobs(''ingest-2'', 5, array[''scan_cloud_folder'']::public.job_type[])', 0,
  'un segundo worker no recibe el mismo trabajo: el SKIP LOCKED sigue vigente');

select public.complete_job(
  (select id from public.jobs where claimed_by = 'ingest-1' limit 1), true);

reset role;
select tests.assert(
  (select status = 'done' from public.jobs where claimed_by = 'ingest-1' limit 1),
  'cerrar por el envoltorio deja el trabajo en done');

\echo '== P. Triaje y cadencia de escaneo =='

reset role;
insert into public.cloud_ingest_items
  (id, connection_id, organization_id, remote_file_id, remote_name, remote_path,
   remote_mime_type, remote_size_bytes, status, matched_folder, skip_reason)
values
  ('00000000-0000-0000-0000-000000000e91', '00000000-0000-0000-0000-000000000d01',
   '00000000-0000-0000-0000-0000000000aa', 'drive-file-091', 'sin-duena.jpg',
   '/Modelos/carpeta-vieja/sin-duena.jpg', 'image/jpeg', 1200000,
   'unassigned', 'carpeta-vieja', 'sin_coincidencia');

-- El editor hace el triaje: decide que material entra.
select set_config('request.jwt.claims', json_build_object('sub', :'editor_a')::text, false);
set role authenticated;

select tests.assert_count(
  'select * from public.cloud_ingest_items where status = ''unassigned''', 1,
  'el editor ve la cola de triaje de su agencia');

select tests.assert_affects(
  'update public.cloud_ingest_items
      set profile_id = ''00000000-0000-0000-0000-000000000f01'',
          status = ''queued'',
          assignment_source = ''manual''
    where id = ''00000000-0000-0000-0000-000000000e91''', 1,
  'el editor asigna un archivo del triaje a una modelo de su agencia');

-- La clave foranea compuesta es lo que impide asignar a una modelo de otra
-- agencia. Sin ella, un id de perfil ajeno colado en la peticion bastaria.
select tests.assert_rejected(
  'update public.cloud_ingest_items
      set profile_id = ''00000000-0000-0000-0000-000000000f03''
    where id = ''00000000-0000-0000-0000-000000000e91''',
  'NO se puede asignar un archivo a una modelo de otra organizacion');

reset role;
select set_config('request.jwt.claims', json_build_object('sub', :'studio_b')::text, false);
set role authenticated;
select tests.assert_affects(
  'update public.cloud_ingest_items set status = ''skipped''
     where id = ''00000000-0000-0000-0000-000000000e91''', 0,
  'el studio de Beta NO puede tocar el triaje de Alfa');

\echo '== Q. Un solo escaneo vivo por conexion =='

reset role;
-- El programador corre dentro del worker y puede haber varias replicas. Sin esta
-- restriccion, cuatro replicas que despiertan a la vez recorren cuatro veces la
-- misma cuenta.
delete from public.jobs where job_type = 'scan_cloud_folder';

select tests.assert_affects(
  'insert into public.jobs (organization_id, job_type, payload)
   values (''00000000-0000-0000-0000-0000000000aa'', ''scan_cloud_folder'',
           jsonb_build_object(''connection_id'', ''00000000-0000-0000-0000-000000000d01''))', 1,
  'el primer escaneo de una conexion se encola');

select tests.assert_rejected(
  'insert into public.jobs (organization_id, job_type, payload)
   values (''00000000-0000-0000-0000-0000000000aa'', ''scan_cloud_folder'',
           jsonb_build_object(''connection_id'', ''00000000-0000-0000-0000-000000000d01''))',
  'un segundo escaneo de la MISMA conexion se rechaza mientras el primero vive');

select tests.assert_affects(
  'insert into public.jobs (organization_id, job_type, payload)
   values (''00000000-0000-0000-0000-0000000000bb'', ''scan_cloud_folder'',
           jsonb_build_object(''connection_id'', ''00000000-0000-0000-0000-000000000d02''))', 1,
  'otra conexion si puede encolar el suyo: la restriccion es por conexion');

update public.jobs set status = 'done'
 where job_type = 'scan_cloud_folder'
   and payload ->> 'connection_id' = '00000000-0000-0000-0000-000000000d01';

select tests.assert_affects(
  'insert into public.jobs (organization_id, job_type, payload)
   values (''00000000-0000-0000-0000-0000000000aa'', ''scan_cloud_folder'',
           jsonb_build_object(''connection_id'', ''00000000-0000-0000-0000-000000000d01''))', 1,
  'terminado el anterior, la siguiente pasada vuelve a encolarse');

select tests.assert_rejected(
  'update public.cloud_connections set scan_interval_minutes = 1
     where id = ''00000000-0000-0000-0000-000000000d01''',
  'la cadencia no baja de cinco minutos: escanear cada minuto agota la cuota del proveedor');

\echo ''
\echo 'Conectores: todas las aserciones pasaron.'
