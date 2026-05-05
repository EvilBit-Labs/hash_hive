import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface CrackerBinary {
  id: number;
  engine: string;
  version: string;
  platform: string;
  fileRef: Record<string, unknown> | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ListOptions {
  engine?: string;
  includeInactive?: boolean;
  enabled?: boolean;
}

const QUERY_KEY = 'crackers' as const;

export function useCrackerBinaries(options: ListOptions = {}) {
  const { engine, includeInactive = false, enabled = true } = options;

  return useQuery({
    queryKey: [QUERY_KEY, { engine, includeInactive }],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (engine) params.set('engine', engine);
      if (includeInactive) params.set('includeInactive', 'true');
      const qs = params.toString();
      const path = qs ? `/dashboard/crackers?${qs}` : '/dashboard/crackers';
      const data = await api.get<{ crackerBinaries: CrackerBinary[] }>(path);
      return data.crackerBinaries;
    },
    enabled,
  });
}

export function useCrackerBinary(id: number, enabled = true) {
  return useQuery({
    queryKey: [QUERY_KEY, id],
    queryFn: async () => {
      const data = await api.get<{ crackerBinary: CrackerBinary }>(`/dashboard/crackers/${id}`);
      return data.crackerBinary;
    },
    enabled: enabled && Number.isFinite(id) && id > 0,
  });
}

interface CreateInput {
  engine: string;
  version: string;
  platform: string;
}

export function useCreateCrackerBinary() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateInput) => {
      const data = await api.post<{ crackerBinary: CrackerBinary }>('/dashboard/crackers', input);
      return data.crackerBinary;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QUERY_KEY] });
    },
  });
}

export function useUpdateCrackerBinary() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: number; isActive?: boolean }) => {
      const { id, ...patch } = input;
      const data = await api.patch<{ crackerBinary: CrackerBinary }>(
        `/dashboard/crackers/${id}`,
        patch
      );
      return data.crackerBinary;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QUERY_KEY] });
    },
  });
}

export function useDeleteCrackerBinary() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await api.delete<{ acknowledged: true }>(`/dashboard/crackers/${id}`);
      return { id };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QUERY_KEY] });
    },
  });
}

/**
 * Direct (single-request) upload of a cracker binary file.
 *
 * Mirrors the resource-upload pattern: the form sends `multipart/form-data`
 * with a `file` field. For very large binaries, callers should use the
 * chunked-upload endpoints exposed via `useChunkedUpload` instead.
 */
export function useUploadCrackerFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: number; file: File }) => {
      const fd = new FormData();
      fd.append('file', input.file);
      const res = await fetch(`/api/v1/dashboard/crackers/${input.id}/upload`, {
        method: 'POST',
        credentials: 'include',
        body: fd,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message ?? `Upload failed (${res.status})`);
      }
      return (await res.json()) as { key: string; size: number };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QUERY_KEY] });
    },
  });
}
