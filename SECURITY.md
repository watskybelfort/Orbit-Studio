# Reportar un problema de seguridad

**No abras un issue público** para un fallo de seguridad. Los issues son
visibles para todo el mundo desde el segundo cero, y eso incluye a quien
quiera aprovecharlo antes de que exista el arreglo.

Usá el canal privado de GitHub:

**[→ Reportar una vulnerabilidad](https://github.com/watskybelfort/Orbit-Studio/security/advisories/new)**
(pestaña *Security* → *Report a vulnerability*)

Es un hilo privado entre vos y el mantenedor hasta que se publique el arreglo.

## Qué sí es un problema de seguridad acá

Orbit es una app de escritorio, no un servicio, así que la superficie es
distinta a la de una web. Interesan sobre todo:

- **Abrir un archivo hace daño.** Un `.orbit`, un `.wav` o un plugin JS que al
  cargarse escriba fuera de su sitio, ejecute código o cuelgue la app.
- **Escapes del renderer.** Cualquier vía por la que el contenido de un
  proyecto alcance el proceso principal o el sistema de archivos sin pasar por
  el guardia de rutas (`apps/desktop/src/main` — ver `path-guard.test.ts`).
- **El servidor de colaboración.** Escucha en `127.0.0.1` por defecto; si algo
  permite salir de una room, leer otra, o alcanzar el disco del host, contá.
- **La cadena de build o el instalador**: que el `.exe` publicado pueda ser
  suplantado o alterado.

## Qué no

- Que SmartScreen avise al instalar: es conocido y esperado, el instalador no
  lleva firma Authenticode todavía. El porqué y el plan están en
  [`docs/FIRMA.md`](docs/FIRMA.md).
- Correr el servidor con `HOST=0.0.0.0` a propósito y exponerlo a internet sin
  túnel: está documentado como una decisión tuya, no como un default.

## Versiones

Se arregla sobre la última versión publicada. No hay ramas de soporte de
versiones viejas: si reportás sobre una anterior, lo primero será comprobar si
sigue pasando en la [última release](https://github.com/watskybelfort/Orbit-Studio/releases/latest).
