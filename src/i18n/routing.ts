import { defineRouting } from 'next-intl/routing';
import { createNavigation } from 'next-intl/navigation';

/**
 * El espanol es el idioma por defecto: es el mercado de arranque del producto.
 * `localePrefix: 'as-needed'` deja las rutas en espanol sin prefijo (/studio) y
 * prefija solo el ingles (/en/studio), para que los enlaces que ya circulen no
 * se rompan al anadir idiomas mas adelante.
 */
export const routing = defineRouting({
  locales: ['es', 'en'],
  defaultLocale: 'es',
  localePrefix: 'as-needed',
});

export type Locale = (typeof routing.locales)[number];

export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);
