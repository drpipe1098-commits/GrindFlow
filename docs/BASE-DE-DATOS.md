# Base de datos

Diez migraciones, en `supabase/migrations/`, que se aplican en orden alfabetico.

| Archivo | Contenido |
|---|---|
| `000000_extensions_and_enums` | Esquema `app`, extensiones y los diez tipos enumerados |
| `000100_core_tenancy` | `organizations`, `users`, `memberships`, `profiles` |
| `000200_compliance` | Expediente 2257 y la funcion de vigencia |
| `000300_media_and_uploads` | `media_assets`, `upload_links`, bitacora de subidas |
| `000400_scheduling` | `schedules`, `scheduling_rules` y las compuertas de publicacion |
| `000500_distribution_and_jobs` | Credenciales de plataforma y cola de trabajos |
| `000600_tracking_links` | Enlaces cortos, clics y los dos RPC publicos |
| `000700_financial` | Libro de reparto de ingresos |
| `000800_rls_helpers` | Funciones de autorizacion y trigger anti-escalada |
| `000900_rls_policies` | Politicas RLS de las catorce tablas |

## Decisiones que se apartan del PRD original

**`profiles` no comparte id con `users`.** El PRD lo planteaba como clave foranea
directa. Pero una agencia registra a sus modelos antes de darles acceso —a veces
sin darselo nunca— asi que `user_id` es opcional y se enlaza despues. Compartir
el id habria obligado a crear una cuenta ficticia por cada modelo.

**`organization_id` desnormalizado en las tablas hijas.** Esta repetido en
`media_assets`, `schedules`, `tracking_links` y las demas para que el RLS filtre
sin un JOIN en cada consulta. Para que no pueda desincronizarse del perfil, cada
tabla lleva una clave foranea compuesta contra `profiles (id, organization_id)`:
la base garantiza la coherencia, no la aplicacion.

**`net_amount` es una columna generada.** El neto de la modelo no depende de que
la aplicacion haga bien la resta.

**Denegar por defecto.** El RLS se activa en la migracion que crea cada tabla y
las politicas llegan en la ultima. Entre una y otra las tablas estan cerradas,
nunca abiertas.

## Las compuertas duras

Se imponen con triggers y restricciones, no desde la interfaz, para que ningun
script, worker ni llamada directa a la API pueda rodearlas.

- No se programa contenido de un perfil sin expediente 2257 verificado y vigente.
- No se programa un asset que aun conserva metadatos EXIF/GPS.
- Un mismo asset no puede tener dos publicaciones vivas en la misma plataforma.
- Un expediente no se marca verificado sin documento, liberacion, fecha de
  nacimiento y custodio.
- No se verifica el expediente de una persona menor de 18 anos.
- La comision de la agencia no puede superar lo facturado.
- Nadie se sube su propio rol ni su propio porcentaje de reparto.
- Un perfil no puede cambiar de organizacion.

Las 53 aserciones de `supabase/tests/` cubren todo esto.

## Regenerar los tipos

`src/lib/database.types.ts` esta escrito a mano y es la unica pieza que el
compilador no puede verificar contra la base. En cuanto exista un proyecto
Supabase real, reemplazalo:

```bash
npx supabase gen types typescript --local > src/lib/database.types.ts
```

Todo en ese archivo son alias de tipo, nunca interfaces: PostgREST exige que
cada fila encaje en `Record<string, unknown>`, y una interfaz no obtiene indice
implicito. Si se usa una, el esquema entero se resuelve a `never` y las consultas
pierden el tipado **en silencio**, sin un solo error que senale la causa.
