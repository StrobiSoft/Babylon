# Babylon Chronicle — seed note

## Purpose

When Babylon reaches its first public release — its practical "birth" as a publicly available product — create a human-readable Babylon Chronicle alongside the technical history.

The Chronicle is not a changelog and not a substitute for Git history. Its purpose is to preserve the program's life story: the major technical, product, business, community, integration, and other memorable milestones that may later be meaningful to look back on.

This idea itself arose from Babylon's first prenatal correction: before the product had even been publicly born, we noticed that emoji support — an obvious and important messaging capability — had not yet been explicitly included in the plan. The requirement was then added to the already-developed Soft Chat client work and the master plan. That incident prompted the idea that Babylon's notable life events should be deliberately preserved rather than reconstructed years later from commits and conversations.

## Presentation/content lock

A PDF seed was created for the future Chronicle. Its file format, typography, page layout and presentation may change later. The **wording, paragraph structure and intentional line breaks of the seed text are historical content and must not be silently rewritten or reflowed** when the final Chronicle is created. Any deliberate editorial change requires an explicit decision.

The future Chronicle's first page should contain a deliberately inconspicuous easter egg before the first visible chapter. It is not a security secret. The intended presentation is white text on a white background (or an equivalent visually hidden treatment), so an ordinary reader sees only empty space while the text remains present in the document. It should be excluded from normal printing where the final publication technology permits. Do not claim that only AI can discover it; source inspection, selection, accessibility tools, indexing or other processing may also expose it.

The hidden text records the personal spark that preceded Babylon's figurative "Big Bang" and explains the metaphor: a communication difficulty with a Belarusian girl supplied the spark from which the Babylon idea emerged; combustion needs combustible material, oxygen and ignition temperature, and an explosion is extremely rapid combustion. The spark is therefore narratively placed before "Még az ősrobbanás előtt".

## Locked seed text

The following text and line breaks are the seed content to preserve. The first block is intended to be visually hidden; the second block is the first visible Chronicle chapter.

### Hidden block

A szikra

A Babylon eredeti szikrája egy belarusz lánnyal való kommunikáció
nyelvi nehézségeinek leküzdése volt.

Az égéshez éghető anyag, oxigén és gyulladási hőmérséklet kell.
A robbanás rendkívül gyors égés.
A szikra szolgáltatta azt, ami az ősrobbanást elindította.

### First visible chapter

Még az ősrobbanás előtt

Babylon első prenatális javítása: az emoji.

A program még meg sem született, amikor egy már elkészült kliensrészt
vissza kellett nyitni, mert az emoji-támogatás nem szerepelt kifejezetten
a követelmények között.

Ez lett Babylon első születés előtti javítása - és ennek apropóján született
meg az ötlet, hogy a program élettörténetének nagy eseményeit tudatosan
megőrizzük egy külön krónikában.

## What belongs in the future Chronicle

Record only meaningful milestones, not routine commits. Examples may include the first public release, first real external user, first revenue or profit milestone, major technical breakthroughs, important external integrations or approvals, major security/product milestones, and other events that materially shape Babylon's story.

Until public release, this file acts only as a seed/reminder. At Babylon's public birth, create the actual Chronicle and use this note and the locked seed text as the starting point rather than treating this file as the finished publication.

## Prenatal chronicle source records

The entries below preserve major pre-release events while they can still be
reconstructed accurately. They are source material for the future human-readable
Chronicle, not a routine commit log. Technical evidence is included only where
it establishes why an event mattered. Operational secrets and internal access
details belong in protected evidence records, not in this public repository.

### 2026-08-29 — Babylon távoli keze és a falba vájt szolgálati bejárat

#### Az eredeti cél

A nap munkája egy korábban megfogalmazott gyakorlati problémából indult ki.
Babylon fejlesztését nemcsak otthonról, a Victus előtt ülve kellene folytatni.
A tulajdonos munkanap közben többnyire nem viszi magával a laptopot, viszont az
iPhone mindig nála van. A kívánt működés ezért nem egyszerű távoli asztal volt,
hanem az, hogy a telefonról, lehetőleg hanggal lehessen feladatot adni az otthoni
Codexnek, amely a valódi Babylon-környezetben dolgozik tovább.

