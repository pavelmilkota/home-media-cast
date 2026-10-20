import { Label, ListBox, Select } from '@heroui/react';

export interface PickOption {
  id: string;
  name: string;
}

/** A HeroUI Select over a flat list. Pass `label` for a visible label, `ariaLabel` for a hidden one. */
export function PickSelect({
  label,
  ariaLabel,
  options,
  value,
  onChange,
  isDisabled,
  className,
}: {
  label?: string;
  ariaLabel?: string;
  options: PickOption[];
  value: string;
  onChange: (id: string) => void;
  isDisabled?: boolean;
  className?: string;
}) {
  return (
    <Select
      className={className}
      isDisabled={isDisabled}
      selectedKey={value}
      onSelectionChange={(key) => key !== null && onChange(String(key))}
      {...(label ? {} : { 'aria-label': ariaLabel ?? '' })}
    >
      {label && <Label>{label}</Label>}
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {options.map((o) => (
            <ListBox.Item key={o.id} id={o.id} textValue={o.name}>
              {o.name}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
