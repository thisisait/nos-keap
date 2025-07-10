// Data Hoarder Companion - Bookmarklet verze
// Zkopírujte a vložte jako bookmark do vašeho prohlížeče

javascript:(function(){
    // Pokud už je script načten, jen znovu otevřeme panel
    if(window.DataHoarderCompanion) {
        const existing = document.getElementById('dh-companion-panel');
        if(existing) {
            existing.style.display = existing.style.display === 'none' ? 'block' : 'none';
            return;
        }
    }
    
    // Jinak načteme script z vaší aplikace
    const script = document.createElement('script');
    script.src = 'http://localhost:5173/companion-script.js'; // Změňte na vaši doménu
    script.onload = function() {
        console.log('Data Hoarder Companion načten!');
    };
    script.onerror = function() {
        alert('Nepodařilo se načíst Data Hoarder Companion. Zkontrolujte, zda běží aplikace.');
    };
    document.head.appendChild(script);
})();