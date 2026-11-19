# ADS-B-Webapp als PWA: Einrichtung und Bedienung

Die Webapp läuft auf zwei Arten, und zwar aus **demselben Build**:

- **Online** über `https://adsb.wetterheidi.de` (Hetzner-Server).
- **Offline**, nachdem die Seite **einmal online geöffnet** wurde. Danach
  startet sie auch ohne Internet, aus dem Browser-Cache. Installiert
  („Zum Startbildschirm hinzufügen“) sieht sie aus wie eine normale App.

Zusätzlich lässt sie sich ganz ohne Server auf dem eigenen Rechner
starten (Teil D).

**Wichtig vorab:**

- **Browser:** Chrome oder Edge. Firefox und Safari können nicht mit
  USB-Geräten sprechen. Auf dem iPhone/iPad geht es gar nicht.
- **Android:** In Chrome geht es nur über WebUSB, und das klappt mit
  manchen Adaptern nicht. Wenn das Verbinden scheitert, nimm die
  Android-App (README, Abschnitt „Android app“).
- **GPS** braucht weder der Dongle noch das Gerät. Der eigene Standort
  dient nur für den blauen Punkt und die Entfernungsringe.

---

## A. Einmalig: Server einrichten

Nötig nur beim allerersten Mal. Alles Weitere erledigt das Deploy-Skript.

### A1. DNS-Eintrag anlegen

Bei deinem DNS-Anbieter für `wetterheidi.de` einen neuen Eintrag anlegen:

| Typ | Name   | Wert              |
| --- | ------ | ----------------- |
| A   | `adsb` | `178.104.206.136` |

Prüfen, ob der Eintrag schon gilt (kann einige Minuten dauern):

```sh
dig +short adsb.wetterheidi.de
```

Es muss `178.104.206.136` erscheinen. Erst dann weitermachen, sonst
scheitert das HTTPS-Zertifikat.

> Gibt es schon einen Wildcard-Eintrag `*.wetterheidi.de` auf den Server,
> entfällt A1. Der `dig`-Test zeigt das.

### A2. Login (Pförtner) ja oder nein?

Das Skript legt die Seite standardmäßig **hinter den Pförtner-Login**,
wie deine anderen Tools (Tool-Name `adsb`). Dafür in der Nutzerverwaltung
den Benutzern das Tool `adsb` freischalten.

Soll die Seite ohne Login erreichbar sein: in
`webapp/scripts/deploy-hetzner.sh` die Zeile

```sh
PFOERTNER="ja"
```

auf `PFOERTNER="nein"` ändern. Das wirkt nur, solange der Vhost noch
**nicht** existiert. Ein vorhandener Vhost wird nie überschrieben.

### A3. Erstes Deploy

```sh
cd webapp
bun run deploy
```

Das Skript erledigt alles Weitere:

1. Es testet und baut.
2. Es legt den nginx-Vhost an.
3. Es holt das Let's-Encrypt-Zertifikat.
4. Es kopiert die Dateien nach `/apps/adsb`.

Am Ende steht `==> Fertig: https://adsb.wetterheidi.de`.

**Wenn etwas schiefgeht:**

| Meldung | Ursache und Abhilfe |
| --- | --- |
| `Permission denied (publickey)` | Kein SSH-Zugang. Mit `ssh root@178.104.206.136` testen. |
| `nginx -t fehlgeschlagen` | Das Skript hat den neuen Vhost schon wieder entfernt, der Server läuft unverändert. Fehlermeldung darüber lesen. Fehlt `snippets/pfoertner.conf`, entweder den Pförtner einrichten oder `PFOERTNER="nein"`. |
| certbot-Fehler | Meist ist DNS noch nicht aktiv (A1). Warten, dann `bun run deploy` nochmal. |

---

## B. Neue Version veröffentlichen

```sh
cd webapp
bun run deploy
```

Das ist alles. Die Tests müssen grün sein, sonst bricht das Skript vor
dem Hochladen ab.

**So kommt das Update bei den Nutzern an:** Beim nächsten Öffnen *mit
Internet* lädt die App die neue Version im Hintergrund. Unten erscheint
**„Update installed – reload to use it“**. Nach einem Neuladen bzw.
Neustart der App läuft die neue Version. Offline läuft einfach die alte
weiter.

**Zurück zur vorigen Version**, falls ein Deploy kaputt ist:

```sh
cd webapp
bun run rollback
```

---

