import type { CreateAttackRequest } from '@hashhive/shared';
import { create } from 'zustand';

/**
 * Wizard-local attack shape. Derived from the canonical wire schema in
 * `@hashhive/shared` so any backend-accepted field is automatically
 * available to the wizard without manual interface drift.
 *
 * `dependencies` is overridden to a required `number[]` because the
 * wizard always carries a list (empty when no deps), and the indices it
 * stores are wizard-local positional indices — not real backend attack
 * IDs. The submit path remaps them to real IDs before POSTing.
 */
export type AttackConfig = Omit<CreateAttackRequest, 'dependencies'> & {
  dependencies: number[];
};

interface WizardState {
  step: number;
  // Step 1: Basic info
  name: string;
  description: string;
  priority: number;
  hashListId: number | null;
  // Step 2: Attacks
  attacks: AttackConfig[];
  // Actions
  setStep: (step: number) => void;
  setBasicInfo: (info: { name: string; description: string; priority: number }) => void;
  setHashListId: (id: number | null) => void;
  addAttack: (attack: AttackConfig) => void;
  removeAttack: (index: number) => void;
  updateAttack: (index: number, attack: AttackConfig) => void;
  /** Adds a dependency: attack at attackIndex depends on attack at dependsOnIndex. */
  addDependency: (attackIndex: number, dependsOnIndex: number) => void;
  /** Removes a dependency from attack at attackIndex. */
  removeDependency: (attackIndex: number, dependsOnIndex: number) => void;
  reset: () => void;
}

const initialState = {
  step: 0,
  name: '',
  description: '',
  priority: 5,
  hashListId: null as number | null,
  attacks: [] as AttackConfig[],
};

export const useCampaignWizard = create<WizardState>((set) => ({
  ...initialState,
  setStep: (step) => set({ step }),
  setBasicInfo: (info) => set(info),
  setHashListId: (hashListId) => set({ hashListId }),
  addAttack: (attack) => set((s) => ({ attacks: [...s.attacks, attack] })),
  removeAttack: (index) =>
    set((s) => ({
      attacks: s.attacks
        .filter((_, i) => i !== index)
        .map((a) => ({
          ...a,
          dependencies: a.dependencies
            .filter((dep) => dep !== index)
            .map((dep) => (dep > index ? dep - 1 : dep)),
        })),
    })),
  updateAttack: (index, attack) =>
    set((s) => ({
      attacks: s.attacks.map((a, i) => (i === index ? attack : a)),
    })),
  addDependency: (attackIndex, dependsOnIndex) =>
    set((s) => ({
      attacks: s.attacks.map((a, i) =>
        i === attackIndex && !a.dependencies.includes(dependsOnIndex)
          ? { ...a, dependencies: [...a.dependencies, dependsOnIndex] }
          : a
      ),
    })),
  removeDependency: (attackIndex, dependsOnIndex) =>
    set((s) => ({
      attacks: s.attacks.map((a, i) =>
        i === attackIndex
          ? { ...a, dependencies: a.dependencies.filter((dep) => dep !== dependsOnIndex) }
          : a
      ),
    })),
  reset: () => set(initialState),
}));
