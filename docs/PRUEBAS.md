# Pruebas

Siete compuertas en CI. La rama principal solo necesita exigir `validate`, que
las agrega.

| Compuerta | Que comprueba | Comando local |
|---|---|---|
| `linters` | ESLint sobre todo el proyecto | `npm run lint` |
| `typescript` | `tsc --noEmit` en modo estricto | `npm run typecheck` |
| `unidad` | 206 casos: Hard Rule, cifrado, limite, textos, conectores y publicacion | `npm test` |
| `aislamiento RLS` | 116 aserciones contra PostgreSQL real | `npm run test:rls` |
| `build` | Compilacion de produccion de Next | `npm run build` |
| `workers python` | Sintaxis y la barrera anti-doxxing | `python workers/verificar_sanitizacion.py` |
| `imagenes docker` | Construye las tres imagenes y valida el compose | `docker compose build` |

## Por que se prueba esto y no otra cosa

El esfuerzo esta puesto donde un fallo no se ve venir.

**El Hard Rule** decide que se publica y cuando. Un error de frontera no rompe
nada visible: simplemente repite contenido antes de tiempo, y eso solo se nota
cuando el publico ya se canso. Por eso las 36 pruebas insisten en los limites
—el instante exacto en que un enfriamiento se cumple, el milisegundo anterior,
el enfriamiento de cero dias— y usan fechas fijas en UTC. Ninguna llama a
`new Date()` sin argumentos: una prueba que dependa del reloj real falla sola
algun martes y nadie sabe por que.

**El cifrado de credenciales** (20 casos) se prueba sobre todo por lo que
*rechaza*. Que el ida y vuelta funcione lo consigue cualquier implementacion,
incluida una insegura; lo que distingue a AES-GCM de un modo sin autenticar es
que detecte manipulacion. Por eso la mayoria de los casos alteran el texto
cifrado, la etiqueta o el IV y exigen que falle, y otros comprueban que el
contexto impide reutilizar el criptograma de una agencia en la fila de otra.

**El limite de tasa** (19 casos entre unidad y base) importa porque sobre el
conteo de clics se reparte dinero: inflarlo no es vandalismo, es fraude. Las
aserciones de PostgreSQL se ejecutan como `anon`, que es exactamente el rol desde
el que se intentaria, y comprueban ademas que omitir el hash de IP no sea una via
de escape.

**El validador de textos** (42 casos) se prueba en dos direcciones opuestas y
las dos importan igual. Hacia un lado, que no se pueda esquivar: los terminos
prohibidos se prueban escritos con puntos, con espacios, en leet, con acentos
añadidos y partidos con caracteres invisibles, que es como se intentan colar de
verdad. Hacia el otro, que no de falsos positivos: "canteen" y "Menorca" no se
bloquean pese a contener terminos vetados, porque un filtro que estorba se acaba
desactivando, y desactivado no protege de nada.

Una de esas pruebas no la ejecuta vitest sino el compilador. `PublishableCaption`
es una cadena con una marca que solo produce el validador, y la prueba incluye un
`@ts-expect-error` al asignarle un `string` corriente: si la marca se debilitara,
`npm run typecheck` fallaria por directiva inutil. Comprobado quitando la marca a
proposito — la prueba falla, como debe.

**El enrutado de la ingesta** (14 casos) importa porque su fallo es invisible.
Si un archivo acaba en el perfil equivocado, el sistema cree que acerto y nadie
lo revisa: el material de una modelo termina publicado en la cuenta de otra. Por
eso el enrutado es codigo puro, sin base ni red, y por eso ante dos perfiles que
normalizan igual se niega a adivinar.

**La clasificacion de fallos de publicacion** (42 casos) importa porque cada
clase de fallo pide lo contrario de la otra: un 429 quiere esperar lo que la
plataforma dijo, un 401 quiere parar del todo, un 400 no quiere reintento
ninguno. Tratarlos igual convierte una incidencia menor en una cuenta baneada, y
eso no se descubre hasta que ya paso. Las pruebas cubren los dos formatos de
`Retry-After`, el `retry_after` que Telegram manda en el cuerpo, y que la espera
calculada nunca quede por debajo de lo pedido.

**El RLS** es la unica pieza cuyo fallo no tiene vuelta atras. Si una politica
esta mal, el material privado de una modelo aparece en el panel de otra agencia,
y eso ya no se deshace. Las pruebas no se limitan a comprobar que cada usuario ve
lo suyo: **intentan activamente cruzar la frontera** y exigen que la base lo
impida.

## Como funcionan las pruebas de RLS

`scripts/run-rls-tests.mjs` crea una base desechable, aplica el arranque de auth
(que reproduce lo que Supabase aporta de fabrica: el esquema `auth`, la funcion
`auth.uid()` y los roles `anon` / `authenticated`), corre las diez migraciones,
siembra dos agencias y ejecuta los archivos de asercion.

Cada bloque suplanta a un usuario real fijando el mismo `request.jwt.claims` que
pondria PostgREST y adoptando el rol `authenticated`. No hay atajos: si una
politica esta mal, esas consultas devuelven datos ajenos y la prueba falla.

Un detalle importante del diseno de las aserciones: bajo RLS, un `UPDATE` o un
`DELETE` sobre filas ajenas **no lanza error**, simplemente no afecta a ninguna
fila. Por eso `tests.assert_affects` mide el alcance de la escritura en vez de
esperar una excepcion. Comprobarlo con un `assert_rejected` daria un falso verde.

## Lo que NO esta probado

- **No hay pruebas end-to-end.** Nadie ha recorrido el flujo completo en un
  navegador.
- **Nada se ha ejecutado contra Supabase Cloud ni R2 reales.** El RLS se prueba
  contra PostgreSQL 16 normal, que es el mismo motor, pero Auth y Storage
  gestionados no se han tocado.
- **La transcodificacion y la marca de agua no tienen pruebas automaticas.**
  Solo la sanitizacion EXIF, que es la parte peligrosa.
- **Las imagenes Docker se construyen en CI, no en local.** La politica de red
  del entorno de desarrollo bloquea el registro de Docker Hub, asi que la
  comprobacion de que compilan ocurre en GitHub Actions.
- **Los clientes HTTP de Dropbox y Drive no se han ejecutado contra las APIs
  reales.** El entorno de desarrollo no alcanza internet. Lo probado es el
  enrutado, el programador, el triaje, el estado de OAuth2, el filtro de tipos y
  el recorrido de la cola; el intercambio de tokens, el listado y la descarga
  siguen sin comprobar contra los proveedores.
- **Nada se ha publicado en Telegram de verdad.** Las pruebas simulan la Bot API
  con un `fetch` sustituido; el envio real sigue sin comprobar.
- **El panel de triaje no tiene pruebas de navegador.** Lo probado de esa
  pantalla es su logica —validacion del lote, tope, repetidos, resumen— y sus
  garantias en la base: que un editor asigne dentro de su agencia, que no se
  pueda asignar a una modelo de otra, y que un estudio ajeno no toque la cola.
  El renderizado y la seleccion no estan cubiertos.
- **Ningun runner de publicacion existe todavia.** El Modulo 5 esta modelado en
  la base pero no implementado.
