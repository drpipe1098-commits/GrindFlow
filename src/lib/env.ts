/**
 * Lectura de variables de entorno con validacion temprana.
 *
 * La alternativa —leer `process.env.X!` donde haga falta— convierte una variable
 * mal escrita en un `undefined` que viaja hasta el SDK de AWS y estalla en
 * tiempo de peticion con un mensaje que no menciona la causa. Aqui falla al
 * arrancar y dice exactamente que falta.
 */
import { z } from 'zod';

const serverSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET: z.string().min(1),
  R2_ENDPOINT: z.string().url(),
  R2_REGION: z.string().default('auto'),
  UPLOAD_LINK_SECRET: z.string().min(32),
  // 32 bytes en hexadecimal. Cifra los tokens de las plataformas en reposo.
  ENCRYPTION_MASTER_KEY: z
    .string()
    .regex(
      /^[0-9a-fA-F]{64}$/,
      'ENCRYPTION_MASTER_KEY debe ser hexadecimal de 64 caracteres (openssl rand -hex 32)',
    ),
  // Sal del hash de IP del acortador. Se guarda el hash, nunca la IP.
  CLICK_IP_SALT: z.string().min(16),
  UPLOAD_PRESIGN_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(300),
  UPLOAD_MAX_BYTES_PER_FILE: z.coerce.number().int().positive().default(2_147_483_648),
  UPLOAD_MAX_FILES_PER_LINK: z.coerce.number().int().positive().default(50),
});

const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
  // Base de las URIs de retorno de OAuth2. Tiene que coincidir caracter a
  // caracter con lo registrado en la consola del proveedor.
  NEXT_PUBLIC_APP_URL: z.string().url().default('http://localhost:3000'),
});

export type ServerEnv = z.infer<typeof serverSchema>;
export type PublicEnv = z.infer<typeof publicSchema>;

let cachedServerEnv: ServerEnv | null = null;

/**
 * Solo debe llamarse desde codigo de servidor. Incluye la clave de servicio, que
 * omite el RLS: si alguna vez acaba en un bundle de cliente, todo el aislamiento
 * multi-tenant queda anulado.
 */
export function serverEnv(): ServerEnv {
  if (cachedServerEnv !== null) return cachedServerEnv;

  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(
      `Variables de entorno de servidor invalidas o ausentes: ${missing}. ` +
        'Revisa .env.example y copia los valores a .env.local.',
    );
  }

  cachedServerEnv = parsed.data;
  return cachedServerEnv;
}

/**
 * Variables de los conectores de nube.
 *
 * Van en su propio esquema y no en `serverEnv()` a proposito: un despliegue que
 * no use la ingesta desde Dropbox no tiene por que configurarlas, y exigirlas en
 * el arranque impediria levantar el panel por una funcion que nadie va a usar.
 * Se validan en el momento en que alguien intenta conectar una nube, y entonces
 * el mensaje dice exactamente que falta.
 */
const connectorSchema = z.object({
  DROPBOX_APP_KEY: z.string().min(5),
  DROPBOX_APP_SECRET: z.string().min(5),
  // Google es opcional: el despliegue puede empezar solo con Dropbox mientras
  // corre el tramite de verificacion, que tarda semanas.
  GOOGLE_CLIENT_ID: z.string().min(5).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(5).optional(),
  // Firma el parametro `state` de OAuth2. Secreto propio y no reutilizado:
  // una clave de cifrado no debe usarse tambien para firmar.
  OAUTH_STATE_SECRET: z.string().min(32),
});

export type ConnectorEnv = z.infer<typeof connectorSchema>;

let cachedConnectorEnv: ConnectorEnv | null = null;

export function connectorEnv(): ConnectorEnv {
  if (cachedConnectorEnv !== null) return cachedConnectorEnv;

  const parsed = connectorSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(
      `Los conectores de nube no estan configurados. Falta o es invalido: ${missing}. ` +
        'Revisa .env.example.',
    );
  }

  cachedConnectorEnv = parsed.data;
  return cachedConnectorEnv;
}

export function publicEnv(): PublicEnv {
  // Se enumeran una a una en vez de pasar `process.env`: Next sustituye estas
  // referencias literalmente al compilar el bundle del cliente, y un acceso
  // dinamico se quedaria sin valor alli.
  const parsed = publicSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  });

  if (!parsed.success) {
    throw new Error(
      'Faltan NEXT_PUBLIC_SUPABASE_URL o NEXT_PUBLIC_SUPABASE_ANON_KEY. Revisa .env.example.',
    );
  }

  return parsed.data;
}