## C. Auf einem Gerät einrichten (für Nutzer)

### C1. Am Computer (Windows, macOS, Linux)

1. In **Chrome** oder **Edge** `https://adsb.wetterheidi.de` öffnen und
   ggf. einloggen.
2. Rechts in der Adressleiste auf das **Installieren-Symbol** klicken
   (Monitor mit Pfeil) und „Installieren“ wählen. Ab jetzt gibt es
   „ADS-B Dongle“ im Startmenü bzw. im Programme-Ordner.
3. Den Standort-Zugriff erlauben, wenn der Browser fragt.
4. Den Dongle (oder den FTDI-Adapter) einstecken.
5. Auf den **grauen Punkt oben rechts** klicken, das Gerät in der Liste
   wählen und „Verbinden“ klicken.
6. Der Punkt wird **orange** (sucht die Baudrate, bis zu 4 s) und dann
   **grün**. Fertig.

Ab dem zweiten Mal verbindet sich die App **automatisch**, sobald das
schon einmal gewählte Gerät eingesteckt ist. Wie in der Android-App muss
man dann nichts mehr klicken.

### C2. Auf Android (Chrome)

1. In Chrome `https://adsb.wetterheidi.de` öffnen.
2. Menü (⋮) → **„App installieren“** bzw. **„Zum Startbildschirm
   hinzufügen“**.
3. Den Adapter per USB-OTG anstecken, auf den grauen Punkt tippen und
   das Gerät wählen.
4. Klappt das nicht (Punkt wird **rot**, Fehlermeldung unten): die
   Android-App verwenden. Das ist eine Grenze von Chrome auf Android,
   kein Fehler der Webapp.

### C3. Für den Offline-Einsatz vorbereiten (wichtig!)

Die App selbst ist nach dem ersten Öffnen offline verfügbar. **Karten und
Flugzeugdatenbank aber nicht automatisch.** Deshalb vor dem Einsatz,
**solange noch Internet da ist**:

1. Die App öffnen und auf das Einsatzgebiet zoomen.
2. Über das Ebenen-Symbol (links) die gewünschten Karten einschalten,
   z. B. OSM und openflightmaps.
3. Den **Download-Knopf** für den Kachel-Cache (links unter dem
   Ebenen-Knopf) drücken. Unten links zählt die Kachelzahl hoch.
4. Optional im Ebenen-Menü die **Flugzeugdatenbank** herunterladen. Dann
   zeigt die App Kennzeichen und Muster an.
5. **Test:** WLAN und Mobilfunk aus (Flugmodus) und die App neu starten.
   Karte und Bedienung müssen da sein.

> Den Browser-Verlauf bzw. die „Websitedaten“ für die Seite **nicht
> löschen**. Das entfernt auch den Offline-Cache, und die App muss dann
> wieder einmal online geöffnet werden.

### Bedeutung des Punkts oben rechts

| Farbe | Bedeutung |
| --- | --- |
| grau | nicht verbunden: klicken zum Verbinden |
| orange | verbindet gerade |
| grün | verbunden: klicken zum Trennen |
| rot | Fehler: Meldung erscheint kurz unten, nochmal klicken |

---

## D. Ganz ohne Server, nur auf dem eigenen Rechner

Z. B. zum Testen oder wenn die Seite gar nicht ins Netz soll:

```sh
cd webapp
bun install
bun run build
bun run preview
```

Dann im Browser `http://localhost:4173` öffnen. Das funktioniert mit USB
und offline genauso wie die Online-Variante. **Nicht** einfach
`dist/index.html` per Doppelklick öffnen: Über `file://` lädt der
Browser die App nicht.

---

## Technischer Hintergrund (für später)

- `webapp/vite.config.ts` erzeugt beim Build `dist/sw.js` aus
  `webapp/src/sw-template.js`. Der Service Worker cached alle Dateien des
  Builds und beantwortet Anfragen zuerst aus dem Cache.
- Ein neuer Build hat eine andere Versionskennung im Cache-Namen. Der
  Browser erkennt so die neue Version.
- Kartenkacheln und Flugzeugdatenbank laufen **nicht** über den Service
  Worker. Sie haben eigene IndexedDB-Speicher (`tile-cache.ts`,
  `aircraft-db.ts`).
- Server: nginx-Vhost `/etc/nginx/sites-available/adsb.wetterheidi.de`,
  Dateien in `/apps/adsb`, Sicherung des vorigen Stands in
  `/apps/adsb.prev`.
