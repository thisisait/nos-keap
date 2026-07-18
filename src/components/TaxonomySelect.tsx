import React from 'react';
import Select, { type StylesConfig } from 'react-select';
import { taxonomyData } from '@/game/data/taxonomy';
import type { TaxonomySubcategory } from '@/game/types/taxonomy';

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
  placeholder = 'Select a taxonomy item…'
}) => {
  // Hierarchical options read the REAL node ids from the dataset — the old
  // version re-derived ids from array indexes, which silently diverged from
  // the canonical ids the rest of the app (and the agent API) use.
  const generateOptions = (): TaxonomyOption[] => {
    const options: TaxonomyOption[] = [];

    const walk = (node: TaxonomySubcategory, level: number) => {
      options.push({ value: node.id, label: `${node.id} - ${node.name}`, level });
      Object.values(node.subcategories ?? {}).forEach((child) => walk(child, level + 1));
      (node.items ?? []).forEach((item) =>
        options.push({ value: item.id, label: `${item.id} - ${item.name}`, level: level + 1 }),
      );
    };

    Object.values(taxonomyData).forEach((category) => walk(category, 0));
    return options;
  };

  const options = generateOptions();
  const selectedOption = options.find(opt => opt.value === value);

  const customStyles: StylesConfig<TaxonomyOption, false> = {
    option: (provided, state) => ({
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
    control: (provided) => ({
      ...provided,
      backgroundColor: 'hsl(var(--background))',
      borderColor: 'hsl(var(--border))',
      '&:hover': {
        borderColor: 'hsl(var(--border))'
      }
    }),
    menu: (provided) => ({
      ...provided,
      backgroundColor: 'hsl(var(--background))',
      border: '1px solid hsl(var(--border))',
      zIndex: 50
    }),
    singleValue: (provided) => ({
      ...provided,
      color: 'hsl(var(--foreground))'
    }),
    placeholder: (provided) => ({
      ...provided,
      color: 'hsl(var(--muted-foreground))'
    }),
    input: (provided) => ({
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