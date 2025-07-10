# KEAP - Knowledge Explorer and Preserver

**A gamified knowledge management interface for Internet-in-a-Box (IIAB) ecosystem**

KEAP provides an intuitive, game-like interface for exploring, organizing, and preserving knowledge stored in IIAB installations. Part of the TaxonomyCollection project, KEAP transforms data hoarding into an engaging quest-like experience.

## 🎯 Project Overview

KEAP serves as a knowledge hub that:
- **Gamifies data exploration** through quest lines and achievement systems
- **Connects IIAB data pieces** with structured taxonomy nodes
- **Enables offline knowledge management** with local data linking
- **Provides visual progress tracking** for learning and data collection goals
- **Facilitates community knowledge sharing** through exportable progress data

### TaxonomyCollection Ecosystem

KEAP is the primary interface for the TaxonomyCollection project, which aims to:
1. Create comprehensive all-taxonomy categorization (max 5 levels initially)
2. Enable sub-taxonomies that branch from existing nodes
3. Connect disparate knowledge sources through unified taxonomy
4. Build community-driven knowledge preservation network

## 🏗️ Architecture

### Technology Stack
- **Frontend**: React 18 + TypeScript + Vite
- **Styling**: Tailwind CSS + shadcn/ui components
- **Database**: better-sqlite3 (server-side SQLite)
- **Routing**: React Router
- **API**: Custom Vite middleware with REST endpoints
- **Build System**: Vite with static output + backend server

### Data Structure
```typescript
interface TaxonomyNode {
  id: string;
  name: string;
  type: 'island' | 'city' | 'building';
  taxonomyId: string;
  position: { x: number; y: number };
  unlocked: boolean;
  completed: boolean;
  children?: TaxonomyNode[];
  items?: TaxonomyItem[];
}

interface TaxonomyItem {
  id: string;
  name: string;
  description?: string;
  completed?: boolean;
  questType?: 'download' | 'read' | 'exercise' | 'explore';
  requiredData?: string; // IIAB module reference
  iiabObtained?: boolean; // Auto-checked if IIAB data available
}
```

## 🚀 Local Development

### Prerequisites
- Node.js 18+ and npm
- Modern web browser with WASM support

### Installation
```bash
# Clone the repository
git clone <repository-url>
cd keap

# Install dependencies
npm install

# Start development server
npm run dev
```

The application will be available at `http://localhost:42069`

### Development Scripts
```bash
npm run dev          # Start development server
npm run build        # Build for production
npm run preview      # Preview production build
npm run lint         # Run ESLint
npm run type-check   # Run TypeScript checks
```

## 📦 Production Build & Deployment

### Building for Production
```bash
npm run build
```

This creates a `dist/` directory with static files ready for deployment.

### Static File Structure
```
dist/
├── index.html
├── assets/
│   ├── index-[hash].js
│   ├── index-[hash].css
│   └── [other-assets]
└── [other-static-files]
```

## 🌐 IIAB Integration

### Overview
KEAP integrates with Internet-in-a-Box as a static web application that provides a modern interface for exploring IIAB's offline knowledge repositories.

### Installation Steps

#### 1. Copy Built Application
```bash
# After building KEAP
sudo cp -r dist/* /var/www/html/keap/
sudo chown -R www-data:www-data /var/www/html/keap/
```

#### 2. Apache Configuration
Create `/etc/apache2/sites-available/keap.conf`:
```apache
<VirtualHost *:80>
    DocumentRoot /var/www/html
    
    # KEAP application
    Alias /keap /var/www/html/keap
    <Directory "/var/www/html/keap">
        Options Indexes FollowSymLinks
        AllowOverride All
        Require all granted
        
        # Enable WASM support
        AddType application/wasm .wasm
        
        # Single Page Application routing
        RewriteEngine On
        RewriteBase /keap/
        RewriteRule ^index\.html$ - [L]
        RewriteCond %{REQUEST_FILENAME} !-f
        RewriteCond %{REQUEST_FILENAME} !-d
        RewriteRule . /keap/index.html [L]
    </Directory>
</VirtualHost>
```

Enable the site:
```bash
sudo a2ensite keap
sudo a2enmod rewrite
sudo systemctl reload apache2
```

#### 3. IIAB Menu Integration
Add KEAP to IIAB's main menu by editing `/opt/iiab/iiab/vars/local_vars.yml`:
```yaml
# Add to enabled services
keap_enabled: true

# Add to menu configuration
iiab_menu_list:
  - keap
```

Create menu entry in `/etc/iiab/menu-files/menu-defs/en-keap.json`:
```json
{
  "keap": {
    "title": "Knowledge Explorer",
    "description": "Gamified interface for exploring and organizing IIAB knowledge",
    "start_url": "/keap",
    "extra_description": "Interactive quest-based learning and data organization tool"
  }
}
```

