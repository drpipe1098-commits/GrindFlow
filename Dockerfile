# =============================================================================
# Panel Next.js — imagen de produccion
# =============================================================================
# Tres etapas para que la imagen final no lleve ni el codigo fuente ni las
# dependencias de compilacion: solo el servidor ya empaquetado.

# --- 1. Dependencias ---------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app

# Se copian solo los manifiestos: mientras no cambien, Docker reutiliza la capa
# de npm ci aunque haya cambiado todo el codigo. Es la diferencia entre un build
# de treinta segundos y uno de cinco minutos.
COPY package.json package-lock.json ./
RUN npm ci

# --- 2. Compilacion ----------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# El build no se conecta a nada, pero next/env exige que las variables publicas
# existan y tengan forma valida. Los valores reales llegan en ejecucion.
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PUBLIC_SUPABASE_URL=http://placeholder.invalid
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=clave-anonima-de-marcador-para-el-build

RUN npm run build

# --- 3. Ejecucion ------------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Usuario sin privilegios: si alguien logra ejecutar codigo dentro del
# contenedor, no lo hace como root.
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 --ingroup nodejs nextjs

# La salida standalone ya trae el servidor y sus dependencias resueltas.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

# Comprueba que el servidor responde, no solo que el proceso vive: un Next
# colgado sigue teniendo su PID en pie.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/es').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
