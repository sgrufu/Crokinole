#!/bin/sh
# Tutte le prove, dalla cartella crokinole/.
# Servono jsdom ed eventsource:  npm install --no-save jsdom eventsource
set -u
cd "$(dirname "$0")"
FALLITI=0

echo "=== motore"
node --test crokinole_test.js 2>&1 | grep -E "^# (pass|fail)" || FALLITI=1
node --test crokinole_test.js >/dev/null 2>&1 || FALLITI=1

echo "=== avvio della pagina"
node --test public/avvio_test.js 2>&1 | grep -E "^# (pass|fail)"
node --test public/avvio_test.js >/dev/null 2>&1 || FALLITI=1

corri() { # $1 = variabili d'ambiente in piu', poi gli argomenti di prova-e2e
  AMB="$1"; shift
  env $AMB ANIMAZIONE_FATTORE=0 PORTA=4700 node server.js > /tmp/crokinole-e2e.log 2>&1 &
  SRV=$!
  sleep 0.5
  if ! timeout 180 node public/prova-e2e.js 4700 "$@"; then
    FALLITI=1
    echo "--- ultime righe del server"; tail -20 /tmp/crokinole-e2e.log
  fi
  kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
}

echo "=== end-to-end"
corri "PUNTI_VITTORIA=30" 2 partita
corri "PUNTI_VITTORIA=30" 4 partita
corri "PUNTI_VITTORIA=30" 2 rientro
corri "TEMPO_TIRO_MS=300" 2 tempo

[ $FALLITI -eq 0 ] && echo "TUTTO VERDE" || echo "QUALCOSA E' FALLITO"
exit $FALLITI
