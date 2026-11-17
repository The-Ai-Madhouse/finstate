# Finstate på en Raspberry Pi – sikkert

Målet: Finstate kører hele tiden på Pi'en, kan bruges fra dine egne enheder (Mac, telefon) – også uden for hjemmet –
men er **ikke synlig på dit wifi eller på internettet**, og data er **krypteret på disken**. Backup hentes til din Mac.

```
Din Mac / telefon ──(Tailscale: krypteret, kun dine enheder)──► Pi: tailscale serve (HTTPS)
                                                                    └─► Finstate på 127.0.0.1:5173 (kun lokalt)
                                                                          └─► /var/lib/finstate/data (AES-256-krypteret)
```

| Lag | Hvad beskytter det mod |
|---|---|
| Tailscale (ingen åbne porte) | Andre på dit wifi, internettet |
| HTTPS (Tailscale-certifikat) | Aflytning |
| Login med adgangskode + 2FA (4 uger) | Andre med adgang til en af dine enheder/netværket |
| Kryptering af data (AES-256-GCM) | Tyveri af Pi'en / SD-kortet |
| systemd-hærdning, egen bruger | Fejl i Finstate kan ikke røre resten af Pi'en |
| Automatiske opdateringer | Kendte sårbarheder |
| Backup til Mac | Et dødt SD-kort |

## 1. Forbered Pi'en (én gang)

Raspberry Pi OS Lite (64-bit). Brug en god adgangskode eller SSH-nøgle til din bruger.

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y unattended-upgrades rsync git
sudo dpkg-reconfigure -plow unattended-upgrades   # vælg "Ja": sikkerhedsopdateringer installeres automatisk

# Node 22 (LTS)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Tailscale – privat netværk mellem dine enheder
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh            # log ind; --ssh gør backup via SSH muligt uden åbne porte
sudo tailscale set --hostname=finstate
```

Slå **MagicDNS** og **HTTPS-certifikater** til i Tailscales admin-panel (DNS-fanen). Siden får navnet
`finstate.DIT-TAILNET.ts.net`.

Valgfrit, men anbefalet: slå SSH via netværket fra (`sudo systemctl disable --now ssh`) – Tailscale SSH virker stadig.

## 2. Installér Finstate

```bash
sudo useradd --system --home /var/lib/finstate --shell /usr/sbin/nologin finstate
sudo mkdir -p /opt/finstate /var/lib/finstate/data
sudo chown -R finstate:finstate /var/lib/finstate && sudo chmod 700 /var/lib/finstate /var/lib/finstate/data

# Kopiér projektet (uden data) fra din Mac – eller git clone, hvis det ligger i et privat repo
rsync -a --exclude node_modules --exclude dist ~/projects/finstate/ PI:/tmp/finstate/      # kør på Mac'en
sudo rsync -a /tmp/finstate/ /opt/finstate/ && sudo chown -R root:root /opt/finstate
cd /opt/finstate && sudo npm ci && sudo npm run build
```

## 3. Flyt dine (krypterede) data over

Sæt login op på Mac'en først (start Finstate med `npm start` – så krypteres dine nuværende data). Kopiér derefter
den krypterede mappe til Pi'en:

```bash
rsync -a ~/Documents/Finstate/ PI:/tmp/finstate-data/        # på Mac'en – filerne er krypteret
sudo rsync -a /tmp/finstate-data/ /var/lib/finstate/data/ && sudo rm -rf /tmp/finstate-data   # på Pi'en
sudo chown -R finstate:finstate /var/lib/finstate/data
```

Du logger ind på Pi'en med **samme adgangskode og 2FA-app**.

## 4. Start tjenesten

```bash
sudo cp /opt/finstate/deploy/finstate.service /etc/systemd/system/
sudo nano /etc/systemd/system/finstate.service       # sæt FINSTATE_ALLOWED_HOSTS=finstate.DIT-TAILNET.ts.net
sudo systemctl daemon-reload && sudo systemctl enable --now finstate
sudo systemctl status finstate

# HTTPS via Tailscale – kun dine enheder kan nå den
sudo tailscale serve --bg --https=443 http://127.0.0.1:5173
```

Åbn `https://finstate.DIT-TAILNET.ts.net` fra din Mac eller telefon (med Tailscale-appen tændt).

**Brug aldrig `tailscale funnel`** – det gør siden offentlig på internettet.

## 5. Backup til din Mac

Krypteret kopi af hele mappen – kan kun åbnes med din adgangskode og 2FA:

Én gang på Pi'en – giv **din egen bruger** lov til kun at *læse* datamappen via rsync (sender-tilstand kan ikke skrive):

```bash
echo "$USER ALL=(root) NOPASSWD: /usr/bin/rsync --server --sender *" | sudo tee /etc/sudoers.d/finstate-backup
sudo chmod 440 /etc/sudoers.d/finstate-backup && sudo visudo -c
```

Derefter, på Mac'en (via Tailscale SSH):

```bash
scripts/backup-from-pi.sh DINBRUGER@finstate ~/Documents/FinstateBackup
```

Scriptet beholder en kopi pr. dag (60 dage) i `snapshots/`. Ligger mappen under din Time Machine/iCloud, kommer den
automatisk med derfra. Åbn en backup på Mac'en:

```bash
FINSTATE_DIR=~/Documents/FinstateBackup/current npm start
```

Fra telefonen eller en anden enhed: **Indstillinger → Backup & data → Download krypteret backup**, og pak den ud med
`node scripts/unpack-backup.mjs fil.json ~/Documents/FinstateBackup`.


## Opdatering af Finstate

```bash
rsync -a --exclude node_modules --exclude dist ~/projects/finstate/ PI:/tmp/finstate/   # Mac
sudo rsync -a /tmp/finstate/ /opt/finstate/ && cd /opt/finstate && sudo npm ci && sudo npm run build
sudo systemctl restart finstate
```

## Hvis noget går galt

- **Glemt adgangskode:** data kan ikke låses op – heller ikke af en backup. Gem adgangskoden i din adgangskodeapp.
- **Mistet telefon:** log ind med adgangskode + en gendannelseskode, og lav nye koder under Indstillinger.
- **Mistanke om misbrug:** Indstillinger → *Log ud på alle enheder*.
- **Låst efter forkerte forsøg:** vent (højst 1 time) – låsen forhindrer gætteri.
