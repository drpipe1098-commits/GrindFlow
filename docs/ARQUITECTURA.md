# Arquitectura

## Decisiones tomadas y por que

| Decision | Eleccion | Motivo |
|---|---|---|
| Multi-tenancy | `organizations` + `memberships` | Una modelo puede trabajar con dos agencias y un editor cubrir varias. Una columna `studio_id` en `profiles` obligaria a migrar el dia que eso pase. |
| Aislamiento | RLS en PostgreSQL | Se aplica en el motor, no en la aplicacion: una llamada directa a la API queda igual de limitada que el panel. |
| Cola de trabajos | Tabla en Postgres con `SKIP LOCKED` | Sin broker que administrar, y encolar es transaccional con el cambio que lo origina. |
| Cumplimiento 2257 | Desde los cimientos, con trigger | Retroadaptarlo sobre miles de assets cuesta mucho mas que disenarlo ahora. |
| Enlaces de subida | URL prefirmada tras validar token | Nunca sale una credencial de escritura del bucket. |
| Acortador | `/l/[slug]` en la misma app | Sin dominio ni despliegue extra. |
| Despliegue | VPS propio con contenedores | Los terminos de Vercel prohiben contenido adulto, y FFmpeg no cabe en una funcion serverless. |
| Secretos en reposo | AES-256-GCM con clave del entorno | GCM autentica ademas de cifrar: un texto alterado falla en vez de devolver basura. |
| Limite del acortador | Dos capas: memoria del borde + ventana en PostgreSQL | Sobre el conteo de clics se reparte dinero. |
| Idiomas | `next-intl`, es + en | Mercado de arranque en espanol, sin cerrar la puerta a vender fuera. |

## Las tres capas de autorizacion

Van de fuera hacia dentro. Cada una sola es insuficiente; juntas, un fallo en
una no abre la puerta.

1. **Privilegios de tabla.** `anon` no tiene concedido nada sobre ninguna tabla.
   Un visitante sin sesion choca aqui, antes de que el RLS llegue a evaluarse.
   Su unica via son dos funciones `SECURITY DEFINER` con la superficie minima
   que necesita el redirector.
2. **Politicas RLS.** Deciden que filas ve cada usuario autenticado. Se apoyan
   en funciones auxiliares del esquema `app`, que son `SECURITY DEFINER` para
   romper la recursion (una politica sobre `memberships` que consultara
   `memberships` se llamaria a si misma sin fin).
3. **Triggers de integridad.** Lo que el RLS no puede expresar: que nadie se
   suba el rol, que nadie se cambie su porcentaje de reparto, que no se programe
   contenido sin sanitizar ni sin expediente 2257 vigente.

### Quien ve que

| | Admin plataforma | Estudio | Editor | Modelo |
|---|---|---|---|---|
| Material de la organizacion | todo | si | si | solo el suyo |
| Expedientes 2257 | todo | si | **no** | solo el suyo |
| Credenciales de plataformas | todo | si | **no** | solo las suyas |
| Finanzas | todo | si | **no** | solo las suyas |
| Otras organizaciones | si | **no** | **no** | **no** |

El editor queda fuera de documentos de identidad, dinero y credenciales a
proposito: necesita ingerir y preparar material, nada mas.

## Camino de un archivo

```
Movil de la modelo
   |  abre /u/<token>
   v
POST /api/uploads/presign   valida token, vigencia, cuota, MIME y peso
   |  devuelve URL prefirmada (minutos de vida, tamano firmado)
   v
PUT directo a R2            el archivo NO pasa por el servidor de Next
   |
   v
inbox/  (sanitized = false) -> la base rechaza programarlo
   |
   v
Worker Python: retira EXIF/GPS, transcodifica, marca de agua
   |
   v
public/ (sanitized = true)  -> ya se puede programar y publicar
```

## Cifrado de credenciales

Los tokens OAuth y las API keys se cifran antes de tocar la base, con
AES-256-GCM y una clave que vive en el entorno (`ENCRYPTION_MASTER_KEY`).
PostgreSQL solo ve texto cifrado.

El formato guardado lleva version: `v1.<iv>.<tag>.<ciphertext>`. El prefijo no es
decorativo — cuando haya que rotar la clave o cambiar de algoritmo, se podra
escribir `v2` y seguir descifrando lo viejo, sin una migracion que toque todas
las filas de golpe.

Cada secreto se firma junto a un contexto (`organizacion:plataforma`) que no se
almacena cifrado. Eso ata el criptograma a su fila: copiar el
`secret_ciphertext` de una agencia a la de otra deja de funcionar, porque el
contexto ya no coincide y el descifrado falla. Sin esa atadura, mover una celda
entre filas bastaria para robar un token.

**Lo que esto protege y lo que no.** Protege un volcado de la base: la clave no
esta en PostgreSQL. No protege contra alguien que ya controle el servidor en
ejecucion, donde la clave esta en memoria. Para eso haria falta un KMS, que es el
paso siguiente si el producto crece.

El unico camino de entrada y salida de `platform_credentials` es
`src/lib/credentials.ts`. Escribir en esa tabla por otra via guardaria el secreto
en claro, y la base no puede impedirlo: solo ve texto.

## Limite de tasa del acortador

`record_link_click` es invocable por `anon` — es lo que permite contar clics de
visitantes sin sesion. El precio es que cualquiera que conozca un slug puede
llamarla en bucle e inflar las metricas de una modelo, y sobre esas metricas se
reparte dinero. Dos capas:

1. **Middleware, en memoria del proceso.** Ventana fija por hash de IP. Corta las
   rafagas antes de que toquen la base. No es autoritativa: con varias replicas
   de `web` el limite efectivo se multiplica, y se rodea llamando al RPC
   directamente.
2. **PostgreSQL, dentro de `record_link_click`.** Descarta clics repetidos de la
   misma IP sobre el mismo enlace dentro de una ventana de 60 segundos. Esta si
   es comun a todas las replicas y no se puede rodear.

La ventana es una constante del cuerpo de la funcion, **no un parametro**. Si el
llamante pudiera elegirla, bastaria pasar cero para anular el limite — y quien
llama es anonimo.

De la IP nunca se guarda la direccion, solo su SHA-256 con una sal del entorno.
El hash basta para contar y limitar, y sin la sal un volcado de la base no
permite recuperar las direcciones. Omitir el hash no es una via de escape: esos
clics caen en un cubo compartido y se limitan todos juntos, que es el
comportamiento mas estricto, no el mas laxo.

## Camino de un clic

```
t.me/canal -> /l/alfa-tg-01
   |
   v
middleware.ts
   |-- resolve_tracking_link(slug)    RPC publico, superficie minima
   |-- redirect 302 (sin cache)       el visitante ya se fue
   `-- waitUntil:                     la analitica se escribe despues
         |-- hash de IP con sal       nunca se guarda la direccion
         |-- limite en memoria        corta rafagas en el borde
         `-- record_link_click        ventana de 60 s, barrera autoritativa
```

El 302 sin cache es deliberado: un 301 lo guardaria el navegador y los clics
siguientes dejarian de contarse, ademas de impedir cambiar el destino.
