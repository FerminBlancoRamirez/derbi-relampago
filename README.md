# Derbi Relampago

Juego de futbol arcade multijugador online hecho con HTML, CSS, JavaScript vanilla, Node.js y WebSocket.

## Ejecutar Local

```bash
npm install
npm start
```

Abre `http://localhost:3000` en dos ventanas o dispositivos de la misma red.

## Controles

- `WASD` o flechas: moverse
- `Espacio`: disparar
- `Shift`: sprint

## Despliegue

### Render

El backend esta preparado con `render.yaml` como Web Service llamado `derbi-relampago-server`.

[Desplegar backend en Render](https://dashboard.render.com/blueprint/new?repo=https://github.com/FerminBlancoRamirez/derbi-relampago)

La URL esperada del servidor es:

```text
https://derbi-relampago-server.onrender.com
```

El WebSocket publico sera:

```text
wss://derbi-relampago-server.onrender.com
```

### GitHub Pages

El repo incluye `.github/workflows/pages.yml` para publicar automaticamente la carpeta `public/` en GitHub Pages cuando haya push a `main`.

En GitHub, configura Pages con la fuente `GitHub Actions`. El cliente usa por defecto `wss://derbi-relampago-server.onrender.com` cuando no esta en localhost.

Si Render genera otra URL, abre el juego con:

```text
https://TU_USUARIO.github.io/derbi-relampago/?server=wss://TU_SERVIDOR.onrender.com
```

## Scripts

- `npm start`: inicia el servidor HTTP + WebSocket.
- `npm run check`: comprueba la sintaxis de `server.js`.
