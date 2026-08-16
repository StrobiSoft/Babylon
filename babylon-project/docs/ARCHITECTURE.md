# Architektúra és biztonsági döntések

A részletes threat model, domain-, token-, session-, recovery-, assurance- és security-event
szemantika a `SECURITY_ARCHITECTURE.md` dokumentumban található.

## Határok

A backend verziózott JSON REST API-t és három statikus, tokenmentes böngészőoldalt szolgál ki. PostgreSQL az egyetlen tartós állapotforrás. A Flutter kliens rendszerböngészőben végzi a WebAuthn-szertartást, majd localhost vagy későbbi HTTPS alkalmazáshivatkozáson kap vissza egy egyszer használható kódot.

Az állapotátmenetek részletes szerződése: `AUTH_STATE_MACHINE.md`. Az API szerződése: `openapi.yaml`.
A tervezett helyi nyelvi rendszer részletes határai:
[`LANGUAGE_SYSTEM_ARCHITECTURE.md`](LANGUAGE_SYSTEM_ARCHITECTURE.md).

## Biztonsági döntések

- **Átlátszatlan tokenek:** meghívó-, e-mail-, beiratkozási-, tranzakció-, ceremony-, return-, access- és refresh-tokenből csak SHA-256 kivonat marad PostgreSQL-ben. A nyers érték csak a szükséges egyszeri válaszban vagy helyi SMTP-levélben létezik.
- **Azonnali visszavonás:** minden védett API-kérés az access-token kivonata mellett az adatbázisbeli munkamenet, eszköz, lejárat és visszavonás állapotát is ellenőrzi. Nincs stateless JWT türelmi idő.
- **Atomi egyszer használat:** a kritikus sorokat PostgreSQL-tranzakció és `SELECT … FOR UPDATE` védi. A refresh-forgatásban az első kérés lecseréli a tokent; az ismétlés visszajátszásként visszavonja a családot.
- **WebAuthn:** `@simplewebauthn/server`; felfedezhető, felhasználónév nélküli passkey; `userVerification: required`; `attestation: none`; fix RP ID és origin-lista. Credential ID, COSE nyilvános kulcs, számláló, transport, single/multi-device és backup state tárolódik. A könyvtári ellenőrzés eredményét követjük, ezért a szinkronizált passkey nulla számlálója önmagában nem támadás.
- **Natív visszatérés:** a tranzakció kliensazonosítóhoz, fix visszatérési profilhoz, művelethez, PKCE S256 challenge-hez és hash-elt `state` értékhez kötött. A redirect csak `code` és `state` paramétert tartalmaz; token soha nem kerül URL-be.
- **Böngészővédelem:** a fragmentben érkező e-mail- és tranzakcióértékeket a JavaScript azonnal eltávolítja a címsorból `history.replaceState` segítségével. Nincs web storage vagy titoknaplózás. A CSP alapértelmezése `none`, csak saját script/style/connect engedett; `Referrer-Policy: no-referrer`, COOP és további Helmet-fejlécek aktívak.
- **API-perem:** 64 KiB body limit, Zod strict sémák, ismeretlen mező elutasítása, hosszkorlátok, kisbetűs normalizált e-mail, explicit CORS-lista, érzékeny végpontokon percenkénti limit, biztonságos általános hibák és kérésazonosító.
- **Admin token:** legalább 32 karakteres környezeti titok; mindkét oldal fix hosszúságú SHA-256 kivonatán `timingSafeEqual` összehasonlítás történik.
- **Naplózás:** Fastify strukturált napló, auth header és minden nyers tokent hordozó ismert mező redakciója. HTTP-válaszban nincs stack vagy belső kivétel.
- **Tesztelhetőség:** a szolgáltatás óra- és kriptográfiai véletlenforrás-interfészt kap. Produkcióban `crypto.randomBytes/randomUUID`, tesztben determinisztikus forrás és kézzel mozgatható óra működik.

## Adatmodell és migrációk

Az `001_initial.sql` létrehozza a felhasználókat, meghívókat, e-mail-tokeneket, beiratkozási jogosultságokat, natív tranzakciókat, WebAuthn-kihívásokat és -credentialöket, eszközöket, refresh-családokat, munkameneteket, refresh-tokeneket, alkalmazás-visszatérési kódokat és auditnaplót. Idegen kulcsok, részleges egyedi indexek, lejárati indexek és check megszorítások védik a konzisztenciát. Az audit tábla UPDATE/DELETE műveletét adatbázistrigger tiltja.

A `002_bind_onboarding_to_native_transaction.sql` a regisztrációs e-mail- és beiratkozási jogosultságot a konkrét natív tranzakcióhoz köti. A migrációfuttató minden fájlt külön tranzakcióban alkalmaz, SHA-256 ellenőrzőösszeget rögzít, és eltérő már alkalmazott fájlt elutasít.

Minden időpont `timestamptz`, az alkalmazás UTC ISO-8601 formátumot ad vissza. A periodikus takarítás a lejárt egyszer használható rekordokat és lejárt/visszavont munkameneteket törli, auditadatot nem.

## Függőségek

Node 24 LTS, Fastify 5, Zod 4, PostgreSQL 17 és SimpleWebAuthn 13 alkotja a kis backend-felületet. Nodemailer kizárólag a konfigurált SMTP-hosthoz kapcsolódik, fájl- és URL-hozzáférése tiltott. A Flutter kliens csak HTTP, kriptográfiai hash, biztonságos operációsrendszer-tárhely és rendszerböngésző csomagot használ.
