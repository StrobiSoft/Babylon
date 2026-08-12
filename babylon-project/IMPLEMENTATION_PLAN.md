# Babylon első hitelesítési vertikális metszete – végrehajtási terv

Kiindulási commit: `429668ee3549f20d8eb219f18a8663c0d8d190df`.

Kiindulási állapot: nem volt Babylon-alkalmazáskód, architektúra- vagy tervdokumentum, illetve Babylon-teszt. A `services/zoolab-monitor` és a nem követett `services/babylon-status` külön infrastruktúra-projekt; egyik sem része ennek a munkának.

## Mérföldkövek

1. **Biztonsági szerződés:** hitelesítési állapotgép, környezeti konfiguráció, API- és adatmodell-határok rögzítése.
2. **Perzisztens backend:** tranzakciós PostgreSQL-migrációk, meghívás, e-mail-ellenőrzés, WebAuthn, PKCE/state, átlátszatlan tokenek, eszköz- és auditkezelés.
3. **Kliensfelületek:** biztonságos WebAuthn-böngészőoldalak és az üzleti logikától elválasztott minimális Flutter-kliens Android/Windows célokra.
4. **Automatizált ellenőrzés:** egység-, integrációs-, biztonsági és kliens-tesztek, típusellenőrzés, lint, formázás és build.
5. **Működési próba:** helyi PostgreSQL + SMTP + backend, teljes meghívás–passkey–munkamenet–visszavonás folyamat, újraindítás és adatmegmaradás.
6. **Átadás:** OpenAPI, reprodukálható README, biztonsági döntések és igazolt környezeti korlátok dokumentálása.

## Döntések

- A Babylon Project izolált monorepója a `babylon-project/`; az infrastruktúra-szolgáltatásokat nem importálja és nem módosítja.
- A hozzáférési és frissítőtokenek átlátszatlanok és csak SHA-256 kivonattal kerülnek PostgreSQL-be. Minden védett kérés adatbázisban ellenőrzi a munkamenet és az eszköz aktív állapotát, így a visszavonás azonnali.
- A WebAuthn-folyamatot a karbantartott `@simplewebauthn/server` könyvtár ellenőrzi; user verification kötelező, attesztáció `none`, a passkeyk felfedezhetők.
- A natív kliens csak előre konfigurált visszatérési profilt használ; PKCE S256 és nagy entrópiájú `state` kötelező. Token nem kerül URL-be.
- Minden egyszer használható jogosultságot tranzakció és sorzár véd; nyers titkos érték nem kerül adatbázisba vagy naplóba.
- A tesztelhető időfüggéshez befecskendezhető óra, a tokenekhez befecskendezhető biztonságos véletlenforrás tartozik.
