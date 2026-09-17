import 'server-only';

import type { CloudProvider } from '@/lib/database.types';

/**
 * Interfaz comun de los proveedores de nube.
 *
 * Mantiene `scan.ts` e `ingest.ts` ignorantes de si detras hay Dropbox o Drive,
 * igual que `CaptionProvider` hace con el generador de textos. Anadir OneDrive
 * seria un archivo mas y una entrada en la factoria.
 *
 * Las dos nubes no se parecen tanto como aparentan:
 *
 *   - Dropbox tiene rutas y listado recursivo nativo; Drive tiene identificadores
 *     opacos y hay que recorrer el arbol carpeta por carpeta.
 *   - El cursor de Dropbox sirve para paginar y para incrementar; Drive separa
 *     las dos cosas (`pageToken` de `files.list` y `pageToken` de `changes.list`).
 *
 * Esta interfaz esconde esas diferencias tras `listInitial` / `listIncremental`.
 */

export interface RemoteFile {
  /** Identificador del archivo en el proveedor. */
  id: string;
  name: string;
  /** Ruta completa con barras. En Drive se reconstruye al recorrer el arbol. */
  path: string;
  sizeBytes: number;
  modifiedAt: string;
  /** Hash propietario del proveedor, si lo ofrece. NO es comparable entre nubes. */
  checksum: string | null;
}

export interface RemoteListing {
  files: RemoteFile[];
  /**
   * Cursor para la siguiente llamada. `null` cuando el proveedor no puede dar
   * uno util todavia (por ejemplo, un recorrido inicial incompleto en Drive).
   */
  cursor: string | null;
  hasMore: boolean;
}

export interface ListContext {
  accessToken: string;
  /** Ruta raiz autorizada. La usa Dropbox. */
  rootPath: string | null;
  /** Identificador de la carpeta raiz. La usa Drive. */
  rootId: string | null;
}

export interface CloudClient {
  readonly provider: CloudProvider;
  /** Primer recorrido completo. */
  listInitial(context: ListContext): Promise<RemoteListing>;
  /** Solo lo que cambio desde el cursor dado. */
  listIncremental(context: ListContext & { cursor: string }): Promise<RemoteListing>;
  /** Descarga en flujo: hay videos de varios gigabytes. */
  download(input: { accessToken: string; fileId: string }): Promise<ReadableStream<Uint8Array>>;
}
