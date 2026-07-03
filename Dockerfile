# Dockerfile para Cloud Build / Cloud Run
FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Instala dependencias de producción.
# Usamos npm install porque el package-lock del repositorio puede venir desfasado
# respecto a package.json durante iteraciones rápidas; npm ci falla en ese caso.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copia el proyecto completo, incluyendo assets de credencial
COPY . .

# Validación sintáctica antes de generar la imagen final
RUN npm run check

EXPOSE 8080

CMD ["npm", "start"]
