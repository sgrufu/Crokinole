# Crokinole

Gioco in rete locale, in 2 o in 4 a coppie, porta **3004**. Le specifiche complete sono nel progetto (`CROKINOLE.md`), l'architettura comune in `ARCHITETTURA-GIOCHI.md`.

## Avvio

```
cd crokinole
node server.js
```

- Gioco: `http://localhost:3004` (dagli altri PC l'indirizzo che il server stampa all'avvio).
- Banco di prova della fisica: `http://localhost:3004/banco.html`.

Nessuna dipendenza npm per giocare. Non c'è salvataggio su disco: se il server si riavvia, la Partita è persa.

## Riga da aggiungere al portale

Nell'array `GIOCHI` del `server.js` del portale:

```js
{
  id: 'crokinole',
  nome: 'Crokinole',
  porta: 3004,
  descrizione: 'Dischetti di legno da tirare col dito verso il 20',
  giocatori: 'in 2 o in 4 a coppie',
},
```

## File

| File | Cosa fa |
|---|---|
| `crokinole.js` | Motore: geometria, fisica deterministica, regole, punteggio. UMD, puro, senza I/O. `node crokinole.js 42` simula una Partita. |
| `crokinole_test.js` | 26 test del motore (fisica, regole NCA, punteggio, vista congelata, Partite a raffica). |
| `server.js` | Sala d'attesa a due colonne, spettatori, chat, timer di tiro, blocco durante le animazioni, rientro per nome, voto, rivincita. |
| `public/index.html` | Il client: un file solo, canvas per il tavolo. |
| `public/tavolo.js` | Disegno del tavolo, gesto della fionda, riproduzione delle traiettorie, suoni. Condiviso tra gioco e banco di prova. |
| `public/banco.html` | Banco di prova: stessa fisica, parametri regolabili con i cursori. |
| `public/avvio_test.js` | Carica la pagina in jsdom e la porta in sala, in partita, a fine round e a fine Partita. |
| `public/prova-e2e.js` | Client Node che gioca davvero contro il server: Partite in 2 e in 4, rientro, voto, tempo scaduto. |
| `prove.sh` | Lancia tutte le prove. |

## Prove

```
npm install --no-save jsdom eventsource   # solo per i test
./prove.sh
```

Variabili d'ambiente del server utili per i test:

- `ANIMAZIONE_FATTORE=0` toglie l'attesa delle animazioni.
- `PUNTI_VITTORIA=30` cambia i punti per vincere proposti in sala (di solito 100; in sala si sceglie tra 50, 75, 100, 150, 200).
- `TEMPO_TIRO_MS=300` fa scadere il timer di tiro quasi subito.
- `GRAZIA_MS` imposta l'attesa prima di liberare il posto di chi si scollega in sala d'attesa.

## Taratura della fisica

1. Apri il banco di prova. Metti dei dischetti (Rossi = tuoi, Blu = avversari), tira e muovi i cursori finché il tiro "si sente" giusto.
2. I cursori restano salvati in quel browser. Il riquadro "Parametri" in fondo mostra solo quelli cambiati.
3. Copia i valori di fisica in `FISICA_DEFAULT` (`crokinole.js`) e quelli di interfaccia in `UI_DEFAULT` (`public/tavolo.js`), poi rilancia `./prove.sh`.

L'imprecisione del tiro (angolo e forza) è già prevista ma è spenta di default. Per accenderla basta un valore maggiore di 0 nei cursori.

## Pubblicazione su Render

La repo contiene `render.yaml`: su render.com **New → Blueprint**, scegli questa repo e conferma. Ogni push su `main` rifà il deploy.

- La porta arriva da Render nella variabile `PORT` (in locale resta 3004).
- Finché c'è almeno una pagina collegata, ogni 10 minuti il server chiama `/sveglia` sul proprio indirizzo pubblico (`RENDER_EXTERNAL_URL`, fornito da Render) per non farsi spegnere dal piano gratuito. Quando se ne vanno tutti smette: dopo ~15 minuti Render lo spegne e al primo accesso si riaccende (30–60 secondi). In locale non succede.
- Se Render riavvia il servizio (per esempio a ogni deploy) la Partita in corso è persa.
