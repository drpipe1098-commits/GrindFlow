import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    reporters: ['verbose'],
    // Valores de prueba para las variables que `serverEnv()` exige. No son
    // credenciales de ningun sitio: solo tienen que pasar la validacion de forma.
    env: {
      SUPABASE_SERVICE_ROLE_KEY: 'clave-de-servicio-solo-para-pruebas-0000',
      R2_ACCESS_KEY_ID: 'pruebas',
      R2_SECRET_ACCESS_KEY: 'pruebas',
      R2_BUCKET: 'grindflow-pruebas',
      R2_ENDPOINT: 'http://127.0.0.1:9000',
      R2_REGION: 'auto',
      UPLOAD_LINK_SECRET: '0'.repeat(64),
      ENCRYPTION_MASTER_KEY:
        '1f8b3d5a7c9e0b2d4f6a8c1e3b5d7f9a0c2e4b6d8f1a3c5e7b9d0f2a4c6e8b1d',
      CLICK_IP_SALT: 'sal-de-pruebas-0123456789',
      DROPBOX_APP_KEY: 'clave-de-app-de-pruebas',
      DROPBOX_APP_SECRET: 'secreto-de-app-de-pruebas',
      OAUTH_STATE_SECRET: 'f'.repeat(64),
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // `server-only` lanza una excepcion al cargarse fuera de un RSC.
      'server-only': fileURLToPath(
        new URL('./tests/support/server-only-stub.ts', import.meta.url),
      ),
    },
  },
});
