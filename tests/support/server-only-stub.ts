/**
 * Sustituto de `server-only` para las pruebas.
 *
 * Ese paquete lanza una excepcion al importarse fuera de un React Server
 * Component: es su forma de impedir que un modulo con secretos acabe en el
 * bundle del navegador. Vitest corre en Node normal, asi que sin este sustituto
 * cualquier prueba que toque el modulo de cifrado fallaria al cargarlo.
 *
 * La proteccion real sigue intacta: la aplica Next al compilar, no las pruebas.
 */
export {};