Az alapvető akadály az volt, hogy a telefonos ChatGPT-beszélgetés önmagában
felhőbeli környezetben futott, ezért nem látta sem a Victust, sem a Babylont, sem
az otthoni Codex munkamenetét. A VPN ötlete eredetileg ennek áthidalására
született. A nap végére kiderült, hogy a ChatGPT/Codex Remote külön vezérlési
réteget ad a telefon és a Victus között, de a VPN ettől nem vált feleslegessé:
biztonságos hálózati elérést biztosít a Victusnak a ZooLab célgépeihez és a
Babylon SSH-munkakörnyezetéhez.

#### A ZooLab magánhálózatának felépítése

A Victus csatlakozott a ZooLab privát Tailscale-hálózatához. A Pepperen futó
külön alhálózati átjáró kizárólag négy jóváhagyott célgépet hirdetett meg:

- a Pepper Proxmox gazdagépet;
- az Idesüss webes virtuális gépét;
- a Babylon virtuális gépét;
- a HP hálózati nyomtatót.

A csatlakozási leltár igazolta, hogy a Tailscale szolgáltatás és háttér fut, a
Victus online, az alhálózati útvonalak elfogadása engedélyezett, nincs exit
node, a Victus nem hirdet saját útvonalakat, és a Tailscale SSH tiltott. A négy
célpont útvonala a Tailscale adapteren keresztül élt, miközben a Windows
alapértelmezett internetes útvonala változatlanul a helyi Etherneten maradt.
Tehát nem a Victus teljes internetforgalma került a VPN-re, hanem csak a négy
szükséges ZooLab-célpont.

A teljes, hash-ekkel rögzített csatlakozási leltár és annak nyers kimenete a
védett belső bizonyítékok között maradt. A nyilvános krónika szándékosan nem
tartalmaz belső címeket vagy operatív fájlutakat.

#### A Victus saját védelme

A Victuson előregisztrált, ellenőrzött változtatással bekapcsoltuk a
`ShieldsUp` védelmet. A cél az volt, hogy a Victus továbbra is kezdeményezhessen
kapcsolatokat a magánhálózaton, de ne fogadjon bejövő Tailscale-kapcsolatokat.

Az ellenőrzés minden kapuja teljesült:

- a Victus védőpajzsa bekapcsolt;
- az alhálózati útvonalak elfogadása változatlan maradt;
- a Tailscale SSH továbbra is tiltott volt;
- exit node továbbra sem volt;
- a Victus nem hirdetett útvonalakat;
- pontosan a négy jóváhagyott célútvonal maradt telepítve;
- minden célútvonal a Tailscale adaptert használta.

A változtatás előtt előregisztráció készült, utána pedig külön ellenőrzési
jelentés és SHA-256 bizonyíték igazolta a végállapotot.

#### A zárt átjáró negatív próbája

Amíg a ZooLab alhálózati átjárójának saját védőpajzsa zárt volt, a Victus már
látta a célútvonalakat, de a Pepper kezelőfelülete és a nyomtatási szolgáltatás
nem volt elérhető. Ez igazolta, hogy pusztán az útvonalak telepítése nem kerülte
meg az átjáró védelmét.

A negatív próba eredménye:

- a Pepper kiválasztott kezelési szolgáltatása az elvárás szerint blokkolt;
- a nyomtató kiválasztott szolgáltatása az elvárás szerint blokkolt;
- a négy célútvonal közben telepítve és élő állapotban maradt;
- konfigurációmódosítás nem történt;
- az eredmény külön, hash-elt jelentésben megmaradt.

#### Az átjáró megnyitási kísérletei és a biztonsági időzítők tanulsága

