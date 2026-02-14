# 🧸 KidsFlix v2.0 - Addon Infantil para Stremio

Addon con **panel de configuración por usuario**. Cada usuario ingresa sus propias
API keys y recibe una URL única para instalar en Stremio.

## 🔑 Cómo funciona

1. Visita `https://tu-app.vercel.app/configure`
2. Ingresa tu TMDB API Key (obligatoria) y OMDB Key (opcional)
3. El panel valida las keys en tiempo real
4. Se genera una URL única con tus keys codificadas
5. Instala esa URL en Stremio

**Las keys se codifican en Base64 dentro de la URL. No se almacenan en ningún servidor.**

### Estructura de URL generada:
```
https://tu-app.vercel.app/{config_base64}/manifest.json
```

## 🚀 Deploy en Vercel

```bash
git clone https://github.com/tu-usuario/kidsflix-stremio.git
cd kidsflix-stremio
vercel --prod
```

No necesitas variables de entorno — cada usuario configura sus propias keys.

🛡️ Filtrado (5 niveles)
1. Flag adulto de TMDB
2. Géneros bloqueados (Terror, Thriller, Crimen, etc.)
3. Palabras clave en descripciones
4. Certificaciones TMDB (G, PG, TV-Y, etc.)
5. Rating OMDB (bloquea R, NC-17, TV-MA, etc.)
   
📋 Endpoints
/configure — Panel de configuración
/{config}/manifest.json — Manifiesto
/{config}/catalog/:type/:id.json — Catálogo
/{config}/meta/:type/:id.json — Metadata
/{config}/test-filter/:imdbId — Test de filtrado
/status — Estado del addon
/poster/:id.jpg — Posters con badges

---

## Puntos clave de esta versión:

**🔑 Panel `/configure`:**
- Valida las API keys contra las APIs reales antes de generar la URL
- Muestra errores claros si una key es inválida
- Botón directo "Instalar en Stremio" con protocolo `stremio://`
- Botón "Copiar URL" para instalación manual
- Diseño responsive para móvil

**🔒 Seguridad:**
- Las keys van codificadas en Base64 en la URL, nunca se guardan en el servidor
- No necesitas variables de entorno en Vercel
- El cache es compartido entre usuarios (las consultas TMDB son iguales sin importar quién las hace)

**📡 Flujo de rutas:**
```
/configure → Panel HTML
/{base64_config}/manifest.json → Manifiesto Stremio
/{base64_config}/catalog/... → Catálogos filtrados
/{base64_config}/meta/... → Metadata
/poster/... → Posters (sin config)
```
