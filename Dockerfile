FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV PATH="/opt/pydeps/bin:${PATH}"

# Python se usa para compresión best-effort de imágenes/PDF sin Ghostscript.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN python3 -m venv /opt/pydeps \
  && /opt/pydeps/bin/pip install --no-cache-dir -r requirements.txt

# Instala dependencias de producción.
# Usamos npm install porque el package-lock del repositorio puede venir desfasado
# respecto a package.json durante iteraciones rápidas; npm ci falla en ese caso.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copia el proyecto completo, incluyendo assets de credencial y script Python de compresión.
COPY . .

# Validación sintáctica antes de generar la imagen final
RUN npm run check

EXPOSE 8080

CMD ["npm", "start"]
