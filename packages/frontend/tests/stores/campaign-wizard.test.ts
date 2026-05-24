import { afterEach, describe, expect, it } from 'bun:test'

import { useCampaignWizard } from '../../src/stores/campaign-wizard'

afterEach(() => {
  useCampaignWizard.getState().reset()
})

describe('useCampaignWizard', () => {
  describe('addDependency', () => {
    it('should add a dependency to the specified attack', () => {
      const store = useCampaignWizard.getState()
      store.addAttack({ mode: 0, dependencies: [] })
      store.addAttack({ mode: 1, dependencies: [] })

      useCampaignWizard.getState().addDependency(1, 0)

      const attacks = useCampaignWizard.getState().attacks
      expect(attacks[1]?.dependencies).toEqual([0])
    })

    it('should not duplicate an existing dependency', () => {
      const store = useCampaignWizard.getState()
      store.addAttack({ mode: 0, dependencies: [] })
      store.addAttack({ mode: 1, dependencies: [0] })

      useCampaignWizard.getState().addDependency(1, 0)

      const attacks = useCampaignWizard.getState().attacks
      expect(attacks[1]?.dependencies).toEqual([0])
    })

    it('should not affect other attacks', () => {
      const store = useCampaignWizard.getState()
      store.addAttack({ mode: 0, dependencies: [] })
      store.addAttack({ mode: 1, dependencies: [] })
      store.addAttack({ mode: 2, dependencies: [] })

      useCampaignWizard.getState().addDependency(2, 0)

      const attacks = useCampaignWizard.getState().attacks
      expect(attacks[0]?.dependencies).toEqual([])
      expect(attacks[1]?.dependencies).toEqual([])
      expect(attacks[2]?.dependencies).toEqual([0])
    })
  })

  describe('removeDependency', () => {
    it('should remove a dependency from the specified attack', () => {
      const store = useCampaignWizard.getState()
      store.addAttack({ mode: 0, dependencies: [] })
      store.addAttack({ mode: 1, dependencies: [0] })

      useCampaignWizard.getState().removeDependency(1, 0)

      const attacks = useCampaignWizard.getState().attacks
      expect(attacks[1]?.dependencies).toEqual([])
    })

    it('should be a no-op when dependency does not exist', () => {
      const store = useCampaignWizard.getState()
      store.addAttack({ mode: 0, dependencies: [] })
      store.addAttack({ mode: 1, dependencies: [] })

      useCampaignWizard.getState().removeDependency(1, 0)

      const attacks = useCampaignWizard.getState().attacks
      expect(attacks[1]?.dependencies).toEqual([])
    })
  })

  describe('removeAttack', () => {
    it('should remove the attack at the given index', () => {
      const store = useCampaignWizard.getState()
      store.addAttack({ mode: 0, dependencies: [] })
      store.addAttack({ mode: 1, dependencies: [] })
      store.addAttack({ mode: 2, dependencies: [] })

      useCampaignWizard.getState().removeAttack(1)

      const attacks = useCampaignWizard.getState().attacks
      expect(attacks.length).toBe(2)
      expect(attacks[0]?.mode).toBe(0)
      expect(attacks[1]?.mode).toBe(2)
    })

    it('should shift dependency indices when an attack is removed', () => {
      const store = useCampaignWizard.getState()
      store.addAttack({ mode: 0, dependencies: [] })
      store.addAttack({ mode: 1, dependencies: [] })
      store.addAttack({ mode: 2, dependencies: [0, 1] })

      // Remove attack at index 0, so old index 1 becomes 0, old index 2 becomes 1
      useCampaignWizard.getState().removeAttack(0)

      const attacks = useCampaignWizard.getState().attacks
      expect(attacks.length).toBe(2)
      // Attack that was index 2 (now index 1) should have dependencies shifted:
      // dep 0 is removed (it was the deleted attack), dep 1 becomes dep 0
      expect(attacks[1]?.dependencies).toEqual([0])
    })

    it('should remove dependencies pointing to the deleted attack', () => {
      const store = useCampaignWizard.getState()
      store.addAttack({ mode: 0, dependencies: [] })
      store.addAttack({ mode: 1, dependencies: [0] })

      useCampaignWizard.getState().removeAttack(0)

      const attacks = useCampaignWizard.getState().attacks
      expect(attacks.length).toBe(1)
      expect(attacks[0]?.dependencies).toEqual([])
    })
  })
})
