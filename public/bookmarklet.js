// Data Hoarder Companion - Bookmarklet verze
// Zkopírujte a vložte jako bookmark do vašeho prohlížeče

javascript:(function(){
    // Pokud už je script načten, jen znovu otevřeme panel
    if(window.DataHoardingCompanion) {
        const existing = document.getElementById('data-hoarding-companion');
        if(existing) {
            existing.style.display = existing.style.display === 'none' ? 'block' : 'none';
            return;
        }
    }
    
    // Jinak načteme script z vaší aplikace
    const script = document.createElement('script');
    script.src = 'http://localhost:8080/companion-script.js'; // Change to your KEAP host
    script.onload = function() {
        console.log('Data Hoarder Companion načten!');
    };
    script.onerror = function() {
        alert('Nepodařilo se načíst Data Hoarder Companion. Zkontrolujte, zda běží aplikace.');
    };
    document.head.appendChild(script);
})();