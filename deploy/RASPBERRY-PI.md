# Finstate på en Raspberry Pi – kun på hjemmenetværket

Målet er, at Finstate kører hele tiden på Pi'en og kan bruges fra dine egne enheder (Mac, telefon), **når de er på samme
netværk som Pi'en derhjemme**. Udefra kan den ikke nås, heller ikke af dig. Data er **krypteret på disken**, og backup hentes
til din Mac.

```
Mac / telefon på hjemmenetværket ──(HTTPS)──► Pi: Caddy på :443 (kun lokale adresser)
                                                   └─► Finstate på 127.0.0.1:5173 (kun lokalt, afviser offentlige adresser)
                                                         └─► /var/lib/finstate/data (AES-256-krypteret)
Internettet ──✕── routeren videresender intet · Pi'ens firewall afviser · Caddy afbryder · Finstate svarer 403
```

| Lag | Hvad beskytter det mod |
|---|---|
| Ingen portvideresendelse/UPnP i routeren | Internettet |
| Firewall på Pi'en (ufw): kun dit netværk | Internettet, hvis routeren ved en fejl åbner en port |
| Caddy og Finstate afviser offentlige IP-adresser | Det samme, endnu en gang |
| HTTPS (Caddys eget lokale certifikat) | Aflytning fra andre enheder på dit wifi |
| Login med adgangskode + 2FA (4 uger) | Gæster og andre enheder på dit netværk |
| Kryptering af data (AES-256-GCM) | Tyveri af Pi'en / SD-kortet |
| systemd-hærdning, egen bruger | Fejl i Finstate kan ikke røre resten af Pi'en |
| Automatiske opdateringer | Kendte sårbarheder |
| Backup til Mac | Et dødt SD-kort |

Brug et wifi med en god adgangskode (WPA2/WPA3), og sæt gerne gæster på routerens gæstenetværk. Så kan de slet ikke se Pi'en.

## 1. Forbered Pi'en (én gang)

Brug Raspberry Pi OS Lite (64-bit). Giv Pi'en værtsnavnet `finstate`, enten i Raspberry Pi Imager eller med `sudo raspi-config` →
System → Hostname. Så hedder den `finstate.local` på hjemmenetværket.

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y unattended-upgrades rsync git ufw avahi-daemon
sudo dpkg-reconfigure -plow unattended-upgrades   # vælg "Ja": sikkerhedsopdateringer installeres automatisk

# Node 22 (LTS)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Caddy (HTTPS foran Finstate)
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

### Firewall: kun dit netværk

Find dit netværks adresseområde. Det er typisk `192.168.1.0/24` eller `192.168.0.0/24`:

```bash
ip -4 route | grep -v default        # fx "192.168.1.0/24 dev wlan0 …"
```

```bash
NET=192.168.1.0/24                    # ret til dit eget
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from $NET to any port 443 proto tcp    # Finstate (HTTPS)
sudo ufw allow from $NET to any port 22 proto tcp     # SSH – til backup
sudo ufw allow from $NET to any port 5353 proto udp   # finstate.local (mDNS)
sudo ufw allow from fe80::/10 to any port 443 proto tcp
sudo ufw allow from fe80::/10 to any port 5353 proto udp
sudo ufw enable && sudo ufw status verbose
```

### SSH: kun med nøgle

Kopiér din Macs nøgle til Pi'en (`ssh-copy-id DINBRUGER@finstate.local`), og slå adgangskoder fra:

```bash
echo "PasswordAuthentication no" | sudo tee /etc/ssh/sshd_config.d/10-kun-noegle.conf
sudo systemctl restart ssh
```

### Routeren

Sørg for, at der **ingen portvideresendelse** (port forwarding) er til Pi'en, og slå gerne **UPnP** fra i routerens
indstillinger. Så kan intet program åbne en port udefra.

## 2. Installér Finstate

```bash
sudo useradd --system --home /var/lib/finstate --shell /usr/sbin/nologin finstate
sudo mkdir -p /opt/finstate /var/lib/finstate/data
sudo chown -R finstate:finstate /var/lib/finstate && sudo chmod 700 /var/lib/finstate /var/lib/finstate/data

# Kopiér projektet (uden data) fra din Mac
rsync -a --exclude node_modules --exclude dist ~/projects/finstate/ DINBRUGER@finstate.local:/tmp/finstate/   # kør på Mac'en
sudo rsync -a /tmp/finstate/ /opt/finstate/ && sudo chown -R root:root /opt/finstate
cd /opt/finstate && sudo npm ci && sudo npm run build
```

## 3. Flyt dine (krypterede) data over

Lokalt kører Finstate uden login, men data er krypteret med nøglen i `local.key`. Kopiér hele mappen (også `local.key`) til Pi'en:

