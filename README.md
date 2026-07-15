# Discord Transcriber – enkel guide

Discord-boten körs på Ubuntu-servern och använder Whisper för att transkribera samtal i Discord. Macen används bara för Discord och för att ansluta till servern via SSH.

Tekniskt är det en tvådelad stack: en TypeScript Discord-bot som tar emot Opus per deltagare, och en FastAPI/GPU-worker som kör KB-Whisper (svenska). Ljud och transkript sparas under `recordings/`.

> Discord audio receive är ingen officiellt stabil API. Boten har DAVE och reconnect-hantering, men använd OBS som backup vid kritiska samtal. Se till att inspelning är laglig och att alla är informerade. Boten postar alltid en publik annons innan inspelning börjar.

---

## Transkribera ett Discord-samtal

När boten och Whisper-processen är igång:

1. Gå in i den röstkanal som ska transkriberas.
2. Skriv `/transcribe start` i en textkanal.
3. Boten ansluter till röstkanalen och börjar transkribera.
4. Prata som vanligt. Preliminär text visas under samtalet.
5. Skriv `/transcribe stop` när samtalet är klart.
6. Vänta tills boten meddelar att den slutliga transkriberingen är färdig.
7. Skriv `/transcribe export`.
8. Ladda ner `.txt`-filen som boten skickar i Discord.

Andra kommandon:

```text
/transcribe pause
/transcribe status
```

Kommandona är på den här servern begränsade till användare med behörigheten **Hantera server**.

Syns inte kommandona kan du skriva `/` och söka efter `transcribe`. Hjälper inte det, starta om Discord-klienten.

---

## Starta transkriberingstjänsten

Anslut först till Ubuntu-servern via SSH.

Gå sedan till projektmappen:

```bash
cd /home/simon/discord-transcriber
```

Starta allt:

```bash
./start-all.sh
```

Det startar:

* Whisper-worker på `127.0.0.1:8765`
* Discord-boten `XS-transcriber`

Kontrollera status:

```bash
./status.sh
```

Worker och bot ska visas som aktiva. Worker-kontrollen ska visa:

```text
health ok: true
```

(JSON-svar innehåller `"ok": true`.)

---

## Stoppa transkriberingstjänsten

```bash
cd /home/simon/discord-transcriber
./stop-all.sh
```

Det stoppar både Discord-boten och Whisper-worker.

`llama-server` påverkas inte eftersom den körs separat.

---

## Efter omstart av Ubuntu-servern

Transkriberingstjänsten startar inte automatiskt.

Efter varje omstart:

```bash
cd /home/simon/discord-transcriber
./start-all.sh
```

Utan detta är boten offline och `/transcribe` fungerar inte.

Före avstängning kan du först köra:

```bash
./stop-all.sh
sudo poweroff
```

---

## Hämta transkriptet

### Via Discord

Det enklaste sättet är:

```text
/transcribe export
```

Boten skickar då det färdiga transkriptet som en `.txt`-fil.

### Direkt från servern

Alla färdiga sessioner sparas här:

```text
/home/simon/discord-transcriber/recordings/<session-id>/transcript.txt
```

Exempel:

```text
/home/simon/discord-transcriber/recordings/2026-07-15_11-43-52/transcript.txt
```

Visa de senaste transkripten:

```bash
ls -lt /home/simon/discord-transcriber/recordings/*/transcript.txt
```

Läs ett transkript på servern:

```bash
cat /home/simon/discord-transcriber/recordings/2026-07-15_11-43-52/transcript.txt
```

Hämta ett bestämt transkript till Macens mapp Hämtade filer:

```bash
scp simon@SERVER-IP:/home/simon/discord-transcriber/recordings/2026-07-15_11-43-52/transcript.txt ~/Downloads/
```

Ersätt `SERVER-IP` med Ubuntu-serverns IP-adress.

---

## Llama-server och GPU-minne

`llama-server` körs separat i Docker och kan använda GPU-minne som Whisper annars hade kunnat använda.

Kontrollera status:

```bash
docker ps -a --filter name=llama-server
```

Stoppa llama-server:

```bash
docker stop llama-server
```

Starta llama-server igen:

```bash
docker start llama-server
```

Vid tung transkribering med Whisper Large kan du stoppa `llama-server` för att frigöra VRAM. Starta den igen när du behöver den lokala chatten.

---

## Loggar

Botens logg:

```text
/home/simon/discord-transcriber/recordings/bot.log
```

Whisper-workers logg:

```text
/home/simon/discord-transcriber/recordings/worker.log
```

Visa de senaste loggraderna:

```bash
tail -n 100 recordings/bot.log
tail -n 100 recordings/worker.log
```

Följ loggarna i realtid:

```bash
tail -f recordings/bot.log
```

eller:

```bash
tail -f recordings/worker.log
```

---

## Snabbreferens

```bash
# Starta
cd /home/simon/discord-transcriber
./start-all.sh

# Kontrollera
./status.sh

# Stoppa
./stop-all.sh
```

Discord:

```text
/transcribe start
/transcribe pause
/transcribe status
/transcribe stop
/transcribe export
```

Normalt arbetsflöde:

```text
Gå in i röstkanalen
→ /transcribe start
→ genomför samtalet
→ /transcribe stop
→ vänta på slutmeddelandet
→ /transcribe export
→ ladda ner textfilen
```

---

# Teknisk installation (utvecklare / ny maskin)

## Krav

- Ubuntu/Linux x86-64 (DAVE-bindingen är glibc x86-64)
- NVIDIA GPU med CUDA-kompatibel drivrutin (testat på RTX 4070, 12 GB)
- Node.js 22.12+
- Python 3.11+
- Discord-applikation med bot + application commands
- Utrymme för KB-Whisper-modeller och `recordings/`

På den här maskinen används bland annat:

```text
Python:          /home/simon/whisper/venv/bin/python
faster-whisper:  1.2.1
Model cache:     /home/simon/whisper/models
Live model:      KBLab/kb-whisper-small
Final model:     KBLab/kb-whisper-large (revision main)
```

## Installera

### 1. Node 22

```bash
nvm install 22
nvm use 22
node --version   # >= v22.12.0
```

### 2. Bot-beroenden

```bash
cd /home/simon/discord-transcriber
npm install
npm run build
```

### 3. Worker-beroenden

```bash
/home/simon/whisper/venv/bin/python -m pip install -r worker/requirements.txt
/home/simon/whisper/venv/bin/python worker/diagnose.py
```

### 4. Ladda ner modeller

```bash
WHISPER_CACHE_DIR=/home/simon/whisper/models \
  /home/simon/whisper/venv/bin/python worker/download_models.py
```

### 5. Konfigurera `.env`

```bash
cp .env.example .env
chmod 600 .env
# Fyll i DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID, WORKER_API_TOKEN
```

Registrera slash-kommandon:

```bash
npm run deploy
```

### 6. Kör

```bash
./start-all.sh
```

Worker binder bara till loopback och kräver bearer-token. Exponera den inte mot internet.

## Arkitektur i korthet

- Separat Opus-ström per Discord-användare → sparas som `.ogg`
- Hållbar segmentkö med återhämtning efter omstart
- Live-pass (KB-Whisper Small) + final-pass (KB-Whisper Large)
- SQLite-sessioner och exakt `[HH:MM:SS] Talare: text`-format
- DAVE, reconnect, packet watchdog, pause/resume, status, export

## Tester

```bash
npm run check
npm test
WORKER_API_TOKEN=test-token \
  /home/simon/whisper/venv/bin/python -m pytest -q tests/worker
```
