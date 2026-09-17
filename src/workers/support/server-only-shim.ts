/**
 * Sustituto de `server-only` para los workers de Node.
 *
 * Ese paquete lanza una excepcion al importarse fuera de un React Server
 * Component: es su forma de impedir que un modulo con secretos acabe en el
 * bundle del navegador. Un worker de Node no es un RSC, asi que sin este
 * sustituto los modulos compartidos (cliente de servicio, R2, cifrado) revientan
 * al cargarse.
 *
 * La proteccion real no se toca: la aplica Next al compilar con el `tsconfig.json`
 * principal. Este atajo vive solo en `tsconfig.workers.json`, que Next nunca usa.
 */
export {};
