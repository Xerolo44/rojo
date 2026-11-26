# rojo-control-mcp – Rojo-Plugin per MCP umschalten

Dieser Fork von [rojo-rbx/rojo](https://github.com/rojo-rbx/rojo) erweitert das Studio-Plugin um eine
**Fernsteuerung**: Ein lokales Werkzeug (hier ein MCP-Server für Claude Code) kann das Plugin von einem
`rojo serve` trennen, Host/Port setzen und neu verbinden – ohne dass jemand im Plugin-Fenster klickt.

```
Claude Code ──stdio/MCP──► server.mjs ──HTTP──► Steuer-Endpunkt 127.0.0.1:34870 ◄──Abfrage (1 s)── Rojo-Plugin in Studio
                                                                                     │
                                                                                     └─► rojo serve :34872 / :34874 / …
```

- Studio-Plugins können keine Verbindungen annehmen. Darum **fragt das Plugin** den Steuer-Endpunkt jede Sekunde ab,
  meldet dabei seinen Status (Place-Name, Place-ID, Verbindung) und holt anstehende Befehle ab.
  Läuft kein Endpunkt, wartet es immer länger (bis 10 s zwischen zwei Versuchen).
- Es wird **nichts im DataModel** angelegt; nichts davon landet beim Speichern im Place.
- Nur das Edit-DataModel antwortet, nicht die Playtest-Kopien des Plugins.
- Jede Studio-Instanz meldet sich mit eigener `instanceId`, Place-Name und Place-ID. Bei mehreren Studios muss
  der Befehl sagen, welches gemeint ist (`studio`), sonst wird er abgelehnt.
- Mehrere Claude-Sitzungen starten je einen eigenen MCP-Server. Der erste belegt Port 34870 und ist der
  Endpunkt, die anderen benutzen ihn mit. Beendet sich der Besitzer, übernimmt der nächste MCP-Server beim
  nächsten Aufruf (das Plugin braucht dann bis zu 10 s, bis es wieder auftaucht).

## Werkzeuge

| Tool | Wirkung |
|---|---|
| `rojo_list_studios` | Alle Studios, deren Plugin den Endpunkt abfragt, mit Status |
| `rojo_status(studio?)` | Status eines Studios (`appStatus`, `projectName`, `address`, `errorMessage`) |
| `rojo_connect(port, host?, studio?, timeoutSeconds?)` | Trennen → Host/Port setzen → Verbinden; wartet bis `Connected`, `Confirming` oder `Error` |
| `rojo_disconnect(studio?)` | Verbindung trennen |
| `rojo_confirm(action, studio?)` | Erstsync-Bestätigung beantworten: `Accept`, `Abort` oder `Reject` |

`studio` ist die `instanceId`, die Place-ID (z. B. `"133163803510735"`) oder ein Teil des Place-Namens. Als Name gilt der veröffentlichte Name aus `MarketplaceService:GetProductInfo` (wird beim Start einmal nachgeschlagen) und zusätzlich `game.Name` (in Studio oft nur „Place1“). Am sichersten ist die Place-ID.
Ohne `studio` geht ein Befehl nur durch, wenn genau ein Studio verbunden ist.

## Einrichtung

Voraussetzung: Node.js ≥ 20. Keine npm-Pakete nötig.

### 1. Plugin bauen und installieren

```powershell
cd F:\BadPlan\rojo-fork
rokit install
rojo build plugin.project.json -o dist\Rojo-RemoteControl.rbxm
```

Die Datei `dist\Rojo-RemoteControl.rbxm` nach `%LOCALAPPDATA%\Roblox\Plugins\` kopieren und Studio neu starten
(oder in Studio: *Plugins → Plugins-Ordner*). **Das Rojo-Plugin aus dem Creator Store vorher deaktivieren**
(*Plugins → Manage Plugins*), sonst laufen zwei Rojo-Plugins mit zwei Toolbar-Knöpfen.

Die Fernsteuerung ist eingeschaltet, sobald das Plugin läuft. Abschalten: Rojo-Fenster → Einstellungen →
**Remote Control**. Beim ersten Zugriff kann Studio fragen, ob das Plugin HTTP-Anfragen an `localhost` stellen darf
– zulassen (dieselbe Freigabe, die Rojo ohnehin braucht).

### 2. MCP-Server in Claude Code eintragen

Projektweit in `.mcp.json`:

```json
{
  "mcpServers": {
    "rojo-control": {
      "command": "node",
      "args": ["F:/BadPlan/rojo-fork/tools/rojo-control-mcp/server.mjs"]
    }
  }
}
```

oder für den eigenen Nutzer:

```powershell
claude mcp add --scope user rojo-control -- node F:/BadPlan/rojo-fork/tools/rojo-control-mcp/server.mjs
```

Anderer Steuer-Port: Umgebungsvariable `ROJO_CONTROL_PORT` beim MCP-Server setzen **und** im Plugin die
Einstellung `remoteControlPort` ändern (bisher ohne Eingabefeld, nur über den Plugin-Einstellungsspeicher) – beide
müssen gleich sein.

## Tests

```powershell
cd F:\BadPlan\rojo-fork\tools\rojo-control-mcp
npm test
```

Die Tests starten den MCP-Server über stdio und lassen ein nachgebautes Plugin (`test/fake-plugin.mjs`, verhält
sich wie `plugin/src/RemoteControl/init.lua`) den Endpunkt abfragen. Die reinen Plugin-Regeln
(`plugin/src/RemoteControl/protocol.lua`) laufen ohne Studio über Lune:

```powershell
lune run scripts/run-pure-spec.luau plugin/src/RemoteControl/protocol.lua plugin/src/RemoteControl/protocol.spec.lua
```

## Grenzen und Sicherheit

- **Nur Loopback-Ziele**: `rojo_connect` akzeptiert nur `localhost`, `127.0.0.1` und `::1`. Das Plugin prüft das
  selbst noch einmal. Ein Befehl kann Studio also nicht auf einen fremden Server lenken, der Code in den Place schiebt.
- Der Endpunkt hört nur auf `127.0.0.1`, lehnt Anfragen mit `Origin`-Header (Browser) und fremdem `Host`-Header
  (DNS-Rebinding) ab. Jedes lokale Programm kann ihn aber erreichen – dasselbe Vertrauensniveau wie `rojo serve`.
- **Bestätigung**: Steht die Plugin-Einstellung *Confirmation Behavior* auf `Initial` (Standard), wartet der erste
  Sync eines Projekts auf Bestätigung. `rojo_connect` meldet dann `Confirming`, danach `rojo_confirm` aufrufen.
  `Accept` übernimmt die Änderungen des Servers in den Place.
- Wer den Endpunkt besitzt, hängt an einer Claude-Sitzung; endet sie, sind Befehle bis zur Übernahme durch einen
  anderen MCP-Server kurz nicht möglich. Befehle, die das Plugin nicht binnen 15 s abholt, verfallen.
- Wenn Rojo verbunden ist, setzt es ggf. `game.PlaceId` laut Projekt um; zur Auswahl eignet sich der Place-Name besser.
- Der Steuer-Code im Plugin ist bisher **nur ohne Studio getestet** (Lune-Spec und Node-Tests gegen das nachgebaute
  Plugin). Die vorhandenen TestEZ-Specs des Plugins laufen nur in Studio (`scripts/unit-test-plugin.sh`).

## Lizenz

Rojo steht unter der [Mozilla Public License 2.0](../../LICENSE.txt). Dieser Fork bleibt unter MPL-2.0:
geänderte und neue Quelldateien sind öffentlich im Fork, die Lizenz- und Urheberhinweise bleiben erhalten.
