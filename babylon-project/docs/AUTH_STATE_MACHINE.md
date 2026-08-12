# Babylon hitelesítési állapotgép

Ez a dokumentum a hitelesítési protokoll normatív szerződése. Bejelentkezés előtti művelethez e-mail-cím vagy felhasználóazonosító önmagában soha nem elegendő: egyszer használható, rövid életű, szerveroldali jogosultság szükséges.

## Állapotok

### Meghívás és e-mail

`INVITED` → `INVITATION_CONSUMED` → `EMAIL_PENDING` → `EMAIL_VERIFIED`

- `INVITED`: csak a kivonatolt, le nem járt és fel nem használt meghívó létezik.
- `INVITATION_CONSUMED`: tranzakcióban létrejött a `pending_email` felhasználó; a meghívó felhasznált.
- `EMAIL_PENDING`: aktív, kivonatolt e-mail-token létezik. Újraküldés minden korábbi aktív tokent érvénytelenít.
- `EMAIL_VERIFIED`: az e-mail-token felhasznált, a felhasználó `email_verified`; egyszer használható beiratkozási jogosultság jött létre.

`onboarding/resume` általános választ ad. Csak érvényes meghívási előzményű, ellenőrzött, passkey nélküli fiókhoz hoz létre új beiratkozási jogosultságot, és azt e-mailben kézbesíti. SMTP-hiba nem törli a felhasználót; újraküldés/resume később megismételhető.

### Passkey-regisztráció

`ENROLLMENT_GRANTED` → `REGISTRATION_CHALLENGE_ISSUED` → `PASSKEY_REGISTERED`

- Az options végpont előfeltétele érvényes, egyszer használható beiratkozási bearer-jogosultság.
- Az options tranzakció felhasználja a jogosultságot és egyszer használható `registration` WebAuthn-kihívást hoz létre.
- A verify csak az azonos felhasználóhoz, originhez, RP ID-hoz és művelethez kötött, le nem járt kihívást fogadja el.
- Sikeres ellenőrzés felhasználja a kihívást, egyedileg tárolja a credential ID-t, public keyt, számlálót, transportokat, backup eligibility/state adatokat, és aktiválja a felhasználót.
- Natív folyamatban itt még nem jön létre eszköz vagy munkamenet; csak visszatérési kód adható ki a kötött natív tranzakcióhoz.

### Passkey-hitelesítés

`AUTH_TRANSACTION_STARTED` → `AUTHENTICATION_CHALLENGE_ISSUED` → `PASSKEY_VERIFIED` → `RETURN_CODE_ISSUED`

- A `native-auth/start` ellenőrzi a kliensazonosítót, az előre konfigurált visszatérési profilt, a PKCE S256 challenge-et és a nagy entrópiájú `state` értéket, majd rövid életű tranzakciót ad.
- Az authentication options csak az aktív tranzakció opaque azonosítójával kérhető; felhasználónév nélküli, felfedezhető passkey-folyamatot indít, ezért e-mail-fiók létezését nem szivárogtatja.
- A verify felhasználja a kihívást, ellenőrzi az aláírást, origint, RP ID-t és kötelező user verificationt; a könyvtár eredménye alapján frissíti a számlálót. Gyanús számlálóváltozás auditált.
- A siker csak rövid életű, kivonatolt, egyszer használható visszatérési kódot hoz létre. A redirect URL kizárólag `code` és az eredeti `state` értéket kapja; tokeneket nem.

### Natív kódcserélés és munkamenet

`RETURN_CODE_ISSUED` → `CODE_EXCHANGED` → `SESSION_ACTIVE` → (`SESSION_REVOKED` | `DEVICE_REVOKED` | `EXPIRED`)

- Az exchange előfeltétele a nyers return code, az eredeti kliensazonosító és a PKCE verifier. A szerver S256-tal összeveti a tranzakcióban rögzített challenge-et.
- Tranzakciós sorzár biztosítja, hogy párhuzamos kódcseréből pontosan egy sikerüljön.
- Csak exchange hoz létre natív eszközt, munkamenetet, hozzáférési tokent és frissítőtoken-családot.
- A hozzáférési token átlátszatlan; minden védett kérésnél ellenőrizni kell a hashét, lejáratát, munkamenetét és eszközét.
- Refresh sorzárral, atomikusan forgatja a tokent. Egy korábbi token újrafelhasználása visszajátszás: a teljes család és munkamenet visszavonandó.
- Logout visszavonja a munkamenetet. Eszköz-visszavonás annak minden munkamenetét visszavonja, ezért a már kiadott access tokenek azonnal érvénytelenek.

## Végpont-előfeltételek és hatások

| Végpont                           | Előfeltétel                                                               | Létrehoz                                       | Érvénytelenít/felhasznál       |
| --------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------ |
| `admin/invitations`               | állandó időben ellenőrzött bootstrap bearer                               | invitation hash                                | –                              |
| `onboarding/accept-invitation`    | helyes aktív kód + kötött e-mail + aktív regisztrációs tranzakció + state | user, tranzakcióhoz kötött email-token hash    | invitation                     |
| `email-verification/resend`       | aktív regisztrációs tranzakció + state; fiókra nézve általános válasz     | új, tranzakcióhoz kötött email-token hash      | korábbi email-tokenek          |
| `email-verification/confirm`      | aktív, ugyanahhoz a tranzakcióhoz kötött email-token + state              | tranzakcióhoz kötött enrollment grant hash     | email-token                    |
| `onboarding/resume`               | aktív regisztrációs tranzakció + state; fiókra nézve általános válasz     | új, tranzakcióhoz kötött enrollment grant hash | korábbi grantok                |
| `native-auth/start`               | kliens + PKCE + state + allowlisted profil                                | auth transaction                               | –                              |
| `passkeys/registration/options`   | enrollment grant + natív tranzakció                                       | registration challenge                         | enrollment grant               |
| `passkeys/registration/verify`    | registration challenge                                                    | passkey, return code                           | challenge                      |
| `passkeys/authentication/options` | natív tranzakció                                                          | authentication challenge                       | –                              |
| `passkeys/authentication/verify`  | authentication challenge                                                  | return code                                    | challenge                      |
| `native-auth/exchange`            | return code + kliens + PKCE verifier                                      | device, session, token family, token hashes    | return code, transaction       |
| `sessions/refresh`                | aktív current refresh token                                               | új refresh/access hash                         | előző refresh token            |
| `sessions/logout`                 | aktív access token                                                        | audit event                                    | session                        |
| `devices/:id` műveletek           | aktív access token + tulajdonjog                                          | névváltozás/audit                              | visszavonáskor device sessions |

## Tiltott átmenetek

- Meghívó nélkül nem hozható létre felhasználó.
- Ellenőrizetlen e-mailhez nem adható passkey-beiratkozási jogosultság.
- Jogosultság nélkül nem kérhető registration challenge.
- Más művelethez/felhasználóhoz/tranzakcióhoz tartozó vagy felhasznált challenge nem ellenőrizhető.
- Passkey-siker önmagában nem hoz létre natív munkamenetet.
- Return code nem váltható be más klienssel, state-tel, visszatérési profillal vagy PKCE-tranzakcióval.
- Visszavont munkamenet vagy eszköz tokenje nem használható.

## Lejárat és takarítás

A periodikus, tranzakciós takarítás törli a lejárt kihívásokat, meghívókat, e-mail-tokeneket, enrollment grantokat, auth tranzakciókat, return code-okat és lejárt/visszavont munkameneteket. Az auditnaplót nem törli és alkalmazás-API nem módosítja.
