# Puesta en marcha local

Nada de esto necesita cuentas en la nube. Supabase corre en local con su CLI y
R2 se simula con MinIO; el codigo es el mismo que correra en produccion.

## Requisitos

- Node.js 22 o superior
- Docker (para Supabase local y MinIO)
- Python 3.11 y FFmpeg, solo si vas a tocar los workers

## Pasos

```bash
# 1. Dependencias
npm install

# 2. Supabase local (PostgreSQL, Auth, PostgREST)
npx supabase start
# Anota la anon key y la service_role key que imprime.

# 3. Almacenamiento simulado
docker compose up -d minio minio-init

# 4. Variables de entorno
cp .env.example .env.local
# Pega las claves del paso 2 y genera los tres secretos:
#   openssl rand -hex 32   -> UPLOAD_LINK_SECRET
#   openssl rand -hex 32   -> ENCRYPTION_MASTER_KEY  (64 caracteres exactos)
#   openssl rand -hex 16   -> CLICK_IP_SALT

# 5. Migraciones
npx supabase db reset

# 6. Arrancar
npm run dev
```

## Comprobar que todo funciona

```bash
npm run validate     # lint + typecheck + hard-rule + RLS
```

`npm run test:rls` crea una base desechable, aplica las diez migraciones, siembra
dos agencias e intenta activamente cruzar la frontera entre ellas. Es la
comprobacion que hay que correr siempre que se toque una politica.

Si el runner no encuentra PostgreSQL, indicale la conexion:

```bash
RLS_TEST_ADMIN_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run test:rls
```

Para inspeccionar la base de prueba en lugar de destruirla:

```bash
RLS_TEST_KEEP=1 npm run test:rls
```

## Workers

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r workers/requirements.txt
python workers/main.py                 # todos los tipos
python workers/main.py sanitize_exif   # solo sanitizacion
```

Verificar la barrera anti-doxxing tras tocar `sanitize.py`:

```bash
pip install Pillow piexif
python workers/verificar_sanitizacion.py
```

## Levantar todo con contenedores

Para probar la pila tal y como corre en produccion, sin instalar Node ni Python:

```bash
cp .env.example .env
docker compose --profile dev up --build
```

El detalle del despliegue en servidor propio esta en `docs/DESPLIEGUE.md`.
