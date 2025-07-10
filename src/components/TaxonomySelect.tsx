import React from 'react';
import Select from 'react-select';
import { taxonomyData } from '@/game/data/taxonomy';

interface TaxonomyOption {
  value: string;
  label: string;
  level: number;
}

interface TaxonomySelectProps {
  value?: string;
  onChange: (value: string | null) => void;
  placeholder?: string;
}

export const TaxonomySelect: React.FC<TaxonomySelectProps> = ({
  value,
  onChange,
  placeholder = 'Vyberte položku taxonomie...'
}) => {
  // Generate hierarchical options with proper IDs
  const generateOptions = (): TaxonomyOption[] => {
    const options: TaxonomyOption[] = [];
    let categoryIndex = 1;

    Object.entries(taxonomyData).forEach(([categoryKey, category]) => {
      const categoryId = String(categoryIndex).padStart(2, '0');
      
      options.push({
        value: categoryId,
        label: `${categoryId} - ${category.name}`,
        level: 0
      });

      let subcategoryIndex = 1;
      Object.entries(category.subcategories).forEach(([subcatKey, subcat]) => {
        const subcatId = `${categoryId}.${String(subcategoryIndex).padStart(2, '0')}`;
        
        options.push({
          value: subcatId,
          label: `${subcatId} - ${subcat.name}`,
          level: 1
        });

        if (subcat.subcategories) {
          let subSubcategoryIndex = 1;
          Object.entries(subcat.subcategories).forEach(([subSubcatKey, subSubcat]) => {
            const subSubcatId = `${subcatId}.${String(subSubcategoryIndex).padStart(2, '0')}`;
            
            options.push({
              value: subSubcatId,
              label: `${subSubcatId} - ${subSubcat.name}`,
              level: 2
            });

            if (subSubcat.items) {
              let itemIndex = 1;
              subSubcat.items.forEach((item) => {
                const itemId = `${subSubcatId}.${String(itemIndex).padStart(2, '0')}`;
                
                options.push({
                  value: itemId,
                  label: `${itemId} - ${item.name}`,
                  level: 3
                });
                
                itemIndex++;
              });
            }

            subSubcategoryIndex++;
          });
        }

        subcategoryIndex++;
      });

      categoryIndex++;
    });

    return options;
  };

  const options = generateOptions();
  const selectedOption = options.find(opt => opt.value === value);

  const customStyles = {
    option: (provided: any, state: any) => ({
      ...provided,
      paddingLeft: `${(state.data.level * 20) + 12}px`,
      fontSize: state.data.level > 0 ? '14px' : '16px',
      fontWeight: state.data.level === 0 ? 'bold' : 'normal',
      backgroundColor: state.isSelected 
        ? 'hsl(var(--primary))' 
        : state.isFocused 
        ? 'hsl(var(--muted))' 
        : 'hsl(var(--background))',
      color: state.isSelected 
        ? 'hsl(var(--primary-foreground))' 
        : 'hsl(var(--foreground))',
      borderBottom: state.data.level === 0 ? '1px solid hsl(var(--border))' : 'none',
    }),
    control: (provided: any) => ({
      ...provided,
      backgroundColor: 'hsl(var(--background))',
      borderColor: 'hsl(var(--border))',
      '&:hover': {
        borderColor: 'hsl(var(--border))'
      }
    }),
    menu: (provided: any) => ({
      ...provided,
      backgroundColor: 'hsl(var(--background))',
      border: '1px solid hsl(var(--border))',
      zIndex: 50
    }),
    singleValue: (provided: any) => ({
      ...provided,
      color: 'hsl(var(--foreground))'
    }),
    placeholder: (provided: any) => ({
      ...provided,
      color: 'hsl(var(--muted-foreground))'
    }),
    input: (provided: any) => ({
      ...provided,
      color: 'hsl(var(--foreground))'
    })
  };

  return (
    <Select
      value={selectedOption || null}
      onChange={(option) => onChange(option?.value || null)}
      options={options}
      placeholder={placeholder}
      isClearable
      isSearchable
      styles={customStyles}
      filterOption={(option, inputValue) => {
        return option.label.toLowerCase().includes(inputValue.toLowerCase());
      }}
      formatOptionLabel={(option: TaxonomyOption) => (
        <div className="flex items-center">
          <span style={{ 
            marginLeft: `${option.level * 16}px`,
            fontSize: option.level > 0 ? '14px' : '16px',
            fontWeight: option.level === 0 ? 'bold' : 'normal'
          }}>
            {option.level > 0 && '└ '}
            {option.label}
          </span>
        </div>
      )}
    />
  );
};