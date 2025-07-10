// ==UserScript==
// @name         Data Hoarding Companion
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Plovoucí panel pro ukládání metadat stránek do data-hoarding aplikace
// @author       You
// @match        *://*/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

/**
 * Data Hoarding Companion Panel
 * Userscript kompatibilní s Tampermonkey/Greasemonkey
 * Komunikuje s vaší data-hoarding aplikací
 */

(function() {
    'use strict';
    
    // Konfigurace
    const CONFIG = {
        appUrl: 'http://localhost:5173', // URL vaší Lovable aplikace
        storageKey: 'dh_companion_data',
        apiEndpoint: '/api/companion' // Pro budoucí rozšíření
    };

    // Pokud už panel existuje, netvořit nový
    if (document.getElementById('dh-companion-panel')) {
        return;
    }

    // Získání aktuální domény a URL
    const currentDomain = window.location.hostname;
    const currentUrl = window.location.href;
    const currentTitle = document.title;

    // CSS styly pro panel
    const styles = `
        #dh-companion-panel {
            position: fixed;
            top: 20px;
            right: 20px;
            width: 320px;
            max-height: 500px;
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(10px);
            border-radius: 12px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
            z-index: 999999;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 14px;
            color: #333;
            border: 1px solid rgba(255, 255, 255, 0.2);
            transition: all 0.3s ease;
        }

        #dh-companion-panel.minimized {
            width: 60px;
            height: 60px;
            overflow: hidden;
        }

        .dh-panel-header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 12px 16px;
            border-radius: 12px 12px 0 0;
            display: flex;
            justify-content: space-between;
            align-items: center;
            cursor: move;
        }

        .dh-panel-title {
            font-weight: 600;
            font-size: 13px;
        }

        .dh-panel-controls {
            display: flex;
            gap: 8px;
        }

        .dh-control-btn {
            width: 20px;
            height: 20px;
            border: none;
            background: rgba(255, 255, 255, 0.2);
            border-radius: 50%;
            color: white;
            cursor: pointer;
            font-size: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: background 0.2s;
        }

        .dh-control-btn:hover {
            background: rgba(255, 255, 255, 0.3);
        }

        .dh-panel-content {
            padding: 16px;
            max-height: 400px;
            overflow-y: auto;
        }

        .dh-current-page {
            background: #f8f9fa;
            border-radius: 8px;
            padding: 12px;
            margin-bottom: 16px;
            border-left: 4px solid #667eea;
        }

        .dh-current-page h4 {
            margin: 0 0 8px 0;
            font-size: 13px;
            font-weight: 600;
            color: #667eea;
        }

        .dh-current-page p {
            margin: 4px 0;
            font-size: 12px;
            color: #666;
            word-break: break-all;
        }

        .dh-form-group {
            margin-bottom: 12px;
        }

        .dh-form-group label {
            display: block;
            margin-bottom: 4px;
            font-weight: 500;
            font-size: 12px;
            color: #555;
        }

        .dh-form-group input,
        .dh-form-group textarea,
        .dh-form-group select {
            width: 100%;
            padding: 8px 12px;
            border: 1px solid #ddd;
            border-radius: 6px;
            font-size: 12px;
            font-family: inherit;
            box-sizing: border-box;
        }

        .dh-form-group textarea {
            resize: vertical;
            min-height: 60px;
        }

        .dh-btn {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
            width: 100%;
            margin-top: 8px;
            transition: transform 0.2s;
        }

        .dh-btn:hover {
            transform: translateY(-1px);
        }

        .dh-btn:active {
            transform: translateY(0);
        }

        .dh-records-list {
            margin-top: 16px;
            max-height: 150px;
            overflow-y: auto;
        }

        .dh-record-item {
            background: #f8f9fa;
            border-radius: 6px;
            padding: 8px;
            margin-bottom: 8px;
            font-size: 12px;
            border-left: 3px solid #28a745;
        }

        .dh-record-item .title {
            font-weight: 500;
            color: #333;
        }

        .dh-record-item .meta {
            color: #666;
            font-size: 11px;
            margin-top: 4px;
        }

        .dh-tabs {
            display: flex;
            border-bottom: 1px solid #eee;
            margin-bottom: 16px;
        }

        .dh-tab {
            padding: 8px 12px;
            background: none;
            border: none;
            cursor: pointer;
            font-size: 12px;
            color: #666;
            border-bottom: 2px solid transparent;
        }

        .dh-tab.active {
            color: #667eea;
            border-bottom-color: #667eea;
        }

        .dh-tab-content {
            display: none;
        }

        .dh-tab-content.active {
            display: block;
        }

        @media (max-width: 768px) {
            #dh-companion-panel {
                width: 280px;
                right: 10px;
                top: 10px;
            }
        }
    `;

    // Vložení stylů
    const styleSheet = document.createElement('style');
    styleSheet.textContent = styles;
    document.head.appendChild(styleSheet);

    // Hlavní HTML struktura panelu
    const panelHTML = `
        <div class="dh-panel-header">
            <span class="dh-panel-title">📚 Data Hoarder</span>
            <div class="dh-panel-controls">
                <button class="dh-control-btn" id="dh-minimize" title="Minimalizovat">−</button>
                <button class="dh-control-btn" id="dh-close" title="Zavřít">×</button>
            </div>
        </div>
        <div class="dh-panel-content">
            <div class="dh-current-page">
                <h4>📍 Aktuální stránka</h4>
                <p><strong>Doména:</strong> ${currentDomain}</p>
                <p><strong>Název:</strong> ${currentTitle}</p>
                <p><strong>URL:</strong> ${currentUrl}</p>
            </div>

            <div class="dh-tabs">
                <button class="dh-tab active" data-tab="add">Přidat</button>
                <button class="dh-tab" data-tab="browse">Záznamy</button>
            </div>

            <div class="dh-tab-content active" id="dh-tab-add">
                <form id="dh-metadata-form">
                    <div class="dh-form-group">
                        <label for="dh-category">Kategorie:</label>
                        <select id="dh-category">
                            <option value="">Vyberte kategorii...</option>
                            <option value="01_natural_sciences">Přírodní vědy</option>
                            <option value="02_formal_sciences">Formální vědy</option>
                            <option value="03_social_sciences">Společenské vědy</option>
                            <option value="04_humanities">Humanitní vědy</option>
                            <option value="05_technology">Technologie</option>
                            <option value="06_arts">Umění</option>
                        </select>
                    </div>

                    <div class="dh-form-group">
                        <label for="dh-title">Název:</label>
                        <input type="text" id="dh-title" value="${currentTitle}" />
                    </div>

                    <div class="dh-form-group">
                        <label for="dh-description">Popis:</label>
                        <textarea id="dh-description" placeholder="Popište obsah této stránky..."></textarea>
                    </div>

                    <div class="dh-form-group">
                        <label for="dh-tags">Štítky (oddělené čárkou):</label>
                        <input type="text" id="dh-tags" placeholder="technologie, tutorial, zajímavé" />
                    </div>

                    <div class="dh-form-group">
                        <label for="dh-priority">Priorita:</label>
                        <select id="dh-priority">
                            <option value="low">Nízká</option>
                            <option value="medium" selected>Střední</option>
                            <option value="high">Vysoká</option>
                        </select>
                    </div>

                    <button type="submit" class="dh-btn">💾 Uložit do taxonomie</button>
                </form>
            </div>

            <div class="dh-tab-content" id="dh-tab-browse">
                <div id="dh-domain-stats">
                    <p><strong>Záznamy pro ${currentDomain}:</strong> <span id="dh-domain-count">0</span></p>
                </div>
                <div class="dh-records-list" id="dh-records-list">
                    <!-- Zde se zobrazí záznamy -->
                </div>
                <button class="dh-btn" id="dh-open-app">🔗 Otevřít aplikaci</button>
            </div>
        </div>
    `;

    // Vytvoření panelu
    const panel = document.createElement('div');
    panel.id = 'dh-companion-panel';
    panel.innerHTML = panelHTML;
    document.body.appendChild(panel);

    // === FUNKCIONALITA ===

    // Lokální úložiště dat
    let companionData = JSON.parse(localStorage.getItem(CONFIG.storageKey) || '[]');

    // Minimalizace/maximalizace panelu
    let isMinimized = false;
    document.getElementById('dh-minimize').addEventListener('click', () => {
        isMinimized = !isMinimized;
        panel.classList.toggle('minimized', isMinimized);
        document.getElementById('dh-minimize').textContent = isMinimized ? '+' : '−';
    });

    // Zavření panelu
    document.getElementById('dh-close').addEventListener('click', () => {
        panel.remove();
        styleSheet.remove();
    });

    // Přepínání tabů
    document.querySelectorAll('.dh-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const tabName = tab.dataset.tab;
            
            // Aktualizace aktivní tab
            document.querySelectorAll('.dh-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.dh-tab-content').forEach(c => c.classList.remove('active'));
            
            tab.classList.add('active');
            document.getElementById(`dh-tab-${tabName}`).classList.add('active');
            
            if (tabName === 'browse') {
                loadDomainRecords();
            }
        });
    });

    // Uložení metadat
    document.getElementById('dh-metadata-form').addEventListener('submit', (e) => {
        e.preventDefault();
        
        const metadata = {
            id: Date.now().toString(),
            url: currentUrl,
            domain: currentDomain,
            title: document.getElementById('dh-title').value,
            description: document.getElementById('dh-description').value,
            category: document.getElementById('dh-category').value,
            tags: document.getElementById('dh-tags').value.split(',').map(t => t.trim()).filter(t => t),
            priority: document.getElementById('dh-priority').value,
            savedAt: new Date().toISOString(),
            userAgent: navigator.userAgent.substring(0, 100)
        };

        // Uložení do lokálního úložiště
        companionData.push(metadata);
        localStorage.setItem(CONFIG.storageKey, JSON.stringify(companionData));

        // Pokus o komunikaci s hlavní aplikací (přes postMessage)
        try {
            window.postMessage({
                type: 'DH_SAVE_METADATA',
                data: metadata
            }, window.location.origin);
        } catch (error) {
            console.log('Companion: Nelze komunikovat s hlavní aplikací:', error);
        }

        // Reset formuláře
        document.getElementById('dh-metadata-form').reset();
        document.getElementById('dh-title').value = currentTitle;
        
        // Zobrazení potvrzení
        const btn = document.querySelector('#dh-metadata-form .dh-btn');
        const originalText = btn.textContent;
        btn.textContent = '✅ Uloženo!';
        btn.style.background = '#28a745';
        
        setTimeout(() => {
            btn.textContent = originalText;
            btn.style.background = '';
        }, 2000);
    });

    // Načtení záznamů pro aktuální doménu
    function loadDomainRecords() {
        const domainRecords = companionData.filter(record => record.domain === currentDomain);
        const recordsList = document.getElementById('dh-records-list');
        const domainCount = document.getElementById('dh-domain-count');
        
        domainCount.textContent = domainRecords.length;
        
        if (domainRecords.length === 0) {
            recordsList.innerHTML = '<p style="color: #666; font-size: 12px; text-align: center; padding: 20px;">Žádné záznamy pro tuto doménu</p>';
            return;
        }

        recordsList.innerHTML = domainRecords
            .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt))
            .slice(0, 10) // Pouze posledních 10 záznamů
            .map(record => `
                <div class="dh-record-item">
                    <div class="title">${record.title}</div>
                    <div class="meta">
                        ${record.tags.length > 0 ? `🏷️ ${record.tags.join(', ')} • ` : ''}
                        📅 ${new Date(record.savedAt).toLocaleDateString('cs-CZ')}
                        ${record.priority === 'high' ? ' • 🔥 Vysoká priorita' : ''}
                    </div>
                </div>
            `).join('');
    }

    // Otevření hlavní aplikace
    document.getElementById('dh-open-app').addEventListener('click', () => {
        const appWindow = window.open(CONFIG.appUrl, 'DataHoarderApp', 'width=1200,height=800');
        
        // Pokus o předání dat do hlavní aplikace
        setTimeout(() => {
            try {
                appWindow.postMessage({
                    type: 'DH_COMPANION_DATA',
                    data: companionData,
                    currentUrl: currentUrl,
                    currentDomain: currentDomain
                }, CONFIG.appUrl);
            } catch (error) {
                console.log('Companion: Nelze předat data hlavní aplikaci:', error);
            }
        }, 1000);
    });

    // Drag & Drop funkcionalita pro panel
    let isDragging = false;
    let dragOffset = { x: 0, y: 0 };

    const header = panel.querySelector('.dh-panel-header');
    
    header.addEventListener('mousedown', (e) => {
        isDragging = true;
        dragOffset.x = e.clientX - panel.offsetLeft;
        dragOffset.y = e.clientY - panel.offsetTop;
        panel.style.cursor = 'grabbing';
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        
        const x = e.clientX - dragOffset.x;
        const y = e.clientY - dragOffset.y;
        
        // Omezení pohybu v rámci viewportu
        const maxX = window.innerWidth - panel.offsetWidth;
        const maxY = window.innerHeight - panel.offsetHeight;
        
        panel.style.left = Math.max(0, Math.min(x, maxX)) + 'px';
        panel.style.top = Math.max(0, Math.min(y, maxY)) + 'px';
        panel.style.right = 'auto';
    });

    document.addEventListener('mouseup', () => {
        isDragging = false;
        panel.style.cursor = '';
    });

    // Inicializace - načtení záznamů pro aktuální doménu
    loadDomainRecords();

    // Export funkcí pro případné rozšíření
    window.DataHoarderCompanion = {
        addRecord: (metadata) => {
            companionData.push(metadata);
            localStorage.setItem(CONFIG.storageKey, JSON.stringify(companionData));
        },
        getRecords: (domain = null) => {
            return domain ? 
                companionData.filter(r => r.domain === domain) : 
                companionData;
        },
        exportData: () => {
            return JSON.stringify(companionData, null, 2);
        },
        importData: (jsonData) => {
            try {
                const imported = JSON.parse(jsonData);
                companionData = [...companionData, ...imported];
                localStorage.setItem(CONFIG.storageKey, JSON.stringify(companionData));
                loadDomainRecords();
                return true;
            } catch (error) {
                console.error('Chyba při importu dat:', error);
                return false;
            }
        }
    };

    console.log('📚 Data Hoarder Companion Panel načten!');
    console.log('Použijte window.DataHoarderCompanion pro programový přístup');

})();