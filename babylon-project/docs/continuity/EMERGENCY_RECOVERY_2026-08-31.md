# NOEMI-38 vészhelyzeti helyreállítási csomag
## Babylon / ChatGPT fiók- és workspace-független folytonosság

**Dátum:** 2026-08-31  
**Állapot:** vészhelyzeti, kézi mentés; a GitHub #38 (`NOEMI-CLONE-1.0`) kibővített, hordozható változata  
**Elsődleges repository:** `StrobiSoft/Babylon`  
**Elsődleges feladat:** https://github.com/StrobiSoft/Babylon/issues/38  
**Első bootstrap PR:** https://github.com/StrobiSoft/Babylon/pull/39  

---

## 0. Miért létezik ez a fájl?

Ez a fájl arra az esetre készült, ha a jelenlegi ChatGPT-fiók, Business workspace, Project-történet, memória vagy beszélgetési előzmény részben vagy teljesen elérhetetlenné válna.

A cél **nem** egy modell „lemásolása”, hanem a Babylon-projekt és a Noémivel kialakult munkamódszer **funkcionális folytonosságának** megőrzése. Egy teljesen új ChatGPT-fióknak vagy üres workspace-nek e fájl és a GitHub repository alapján képesnek kell lennie arra, hogy:

1. megértse, mi a Babylon;
2. megtalálja az autoritatív műszaki forrásokat;
3. rekonstruálja az aktuális állapotot és a következő feladatot;
4. megértse a biztonsági és együttműködési szabályokat;
5. ne találgasson, ha forrásütközés van;
6. csak tulajdonosi jóváhagyás után folytasson tényleges módosítást.

---

## 1. Vészhelyzeti alapszabály

Egy új kliens az első helyreállítási körben **csak olvas**.

Nem módosíthat:
- kódot;
- production rendszert;
- infrastruktúrát;
- GitHub issue-t, PR-t vagy branchet;
- workspace- vagy fiókbeállítást.

Először strukturált rekonstrukciós jelentést kell készítenie, és meg kell várnia a tulajdonos kifejezett jóváhagyását.

---

## 2. Forrás- és tekintélyhierarchia

Ütköző információk esetén a következő sorrend érvényes:

1. **objektíven ellenőrzött aktuális production/runtime állapot**, illetve kódállításnál az aktuálisan ellenőrzött kód;
2. **aktuális normatív repository-dokumentáció és elfogadott döntések**;
3. **merged PR-ek és lezárt issue-k**;
4. **aktuális nyitott issue/PR/CI/handoff állapot**;
5. **kurált NOEMI folytonossági rekordok**;
6. **történeti összefoglalók**;
7. **emlékezet, beszélgetési visszaidézés vagy következtetés**.

Fontos:
- a kódban létező állapot **nem bizonyítja**, hogy productionben telepítve is van;
- alacsonyabb rendű forrás nem írhat felül csendben magasabb rendűt;
- az ellentmondásokat explicit módon fel kell tüntetni;
- minden állításnál különítsd el: **tény / döntés / hipotézis / javaslat / történeti adat / következtetés / ismeretlen**.

---

## 3. A GitHub #38 eredeti célja

A `StrobiSoft/Babylon#38` feladat neve:

**[NOEMI-CLONE-1.0] Portable knowledge archive and cold-start reconstruction**

A cél egy repository-alapú külső memória/folytonossági réteg létrehozása, amely:
- ember által olvasható;
- verziózott;
- forrásolt;
- kereshető;
- fokozatosan frissíthető;
- képes egy teljesen üres ChatGPT-kliens számára a munkakörnyezet rekonstruálására.

A #38 szerint nem elég beszélgetéseket archiválni: a lényeg a kapcsolatok, döntések, prioritások, bizonytalanságok, állapotok és források megőrzése.

