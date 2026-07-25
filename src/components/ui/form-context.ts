import * as React from "react"
import { FieldPath, FieldValues, useFormContext } from "react-hook-form"

// The form contexts and the hook that reads them live here, not in form.tsx:
// react-hooks/only-export-components (react-refresh) requires a component file
// to export ONLY components, and a hook is not a component — exporting
// useFormField from form.tsx costs that file its Fast Refresh. Splitting the
// contexts out with it keeps provider and consumer defined in one place.
// This module imports nothing from form.tsx, so there is no cycle.

export type FormFieldContextValue<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>
> = {
  name: TName
}

export const FormFieldContext = React.createContext<FormFieldContextValue>(
  {} as FormFieldContextValue
)

export type FormItemContextValue = {
  id: string
}

export const FormItemContext = React.createContext<FormItemContextValue>(
  {} as FormItemContextValue
)

export const useFormField = () => {
  const fieldContext = React.useContext(FormFieldContext)
  const itemContext = React.useContext(FormItemContext)
  const { getFieldState, formState } = useFormContext()

  const fieldState = getFieldState(fieldContext.name, formState)

  if (!fieldContext) {
    throw new Error("useFormField should be used within <FormField>")
  }

  const { id } = itemContext

  return {
    id,
    name: fieldContext.name,
    formItemId: `${id}-form-item`,
    formDescriptionId: `${id}-form-item-description`,
    formMessageId: `${id}-form-item-message`,
    ...fieldState,
  }
}