Az átjáró továbbított forgalmának megnyitása előregisztrált próbával indult.
A helyi tűzfal csak az előre jóváhagyott célgépek és szolgáltatások felé
engedélyezett forgalmat, a visszatérő állapottartó kapcsolatokat elfogadta, és
minden más továbbított forgalmat eldobott.

Az IPv4-továbbítás, az állapottartó szűrés és a szükséges forráscím-fordítás
megmaradt. Az IPv6-továbbítás, az idegen alhálózati útvonalak elfogadása és a
Tailscale SSH tiltva maradt. A Victus saját védőpajzsa közben változatlan volt.

Az első tesztablakhoz automatikus visszazárást terveztünk, de az időzítő
állapota ellentmondásos lett: a kezdeti kimenet aktív időzítőt jelzett, később
azonban az időzítő és a hozzá tartozó szolgáltatás eltűnt, miközben az átjáró
nyitva maradt. A hiteles külső jelentés ekkor még nem állt rendelkezésre.

A rendszer ezért eltérésként kezelte az állapotot, visszakapcsolta az átjáró
védelmét, majd ellenőrizte, hogy a négy útvonal, a tűzfalszabályok, a továbbítási
beállítások, a hálózati konfiguráció és a konténerkonfiguráció sértetlen maradt.
A helyreállítás minden lépése és ellenőrzőösszege külön bizonyítékban megmaradt.

A következő időzítési diagnosztika azt is igazolta, hogy a korábban várt
systemd-egységfájlok hiányoztak, és nem volt használható naplóbejegyzés. A
továbbítási tűzfalszabályok azonban változatlanok voltak, az átjáró pedig zárt
végállapotban maradt.

A harmadik változat már tartós egységfájlokkal, abszolút programutakkal és
rövid tesztablakkal készült. Az első próbálkozás azért állt meg, mert egy shell
beépített parancsot a konténerkezelő közvetlen futtatható programként próbált
elindítani. Az abszolút programutakkal javított változat ezután igazoltan
megnyitotta a tesztablakot, működő visszazárási idővel.

#### A célzott szolgáltatáspolitika mérése

A következő külső vizsgálat célja nem pusztán az volt, hogy „van hálózat”,
hanem hogy a tűzfalszabályok pontosan a kívánt szolgáltatásokat engedjék:

| Cél | Elvárt állapot |
|---|---|
| Pepper kezelőfelület | engedélyezett |
| Idesüss web | engedélyezett |
| Babylon SSH | engedélyezett |
| HP nyomtató IPP | engedélyezett |
| HP nyomtató web | tiltott |
| HP nyomtató RAW | tiltott |

Az első hosszú PowerShell-blokk az interaktív bevitel és a lezáró kapcsos
zárójel körüli viselkedés miatt nem hozott létre hiteles jelentést. A korábbi
változók egy része nem maradt használható állapotban, az egymástól külön
beküldött `if` és `else` blokkokban pedig az `else` külön parancsként
értelmeződött. Ez nem hálózati hiba volt, hanem annak bizonyítéka, hogy a hosszú
interaktív parancsblokkok kézi beillesztése önmagában megbízhatatlan folyamat.

A megismételt mérés négy eltérést talált: a négy engedélyezendő szolgáltatás
zárt volt, míg a két tiltandó nyomtatóport helyesen zárt maradt. Az időzítési
diagnosztika később igazolta, hogy ez a mérés már visszazárt átjárón történt,
nem pedig hibás tűzfalszabályokat talált.

Az igazoltan nyitott tesztablakban végrehajtott végleges mérés mind a hat
ellenőrzést teljesítette:

- a négy engedélyezett cél elérhető volt;
- a két tiltott nyomtató-szolgáltatás elérhetetlen maradt;
- eltérések száma: nulla;
- a teljes jelentés és annak SHA-256 bizonyítéka megmaradt a védett belső
  dokumentációban.

A sikeres mérés után a subnet router használható, tűzfallal szűrt továbbítási
állapotban maradt. A Victus saját bejövő védelme közben végig aktív volt.