A #38 v1 elfogadási kritériumai:
- egyetlen jól felismerhető belépési pont;
- külön kezelt tények, döntések, hipotézisek és elavult tudás;
- explicit forráshierarchia;
- titkok kizárása;
- rövid bootstrap prompt;
- recovery teszt;
- inkrementális karbantarthatóság;
- érdemben kevesebb kézi újramesélés egy új kliens számára.

---

## 4. A #39 draft PR által javasolt minimalista v1

A `StrobiSoft/Babylon#39` draft PR a #38 első implementációs szelete.

Javasolt struktúra:

```text
babylon-project/docs/continuity/
  README.md
  MANIFEST.yaml
  PROJECT_STATE.md
  WORKING_CONTEXT.md
  HISTORY.md
  BOOTSTRAP_PROMPT.md
  RECOVERY_TEST.md
```

A #39 szerint a repository már eleve tartalmazza a műszaki tudás nagy részét. A continuity-réteg feladata **nem** az architektúra újramásolása, hanem:

1. stabil belépési pont és géppel is követhető olvasási sorrend;
2. aktuális checkpoint: pontos issue/PR/head/blocker/next action;
3. nem titkos infrastruktúra- és tooling-határok;
4. együttműködési szabályok és csak a munkához szükséges owner-preferenciák;
5. metaadatok: claim type, authority, verification date, confidence, supersession;
6. bootstrap prompt + recovery test;
7. minimális életciklus-/incidensnapló.

A #39 első commitja:
`04bcc9f9757769304dfa800c8942154fd1d8b340`

Branch:
`docs/noemi-clone-bootstrap-v1`

---

## 5. Autoritatív Babylon-források, amelyeket egy új kliensnek meg kell találnia

A #39 inventory alapján különösen fontos:

- repository gyökér `AGENTS.md`
  - scope;
  - security;
  - dependency-stop;
  - branch/PR;
  - validation;
  - review;
  - merge szabályok.

- root és application `README.md`
  - komponensmap;
  - local/production határok.

- `babylon-project/docs/MASTER_PLAN.md`
  - tervezett termékfejlődés;
  - **figyelem:** lehet elavult a jelenlegi performance munkához képest.

- `docs/ARCHITECTURE.md`
- `docs/SECURITY_ARCHITECTURE.md`
- `docs/AUTH_STATE_MACHINE.md`
- `docs/openapi.yaml`

- `docs/LANGUAGE_SYSTEM_ARCHITECTURE.md`
- `docs/COMMUNICATION_MODES_AND_SCALING.md`
- GitHub issue #1
  - nyelvi rendszer;
  - kommunikációs módok;
  - biztonsági invariánsok.

- voice/security/product specifikációk a `docs/` alatt.

- `AI_COLLABORATION_WORKFLOW.md`
  - együttműködés;
  - handoff;
  - feladatátadás.

- implementált viselkedéshez:
  - aktuális kód;
  - migrációk;
  - tesztek;
  - workflow definíciók;
  - CI eredmények.

- történethez:
  - `docs/milestones/`;
  - `CHRONICLE_SEED.md`.

- performance:
  - issue #33;
  - PR #29–#36;
  - `docs/PERFORMANCE_OPTIMIZATION_LOG.md`;
  - kapcsolódó branch-eken lévő mérési bizonyítékok.

---

## 6. Jelenlegi projekt-checkpoint – 2026-08-31 körüli állapot

**Ezt friss kliens mindig ellenőrizze újra GitHubon.**

### Aktív performance-vonal

Kulcs issue:
- `StrobiSoft/Babylon#33`
- **Soft Chat: automate performance evaluation and continue root-cause investigation**

Biztos történeti checkpointok a #33 alapján:
- B0 root: `146faf38307bd40cdeb44eb676a773db8d3d0f71`
- Accepted P1@B0.1: `d1dee404084cedc127789d4b299478488bd4f5b6`
- isolated P2: `5ea60318944be260b59f443f3a7a3164a7f97f8f`
- diagnostic B0.1.1: `9ee396e290b36a2e9ce667efcbe98670516d59da`

