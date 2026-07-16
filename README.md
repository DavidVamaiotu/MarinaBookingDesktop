# Marina Booking Desktop

Client desktop Electron pentru rezervările WordPress Booking Calendar prin **Marina Booking API v1.0.6+**. Păstrează designul și interacțiunile timeline-ului Parkline Web, înlocuind serverul local vechi cu un proces principal securizat, bazat exclusiv pe API.

## Dezvoltare

Cerințe: Node.js 22.5+ și un serviciu de credențiale disponibil pentru Electron (Windows Credential Protection, macOS Keychain sau Linux Secret Service).

```bash
npm install
npm test
npm run check
npm start
```

Aplicația are două spații de lucru independente: **Camere** pentru `marinapark.ro` și **Camping** pentru corturi/rulote pe `camping.marinapark.ro`. Fiecare păstrează separat cache-ul, coada și datele de acces, astfel încât ID-urile WordPress identice să nu se suprascrie.

La prima pornire a fiecărui spațiu, deschide Setări și introdu:

- URL-ul API care se termină în `/wp-json/marina-booking/v1`
- utilizatorul API WordPress dedicat
- parola de aplicație
- fusul orar al site-ului, de regulă `Europe/Bucharest`

Camping afișează exact două rânduri, Corturi și Rulote, dar păstrează toate ID-urile de resurse returnate de API. La creare se selectează numai categoria părinte; Booking Calendar verifică întreaga capacitate și atribuie rezervarea primei resurse părinte/copil disponibile pentru tot intervalul, în ordinea priorității configurate în WordPress. ID-ul real atribuit de server rămâne pe rezervare pentru editare și sincronizare. Patul suplimentar nu este oferit în Camping. Site-ul Camping trebuie să aibă instalat Marina Booking API v1.0.4+; aplicația nu încearcă acces direct la baza WordPress.

Parolele sunt criptate separat cu Electron `safeStorage` și păstrate în bazele SQLite locale doar ca date criptate. Aplicația respinge fallback-ul Linux nesigur `basic_text`. Parolele nu sunt returnate niciodată prin IPC.

## Build pentru producție

```bash
npm ci
npm test
npm run check
npm run dist
```

Instalatorul Windows NSIS este scris în `dist-electron/`. Starea aplicației este păstrată în directorul `userData` al utilizatorului, nu lângă aplicația instalată.

Versiunile instalate verifică automat actualizările la pornire. Windows descarcă release-ul nou din `DavidVamaiotu/MarinaBookingDesktop` și cere repornirea pentru instalare. Android descarcă release-ul din `DavidVamaiotu/MarinaBookingMobile`, verifică fișierul SHA-256 și deschide installerul Android. Prima instalare Android de producție trebuie făcută manual; actualizările următoare păstrează aceeași semnătură și pot fi instalate peste aplicație.

Publicarea este separată pe cele două repository-uri. După actualizarea aceleiași versiuni în `package.json` și `android/app/build.gradle`, tag-ul `vX.Y.Z` pornește workflow-ul desktop în repository-ul Desktop și workflow-ul APK semnat în repository-ul Mobile. `scripts/verify-release-version.js` oprește release-ul dacă tag-ul și versiunile nu coincid.

Pentru un release complet rulează `./bump`. Fără argument crește versiunea patch; acceptă și `./bump minor`, `./bump major` sau `./bump X.Y.Z`. Comanda include modificările curente, verifică repository-urile, rulează testele, publică același commit și tag în ambele și așteaptă până când release-urile EXE și APK sunt disponibile.

## Domeniu

Include timeline pe nouă luni și cache SQLite pentru Camere și Camping, actualizare periodică condiționată, creare/editare, redimensionare de la margine, status aprobat/în așteptare, note, gunoi/restaurare, verificarea disponibilității, previzualizări native de preț și avans, schimbarea avansului cu actualizarea automată a restului și cereri de plată prin email, actualizări optimiste locale, cozi sigure la repornire, diagnostic, setări securizate și actualizare prin API. Crearea unei rezervări necesită disponibilitate online și confirmarea prețului; rezervările din cache rămân disponibile offline.

Nu include administrarea pluginului WordPress, constructori de formulare, configurarea plăților, configurarea șabloanelor de email, ștergere definitivă, acces direct la baza WordPress sau funcțiile vechi Marina Park pentru bonuri, statistici și server local.

Vezi [arhitectura](docs/ARCHITECTURE.md), [compatibilitatea API](docs/API-COMPATIBILITY.md) și [lista de teste manuale](docs/MANUAL-TEST-CHECKLIST.md).
## Instalare pe Android și Windows

### Android (inclusiv Samsung Galaxy Z Fold 7)

Aplicația Android este independentă de PC și folosește direct același Marina Booking API. Pe telefon păstrează un cache local pentru consultare fără internet, dar creează și modifică rezervări numai când există conexiune. Parola API este criptată cu Android Keystore.

1. Pentru dezvoltare, generează APK-ul cu `npm run mobile:apk`. Pentru instalarea de producție folosește `MarinaBookingMobile.apk` din pagina Releases a repository-ului Mobile.
2. Copiază APK-ul pe telefon.
3. Pe telefon, deschide APK-ul și permite **Instalare aplicații necunoscute** pentru aplicația din care l-ai deschis (de exemplu My Files).
4. Apasă **Instalare**, apoi deschide **Marina Booking**.
5. În **Setări**, introdu URL-ul API, utilizatorul WordPress și parola de aplicație. Configurează separat filele **Camere** și **Camping**.

Pe Galaxy Z Fold 7 aplicația se adaptează automat atât ecranului exterior, cât și ecranului interior. Poate fi pliată/desfăcută în timp ce rulează; calendarul rămâne derulabil orizontal.

### Windows

1. Generează installerul cu `npm run dist` pe Windows sau într-un mediu care poate construi NSIS.
2. Rulează `dist-electron/MarinaBookingDesktop-Setup-1.0.9.exe`.
3. Installerul este per utilizator și nu cere drepturi de administrator. După instalare, aplicația pornește automat.
4. Deschide **Setări** și configurează conexiunile **Camere** și **Camping**.

Datele locale Windows rămân în profilul utilizatorului la dezinstalare, pentru a proteja coada offline. Aplicația Android și cea Windows folosesc același server, dar au stocări locale separate.
