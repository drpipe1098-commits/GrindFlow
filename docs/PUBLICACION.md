# Motor de publicacion (Modulo 5)

**Estado: Telegram y webhook generico funcionando.** X, Reddit y Bluesky estan
registrados pero sin implementar, a proposito: validan que la arquitectura
soporta destinos nuevos sin tocar el motor.

## Recorrido de una publicacion

```
schedules (queued, scheduled_at vencido)
   |
   v  despachador del worker, cada 60 s
jobs (publish)              <- jobs_one_live_publish_per_schedule
   |
   v  worker toma el trabajo
comprobaciones baratas primero:
   |-- ¿hay publicador para esa red?        si no -> muerto, sin descargar nada
   |-- ¿el perfil esta suspendido en ella?  si si -> muerto, sin descargar nada
   |-- ¿el asset esta sanitizado?           si no -> muerto
   |-- ¿el texto pasa el filtro AHORA?      si no -> muerto
   v
descarga del derivado con marca de agua desde R2
   |
   v
schedules -> 'publishing'   <- vuelve a disparar el trigger de compuertas 2257
   |
   v
publisher.publish()
   |
   +-- exito -> 'published' + id y URL del post
   `-- fallo  -> se clasifica y se decide (abajo)
```

El orden no es casual. Descargar cincuenta megas de R2 para descubrir despues
que la cuenta esta suspendida es trabajo y dinero tirados, asi que todo lo que
puede descartar sin coste va primero.

## La garantia del texto, otra vez

`schedules.caption_text` es una cadena corriente en la base, pero
`PlatformPublisher.publish` exige `PublishableCaption`. La unica forma de
obtener ese tipo es llamar al validador del Modulo 4, asi que **el worker vuelve
a validar justo antes de enviar**.

No es un tramite. Entre programar y publicar pueden haber cambiado los destinos
verificados, o haberse editado el texto por otra via. Un texto que ya no pasa el
filtro no sale, y no se reintenta: fallaria igual las cinco veces.

Lo mismo con el expediente 2257. Pasar la programacion a `publishing` vuelve a
disparar `schedules_enforce_gates`, que exige expediente vigente. Un expediente
que caduco entre programar y publicar detiene el envio.

## Clasificacion de fallos

Es el nucleo del motor, y esta en codigo puro (`src/lib/publishing/errors.ts`)
justamente para poder probarlo sin red ni esperas reales.

| Respuesta | Clase | Que se hace |
|---|---|---|
| 429 | `rate_limited` | Se aplaza lo que la plataforma pidio, mas un margen pequeno |
| 401, 403 | `auth_revoked` | **Se suspende el perfil en esa red** y el trabajo muere |
| 400, 404, 413, 422 | `invalid_content` | Muere sin reintentar |
| 408, 425, 5xx | `transient` | Se aplaza con espera exponencial |
| resto | `permanent` | Muere sin reintentar |

Tres decisiones que conviene entender:

**El 403 va con el 401.** En la practica significa lo mismo: cuenta suspendida,
bot expulsado del canal o permiso retirado. Ninguna se arregla reintentando.

**El 429 respeta `Retry-After`, y tambien el `parameters.retry_after` del cuerpo**
que usa Telegram. Adivinar una espera propia ignora la unica informacion fiable
que existe, y suele costar otro 429 mas largo. El margen que se suma es para que
varias replicas no vuelvan en el mismo segundo; nunca se espera menos de lo
pedido.

**Un 429 no gasta intento.** `defer_job` decrementa `attempts` a proposito:
esperar porque la plataforma lo pidio no es un fallo del trabajo, y contarlo
haria que una racha de 429 lo diera por muerto sin haberlo intentado de verdad.

## Suspension por perfil y red

Un 401 no para solo esa publicacion: para **todas las de ese perfil hacia esa
red**. Seguir intentando con credenciales muertas encadena peticiones fallidas
contra la API, que es exactamente el patron que las plataformas castigan con un
baneo.

Es por perfil y red, no global: que caiga el Telegram de una modelo no debe parar
su X ni el Telegram de sus companeras.

La suspension nace con `until` nulo, es decir, sin caducidad. Un token revocado no
se arregla esperando: hace falta reconectar la cuenta y que alguien de la agencia
la levante. El editor no puede, porque no tiene acceso a las credenciales; la
modelo tampoco, pero si ve por que se paro su cuenta.

## Destinos

**Telegram** sube por `multipart/form-data` y no por URL. Telegram admite las
dos, pero la de URL exige que el archivo sea alcanzable publicamente, y este
material vive en un bucket privado: entregar una URL prefirmada a un tercero deja
ese enlace en sus registros. Limites de la Bot API: 10 MB para foto y 50 MB para
video, comprobados **antes** de subir.

**Webhook generico** manda una URL temporal en vez de los bytes: es
infraestructura del propio estudio, y mandarle cincuenta megas por POST es una
forma barata de agotar su servidor. El cuerpo va firmado con HMAC-SHA256 sobre
`<momento>.<cuerpo>`, en el formato `t=...,v1=...`. El momento entra en la firma
para que una peticion capturada no se pueda reenviar mas tarde.

**X, Reddit y Bluesky** fallan como `permanent` con un mensaje que dice que
falta. Lo pendiente no es el envio —es una llamada HTTP— sino sus reglas propias:
X limita por nivel de acceso y exige marcar contenido sensible; Reddit tiene
reglas de flair, formato y frecuencia **distintas en cada subreddit**, que es lo
que de verdad cuesta modelar; Bluesky sube el medio en un paso aparte.

El tipo `Record<Platform, PlatformPublisher>` del registro obliga a que esten
todos: anadir un valor al enum sin su publicador no compila.

## Lo que falta

- **Ejecutarlo contra Telegram real.** Las pruebas simulan la Bot API; nada ha
  hablado con `api.telegram.org`.
- **Levantar suspensiones desde el panel.** La politica RLS ya lo permite al
  estudio; falta la pantalla.
- **X, Reddit y Bluesky.**