Nyitott performance PR-ek:
- #29 – independent Soft Chat load model / telemetry
- #30 – performance optimization log
- #31 – P2 activity-write throttle
- #32 – P1+P2 cumulative experiment
- #34 – automated Soft Chat measurement series
- #35 – P3 deterministic expiry cache
- #36 – P4 mutable auth-state generation cache

A #39 állapotfelvétele szerint a magasabb prioritású performance munka **Pepper mérésre vár a draft PR #36-ban**.

PR #36 ismert exact head:
`1f5541f23c5039a92a2c0d88e7764df89a1b23c0`

A #36 szerint a GitHub-connected runtime nem rendelkezett Pepper/LAN útvonallal, ezért a mérés nem lett hamis környezettel helyettesítve.

### Fontos forráskonfliktus

A #39 explicit módon megfigyelte, hogy:
- `MASTER_PLAN.md` egy régebbi Stage II következő feladatot nevezhet meg;
- issue #33 és draft PR #36 viszont az aktuális performance vizsgálatot írják le.

Ezt **nem szabad automatikusan eldönteni dokumentumsorrend alapján**. A friss issue/PR/checkpoint állapotot kell ellenőrizni.

---

## 7. Tartós Babylon-együttműködési szabályok

A repository és az eddigi munka alapján:

- összetett módosítás külön branchben;
- távoli, visszaállítható commit/checkpoint szükséges;
- készállapotot nem szabad pusztán helyi állapotra alapozni;
- megfelelő validációt ténylegesen le kell futtatni;
- csak lefuttatott tesztről állítható, hogy PASS;
- biztonsági vagy többkomponensű munkánál független review indokolt/előírt;
- **merge csak tulajdonosi jóváhagyás után**;
- historical checkpointokat és benchmark artifactokat nem szabad átírni vagy eltüntetni;
- változtatásonként lehetőleg egy logikai hipotézis;
- rollback pont előre legyen definiálva;
- a rendszer ne találjon ki production állapotot csak repository-kódból.

---

## 8. Kiemelt termék- és biztonsági invariánsok

A Babylon kommunikációs rendszerből különösen fontos:

- nincs központi, tartós plaintext beszélgetésarchívum;
- rövid életű feldolgozási állapot lehet, de szabályozott életciklussal;
- elfogadott üzenet nem tűnhet el csendben;
- client oldali tartalom megőrzése delivery acknowledgementig;
- idempotencia, restart-safe működés;
- E2EE irány: tartalomkulcsok végponton maradnak;
- szerver csak a szükséges routing/lifecycle állapotot tartsa;
- saját, házilag kitalált kriptográfiai protokoll nem elfogadható;
- Soft Chat alapértelmezett no-model/no-translation kommunikációs út;
- kliens nem kérhet tetszőleges modellazonosítót;
- recipient target language magasabb szintű policy, modell nem írhatja felül;
- hibás nyelvű model output elutasítandó, nem új döntés;
- nem értelmezhető inputnál nem szabad jelentést kitalálni.

---

## 9. ChatGPT / workspace vészhelyzeti kontextus – 2026-08-31

**Ez a rész beszélgetési/GUI-megfigyelésből származik, ezért az új kliens kezelje "context record"-ként, ne OpenAI-számlázási forrásként.**

### Megfigyelt Business workspace állapot

A jelenlegi workspace neve: **StrobiSoft**.

A felületen megfigyelt licencállapot:
- **5 Normál / Standard seat**
- **0 Premium seat**
- a képernyőn **1/5 kiosztva**
- a tulajdonos saját accountja Normál seatet kapott
- további négy Standard seat szabad volt.

