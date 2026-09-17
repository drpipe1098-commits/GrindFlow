-- =============================================================================
-- Pruebas del limite de tasa del acortador
-- =============================================================================
-- Sobre el conteo de clics se reparte dinero, asi que inflarlo no es vandalismo
-- sino fraude. Estas aserciones se ejecutan como `anon`, que es exactamente el
-- rol desde el que se intentaria.

\set QUIET on
\set ON_ERROR_STOP on

\echo '== I. Limite de tasa por IP =='

reset role;
-- Se parte de cero para que las cuentas sean exactas.
delete from public.link_clicks;
update public.tracking_links set clicks_count = 0;

select set_config('request.jwt.claims', '', false);
set role anon;

select tests.assert(
  public.record_link_click('alfa-tg-01', 'co', null, 'Chrome', 'hash-ip-aaa'),
  'el primer clic de una IP se cuenta');

select tests.assert(
  not public.record_link_click('alfa-tg-01', 'co', null, 'Chrome', 'hash-ip-aaa'),
  'el segundo clic de la MISMA IP dentro de la ventana NO se cuenta');

select tests.assert(
  not public.record_link_click('alfa-tg-01', 'co', null, 'Chrome', 'hash-ip-aaa'),
  'insistir tampoco cuenta: el contador no se puede inflar a base de refrescos');

select tests.assert(
  public.record_link_click('alfa-tg-01', 'mx', null, 'Safari', 'hash-ip-bbb'),
  'un visitante distinto SI se cuenta');

select tests.assert(
  public.record_link_click('beta-x-01', 'co', null, 'Chrome', 'hash-ip-aaa'),
  'la misma IP sobre OTRO enlace se cuenta: la ventana es por enlace');

reset role;
select tests.assert(
  (select clicks_count = 2 from public.tracking_links where slug = 'alfa-tg-01'),
  'el contador refleja 2 visitantes, no los 4 intentos');

\echo '== J. Degradacion segura y caducidad de la ventana =='

set role anon;
-- Omitir el hash no debe ser una via de escape: esos clics comparten un unico
-- cubo y se limitan entre ellos.
select tests.assert(
  public.record_link_click('alfa-tg-01', 'co', null, 'Chrome', null),
  'un clic sin hash de IP se cuenta la primera vez');

select tests.assert(
  not public.record_link_click('alfa-tg-01', 'co', null, 'Chrome', null),
  'omitir el hash de IP NO permite saltarse el limite');

select tests.assert(
  not public.record_link_click('alfa-tg-01', 'co', null, 'Chrome', '   '),
  'un hash en blanco cae en el mismo cubo compartido');

reset role;
-- Envejecer los clics simula que la ventana ya paso.
update public.link_clicks set occurred_at = now() - interval '2 minutes';

set role anon;
select tests.assert(
  public.record_link_click('alfa-tg-01', 'co', null, 'Chrome', 'hash-ip-aaa'),
  'pasada la ventana, la misma IP vuelve a contar');

\echo '== K. La IP nunca se guarda en claro =='

reset role;
select tests.assert(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'link_clicks'
      and data_type in ('inet', 'cidr')
  ),
  'link_clicks no tiene ninguna columna de tipo IP');

select tests.assert(
  not exists (select 1 from public.link_clicks where ip_hash !~ '^[a-z0-9-]+$'),
  'todo lo almacenado en ip_hash es un hash, no una direccion');

\echo ''
\echo 'Limite de tasa: todas las aserciones pasaron.'