#### A Remote váratlan megjelenése

A következő fordulat nem a VPN-ben, hanem a ChatGPT/Codex asztali kliensben
történt. Korábbi keresések során a `Kapcsolatok` menüpont sem a ChatGPT-ben,
sem a Codexben nem jelent meg, ezért egy időre úgy tűnt, hogy a hivatalos
Remote megoldás nem használható. Ugyanazon a napon a menüpont később mégis
megjelent a beállításokban.

A Victuson engedélyeztük, hogy egy párosított saját eszköz vezérelhesse a
számítógépet, majd az iPhone a megjelenített QR-kóddal kapcsolódott hozzá. A
telefon Remote felületén a Victus online gépként jelent meg. Ezzel megvalósult
az eredeti használati elképzelés: a telefon a Victuson futó Codex
munkameneteit tudta indítani és követni anélkül, hogy nyilvános internetes
szolgáltatást vagy saját házi vezérlőtunnelt kellett volna fejleszteni.

A telefonos hangbeszélgetésben a rendszer külön engedélyt kért egy új Codex
feladat létrehozásához. Az engedélyezés után Codex valóban létrehozott egy új
csevegést és megkapta a GitHub 33-as feladatára vonatkozó utasítást. A
felhasználói élmény ekkor még nyers volt: Codex nem adott azonnali szóbeli
visszajelzést, a csevegés létrehozása és megjelenése hosszasan töltött, és a
valós idejű hangbeszélgetés bezárásakor a csevegés átmenetileg eltűnőnek tűnt.
Később azonban a feladat megjelent a Victus asztali kliensében, és Codex
ténylegesen dolgozott rajta.

Az operatív tanulság az lett, hogy a rövid hangos indítóutasításnak tartalmaznia
kell a feladat azonosítóját és az indulás visszaigazolásának kérését. A részletes
műszaki feltételeknek továbbra is a GitHub tulajdonosi utasításában kell
maradniuk, nem a járás közben bemondott mondatban.

#### Soft Chat P3 és P4: a távoli munkavégzés első valódi célja

A Remote első valós Babylon-feladata a Soft Chat magas p99 válaszidejének
vizsgálatához kapcsolódott. A munka nem egy általános „gyorsítsd fel” kérés
volt, hanem a GitHub issue #33 előregisztrált P1–P5 kísérletsorozatának
folytatása. Az elfogadási politika ekkorra már nem egyetlen merev 2000 ms-os
határ volt: a 2000 ms referenciaérték maradt, a későbbi tízfutásos jelölt
feltétele pedig legalább öt, 2000 ms-os vagy jobb eredmény és megfelelő átlag.

Codex elkészítette az izolált P3 determinisztikus lejárati állapotgyorsítótárat,
előregisztrálta, tesztelte és külön draft PR-ben dokumentálta. A statikus
ellenőrzések, 94 nem adatbázisos teszt és 33 PostgreSQL auth/security teszt
sikeres volt. A P3 biztonsági határa szűk maradt: csak önmagában lejáró,
tokenhez kötött állapot kerülhetett gyorsítótárba; a visszavonási és más
változó biztonsági állapot továbbra is friss PostgreSQL-ellenőrzést kapott.

A valós P3 mérés azonban nem érte el a célértéket:

- átlagos throughput: körülbelül `145.00 msg/s`;
- mért p99: körülbelül `3388 ms`;
- biztonsági regresszió nem jelent meg;
- a teljesítményjavulás nem volt elegendő;
- a mérési munkapéldány visszaállt a tiszta B0 alapra.

A következő izolált kísérlet, P4 elkészült és mérésre kész állapotba került.
A draft PR ellenőrzése 137 sikeres tesztet, három kontrollált E2E kihagyást,
sikeres typechecket, lintet, formázást és buildet mutatott. A független
biztonsági és hatókör-ellenőrzés nem talált blokkoló hibát.