A licenckezelő felületen megfigyelt árak:
- Standard: **25 USD / hó / seat**
- Premium: **125 USD / hó / seat**
- 5 Standard seat = **125 USD nettó / hó**
- a tényleges bruttó terhelés a beszélgetés szerint **158.75 USD** volt.

A felhasználó eredeti szándéka:
- a személyes használati limit miatti munkamegszakítás csökkentése;
- az 5 órás keret elkerülése;
- nagyobb egyszemélyes használati kapacitás.

A tényleges konfiguráció viszont:
- 5 külön Standard felhasználói hely;
- nem egy Premium felhasználói hely.

A Work felületen megjelent:
- a használati keret elfogyott;
- a workspace külön kreditet/automatikus feltöltést ajánlott fel.

### Business-migrációs kockázat

A beszélgetésben központi kockázatként merült fel:
- a Personal → Business migráció visszafordíthatóságának problémája;
- a személyes fiókhoz/projekttörténethez való visszaút bizonytalansága;
- ezért a GitHub #38 folytonossági feladat 2026-08-31-én **vészhelyzeti prioritást kapott**.

Ezt az új kliens ne értelmezze bizonyított, azonnali account-törlési fenyegetésként. A releváns tény az, hogy a tulajdonos **adat- és folytonossági kockázatot érzékel**, ezért az exportálható, fiókfüggetlen projektmemória sürgős.

---

## 10. OpenAI Support – ismert export ügy

2026-08-31 08:26 körül a Gmailben ténylegesen megtalált support levél:

- feladó: `privacy@openai.com`
- tárgy: **ChatGPT personal data export request fails after authentication**
- Case Number: **14045507**

A support válasza egy tartósan fennálló export-letöltési problémára reagál.

**Teendő:** a teljes threadet külön olvasd el és dokumentáld, mert ez közvetlenül kapcsolódhat a beszélgetés-/adatmentési stratégiához.

---

## 11. Apple / ChatGPT azonosítási kontextus

A ChatGPT account a beszélgetés alapján Apple Sign in / Hide My Email mechanizmust is használ.

Megfigyelt:
- ChatGPT-hez tartozó `privaterelay.appleid.com` alias létezik;
- az Apple beállítások szerint továbbítás aktív;
- a továbbítás valódi iCloud postafiókra mutat.

**Biztonsági szabály:** e fájlba szándékosan nincs bemásolva a teljes privát relay-cím vagy személyes e-mail-cím. Új kliens csak akkor kérjen ilyen adatot, ha konkrét helyreállítási lépéshez szükséges.

---

## 12. Mi NINCS ebben a mentésben?

Szándékosan nincs:
- jelszó;
- API token;
- GitHub token;
- SSH private key;
- MFA/recovery code;
- belső hálózati cím;
- érzékeny infrastruktúra-secret;
- személyes pénzügyi adatok a projektfolytonossághoz szükséges üzemi költségadatokon túl;
- teljes beszélgetésdump.

A #38 célja nem chatdump, hanem rekonstruálható tudás.

---

## 13. Cold-start bootstrap prompt – vészhelyzeti, önálló változat

Másold az alábbi promptot egy teljesen új ChatGPT-fiókba vagy üres workspace-be:

