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
 * Komunikuje s vaší data-hoarding aplikací přes API
 */

// Configuration
const CONFIG = {
  // Default API servers
  servers: [
    { name: 'Local Development', url: 'http://localhost:8081', default: true },
    { name: 'Local Network', url: 'http://192.168.1.131:8081', default: false },
    { name: 'Custom', url: '', default: false }
  ],
  // Current API target
  currentServer: localStorage.getItem('dh_api_server') || 'http://localhost:8081',
  // Storage keys
  storageKeys: {
    server: 'dh_api_server',
    position: 'dh_panel_position',
    visible: 'dh_panel_visible'
  }
};

(function() {
  'use strict';
  
  // Prevent multiple instances
  if (window.DataHoardingCompanion) {
    return;
  }
  
  window.DataHoardingCompanion = true;

  // API Service
  class ApiService {
    constructor(baseUrl) {
      this.baseUrl = baseUrl.replace(/\/$/, '');
      this.requestId = 0;
    }

    setBaseUrl(url) {
      this.baseUrl = url.replace(/\/$/, '');
      CONFIG.currentServer = url;
      localStorage.setItem(CONFIG.storageKeys.server, url);
    }

    async request(method, path, data = null) {
      const url = `${this.baseUrl}${path}`;
      
      try {
        const options = {
          method,
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          mode: 'cors'
        };

        if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
          options.body = JSON.stringify(data);
        }

        const response = await fetch(url, options);
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const result = await response.json();
        return { success: true, data: result };
        
      } catch (error) {
        console.error('API Request failed:', error);
        return { 
          success: false, 
          error: `Připojení selhalo: ${error.message}` 
        };
      }
    }

    async getMetadataByDomain(domain) {
      return this.request('GET', `/api/metadata/domain/${encodeURIComponent(domain)}`);
    }

    async saveMetadata(metadata) {
      return this.request('POST', '/api/metadata', metadata);
    }

    async searchMetadata(query) {
      return this.request('GET', `/api/metadata/search?q=${encodeURIComponent(query)}`);
    }

    async getTaxonomy() {
      return this.request('GET', '/api/taxonomy');
    }

    async healthCheck() {
      return this.request('GET', '/api/health');
    }

    async getStats() {
      return this.request('GET', '/api/stats');
    }
  }

  const api = new ApiService(CONFIG.currentServer);

  // Create companion panel
  function createCompanionPanel() {
    const panel = document.createElement('div');
    panel.id = 'data-hoarding-companion';
    panel.innerHTML = `
      <div class="dh-panel">
        <div class="dh-header">
          <div class="dh-title">
            <span class="dh-icon">📚</span>
            Data Hoarding
          </div>
          <div class="dh-status" id="dh-status">
            <span class="dh-status-indicator" id="dh-status-indicator">🔴</span>
            <span class="dh-status-text" id="dh-status-text">Offline</span>
          </div>
          <div class="dh-controls">
            <button class="dh-btn dh-btn-minimize" title="Minimalizovat">−</button>
            <button class="dh-btn dh-btn-close" title="Zavřít">×</button>
          </div>
        </div>
        <div class="dh-content">
          <div class="dh-tabs">
            <button class="dh-tab active" data-tab="add">Přidat</button>
            <button class="dh-tab" data-tab="browse">Procházet</button>
            <button class="dh-tab" data-tab="settings">Nastavení</button>
          </div>
          
          <div class="dh-tab-content" id="dh-add-tab">
            <form class="dh-form" id="dh-metadata-form">
              <div class="dh-form-group">
                <label>Taxonomie *</label>
                <div class="dh-taxonomy-container">
                  <select id="dh-taxonomy" required>
                    <option value="">Načítám taxonomii...</option>
                  </select>
                  <div class="dh-taxonomy-search">
                    <input type="text" id="dh-taxonomy-search" placeholder="Hledat v taxonomii...">
                  </div>
                </div>
              </div>
              <div class="dh-form-group">
                <label>Název (volitelné)</label>
                <input type="text" id="dh-title" placeholder="Ponechte prázdné pro automatické pojmenování">
              </div>
              <div class="dh-form-group">
                <label>Popis</label>
                <textarea id="dh-description" rows="3" placeholder="Stručný popis obsahu stránky"></textarea>
              </div>
              <div class="dh-form-group">
                <label>Priorita</label>
                <select id="dh-priority">
                  <option value="low">Nízká</option>
                  <option value="medium" selected>Střední</option>
                  <option value="high">Vysoká</option>
                </select>
              </div>
              <div class="dh-form-group">
                <label>Tagy (oddělené čárkou)</label>
                <input type="text" id="dh-tags" placeholder="web, development, tutorial">
              </div>
              <div class="dh-form-group">
                <label>URL</label>
                <input type="url" id="dh-url" readonly>
              </div>
              <button type="submit" class="dh-btn dh-btn-primary">Uložit metadata</button>
            </form>
          </div>
          
          <div class="dh-tab-content" id="dh-browse-tab" style="display: none;">
            <div class="dh-browse-header">
              <div class="dh-stats" id="dh-browse-stats">
                <span class="dh-stats-text">Načítám statistiky...</span>
              </div>
              <div class="dh-search">
                <input type="text" id="dh-search" placeholder="Hledat záznamy...">
                <button id="dh-search-btn" class="dh-btn">🔍</button>
              </div>
            </div>
            <div class="dh-records" id="dh-records-list">
              <div class="dh-loading">Načítám záznamy...</div>
            </div>
          </div>

          <div class="dh-tab-content" id="dh-settings-tab" style="display: none;">
            <div class="dh-form-group">
              <label>API Server</label>
              <select id="dh-server-select">
                ${CONFIG.servers.map(server => `
                  <option value="${server.url}" ${server.url === CONFIG.currentServer ? 'selected' : ''}>
                    ${server.name}
                  </option>
                `).join('')}
              </select>
            </div>
            <div class="dh-form-group" id="dh-custom-server-group" style="display: none;">
              <label>Custom Server URL</label>
              <input type="text" id="dh-custom-server" placeholder="http://example.com:8080">
            </div>
            <div class="dh-form-group">
              <div class="dh-button-group">
                <button id="dh-save-settings" class="dh-btn dh-btn-save">
                  <span class="dh-btn-text">Uložit</span>
                  <span class="dh-spinner" style="display: none;">⏳</span>
                </button>
                <button id="dh-test-connection" class="dh-btn dh-btn-test">
                  <span class="dh-btn-text">Test</span>
                  <span class="dh-spinner" style="display: none;">⏳</span>
                </button>
              </div>
            </div>
            <div class="dh-api-stats" id="dh-api-stats">
              <div class="dh-loading">Načítám statistiky...</div>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(panel);
    return panel;
  }

  // Initialize companion panel functionality
  function initializeCompanion() {
    const panel = document.getElementById('data-hoarding-companion');
    if (!panel) return;

    // Auto-fill form with current page data
    const currentUrl = window.location.href;
    const currentDomain = window.location.hostname;
    const currentTitle = document.title || 'Untitled Page';

    document.getElementById('dh-url').value = currentUrl;
    document.getElementById('dh-title').placeholder = currentTitle;
    document.getElementById('dh-description').value = getPageDescription();
    
    // Load taxonomy data
    loadTaxonomyData();

    // Tab switching
    const tabs = panel.querySelectorAll('.dh-tab');
    const tabContents = panel.querySelectorAll('.dh-tab-content');

    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tabContents.forEach(tc => tc.style.display = 'none');
        
        tab.classList.add('active');
        const targetTab = tab.getAttribute('data-tab');
        document.getElementById(`dh-${targetTab}-tab`).style.display = 'block';
        
        if (targetTab === 'browse') {
          loadDomainRecords();
        } else if (targetTab === 'settings') {
          loadApiStats();
        }
      });
    });

    // Server selection
    document.getElementById('dh-server-select').addEventListener('change', (e) => {
      const selectedValue = e.target.value;
      const customGroup = document.getElementById('dh-custom-server-group');
      
      if (selectedValue === '') {
        customGroup.style.display = 'block';
      } else {
        customGroup.style.display = 'none';
      }
    });

    // Save settings button
    document.getElementById('dh-save-settings').addEventListener('click', async () => {
      const btn = document.getElementById('dh-save-settings');
      const btnText = btn.querySelector('.dh-btn-text');
      const spinner = btn.querySelector('.dh-spinner');
      
      // Show spinner
      btnText.style.display = 'none';
      spinner.style.display = 'inline';
      btn.disabled = true;
      
      // Get selected or custom server URL
      const serverSelect = document.getElementById('dh-server-select');
      const customServer = document.getElementById('dh-custom-server');
      
      let newUrl;
      if (serverSelect.value === '') {
        newUrl = customServer.value.trim();
        if (!newUrl) {
          showMessage('❌ Zadejte URL serveru!', 'error');
          btnText.style.display = 'inline';
          spinner.style.display = 'none';
          btn.disabled = false;
          return;
        }
      } else {
        newUrl = serverSelect.value;
      }
      
      // Update API base URL
      api.setBaseUrl(newUrl);
      
      // Test connection to new server
      const result = await api.healthCheck();
      
      // Hide spinner
      btnText.style.display = 'inline';
      spinner.style.display = 'none';
      btn.disabled = false;
      
      if (result.success) {
        showMessage('✅ Nastavení uloženo a připojení úspěšné!', 'success');
        updateConnectionStatus(true);
        loadApiStats(); // Refresh stats
      } else {
        showMessage('⚠️ Nastavení uloženo, ale připojení selhalo: ' + result.error, 'warning');
        updateConnectionStatus(false);
      }
    });

    // Test connection button
    document.getElementById('dh-test-connection').addEventListener('click', async () => {
      const btn = document.getElementById('dh-test-connection');
      const btnText = btn.querySelector('.dh-btn-text');
      const spinner = btn.querySelector('.dh-spinner');
      
      // Show spinner
      btnText.style.display = 'none';
      spinner.style.display = 'inline';
      btn.disabled = true;
      
      const result = await api.healthCheck();
      
      // Hide spinner
      btnText.style.display = 'inline';
      spinner.style.display = 'none';
      btn.disabled = false;
      
      if (result.success) {
        showMessage('✅ Připojení úspěšné!', 'success');
        updateConnectionStatus(true);
      } else {
        showMessage('❌ Připojení selhalo: ' + result.error, 'error');
        updateConnectionStatus(false);
      }
    });

    // Taxonomy search functionality
    document.getElementById('dh-taxonomy-search').addEventListener('input', (e) => {
      filterTaxonomyOptions(e.target.value);
    });

    // Form submission
    document.getElementById('dh-metadata-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const taxonomyId = document.getElementById('dh-taxonomy').value;
      if (!taxonomyId) {
        showMessage('❌ Vyberte taxonomii!', 'error');
        return;
      }

      const titleValue = document.getElementById('dh-title').value.trim();
      
      const metadata = {
        name: titleValue || currentTitle,
        description: document.getElementById('dh-description').value,
        taxonomyId: taxonomyId,
        icon: getTaxonomyIcon(taxonomyId),
        links: {
          url: currentUrl,
          domain: currentDomain,
          priority: document.getElementById('dh-priority').value,
          tags: document.getElementById('dh-tags').value.split(',').map(tag => tag.trim()).filter(tag => tag),
          savedAt: new Date().toISOString()
        },
        translations: {}
      };

      // Try to save via API
      const result = await api.saveMetadata(metadata);
      
      if (result.success) {
        showMessage('✅ Metadata úspěšně uložena!', 'success');
        // Reset form
        document.getElementById('dh-metadata-form').reset();
        document.getElementById('dh-taxonomy').selectedIndex = 0;
        document.getElementById('dh-url').value = currentUrl;
        document.getElementById('dh-title').placeholder = currentTitle;
        document.getElementById('dh-description').value = getPageDescription();
      } else {
        showMessage('❌ Chyba ukládání: ' + result.error, 'error');
      }
    });

    // Panel controls
    panel.querySelector('.dh-btn-minimize').addEventListener('click', () => {
      panel.classList.toggle('minimized');
    });

    panel.querySelector('.dh-btn-close').addEventListener('click', () => {
      panel.style.display = 'none';
      localStorage.setItem(CONFIG.storageKeys.visible, 'false');
    });

    // Drag functionality
    makePanelDraggable(panel);

    // Search functionality
    document.getElementById('dh-search-btn').addEventListener('click', searchRecords);
    document.getElementById('dh-search').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        searchRecords();
      }
    });

    // Initialize connection status
    updateConnectionStatus();
  }

  // Global variable to store taxonomy data
  let taxonomyOptions = [];

  // Load taxonomy data from API
  async function loadTaxonomyData() {
    const taxonomySelect = document.getElementById('dh-taxonomy');
    
    const result = await api.getTaxonomy();
    
    if (result.success) {
      taxonomyOptions = result.data;
      renderTaxonomyOptions(taxonomyOptions);
    } else {
      taxonomySelect.innerHTML = '<option value="">Chyba načítání taxonomie</option>';
      showMessage('❌ Chyba načítání taxonomie: ' + result.error, 'error');
    }
  }

  // Render taxonomy options in select
  function renderTaxonomyOptions(options) {
    const taxonomySelect = document.getElementById('dh-taxonomy');
    
    taxonomySelect.innerHTML = '<option value="">Vyberte taxonomii...</option>';
    
    options.forEach(option => {
      const optionElement = document.createElement('option');
      optionElement.value = option.value;
      optionElement.textContent = option.label;
      optionElement.style.paddingLeft = `${option.level * 20}px`;
      
      if (option.level === 0) {
        optionElement.style.fontWeight = 'bold';
        optionElement.style.backgroundColor = '#f8f9fa';
      } else if (option.level === 1) {
        optionElement.style.fontStyle = 'italic';
      }
      
      taxonomySelect.appendChild(optionElement);
    });
  }

  // Filter taxonomy options based on search
  function filterTaxonomyOptions(searchQuery) {
    if (!searchQuery.trim()) {
      renderTaxonomyOptions(taxonomyOptions);
      return;
    }
    
    const filteredOptions = taxonomyOptions.filter(option =>
      option.label.toLowerCase().includes(searchQuery.toLowerCase())
    );
    
    renderTaxonomyOptions(filteredOptions);
  }

  // Get icon based on taxonomy ID
  function getTaxonomyIcon(taxonomyId) {
    if (!taxonomyId) return '📎';
    
    // Map taxonomy categories to icons
    if (taxonomyId.startsWith('01')) return '🔬'; // Natural Sciences
    if (taxonomyId.startsWith('02.01')) return '📊'; // Mathematics
    if (taxonomyId.startsWith('02.02')) return '💻'; // Computer Science
    if (taxonomyId.startsWith('03')) return '🧠'; // Applied Sciences
    if (taxonomyId.startsWith('04')) return '🏛️'; // Social Sciences
    if (taxonomyId.startsWith('05')) return '📚'; // Humanities
    if (taxonomyId.startsWith('06')) return '🎨'; // Arts
    
    return '📎'; // Default
  }

  // Update connection status
  async function updateConnectionStatus(forceStatus = null) {
    const indicator = document.getElementById('dh-status-indicator');
    const text = document.getElementById('dh-status-text');
    
    if (forceStatus !== null) {
      indicator.textContent = forceStatus ? '🟢' : '🔴';
      text.textContent = forceStatus ? 'Online' : 'Offline';
      return;
    }
    
    // Show loading state
    indicator.textContent = '🟡';
    text.textContent = 'Testování...';
    
    const result = await api.healthCheck();
    
    if (result.success) {
      indicator.textContent = '🟢';
      text.textContent = 'Online';
    } else {
      indicator.textContent = '🔴';
      text.textContent = 'Offline';
      console.log('Connection test failed:', result.error);
    }
  }

  // Load API stats
  async function loadApiStats() {
    const statsContainer = document.getElementById('dh-api-stats');
    statsContainer.innerHTML = '<div class="dh-loading">Načítám statistiky...</div>';
    
    const result = await api.getStats();
    
    if (result.success) {
      const stats = result.data;
      statsContainer.innerHTML = `
        <div class="dh-stats">
          <div class="dh-stat">
            <div class="dh-stat-label">Celkem metadat</div>
            <div class="dh-stat-value">${stats.totalMetadata}</div>
          </div>
          <div class="dh-stat">
            <div class="dh-stat-label">Domény</div>
            <div class="dh-stat-value">${stats.domains.length}</div>
          </div>
          <div class="dh-stat">
            <div class="dh-stat-label">Poslední aktualizace</div>
            <div class="dh-stat-value">${new Date(stats.lastUpdate).toLocaleString()}</div>
          </div>
        </div>
        <div class="dh-domains">
          <div class="dh-domains-title">Top domény:</div>
          ${stats.domains.slice(0, 5).map(domain => `
            <div class="dh-domain">${domain}</div>
          `).join('')}
        </div>
      `;
    } else {
      statsContainer.innerHTML = `<div class="dh-error">Chyba načítání: ${result.error}</div>`;
    }
  }

  // Load domain records
  async function loadDomainRecords() {
    const recordsList = document.getElementById('dh-records-list');
    const currentDomain = window.location.hostname;
    
    recordsList.innerHTML = '<div class="dh-loading">Načítám záznamy...</div>';
    
    // Try API first
    const result = await api.getMetadataByDomain(currentDomain);
    
    if (result.success && result.data.length > 0) {
      recordsList.innerHTML = result.data.map(record => `
        <div class="dh-record">
          <div class="dh-record-title">${record.name}</div>
          <div class="dh-record-description">${record.description}</div>
          <div class="dh-record-meta">
            <span class="dh-record-category">${record.links.category || 'unknown'}</span>
            <span class="dh-record-priority priority-${record.links.priority || 'medium'}">${record.links.priority || 'medium'}</span>
            <span class="dh-record-date">${new Date(record.links.savedAt).toLocaleDateString()}</span>
          </div>
          <div class="dh-record-tags">
            ${(record.links.tags || []).map(tag => `<span class="dh-tag">${tag}</span>`).join('')}
          </div>
        </div>
      `).join('');
    } else {
      recordsList.innerHTML = '<div class="dh-no-records">Žádné záznamy pro tuto doménu</div>';
    }
  }

  // Search records
  async function searchRecords() {
    const query = document.getElementById('dh-search').value.toLowerCase();
    const recordsList = document.getElementById('dh-records-list');
    
    if (!query.trim()) {
      loadDomainRecords();
      return;
    }
    
    recordsList.innerHTML = '<div class="dh-loading">Vyhledávám...</div>';
    
    // Try API search first
    const result = await api.searchMetadata(query);
    
    if (result.success) {
      if (result.data.length === 0) {
        recordsList.innerHTML = '<div class="dh-no-records">Žádné výsledky pro hledání</div>';
        return;
      }
      
      recordsList.innerHTML = result.data.map(record => `
        <div class="dh-record">
          <div class="dh-record-title">${record.name}</div>
          <div class="dh-record-description">${record.description}</div>
          <div class="dh-record-meta">
            <span class="dh-record-domain">${record.links.domain || 'unknown'}</span>
            <span class="dh-record-category">${record.links.category || 'unknown'}</span>
            <span class="dh-record-priority priority-${record.links.priority || 'medium'}">${record.links.priority || 'medium'}</span>
            <span class="dh-record-date">${new Date(record.links.savedAt).toLocaleDateString()}</span>
          </div>
          <div class="dh-record-tags">
            ${(record.links.tags || []).map(tag => `<span class="dh-tag">${tag}</span>`).join('')}
          </div>
        </div>
      `).join('');
    } else {
      recordsList.innerHTML = '<div class="dh-no-records">Chyba vyhledávání</div>';
    }
  }

  // Get category icon
  function getCategoryIcon(category) {
    const icons = {
      article: '📄',
      video: '🎥',
      tool: '🔧',
      documentation: '📚',
      other: '📎'
    };
    return icons[category] || icons.other;
  }

  // Utility functions
  function getPageDescription() {
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) return metaDesc.getAttribute('content');
    
    const firstP = document.querySelector('p');
    if (firstP) return firstP.textContent.substring(0, 200);
    
    return '';
  }

  function makePanelDraggable(panel) {
    let isDragging = false;
    let dragOffset = { x: 0, y: 0 };

    const header = panel.querySelector('.dh-header');
    
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
  }

  function showMessage(text, type = 'info') {
    const message = document.createElement('div');
    message.className = `dh-message ${type}`;
    message.textContent = text;
    document.body.appendChild(message);

    setTimeout(() => {
      message.remove();
    }, 3000);
  }

  /* Improved Styles with API status */
  const styles = `
    #data-hoarding-companion {
      position: fixed;
      top: 20px;
      right: 20px;
      width: 350px;
      max-height: 80vh;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
      font-size: 14px;
      z-index: 999999;
      user-select: none;
    }

    .dh-panel {
      background: linear-gradient(145deg, #ffffff, #f8f9fa);
      border: 1px solid #e1e5e9;
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
      overflow: hidden;
      backdrop-filter: blur(10px);
    }

    .dh-header {
      background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 12px 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: move;
    }

    .dh-title {
      display: flex;
      align-items: center;
      font-weight: 600;
      font-size: 16px;
    }

    .dh-icon {
      margin-right: 8px;
      font-size: 18px;
    }

    .dh-status {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 12px;
      background: rgba(255, 255, 255, 0.1);
      padding: 4px 8px;
      border-radius: 12px;
    }

    .dh-status-indicator {
      font-size: 8px;
    }

    .dh-controls {
      display: flex;
      gap: 4px;
    }

    .dh-btn {
      background: rgba(255, 255, 255, 0.2);
      border: none;
      color: white;
      width: 24px;
      height: 24px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      font-weight: bold;
      transition: background 0.2s;
    }

    .dh-btn:hover {
      background: rgba(255, 255, 255, 0.3);
    }

    .dh-content {
      padding: 16px;
      max-height: 500px;
      overflow-y: auto;
    }

    .dh-tabs {
      display: flex;
      margin-bottom: 16px;
      background: #f1f3f4;
      border-radius: 8px;
      padding: 4px;
    }

    .dh-tab {
      flex: 1;
      padding: 8px 12px;
      background: transparent;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      transition: all 0.2s;
      color: #5f6368;
    }

    .dh-tab.active {
      background: white;
      color: #1a73e8;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    }

    .dh-form-group {
      margin-bottom: 12px;
    }

    .dh-form-group label {
      display: block;
      margin-bottom: 4px;
      font-weight: 500;
      color: #3c4043;
      font-size: 13px;
    }

    .dh-form-group input,
    .dh-form-group textarea,
    .dh-form-group select {
      width: 100%;
      padding: 8px 12px;
      border: 1px solid #dadce0;
      border-radius: 6px;
      font-size: 14px;
      transition: border-color 0.2s;
      box-sizing: border-box;
    }

    .dh-form-group input:focus,
    .dh-form-group textarea:focus,
    .dh-form-group select:focus {
      outline: none;
      border-color: #1a73e8;
      box-shadow: 0 0 0 2px rgba(26, 115, 232, 0.1);
    }

    .dh-btn-primary {
      background: linear-gradient(135deg, #1a73e8, #4285f4);
      color: white;
      border: none;
      padding: 10px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 500;
      width: 100%;
      transition: all 0.2s;
    }

    .dh-btn-primary:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(26, 115, 232, 0.3);
    }

    .dh-search {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
    }

    .dh-search input {
      flex: 1;
    }

    .dh-search button {
      padding: 8px 12px;
      background: #f8f9fa;
      border: 1px solid #dadce0;
      border-radius: 6px;
      cursor: pointer;
    }

    .dh-records {
      max-height: 300px;
      overflow-y: auto;
    }

    .dh-record {
      background: #f8f9fa;
      border: 1px solid #e8eaed;
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 8px;
      transition: all 0.2s;
    }

    .dh-record:hover {
      background: #f1f3f4;
      border-color: #1a73e8;
    }

    .dh-record-title {
      font-weight: 600;
      color: #1a73e8;
      margin-bottom: 4px;
    }

    .dh-record-description {
      color: #5f6368;
      font-size: 13px;
      margin-bottom: 8px;
    }

    .dh-record-meta {
      display: flex;
      gap: 8px;
      margin-bottom: 8px;
      font-size: 12px;
    }

    .dh-record-category,
    .dh-record-priority,
    .dh-record-date,
    .dh-record-domain {
      background: #e8f0fe;
      color: #1a73e8;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 11px;
    }

    .priority-high {
      background: #fce8e6 !important;
      color: #d93025 !important;
    }

    .priority-medium {
      background: #fef7e0 !important;
      color: #f29900 !important;
    }

    .priority-low {
      background: #e6f4ea !important;
      color: #137333 !important;
    }

    .dh-record-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }

    .dh-tag {
      background: #f1f3f4;
      color: #3c4043;
      padding: 2px 6px;
      border-radius: 8px;
      font-size: 11px;
    }

    .dh-loading,
    .dh-no-records,
    .dh-error {
      text-align: center;
      color: #5f6368;
      font-style: italic;
      padding: 20px;
    }

    .dh-error {
      color: #d93025;
    }

    .dh-stats {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-bottom: 12px;
    }

    .dh-stat {
      background: #f8f9fa;
      padding: 8px;
      border-radius: 6px;
      text-align: center;
    }

    .dh-stat-label {
      font-size: 11px;
      color: #5f6368;
      margin-bottom: 2px;
    }

    .dh-stat-value {
      font-weight: 600;
      color: #1a73e8;
    }

    .dh-domains {
      background: #f8f9fa;
      padding: 8px;
      border-radius: 6px;
    }

    .dh-domains-title {
      font-size: 12px;
      font-weight: 500;
      margin-bottom: 4px;
      color: #3c4043;
    }

    .dh-domain {
      font-size: 11px;
      color: #5f6368;
      padding: 2px 0;
    }

    .dh-message {
      position: fixed;
      top: 50px;
      right: 20px;
      padding: 12px 16px;
      border-radius: 8px;
      color: white;
      font-weight: 500;
      z-index: 1000000;
      animation: dh-slideIn 0.3s ease;
    }

    .dh-message.success {
      background: #137333;
    }

    .dh-message.error {
      background: #d93025;
    }

    .dh-message.warning {
      background: #f29900;
    }

    @keyframes dh-slideIn {
      from {
        transform: translateX(100%);
        opacity: 0;
      }
      to {
        transform: translateX(0);
        opacity: 1;
      }
    }

    #data-hoarding-companion.minimized .dh-content {
      display: none;
    }

    #data-hoarding-companion.minimized {
      width: auto;
    }

    .dh-taxonomy-container {
      position: relative;
    }

    .dh-taxonomy-search {
      margin-top: 8px;
    }

    .dh-taxonomy-search input {
      width: 100%;
      padding: 6px 10px;
      border: 1px solid #dadce0;
      border-radius: 4px;
      font-size: 12px;
      background: #f8f9fa;
    }

    #dh-taxonomy {
      max-height: 200px;
      overflow-y: auto;
    }

    #dh-taxonomy option {
      padding: 4px 8px;
    }

    #dh-taxonomy option[style*="level"] {
      font-family: monospace;
    }

    .dh-browse-header {
      margin-bottom: 12px;
    }

    .dh-stats {
      margin-bottom: 8px;
    }

    .dh-stats-text {
      font-size: 12px;
      color: #666;
      background: #f8f9fa;
      padding: 4px 8px;
      border-radius: 4px;
      display: inline-block;
    }

    .dh-record-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
    }

    .dh-record-icon {
      font-size: 16px;
    }

    .dh-taxonomy-badge {
      background: #e3f2fd;
      color: #1976d2;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 10px;
      font-family: monospace;
    }

    .dh-record-link {
      color: #1976d2;
      text-decoration: none;
    }

    .dh-record-link:hover {
      color: #0d47a1;
    }

    /* Button group styles */
    .dh-button-group {
      display: flex;
      gap: 8px;
    }

    .dh-button-group .dh-btn {
      flex: 1;
      background: #f8f9fa;
      color: #3c4043;
      border: 1px solid #dadce0;
      padding: 10px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 500;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      min-height: 40px;
    }

    .dh-btn-save {
      background: linear-gradient(135deg, #1a73e8, #4285f4) !important;
      color: white !important;
      border-color: #1a73e8 !important;
    }

    .dh-btn-save:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(26, 115, 232, 0.3);
    }

    .dh-btn-test:hover {
      background: #e8f0fe;
      border-color: #1a73e8;
      color: #1a73e8;
    }

    .dh-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none !important;
      box-shadow: none !important;
    }

    .dh-spinner {
      font-size: 14px;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  `;

  // Apply styles
  const styleSheet = document.createElement('style');
  styleSheet.textContent = styles;
  document.head.appendChild(styleSheet);

  // Initialize the panel
  const panel = createCompanionPanel();
  initializeCompanion();

  console.log('📚 Data Hoarding Companion loaded with API support!');

})();