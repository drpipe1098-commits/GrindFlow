-- =============================================================================
-- 001300 — Estados nuevos del inventario de ingesta
-- =============================================================================
-- Van en su propio archivo porque PostgreSQL no permite usar un valor de enum en
-- la misma transaccion en que se crea, y la migracion siguiente los usa.

-- Descubierto, pero sin perfil al que asignarlo. No es un error: es el caso
-- normal de una carpeta compartida de estudio donde el nombre de la subcarpeta
-- no coincidio con ninguna modelo. Queda esperando triaje manual.
alter type public.cloud_item_status add value if not exists 'unassigned';

-- Ya existe el mismo contenido en el vault. NO se descarta en silencio: la fila
-- se conserva con este estado y con el enlace al original, para que el panel
-- pueda explicar por que ese archivo no se va a publicar otra vez. Un descarte
-- silencioso solo genera un ticket de soporte tres semanas despues.
alter type public.cloud_item_status add value if not exists 'duplicate';
