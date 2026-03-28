import type { CreateAttackTemplateRequest } from '@hashhive/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useUiStore } from '../stores/ui';

export interface AttackTemplate {
  id: number;
  projectId: number;
  name: string;
  description: string | null;
  mode: number;
  hashTypeId: number | null;
  wordlistId: number | null;
  rulelistId: number | null;
  masklistId: number | null;
  advancedConfiguration: Record<string, unknown> | null;
  tags: string[];
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
}

interface InstantiateResponse {
  attack: {
    mode: number;
    hashTypeId: number | null;
    wordlistId: number | null;
    rulelistId: number | null;
    masklistId: number | null;
    advancedConfiguration: unknown | null;
  };
}

export function useAttackTemplates() {
  const { selectedProjectId } = useUiStore();

  return useQuery({
    queryKey: ['attack-templates', selectedProjectId],
    queryFn: () =>
      api.get<{ templates: AttackTemplate[]; total: number }>('/dashboard/attack-templates'),
    enabled: !!selectedProjectId,
  });
}

export function useAttackTemplate(id: number) {
  const { selectedProjectId } = useUiStore();

  return useQuery({
    queryKey: ['attack-template', id, selectedProjectId],
    queryFn: () => api.get<{ template: AttackTemplate }>(`/dashboard/attack-templates/${id}`),
    enabled: id > 0 && !!selectedProjectId,
  });
}

export function useCreateAttackTemplate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateAttackTemplateRequest) =>
      api.post<{ template: AttackTemplate }>('/dashboard/attack-templates', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['attack-templates'] });
    },
  });
}

export function useUpdateAttackTemplate(id: number) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: Partial<CreateAttackTemplateRequest>) =>
      api.patch<{ template: AttackTemplate }>(`/dashboard/attack-templates/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['attack-templates'] });
      queryClient.invalidateQueries({ queryKey: ['attack-template', id] });
    },
  });
}

export function useDeleteAttackTemplate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: number) =>
      api.delete<{ deleted: boolean }>(`/dashboard/attack-templates/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['attack-templates'] });
    },
  });
}

export function useInstantiateAttackTemplate() {
  return useMutation({
    mutationFn: (id: number) =>
      api.post<InstantiateResponse>(`/dashboard/attack-templates/${id}/instantiate`),
  });
}