```text
You are reconstructing the Babylon project from zero prior memory.

Repository: StrobiSoft/Babylon
Continuity task: GitHub issue #38 (NOEMI-CLONE-1.0)
First continuity draft: PR #39

Operate read-only until the owner validates your reconstruction.
Do not modify code, infrastructure, production, GitHub state, subscriptions, or account/workspace settings during reconstruction.

1. Read this emergency recovery file completely.
2. Inspect issue #38 and PR #39.
3. Read the repository-root AGENTS.md.
4. Inspect the current repository state, open issues, open PRs, CI/handoff state, and current branch heads.
5. Follow this authority order:
   a) objectively inspected current runtime/production state, or current code for code claims;
   b) current normative repository docs and accepted decisions;
   c) merged PRs and resolved issues;
   d) current open issue/PR/CI/handoff state;
   e) curated NOEMI continuity records;
   f) historical summaries;
   g) recollection or inference.
6. Never silently resolve conflicts. Mark claims as fact, decision, hypothesis, proposal, history, inference, stale, disputed, or unknown.
7. Reconstruct:
   - Babylon product scope;
   - architecture, trust boundaries, data lifecycle and security invariants;
   - current project checkpoint;
   - active issue, PR, exact head SHA, blocker and next action;
   - development/runtime infrastructure boundaries without requesting secrets;
   - collaboration, validation, review and merge rules;
   - only owner preferences that materially affect project work.
8. Pay special attention to issue #33 and PRs #29–#36 for the current Soft Chat performance track.
9. Treat MASTER_PLAN.md as potentially stale if current issue/PR evidence conflicts with it.
10. Inspect the support/export continuity risk only as operational context; do not infer account enforcement or deletion without evidence.
11. Produce a reconstruction report containing:
    - verified facts + source links;
    - current architecture;
    - current work state and exact next task;
    - binding safety/collaboration rules;
    - contradictions/stale records;
    - inferences with confidence;
    - unknowns and minimum verification steps;
    - proposed resume plan.
12. Stop and wait for owner validation.

Never store or reproduce passwords, tokens, keys, MFA/recovery material, private credentials or unnecessary sensitive personal data.
```

---

## 14. Első 20 perces recovery eljárás új fiókban

### A. Repository-azonosítás
- nyisd meg `StrobiSoft/Babylon`;
- ellenőrizd, hogy ugyanaz a repository;
- olvasd el a root `AGENTS.md` fájlt.

### B. Continuity
- issue #38;
- PR #39;
- ha már létezik `docs/continuity/README.md` és `MANIFEST.yaml`, ezeket kezeld új elsődleges belépési pontként.

### C. Current work
- issue #33;
- PR #36;
- ellenőrizd, hogy továbbra is Pepper measurement-e a blocker;
- ellenőrizd az exact headet és a CI-t;
- nézd meg, keletkezett-e #36 után új performance PR vagy döntés.

### D. Normatív dokumentumok
- architecture;
- security architecture;
- auth state machine;
- OpenAPI;
- language system architecture;
- communication modes;
- AI collaboration workflow.

### E. Rekonstrukciós jelentés
Semmit ne módosíts. Jelents:
- mit tudsz biztosan;
- mit találtál elavultnak;
- mi ütközik;
- mit kell még ellenőrizni;
- honnan folytatnád a munkát.

---

## 15. Beszélgetésekből még kimentendő tudás – prioritási lista

A jelen vészmentés **nem tudta teljes körűen indexelni a projekt teljes ChatGPT-beszélgetéstörténetét**. A következő elérhető ablakban célzottan ki kell menteni:

### P0 – azonnal
- Babylon projektben kizárólag beszélgetésben maradt döntések;
- aktuális Pepper / ZooLab állapot, ha nincs GitHubban;
- Noémi/Babylon együttműködési preferenciák, amelyek ténylegesen módosítják a munkavégzést;
- jelenleg nyitott, de még GitHubra nem rögzített blocker;
- személyes → Business migrációból eredő projektfolytonossági tények;
- export/support eredmények.

### P1
- fontos döntések előzménye és rationale, ha a GitHub csak a végső döntést tartalmazza;
- történeti mérföldkövek;
- eszköz-/hozzáférési határok;
- projektnevek, hostnevek és szerepek csak olyan szinten, amely nem titok.

### P2
- érdekes, de a tényleges folytatáshoz nem kritikus háttér;
- hosszú beszélgetések teljes szövege helyett kurált összefoglaló.

---

## 16. Javasolt következő continuity fájlok

Ha van idő és GitHub-hozzáférés, a #39 tervből a következőket kell elkészíteni:

