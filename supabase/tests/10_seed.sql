-- =============================================================================
-- Datos de prueba: dos agencias que NUNCA deben verse entre si
-- =============================================================================
--   Agencia Alfa (orgA)          Agencia Beta (orgB)
--     studio_a  (studio)           studio_b (studio)
--     editor_a  (editor)           perfil beta_uno
--     model_a1  (model) -> perfil alfa_uno
--     model_a2  (model) -> perfil alfa_dos
--   admin_plataforma: rol 'admin' global, sin membresia en ninguna.

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000a001', 'admin@grindflow.test',  '{"role":"admin"}'),
  ('00000000-0000-0000-0000-00000000a002', 'studioa@grindflow.test','{"role":"studio"}'),
  ('00000000-0000-0000-0000-00000000a003', 'editora@grindflow.test','{"role":"editor"}'),
  ('00000000-0000-0000-0000-00000000a004', 'modela1@grindflow.test','{"role":"model"}'),
  ('00000000-0000-0000-0000-00000000a005', 'modela2@grindflow.test','{"role":"model"}'),
  ('00000000-0000-0000-0000-00000000b001', 'studiob@grindflow.test','{"role":"studio"}');

insert into public.organizations (id, name, slug, type) values
  ('00000000-0000-0000-0000-0000000000aa', 'Agencia Alfa', 'agencia-alfa', 'studio'),
  ('00000000-0000-0000-0000-0000000000bb', 'Agencia Beta', 'agencia-beta', 'studio');

insert into public.memberships (organization_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-00000000a002', 'studio'),
  ('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-00000000a003', 'editor'),
  ('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-00000000a004', 'model'),
  ('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-00000000a005', 'model'),
  ('00000000-0000-0000-0000-0000000000bb', '00000000-0000-0000-0000-00000000b001', 'studio');

insert into public.profiles (id, organization_id, user_id, display_name, handle, rev_share_percentage, r2_folder_path) values
  ('00000000-0000-0000-0000-000000000f01', '00000000-0000-0000-0000-0000000000aa',
   '00000000-0000-0000-0000-00000000a004', 'Alfa Uno', 'alfa_uno', 70.00, 'org-alfa/alfa_uno'),
  ('00000000-0000-0000-0000-000000000f02', '00000000-0000-0000-0000-0000000000aa',
   '00000000-0000-0000-0000-00000000a005', 'Alfa Dos', 'alfa_dos', 65.00, 'org-alfa/alfa_dos'),
  ('00000000-0000-0000-0000-000000000f03', '00000000-0000-0000-0000-0000000000bb',
   null, 'Beta Uno', 'beta_uno', 80.00, 'org-beta/beta_uno');

-- Expediente 2257 vigente solo para alfa_uno. alfa_dos queda sin verificar a
-- proposito: las pruebas comprueban que su contenido no se puede programar.
insert into public.compliance_records
  (organization_id, profile_id, status, id_document_r2_key, model_release_r2_key,
   date_of_birth, verified_at, expires_at, verified_by, custodian_name)
values
  ('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000f01',
   'verified', 'compliance/alfa_uno/id.pdf', 'compliance/alfa_uno/release.pdf',
   '1996-04-11', now() - interval '30 days', now() + interval '335 days',
   '00000000-0000-0000-0000-00000000a002', 'Agencia Alfa S.A.S.'),
  ('00000000-0000-0000-0000-0000000000bb', '00000000-0000-0000-0000-000000000f03',
   'verified', 'compliance/beta_uno/id.pdf', 'compliance/beta_uno/release.pdf',
   '1994-09-02', now() - interval '60 days', now() + interval '305 days',
   '00000000-0000-0000-0000-00000000b001', 'Agencia Beta S.A.S.');

insert into public.media_assets
  (id, organization_id, profile_id, r2_key, file_type, mime_type, bytes, sanitized, outfit_tag, status)
values
  ('00000000-0000-0000-0000-000000000e01', '00000000-0000-0000-0000-0000000000aa',
   '00000000-0000-0000-0000-000000000f01', 'org-alfa/alfa_uno/set01/img001.jpg',
   'image', 'image/jpeg', 2400000, true, 'lenceria-roja', 'edited'),
  ('00000000-0000-0000-0000-000000000e02', '00000000-0000-0000-0000-0000000000aa',
   '00000000-0000-0000-0000-000000000f01', 'org-alfa/alfa_uno/set01/vid001.mp4',
   'video', 'video/mp4', 84000000, false, 'lenceria-roja', 'raw'),
  ('00000000-0000-0000-0000-000000000e03', '00000000-0000-0000-0000-0000000000aa',
   '00000000-0000-0000-0000-000000000f02', 'org-alfa/alfa_dos/set01/img001.jpg',
   'image', 'image/jpeg', 1900000, true, 'vestido-negro', 'edited'),
  ('00000000-0000-0000-0000-000000000e04', '00000000-0000-0000-0000-0000000000bb',
   '00000000-0000-0000-0000-000000000f03', 'org-beta/beta_uno/set01/img001.jpg',
   'image', 'image/jpeg', 2100000, true, 'bikini-azul', 'edited');

insert into public.tracking_links
  (id, organization_id, profile_id, asset_id, slug, destination_url, campaign, network)
values
  ('00000000-0000-0000-0000-000000000c01', '00000000-0000-0000-0000-0000000000aa',
   '00000000-0000-0000-0000-000000000f01', '00000000-0000-0000-0000-000000000e01',
   'alfa-tg-01', 'https://onlyfans.com/alfa_uno', 'lanzamiento-abril', 'telegram'),
  ('00000000-0000-0000-0000-000000000c02', '00000000-0000-0000-0000-0000000000bb',
   '00000000-0000-0000-0000-000000000f03', null,
   'beta-x-01', 'https://onlyfans.com/beta_uno', 'lanzamiento-abril', 'x');

insert into public.financial_records
  (organization_id, profile_id, period_start, period_end, gross_amount, agency_fee, payout_status, paid_at)
values
  ('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000f01',
   '2026-03-01', '2026-03-31', 4200.00, 1260.00, 'paid', now() - interval '5 days'),
  ('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000f02',
   '2026-03-01', '2026-03-31', 2800.00, 980.00, 'pending', null),
  ('00000000-0000-0000-0000-0000000000bb', '00000000-0000-0000-0000-000000000f03',
   '2026-03-01', '2026-03-31', 9100.00, 1820.00, 'approved', null);

insert into public.platform_credentials
  (organization_id, profile_id, platform, credential_type, label, account_identifier, secret_ciphertext)
values
  ('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000f01',
   'telegram', 'api_key', 'Canal Alfa Uno', '@alfa_uno_teasers', 'cifrado:aaaa'),
  ('00000000-0000-0000-0000-0000000000bb', '00000000-0000-0000-0000-000000000f03',
   'telegram', 'api_key', 'Canal Beta Uno', '@beta_uno_teasers', 'cifrado:bbbb');
