# Firma del instalador — estado y camino a seguir

## Qué pasa hoy

El instalador (`Orbit-Studio-Setup-<versión>.exe`, generado por
`apps/desktop/electron-builder.yml`) sale **sin firma Authenticode**. Windows
SmartScreen, la primera vez que alguien lo ejecuta en su propia máquina,
muestra la pantalla azul "Windows protegió tu PC" (editor no reconocido) y
exige *Más información → Ejecutar de todas formas*. Para un instalador que se
distribuye fuera de una tienda de apps, esa pantalla es la mayor fuente de
abandono: mucha gente no pasa de ahí.

`.github/workflows/release.yml` ya está preparado para firmar automáticamente
el día que exista un certificado — **no hace falta tocar ni ese workflow ni
`electron-builder.yml` de nuevo**. El paso que empaqueta (`npm run dist -w
@orbit/desktop`) ya recibe `CSC_LINK` y `CSC_KEY_PASSWORD` como variables de
entorno leídas de secrets del repo:

```yaml
env:
  CSC_LINK: ${{ secrets.CSC_LINK }}
  CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}
```

Hoy esos secrets no existen, así que GitHub Actions los resuelve como cadena
vacía. electron-builder trata `CSC_LINK === ""` exactamente igual que "no
seteado" y omite la firma sin fallar el build — es su propio comportamiento
documentado, verificado leyendo la fuente instalada en este repo:

```
node_modules/app-builder-lib/out/codeSign/windowsSignToolManager.js:76
if (cscLink == null || cscLink === "") { return null; }
```

`electron-builder.yml` no lleva ninguna configuración de firma propia
(`cscLink`/`cscKeyPassword`), así que hereda este comportamiento estándar por
variables de entorno sin que haga falta editarlo. En cuanto los dos secrets
existan en GitHub, el próximo tag que dispare `release.yml` sale firmado
solo.

## Qué certificado hace falta

Se necesita un certificado Authenticode para firma de código de Windows,
emitido por una CA (autoridad certificadora) reconocida por Microsoft. Hay
dos niveles de validación, y la diferencia importa para SmartScreen, no solo
para el precio:

### OV (Organization Validated)

- Más barato (del orden de 70–250 USD/año según la CA).
- Verifica que la organización/persona existe, pero **SmartScreen no confía
  en la clave desde el día uno**: acumula "reputación" según cuántas veces se
  descarga y ejecuta un instalador firmado con esa misma clave. Mientras esa
  reputación está en cero, SmartScreen sigue avisando igual que si no
  estuviera firmado — el período puede ser de semanas o meses, y depende del
  volumen real de descargas.
- Alcanza para que `signtool verify` o `Get-AuthenticodeSignature` digan
  "válido" y para que el editor deje de figurar como "desconocido" en las
  propiedades del archivo, pero **no resuelve el problema de SmartScreen a
  corto plazo**, que es el motivo de esta tarea.

### EV (Extended Validation)

- Más caro (del orden de 300–600 USD/año) y la validación es más estricta
  (verificación legal/telefónica de la organización).
- **SmartScreen confía en la reputación de la CA desde el primer instalador
  firmado** — el aviso desaparece de inmediato, sin período de espera.
- La clave privada suele vivir en un token USB con hardware criptográfico (o
  un HSM en la nube), no se puede exportar como `.pfx` plano. Eso complica
  firmar desde un runner de GitHub Actions estándar salvo que la CA ofrezca
  **firma remota** (DigiCert KeyLocker, SSL.com eSigner, GlobalSign y otras
  la ofrecen) — sin eso, un EV clásico no encaja con el flujo
  `CSC_LINK`/`CSC_KEY_PASSWORD` de electron-builder tal como está preparado
  este workflow.

### Dónde se compran

DigiCert, Sectigo (antes Comodo), GlobalSign y SSL.com son las CAs más
usadas; todas venden OV y EV, y varias ofrecen firma remota para EV
compatible con CI.

## Alternativa más barata: Azure Trusted Signing

(antes "Azure Code Signing"). Servicio de Microsoft, factura por uso, no
exige comprar un certificado tradicional ni un token USB. Da reputación
inmediata en SmartScreen porque firma con la cadena de confianza de
Microsoft. Requiere:

- una cuenta de Azure con un *Trusted Signing Account* habilitado,
- verificación de identidad de la organización (la hace Microsoft, es
  equivalente a la de un cert OV/EV),
