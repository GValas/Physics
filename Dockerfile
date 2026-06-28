# ---- Étape 1 : build du site statique avec Node ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build          # produit /app/dist (HTML/CSS/JS statiques)

# ---- Étape 2 : image finale, nginx servant les fichiers statiques ----
FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
# nginx démarre automatiquement (CMD hérité de l'image de base)