### IIAB Data Integration

#### Linking IIAB Modules
KEAP can reference IIAB content through:

1. **Kiwix Collections** - Link taxonomy items to specific Wikipedia/educational content
2. **Local Repositories** - Connect to git-based educational materials
3. **Media Collections** - Reference video, audio, and document libraries

#### Example Integration Script
```javascript
// Browser script for capturing IIAB pages
function captureIIABPage() {
  const pageData = {
    url: window.location.href,
    title: document.title,
    content: document.querySelector('main').innerHTML,
    module: detectIIABModule(),
    timestamp: new Date().toISOString()
  };
  
  // Send to KEAP for taxonomy mapping
  fetch('/keap/api/capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pageData)
  });
}
```

## 🎮 Gamification Features

### Quest System
- **Linear Quest Lines**: Guide users through systematic data exploration
- **Achievement Tracking**: Unlock badges for completing taxonomy branches
- **Progress Visualization**: Galaxy map showing exploration progress
- **Collaborative Goals**: Community challenges for knowledge preservation

### Data Hoarding Gamification
1. **Discovery Quests**: Find and download specific IIAB modules
2. **Organization Challenges**: Properly categorize and tag content
3. **Knowledge Verification**: Cross-reference and validate information
4. **Community Contribution**: Share taxonomies and progress data

## 📊 Data Management

### Local Storage
- Server-side SQLite database stores all user progress and metadata
- Local API endpoints provide real-time data access
- Export capabilities for progress sharing and backup

### Taxonomy Structure
```
src/game/data/
├── taxonomy/
│   ├── all-taxonomy.ts          # Main 5-level taxonomy
│   ├── sub-taxonomies/
│   │   ├── science-deep.ts      # Deep science taxonomy
│   │   ├── history-detailed.ts  # Detailed history taxonomy
│   │   └── ...
│   └── modules/
│       ├── kiwix-mappings.ts    # Kiwix content mappings
│       ├── repo-connections.ts  # Repository linkages
│       └── ...
```

### Data Export/Import
```typescript
// Export user progress for community sharing
interface ProgressExport {
  userId: string;
  completedNodes: string[];
  achievements: Achievement[];
  customNotes: UserNote[];
  timestamp: string;
}

// Import community taxonomies
interface TaxonomyImport {
  name: string;
  version: string;
  rootNode: string;
  structure: TaxonomyNode[];
  mappings: IIABMapping[];
}
```

## 🔧 Configuration

### Environment Setup
Configuration handled through:
- `src/config/port.ts` - Server port configuration (42069)
- `src/game/config/featureFlags.ts` - Feature toggles  
- `src/game/data/taxonomy.ts` - Taxonomy structure
- `src/services/database.ts` - Database schema and API layer

### IIAB-Specific Configuration
```typescript
// src/config/iiab.ts
export const iiabConfig = {
  baseUrl: window.location.origin,
  modules: {
    kiwix: '/kiwix',
    kolibri: '/kolibri',
    sugarizer: '/sugarizer'
  },
  dataCapture: {
    enabled: true,
    endpoint: '/keap/api/capture'
  }
};
```

## 🤝 Community Integration

### TaxonomyCollection Forum
- Community-driven taxonomy development
- IIAB module recommendations
- Progress sharing and challenges
- Knowledge verification crowdsourcing

### Data Sharing Protocol
1. **Trust-based system** for progress validation
2. **Exportable progress data** for online leaderboards
3. **Community taxonomy contributions**
4. **Offline-first design** with optional online sync

## 🔮 Future Roadmap

### Phase 1 (Current)
- ✅ Basic gamified interface
- ✅ Server-side database with API
- ✅ Real-time data management
- ✅ Backend-first architecture

### Phase 2
- 📱 Mobile-responsive interface
- 🌐 Community taxonomy sharing
- 📊 Advanced progress analytics
- 🔗 Enhanced IIAB module integration

### Phase 3
- 🎯 Advanced quest systems
- 👥 Multi-user installations
- 🌍 Global knowledge preservation network
- 🤖 AI-assisted taxonomy generation

## 📄 License

[License information to be added]

## 🤝 Contributing

KEAP is part of the broader TaxonomyCollection initiative. Contributions welcome for:
- Taxonomy structure improvements
- IIAB integration enhancements
- Gamification features
- Community tools development

## 📞 Support

For IIAB integration support and TaxonomyCollection questions:
- [Community Forum Link]
- [Documentation Wiki]
- [Issue Tracker]

---

**KEAP transforms knowledge preservation from a chore into an adventure. Join the quest to democratize access to human knowledge.**