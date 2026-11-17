#!/usr/bin/env bash
# Hent den krypterede Finstate-mappe fra din Raspberry Pi til din computer (fx så Time Machine tager den med).
# Filerne er krypteret – de kan kun åbnes med din adgangskode og 2FA:  FINSTATE_DIR=<mappe>/current npm start
#
#   scripts/backup-from-pi.sh DINBRUGER@finstate.local                    # → ~/Documents/FinstateBackup
#   scripts/backup-from-pi.sh DINBRUGER@finstate.local ~/Sti/Til/Backup
#
# Kræver på Pi'en en sudo-regel, der KUN tillader rsync at sende (læse) filer – se deploy/RASPBERRY-PI.md.
set -euo pipefail
if [ $# -lt 1 ]; then echo "Brug: $0 bruger@pi [mappe]"; exit 1; fi
SRC="$1"
DEST="${2:-$HOME/Documents/FinstateBackup}"
REMOTE_DIR="${FINSTATE_REMOTE_DIR:-/var/lib/finstate/data}"
mkdir -p "$DEST/snapshots"
chmod 700 "$DEST"
STAMP="$(date +%Y-%m-%d)"
rsync -a --delete --exclude '*.tmp-*' --rsync-path="sudo rsync" "$SRC:$REMOTE_DIR/" "$DEST/current/"
# Én kopi pr. dag i snapshots/ – ældre end 60 dage slettes.
rsync -a --delete "$DEST/current/" "$DEST/snapshots/$STAMP/"
find "$DEST/snapshots" -mindepth 1 -maxdepth 1 -type d -mtime +60 -exec rm -rf {} +
echo "Backup hentet til $DEST/current (og snapshots/$STAMP)."
echo "Åbn den med: FINSTATE_DIR=$DEST/current npm start"