A három hiteles P4 mérés mégsem indult el a felhőbeli Codex-környezetből, mert
annak nem volt útvonala a Pepper és a belső Babylon-környezet felé. Ez volt az
a pont, ahol a Remote és a VPN együttműködésének valódi értéke először
kézzelfoghatóvá vált: a Victuson futó helyi Codexnek kellett elérnie a
Babylont, és ott végrehajtania a már elkészített mérési tervet.

#### A korábban létrehozott SSH-útvonal felfedezése

A Victus munkakörnyezetének felmérése közben kiderült, hogy a szükséges
Babylon-hozzáférés valójában már korábban elkészült. A Victuson két külön
kulcspár és két SSH-álnév volt jelen, és mindkettő nem interaktív, szigorú
hostkulcs-ellenőrzés mellett sikeresen belépett a Babylon elkülönített `codex`
fiókjába.

A távoli környezet igazolta a Babylon repositoryt, a Node és Docker
elérhetőségét, valamint a tiszta, leválasztott B0 állapotot. Ezzel
funkcionálisan megoldódott a Codex-munkakörnyezet problémája.

Ugyanez azonban biztonsági megállapítást is jelentett. Nem új nyilvános portot
nyitottunk és nem új kulcsot hoztunk létre; egy korábban létező, teljes értékű
oldalirányú hozzáférési utat fedeztünk fel. Ha valaki megszerzi a Victus
munkamenetét és a használható magánkulcsot, a jóváhagyott VPN-útvonalon
továbbléphet a Babylon elkülönített fejlesztői fiókjába. A Victus saját bejövő
védelme ezt nem tiltja, mert az a Victus felé érkező kapcsolatokat korlátozza,
nem a Victus által kezdeményezett kapcsolatokat.

A nyilvános krónika nem közli a kulcsok ujjlenyomatait, belső címeket,
felhasználói fájlutakat vagy a hozzáférési konfiguráció pontos szerkezetét.
Ezek a már létrehozott, védett biztonsági feljegyzésben maradnak.

#### Az „ágyúgolyó ütötte lyukból” ellenőrzött szolgálati bejárat

A tulajdonosi döntés nem egy újabb bonyolult hálózati védelmi réteg lett.
Megszületett a StZoo-féle egyszerűsítő megoldás: alapállapotban a Babylon ne
fogadja el a Victus kulcsait; a hozzáférést kizárólag a Pepperről lehessen
ideiglenesen megnyitni, majd a munka után bezárni.

Először független helyreállítási utat kellett igazolni. A preferált
virtuálisgép-kezelő út nem volt használható, ezért nem lehetett rá
vészbejáratként támaszkodni. A Pepper külön SSH-kulcsa azonban megvolt. Az SSH
elsőre nem választotta ki automatikusan, de a kulcs kifejezett megadásával a
Pepper sikeresen belépett a Babylonra. Csak ezután kezdődött meg a Victus
hozzáférésének lezárása.

A Pepperen elkészült két kanonikus kulcslista:

- nyitott állapot: Pepper és a jóváhagyott Victus-kulcsok;
- zárt állapot: kizárólag a Pepper helyreállítási kulcsa.

A Victus-kulcsok eltávolítása után mindkét Victus-álnév új kapcsolata az
elvárás szerint meghiúsult, miközben a Pepper saját kulcsával továbbra is be
tudott lépni. Így a kizárás és a helyreállítási út egyszerre kapott valódi
bizonyítékot.

A Pepperen ezután létrejött egy kizárólag rendszergazdai joggal használható
háromállapotú kezelőeszköz:

- nyitás: a jóváhagyott Victus-kulcsok ideiglenes engedélyezése;
- zárás: visszaállás a kizárólagos Pepper-kulcsra;
- állapot: az aktív lista és a kulcsok ellenőrzése.

A kezelő minden váltás előtt biztonsági másolatot készít, atomikusan telepíti a
kulcslistát, ellenőrzőösszeggel visszaellenőrzi az eredményt, és hiba esetén
megkísérli az előző állapot visszaállítását. A teljes
`nyitás → zárás → állapot` életcikluspróba sikeres volt. A próba végén csak a
Pepper kulcsa maradt, a Victus útjai ismét zárva voltak.

