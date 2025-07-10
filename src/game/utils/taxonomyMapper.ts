import { TaxonomyData, GameNode, GameLevel } from '../types/taxonomy';
import { taxonomyData } from '../data/taxonomy';
import { isUnlockAllEnabled } from '../config/featureFlags';

export class TaxonomyMapper {
  static mapToGameNodes(taxonomy: TaxonomyData): GameNode[] {
    const islands: GameNode[] = [];
    
    Object.entries(taxonomy).forEach(([key, category], index) => {
      const island: GameNode = {
        id: category.id,
        name: category.name,
        type: 'island' as GameLevel,
        taxonomyId: category.id,
        position: this.getIslandPosition(index),
        unlocked: isUnlockAllEnabled() || index === 0, // Use feature flag or first island unlocked by default
        completed: false,
        children: this.mapSubcategoriesToCities(category.subcategories, category.id)
      };
      islands.push(island);
    });
    
    return islands;
  }
  
  private static getIslandPosition(index: number): { x: number; y: number } {
    // Arrange islands in a rough circle
    const angle = (index * 2 * Math.PI) / 6; // Assuming max 6 main categories
    const radius = 300;
    return {
      x: Math.cos(angle) * radius + 400, // Center offset
      y: Math.sin(angle) * radius + 300
    };
  }
  
  private static mapSubcategoriesToCities(subcategories: any, parentId: string): GameNode[] {
    const cities: GameNode[] = [];
    
    Object.entries(subcategories).forEach(([key, subcat]: [string, any], index) => {
      const city: GameNode = {
        id: subcat.id,
        name: subcat.name,
        type: 'city' as GameLevel,
        taxonomyId: subcat.id,
        position: this.getCityPosition(index),
        unlocked: isUnlockAllEnabled(), // Use feature flag
        completed: false,
        children: subcat.subcategories ? 
          this.mapSubcategoriesToBuildings(subcat.subcategories, subcat.id) : []
      };
      cities.push(city);
    });
    
    return cities;
  }
  
  private static getCityPosition(index: number): { x: number; y: number } {
    // Arrange cities in a grid
    const cols = 3;
    const spacing = 150;
    return {
      x: (index % cols) * spacing + 100,
      y: Math.floor(index / cols) * spacing + 100
    };
  }
  
  private static mapSubcategoriesToBuildings(subcategories: any, parentId: string): GameNode[] {
    const buildings: GameNode[] = [];
    
    Object.entries(subcategories).forEach(([key, subcat]: [string, any], index) => {
      const building: GameNode = {
        id: subcat.id,
        name: subcat.name,
        type: 'building' as GameLevel,
        taxonomyId: subcat.id,
        position: this.getBuildingPosition(index),
        unlocked: isUnlockAllEnabled(), // Use feature flag
        completed: false,
        items: subcat.items || [] // Map items from taxonomy to building
      };
      buildings.push(building);
    });
    
    return buildings;
  }
  
  private static getBuildingPosition(index: number): { x: number; y: number } {
    // Arrange buildings in a smaller grid
    const cols = 2;
    const spacing = 120;
    return {
      x: (index % cols) * spacing + 50,
      y: Math.floor(index / cols) * spacing + 50
    };
  }
}

export const gameMap = TaxonomyMapper.mapToGameNodes(taxonomyData);
