# ZooLab Monitor

A ZooLab Monitor egy függőségmentes, Python standard könyvtárra épülő központi szolgáltatásfigyelő. HTTP/HTTPS végpontokat és TCP-portokat ellenőriz, az eredményeket SQLite-ban őrzi, valamint magyar nyelvű, reszponzív irányítópultot és JSON API-t biztosít.

## Felépítés

- `app.py`: parancssori belépési pont és életciklus-kezelés.
- `zoolab_monitor/config.py`: JSON-konfiguráció betöltése és szigorú ellenőrzése.
- `zoolab_monitor/checks.py`: HTTP/HTTPS- és TCP-ellenőrzések timeouttal.
- `zoolab_monitor/database.py`: párhuzamos hozzáférést támogató SQLite-tárolás WAL módban.
- `zoolab_monitor/monitor.py`: háttérben futó, konfigurálható ütemező.
- `zoolab_monitor/web.py`: irányítópult és API.
- `config/services.json`: a kizárólag fájlból módosítható szolgáltatáslista.
- `tests/`: internetkapcsolattól és valódi ZooLab gépektől független tesztek.

## Közvetlen indítás

Python 3.11 vagy újabb szükséges, külső csomag nem kell.

```sh
cd /srv/babylon/services/zoolab-monitor
python3 app.py --config config/services.json
```

Az irányítópult ezután a <http://localhost:8090> címen érhető el. Leállítás: `Ctrl+C`, illetve szolgáltatáskezelőből `SIGTERM`.

## Docker Compose

```sh
docker compose up --build -d
docker compose ps
docker compose logs -f zoolab-monitor
```

Leállítás az adatok megtartásával:

```sh
docker compose down
```

Az SQLite-adatbázist a `zoolab-monitor-data` nevű Docker-volume őrzi. A volume törléséhez külön, tudatosan a `docker compose down --volumes` parancs szükséges.

## Konfigurálás

A `config/services.json` módosítása után indítsd újra az alkalmazást. A globális `check_interval_seconds` alapértéke 30 másodperc, a `timeout_seconds` alapértéke 3 másodperc. Szolgáltatásonként külön timeout is megadható.

HTTP-példa:

```json
{
  "id": "example-api",
  "name": "Example API",
  "type": "http",
  "url": "https://example.test/health",
  "expected_status": 200,
  "timeout_seconds": 3
}
```

TCP-példa:

```json
{
  "id": "example-ssh",
  "name": "Example SSH",
  "type": "tcp",
  "host": "192.0.2.10",
  "port": 22
}
```

A webes API nem fogad célcímet, portot vagy parancsot. A `POST /api/check-now` kizárólag a JSON-fájlban előre rögzített szolgáltatásokat ellenőrzi, és kérésbody esetén hibát ad.

## API

- `GET /health` – alkalmazás-healthcheck.
- `GET /api/services` – szolgáltatások aktuális állapota, rövid előzménye és összesítés.
- `GET /api/history?service=<azonosító>&limit=<1-100>` – egy szolgáltatás előzménye.
- `POST /api/check-now` – az összes konfigurált ellenőrzés azonnali futtatása.

## Tesztelés

```sh
python3 -m compileall -q app.py zoolab_monitor tests
python3 -m unittest discover -s tests -v
docker compose config --quiet
```

A tesztek ideiglenes HTTP- és TCP-szervereket, illetve ideiglenes SQLite-adatbázist használnak. Nem függnek a Pepper vagy a Babylon Status elérhetőségétől.

Kézi smoke teszt:

```sh
curl -i http://127.0.0.1:8090/health
curl -i http://127.0.0.1:8090/api/services
curl -i -X POST http://127.0.0.1:8090/api/check-now
```

Az offline célok normális mérési eredményként kerülnek az adatbázisba, és nem állítják le az alkalmazást.