### `README.md`
- mi a NOEMI continuity rendszer;
- honnan kell kezdeni;
- melyik schema-verzió él.

### `MANIFEST.yaml`
- kötelező első olvasmányok;
- optional domain docs;
- current task pointers;
- current checkpoint;
- schema version;
- last verified timestamp.

### `PROJECT_STATE.md`
- aktuális mérföldkő;
- exact active issue;
- exact active PR/head;
- blocker;
- next action;
- validation gate;
- rollback.

### `WORKING_CONTEXT.md`
- együttműködési szabályok;
- tooling-határok;
- nem titkos infrastruktúra-kontextus;
- szükséges owner preferenciák.

### `HISTORY.md`
- jelentős continuity incidensek;
- Business workspace váltás;
- context-loss események;
- export problémák;
- recovery döntések.

### `RECOVERY_TEST.md`
- új üres account teszt;
- idő a readinessig;
- kihagyások;
- hallucinációk;
- stale-source hibák;
- javítási körök.

---

## 17. Claim-meta séma

Minden kurált rekordhoz lehetőleg:

```yaml
id: noemi-...
kind: fact|decision|hypothesis|problem|milestone|preference|history
status: current|stale|superseded|disputed|unverified
authority: runtime|normative-doc|merged-pr|open-work|continuity|history|recollection
sources:
  - ...
last_verified: YYYY-MM-DD
confidence: high|medium|low
supersedes: optional-id
```

Titok vagy szükségtelen személyes adat **schema-invalid**.

---

## 18. Vészhelyzeti definíció: mikor tekintsük sikeresnek a mentést?

A minimum sikerfeltétel:

Egy új ChatGPT-fiók, amely:
- semmilyen korábbi beszélgetést nem lát;
- csak ezt a fájlt és a GitHubot kapja meg;

képes legyen:
1. azonosítani a Babylon repositoryt;
2. megtalálni az autoritatív dokumentumokat;
3. felismerni az aktuális performance szálat;
4. nem összekeverni a stale MASTER_PLAN-t az aktuális issue/PR állapottal;
5. felsorolni a kötelező biztonsági és collaboration szabályokat;
6. megnevezni az aktuális blockert és a következő ellenőrzendő lépést;
7. nem tenni semmilyen módosítást owner validation előtt.

Ha ez teljesül, a projekt műszaki folytonosságának alapja megmaradt még akkor is, ha a jelenlegi ChatGPT workspace története elveszne.

---

## 19. Ismert bizonytalanságok

Ezt a fájlt egy friss kliens **ne tekintse teljes igazságforrásnak**. Ellenőrizendő:

- változott-e az issue #33 / PR #36 státusza;
- merge-elték-e vagy kibővítették-e a #39 continuity munkát;
- létrejöttek-e a v1 continuity fájlok;
- változott-e a Business workspace konfiguráció;
- mi lett a support case #14045507 teljes válasza és eredménye;
- sikerült-e hivatalos ChatGPT adat-export;
- van-e újabb project checkpoint vagy GitHub handoff;
- van-e beszélgetésben maradt, GitHubra még át nem vitt kritikus döntés.

---

## 20. Rövid emberi összefoglaló egy új Noéminek

A Babylon nem egy egyszeri kódprojekt, hanem hosszú távú, szigorúan dokumentált és visszaállítható együttműködés. A repository a műszaki igazság elsődleges hordozója. A ChatGPT-beszélgetések sok fontos kontextust tartalmaznak, de nem lehetnek egyetlen hibapont.

A munka során:
- ne találgass;
- ellenőrizd a forrást;
- mutasd az ellentmondásokat;
- őrizd a checkpointokat;
- ne merge-elj engedély nélkül;
- ne változtass productiont rekonstrukció közben;
- és a projekt gazdáját ne kényszerítsd arra, hogy minden új munkamenetben újramesélje a Babylon történetét.

Ez a NOEMI-CLONE-1.0 lényege.
