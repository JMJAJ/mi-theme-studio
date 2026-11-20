import { create } from 'zustand';

export interface CustomPreviewVariable {
  id: string;
  name: string;
  value: string;
}

export interface PreviewGlobalsState {
  /** Minutes after midnight, or null to follow the computer's clock. */
  timeMinutes: number | null;
  variables: Record<string, number>;
  customVariables: CustomPreviewVariable[];
  setTimeMinutes: (minutes: number | null) => void;
  setVariable: (name: string, value: number) => void;
  addCustomVariable: () => void;
  updateCustomVariable: (id: string, field: 'name' | 'value', value: string) => void;
  removeCustomVariable: (id: string) => void;
  reset: () => void;
}

const DEFAULT_VARIABLES = {
  battery_level: 82,
  battery_state: 0,
  music_state: 0,
  sms_unread_count: 0,
  call_missed_count: 0,
};

export const usePreviewGlobals = create<PreviewGlobalsState>((set) => ({
  timeMinutes: null,
  variables: { ...DEFAULT_VARIABLES },
  customVariables: [],
  setTimeMinutes: (timeMinutes) => set({ timeMinutes }),
  setVariable: (name, value) => set((state) => ({ variables: { ...state.variables, [name]: value } })),
  addCustomVariable: () =>
    set((state) => ({
      customVariables: [
        ...state.customVariables,
        { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, name: `custom_${state.customVariables.length + 1}`, value: '0' },
      ],
    })),
  updateCustomVariable: (id, field, value) =>
    set((state) => ({ customVariables: state.customVariables.map((variable) => (variable.id === id ? { ...variable, [field]: value } : variable)) })),
  removeCustomVariable: (id) => set((state) => ({ customVariables: state.customVariables.filter((variable) => variable.id !== id) })),
  reset: () => set({ timeMinutes: null, variables: { ...DEFAULT_VARIABLES }, customVariables: [] }),
}));

/** Apply a preview clock slider value to the current date. */
export function previewDate(now: Date, timeMinutes: number | null) {
  if (timeMinutes === null) return now;
  const date = new Date(now);
  date.setHours(Math.floor(timeMinutes / 60), timeMinutes % 60, 0, 0);
  return date;
}

/** Values supplied by MAML that can be changed in the Globals panel. */
export function previewVariableOverrides(variables: Record<string, number>, custom: CustomPreviewVariable[]) {
  const overrides: Record<string, number | string> = { ...variables };
  for (const variable of custom) {
    const name = variable.name.trim();
    if (!name) continue;
    const numeric = Number(variable.value);
    overrides[name] = variable.value.trim() !== '' && Number.isFinite(numeric) ? numeric : variable.value;
  }
  return overrides;
}
