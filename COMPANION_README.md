# 📚 Data Hoarder Companion Panel

Miniaturní JavaScript companion panel pro vaši data-hoarding aplikaci, který můžete vložit do jakékoli webové stránky.

## 🚀 Funkce

- **Plovoucí panel** - Elegantní, přenositelný panel s moderním designem
- **Prohlížení záznamů** - Zobrazuje záznamy pro aktuální doménu
- **Formulář pro metadata** - Rychlé přidání stránky do taxonomie
- **Drag & Drop** - Panel lze přetahovat po obrazovce
- **Responsive design** - Funguje na desktop i mobile
- **Lokální úložiště** - Data se ukládají i offline
- **Komunikace s hlavní aplikací** - Přenos dat přes postMessage API

## 📋 Použití

### Metoda 1: Přímé vložení scriptu

```html
<script src="http://localhost:42069/companion-script.js"></script>
```

### Metoda 2: Bookmarklet (doporučeno)

1. Zkopírujte obsah souboru `public/bookmarklet.js`
2. Vytvořte nový bookmark ve vašem prohlížeči
3. Vložte zkopírovaný kód jako URL bookmarku
4. Klikněte na bookmark na jakékoli stránce pro aktivaci panelu

### Metoda 3: Browser Extension

Obsah `companion-script.js` můžete integrovat do vaší vlastní browser extension.

## 🎛️ Ovládání panelu

### Hlavní tlačítka
- **`−`** - Minimalizovat/maximalizovat panel
- **`×`** - Zavřít panel
- **Drag** - Uchopte hlavičku pro přetažení panelu

### Taby
- **Přidat** - Formulář pro uložení aktuální stránky
- **Záznamy** - Prohlížení uložených záznamů pro aktuální doménu

### Formulář pro metadata
- **Kategorie** - Výběr z hierarchie taxonomie
- **Název** - Automaticky vyplněn z `document.title`
- **Popis** - Volitelný popis obsahu stránky
- **Štítky** - Klíčová slova oddělená čárkou
- **Priorita** - Nízká/Střední/Vysoká

## 🔧 Konfigurace

Upravte konstanty v `companion-script.js`:

```javascript
const CONFIG = {
    appUrl: 'http://localhost:42069', // URL vaší aplikace
    storageKey: 'dh_companion_data', // Klíč pro localStorage
    apiEndpoint: '/api/companion'    // Pro budoucí API
};
```

## 📡 Komunikace s hlavní aplikací

Panel komunikuje s hlavní aplikací pomocí REST API na portu 42069:

### Zprávy od Companion panelu:
```javascript
// Uložení nových metadat
{
    type: 'DH_SAVE_METADATA',
    data: {
        id: '1234567890',
        url: 'https://example.com/page',
        domain: 'example.com',
        title: 'Název stránky',
        description: 'Popis obsahu',
        category: '05_technology',
        tags: ['javascript', 'tutorial'],
        priority: 'medium',
        savedAt: '2024-01-15T10:30:00.000Z'
    }
}

// Předání všech dat při otevření aplikace
{
    type: 'DH_COMPANION_DATA',
    data: [/* array všech záznamů */],
    currentUrl: 'https://example.com/page',
    currentDomain: 'example.com'
}
```

### Zpracování v hlavní aplikaci:
Hlavní aplikace automaticky přijímá data a:
- Ukládá je do databáze pomocí `saveTaxonomyMetadata()`
- Zobrazuje toast notifikaci
- Ukazuje stav připojení v hlavičce

## 💾 Formát uložených dat

```javascript
{
    id: "1234567890",
    url: "https://example.com/page",
    domain: "example.com", 
    title: "Název stránky",
    description: "Popis obsahu",
    category: "05_technology",
    tags: ["javascript", "tutorial"],
    priority: "medium",
    savedAt: "2024-01-15T10:30:00.000Z",
    userAgent: "Mozilla/5.0..."
}
```

## 🛠️ Programový přístup

Panel exportuje globální objekt `window.DataHoarderCompanion` s API:

```javascript
// Přidání záznamu
DataHoarderCompanion.addRecord(metadata);

// Získání záznamů
const allRecords = DataHoarderCompanion.getRecords();
const domainRecords = DataHoarderCompanion.getRecords('example.com');

// Export dat (JSON)
const jsonData = DataHoarderCompanion.exportData();

// Import dat
const success = DataHoarderCompanion.importData(jsonString);
```

## 📱 Responsive design

Panel se automaticky přizpůsobuje různým velikostem obrazovky:
- **Desktop**: 320px šířka, pozice vpravo nahoře
- **Mobile**: 280px šířka, optimalizované rozestupy
- **Touch**: Všechna tlačítka jsou dostatečně velká pro dotyková zařízení

## 🎨 Přizpůsobení vzhledu

Styles jsou definovány v JavaScriptu pro snadnou úpravu. Hlavní CSS proměnné:

```css
/* Barevné schéma */
background: rgba(255, 255, 255, 0.95);
backdrop-filter: blur(10px);
box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);

/* Gradient hlavičky */
background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
```

## 🔒 Bezpečnost a soukromí

- **Lokální úložiště**: Data se ukládají pouze do `localStorage`
- **Same-origin**: PostMessage komunikace je omezena na stejnou doménu
- **Žádné tracking**: Panel neodesílá data třetím stranám
- **CORS friendly**: Funguje s jakýmikoli CORS nastaveními

## 🐛 Troubleshooting

### Panel se nezobrazuje
- Zkontrolujte, zda se script správně načetl
- Otevřete Developer Tools a podívejte se na chyby v konzoli
- Zkontrolujte, zda není panel blokován ad-blockerem

### Komunikace s hlavní aplikací nefunguje
- Ověřte, že hlavní aplikace běží na správné URL
- Zkontrolujte CORS nastavení
- Ujistěte se, že jsou domény stejné pro postMessage

### Data se neukládají
- Zkontrolujte, zda je povolený localStorage
- Ověřte, zda není překročen limit localStorage (obvykle 5-10MB)

## 🔄 Aktualizace

Pro aktualizaci companion panelu:
1. Aktualizujte soubor `companion-script.js`
2. Obnovte stránku s panelem
3. Panel se automaticky načte s nejnovější verzí

## 🤝 Integrace s jinými systémy

Panel je navržen pro snadnou integraci:
- **CMS systémy**: Vložte script do template
- **Browser extensions**: Použijte jako content script
- **Aplikace**: Komunikace přes postMessage API
- **API**: Rozšiřte o HTTP endpoint pro synchronizaci

---

**Vytvořeno pro vaši data-hoarding aplikaci** 📚✨