```bash
rsync -a ~/Documents/Finstate/ DINBRUGER@finstate.local:/tmp/finstate-data/      # på Mac'en – filerne er krypteret
sudo rsync -a /tmp/finstate-data/ /var/lib/finstate/data/ && sudo rm -rf /tmp/finstate-data   # på Pi'en
sudo chown -R finstate:finstate /var/lib/finstate/data
```

Første gang du åbner Finstate på Pi'en, sætter du login op (adgangskode + 2FA-app). Login'et låser den samme nøgle op, og
`local.key` slettes på Pi'en – derefter kan data kun læses med adgangskode + 2FA. Har du allerede sat login op tidligere, logger du ind med
**samme adgangskode og 2FA-app**.

## 4. Start tjenesten og HTTPS

```bash
sudo cp /opt/finstate/deploy/finstate.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now finstate
sudo systemctl status finstate

sudo cp /opt/finstate/deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl restart caddy
```

Caddy laver sit eget lille certifikat til `finstate.local`. Dine enheder skal stole på det **én gang**:

```bash
sudo cat /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt   # på Pi'en – kopiér til Mac'en som finstate-ca.crt
```

- **Mac:** dobbeltklik `finstate-ca.crt` → Nøglering → åbn certifikatet → *Hav tillid* → *Altid*.
- **iPhone:** send filen til telefonen (fx AirDrop) → Indstillinger → *Profil hentet* → Installér. Derefter: Generelt → Om →
  Certifikatindstillinger → slå fuld tillid til for certifikatet.

Åbn `https://finstate.local` fra din Mac eller telefon, mens den er på hjemmenetværket. Uden for hjemmet virker siden ikke,
og sådan er den lavet med vilje.

**Åbn aldrig en port i routeren til Pi'en, og brug ikke tjenester som Tailscale Funnel, ngrok eller Cloudflare Tunnel.** De
gør siden tilgængelig udefra.

## 5. Backup til din Mac

Backuppen er en krypteret kopi af hele mappen. Den kan kun åbnes med din adgangskode og 2FA, og den hentes over
hjemmenetværket.

Gør dette én gang på Pi'en. Det giver **din egen bruger** lov til kun at *læse* datamappen via rsync, fordi sender-tilstand
ikke kan skrive:

```bash
echo "$USER ALL=(root) NOPASSWD: /usr/bin/rsync --server --sender *" | sudo tee /etc/sudoers.d/finstate-backup
sudo chmod 440 /etc/sudoers.d/finstate-backup && sudo visudo -c
```

Derefter, på Mac'en, mens den er hjemme:

```bash
scripts/backup-from-pi.sh DINBRUGER@finstate.local ~/Documents/FinstateBackup
```

Scriptet beholder en kopi pr. dag (60 dage) i `snapshots/`. Ligger mappen under din Time Machine eller iCloud, kommer den
automatisk med derfra. Sådan åbner du en backup på Mac'en (første gang låser du den op med adgangskode + 2FA – derefter kører den uden login):

```bash
FINSTATE_DIR=~/Documents/FinstateBackup/current npm start
```

Fra telefonen eller en anden enhed: **Indstillinger → Backup & data → Download krypteret backup**. Pak den ud med
`node scripts/unpack-backup.mjs fil.json ~/Documents/FinstateBackup`.

## Opdatering af Finstate

```bash
rsync -a --exclude node_modules --exclude dist ~/projects/finstate/ DINBRUGER@finstate.local:/tmp/finstate/   # Mac
sudo rsync -a /tmp/finstate/ /opt/finstate/ && cd /opt/finstate && sudo npm ci && sudo npm run build
sudo systemctl restart finstate
```

## Tjek, at den ikke kan nås udefra

- Slå wifi fra på telefonen, så den bruger mobilnettet, og åbn `https://finstate.local`. Siden skal **ikke** kunne åbnes.
- `sudo ufw status` skal kun vise dit netværk (og `fe80::/10`) som tilladt.
- I routeren må der ikke stå nogen portvideresendelse til Pi'en.

## Hvis noget går galt

- **Glemt adgangskode:** data kan ikke låses op, heller ikke af en backup. Gem adgangskoden i din adgangskodeapp.
- **Mistet telefon:** log ind med adgangskoden og en gendannelseskode, og lav nye koder under Indstillinger.
- **Mistanke om misbrug:** Indstillinger → *Log ud på alle enheder*.
- **Låst efter forkerte forsøg:** vent højst 1 time. Låsen forhindrer gætteri.
- **`finstate.local` findes ikke:** brug Pi'ens IP-adresse i stedet (`hostname -I` på Pi'en). Tilføj den så i
  `FINSTATE_ALLOWED_HOSTS` og i Caddyfile (fx `finstate.local, 192.168.1.50 { … }`), og genstart begge.