A rendszer így azt a biztonsági hibalehetőséget, amelyet a tulajdonos találóan
„ágyúgolyó ütötte lyuknak” nevezett, nem pusztán betömte. A lyukból ellenőrzött
szolgálati bejárat lett: a Victus felől nem nyitható, Pepper őrzi a vezérlését,
a kulcslista állapota mérhető, minden váltás mentett és visszaellenőrzött.

#### Az első éles nyitás

Az éjfél körüli első éles nyitás sikerült. Az aktív kulcslista pontosan
megegyezett a kanonikus nyitott állapottal, és minden várt kulcs megjelent.

A Victusról végzett azonnali próba sikeresen belépett a Babylonra, igazolta az
elkülönített fejlesztői felhasználót, a célgépet és a tiszta, leválasztott B0
állapotot. A kapcsolat ténylegesen a Victusról, a privát hálózati útvonalon
keresztül érte el a Babylon virtuális gépet.

A GitHub issue #33 új tulajdonosi utasítást kapott. A korábban elérhetetlen
végrehajtási szállítás helyett a validált Victus–Babylon utat írta elő, miközben
a mérési tartalom, a P4 forrásállapota, a B0 visszaállítási cél és valamennyi
biztonsági, helyességi és bizonyítékmegőrzési kapu változatlan maradt.

A feladat a három hiteles P4 futás, a bizonyítékok megőrzése, a végső
P4-besorolás és a tiszta B0 visszaállítás. Tilos maradt a merge, az éles
rendszer módosítása, más kísérletek kombinálása, illetve a VPN vagy a
beléptetőrendszer megváltoztatása.

A hozzáférési kapu pillanatnyi működési állapota szándékosan nem szerepel ebben
a nyilvános krónikában. A védett üzemeltetési nyilvántartás tartalmazza az
aktuális állapotot és a kötelező visszazárási lépést. A dokumentált nyugalmi
alapállapot zárt, kizárólagos Pepper-helyreállítási hozzáféréssel.

#### Költség és elszámolás

A tulajdonos ezen a napon további **25,40 USD** ChatGPT/Codex kreditet vásárolt.
A költség Babylonhoz számítandó, mert a VPN, a Remote elérés és a helyi Codex
munkakörnyezet közvetlen célja Babylon távoli fejlesztésének lehetővé tétele
volt. Ez a tétel a Babylon teljes bekerülési költségének része, még akkor is,
ha a technikai munka egy része ZooLab infrastruktúrában jelent meg.

#### A nap mérlege

A nap nem egyetlen kódváltoztatással vitte előre Babylont. Ennél alapvetőbb
képesség született:

1. a Victus biztonságosan csatlakozott a ZooLab célpontokra korlátozott privát
   hálózatához;
2. a hálózati tűzfalszabályok pozitív és negatív próbákkal igazolták a kívánt
   szolgáltatáspolitikát;
3. az iPhone és a Victus között működésbe lépett a hivatalos Remote vezérlés;
4. Codex telefonról indítható, követhető és a Victus valódi környezetében tud
   dolgozni;
5. a Victus régi, korábban már működő Babylon SSH-útja láthatóvá és mérhetővé
   vált;
6. a felfedezett oldalirányú kockázatból Pepper által vezérelt, alapállapotban
   zárt beléptető rendszer készült;
7. a P4 hiteles mérésének utolsó infrastrukturális akadálya megszűnt.

A megoldás lényege végül nem egy saját vezérlőtunnel és nem egy újabb összetett
szolgáltatás lett. A hivatalos Remote elérte a Victust, a Tailscale elérte a
Babylont, a Pepper pedig kézben tartotta a Babylon ajtókulcsát. A StZoo-féle
egyszerűsítő módszer ezen a napon nem a védelem csökkentését jelentette, hanem
azt, hogy minden réteg pontosan egy feladatot kapott.