- un paso de workflow distinto al de hoy: la acción oficial
  `azure/trusted-signing-action` (o la CLI `trusted-signing-cli`) corriendo
  **después** de que electron-builder generó el `.exe`, no las variables
  `CSC_LINK`/`CSC_KEY_PASSWORD` — es un mecanismo de firma diferente. Si se
  elige esta vía hace falta un cambio nuevo en `release.yml`, no está
  preparado hoy (no tiene sentido dejarlo armado sin saber qué cuenta de
  Azure se va a usar).

Costo bastante menor que un EV tradicional (facturación por firma, del orden
de pocos dólares al mes con volumen bajo de releases).

## Alternativa sin costo: publicar el hash

No quita el aviso de SmartScreen — sigue apareciendo igual que hoy — pero
permite que cualquiera compruebe que el `.exe` descargado es exactamente el
que salió de esta CI y no uno modificado en el camino. Se combina bien con
`tools/qa/package-smoke.mjs`, que ya corre en `release.yml`: agregar un
`sha256sum` del `.exe` al mismo job y publicarlo en la descripción de la
release o como archivo adjunto (`checksums.txt`). No requiere secrets ni
certificado — es honesto y gratis, pero no ataca el síntoma (SmartScreen).

## Secrets exactos si se firma con Authenticode (OV o EV con firma remota tipo `.pfx`)

En GitHub: **Settings → Secrets and variables → Actions → New repository
secret**. Crear exactamente estos dos, con estos nombres (ya son los que lee
`release.yml`):

| Nombre del secret | Contenido |
|---|---|
| `CSC_LINK` | El archivo `.pfx`/`.p12` del certificado, codificado en base64 (en Windows: `certutil -encode cert.pfx cert_base64.txt`, y pegar el contenido sin las líneas `-----BEGIN/END CERTIFICATE-----`), o una URL `https://` que resuelva directamente a ese archivo |
| `CSC_KEY_PASSWORD` | La contraseña del `.pfx` |

Nada más: ni `electron-builder.yml` ni `release.yml` necesitan otro cambio
para que la firma funcione una vez que estos dos secrets existen.

## Qué ve el usuario hoy vs. firmado

- **Hoy (sin firmar):** al abrir el `.exe` descargado, SmartScreen muestra
  "Windows protegió tu PC" con el botón principal "No ejecutar"; hace falta
  un clic extra en "Más información" para que aparezca "Ejecutar de todas
  formas". Es el paso donde más gente abandona.
- **Firmado con OV recién comprado:** la misma pantalla puede seguir
  apareciendo durante un tiempo (reputación en cero), aunque las propiedades
  del archivo ya muestran el editor identificado en vez de "Editor
  desconocido".
- **Firmado con EV, con OV tras ganar reputación, o vía Azure Trusted
  Signing:** SmartScreen no interrumpe; el instalador corre directo tras el
  UAC estándar.

## Decisión pendiente — es del usuario, no técnica

Tres salidas legítimas, en orden de costo creciente:

1. **Publicar el hash SHA-256** del `.exe` en la release — gratis, no quita
   el aviso de SmartScreen.
2. **Azure Trusted Signing** — barato, reputación inmediata, requiere cuenta
   de Azure y verificación de identidad.
3. **Certificado EV tradicional** — caro, reputación inmediata, requiere
   token USB o firma remota de la CA.

Un OV normal no está descartado, pero para el objetivo concreto de esta tarea
(que SmartScreen deje de asustar) rinde peor que las tres anteriores durante
el período de "reputación cero", que puede durar semanas o meses. Lo único
que no es una opción válida es dejarlo sin decidir otra versión más.

## Verificación — pendiente, requiere que exista un certificado

No se comprobó en esta tarea porque no hay certificado disponible; no se
puede firmar sin él. Cuando exista uno y los secrets estén cargados:

1. `gh release download <tag> -p '*.exe'` para bajar el instalador ya
   publicado por `release.yml`.
2. En PowerShell: `Get-AuthenticodeSignature .\Orbit-Studio-Setup-<versión>.exe`
   — `Status` debe salir `Valid` y `SignerCertificate` debe mostrar el
   emisor esperado. Equivalente por línea de comandos:
   `signtool verify /pa /v Orbit-Studio-Setup-<versión>.exe`.
3. Instalar ese mismo `.exe` en una máquina limpia (una VM donde ese
   certificado nunca se importó) y confirmar si SmartScreen interrumpe o no.
   Con un certificado OV recién comprado este paso puede seguir mostrando el
   aviso — no es un "sí/no" definitivo la primera vez, la reputación se
   construye con el tiempo.
